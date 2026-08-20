import type Database from "better-sqlite3";

import { isPhase, type Phase } from "../domain/phase";
import { roundFromLedger } from "../domain/round";
import {
  isRepoRelativePath,
  materializeStageRound,
  type MaterializedStageRound,
  type StageRoundArtifact,
} from "../domain/stage-artifact";
import { readStageArtifact } from "../graph/read-stage-artifact";
import { readFileIngredients, readWorkspaceGraph, readWorkspaceModuleGraph } from "../graph/read-workspace";
import { reconstructStageArtifacts } from "../graph/reconstruct-stage-artifact";
import { layoutStageArtifacts, selectedDependencies } from "../graph/stage-artifact-layout";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { StageArtifactStore } from "../store/stage-artifact-store";
import type { RepoOps } from "../work/repo";

/**
 * 四条要**读仓库**的路：产物、产物正文、图谱、单文件配料单。
 *
 * ## 为什么它们单独一个模块
 *
 * 它们都要 `graph/module-graph.ts` 真解析 import，而那个模块依赖 **TypeScript 编译器**。
 * 实测（2026-08-18）：急切加载让插件启动从 110ms 变成 ~200ms、堆多 21MB —— 而绝大多数
 * Codex 会话根本不看产物和图谱，那笔钱不该每次都付。
 *
 * 所以这里是**唯一的懒加载边界**：`api.ts` 只在真收到这四条路时才
 * `await import("./repo-routes")`，编译器跟着这一刻才进内存。第二次起是 0。
 * 那 90ms 和「算一次图谱」本身（实测 65~128ms）是同一个数量级，人点开本来就要等一下。
 *
 * ## 逻辑是搬过来的，不是重写的
 *
 * 原样来自 `web/stage-artifact-api.ts` 和 `web/graph-api.ts` —— 2026-08-18 网页端
 * 退休时那两层 HTTP 壳删了，判据（哪个状态码对应哪种拒绝）一条不改地搬到这里。
 */

export interface RepoDeps {
  readonly database: Database.Database;
  readonly repo: RepoOps;
}

export interface RouteAnswer {
  readonly status: number;
  readonly body: unknown;
}

const fail = (status: number, error: string): RouteAnswer => ({ status, body: { error } });

interface StageContext {
  readonly changeId: string;
  readonly phase: Phase;
  readonly root: string;
  readonly excluded: readonly string[];
  readonly changes: ChangeStore;
}

interface RoundReading {
  readonly artifacts: readonly StageRoundArtifact[];
  readonly incompleteRounds: readonly number[];
}

/** 这次请求落在哪个 Change / 阶段 / 仓库上。缺一样就说清楚缺哪样。 */
function contextFor(
  database: Database.Database,
  params: URLSearchParams,
): StageContext | RouteAnswer {
  const changeId = params.get("change") ?? "";
  if (changeId === "") return fail(400, "change-required");
  const phaseName = params.get("phase") ?? "";
  if (!isPhase(phaseName)) return fail(400, "phase-invalid");
  const changes = new ChangeStore(database);
  let change: ReturnType<ChangeStore["read"]>;
  try {
    change = changes.read(changeId);
  } catch {
    return fail(404, "change-unknown");
  }
  if (change.projectId === null) return fail(409, "project-mismatch");
  const projects = new ProjectStore(database);
  let project: ReturnType<ProjectStore["read"]>;
  try {
    project = projects.read(change.projectId);
  } catch {
    return fail(409, "project-mismatch");
  }
  if (project.path === null) return fail(409, "no-path");
  return {
    changeId,
    phase: phaseName,
    root: project.path,
    excluded: projects.graphExcludes(project.id),
    changes,
  };
}

/**
 * 这个阶段有哪几轮产物。
 *
 * 库里记着就用库里的；没记（老数据、或者那一轮是在别处跑的）就从仓库里**重建**
 * —— 重建不出来要说出重建失败的原因，不能返回一个空列表冒充「这个阶段没产物」。
 */
function roundsFor(deps: RepoDeps, context: StageContext): RoundReading | RouteAnswer {
  const recorded = new StageArtifactStore(deps.database).list(context.changeId, context.phase);
  if (recorded.length > 0) return { artifacts: recorded, incompleteRounds: [] };

  const evidence = new EvidenceStore(deps.database).read(context.changeId, context.phase);
  const updated = deps.database.prepare(
    "SELECT updated_at FROM change_evidence WHERE change_id = ? AND phase = ?",
  ).get(context.changeId, context.phase) as { updated_at: string } | undefined;
  const reconstructed = reconstructStageArtifacts({
    root: context.root,
    changeId: context.changeId,
    phase: context.phase,
    knownRound: roundFromLedger(context.changes.ledger(context.changeId), context.phase),
    evidenceArtifactIds: evidence.artifactIds,
    evidenceUpdatedAt: updated?.updated_at ?? null,
    repo: deps.repo,
  });
  if (reconstructed.reason !== null) return fail(409, reconstructed.reason);
  return reconstructed;
}

function requestedRound(params: URLSearchParams): number | null | "invalid" {
  const raw = params.get("round");
  if (raw === null || raw === "") return null;
  const round = Number(raw);
  return Number.isInteger(round) && round >= 1 ? round : "invalid";
}

function selectRound(reading: RoundReading, wanted: number | null): {
  selectedRound: number | null;
  current: MaterializedStageRound | null;
  incomplete: boolean;
} | null {
  const selectedRound = wanted ?? reading.artifacts[0]?.round ?? null;
  if (selectedRound === null) return { selectedRound: null, current: null, incomplete: false };
  if (reading.artifacts.some((artifact) => artifact.round === selectedRound)) {
    return {
      selectedRound,
      current: materializeStageRound(reading.artifacts, selectedRound),
      incomplete: false,
    };
  }
  if (reading.incompleteRounds.includes(selectedRound)) {
    return { selectedRound, current: null, incomplete: true };
  }
  return null;
}

/** 开着的问题，分给「某个文件」还是「整个阶段」—— 有 where 且那个文件在这一轮里才挂到文件上。 */
function gapFacts(
  database: Database.Database,
  context: StageContext,
  current: MaterializedStageRound | null,
): { fileFacts: Readonly<Record<string, unknown[]>>; stageFacts: readonly unknown[] } {
  const paths = new Set(current?.files.map((file) => file.path) ?? []);
  const fileFacts: Record<string, unknown[]> = {};
  const stageFacts: unknown[] = [];
  for (const gap of new GapStore(database).all(context.changeId, context.phase)) {
    if (gap.status !== "open") continue;
    if (gap.where !== null && isRepoRelativePath(gap.where) && paths.has(gap.where)) {
      fileFacts[gap.where] = [...(fileFacts[gap.where] ?? []), gap];
    } else {
      stageFacts.push(gap);
    }
  }
  return { fileFacts, stageFacts };
}

export function handleRepoRoute(
  pathname: string,
  params: URLSearchParams,
  deps: RepoDeps,
): RouteAnswer {
  const trackedFiles = (cwd: string): readonly string[] | null => deps.repo.trackedFiles(cwd);

  /* ── 图谱那两条 ───────────────────────────────────────────── */
  if (pathname === "/api/graph" || pathname === "/api/file") {
    const projectId = params.get("project") ?? "";
    let root: string | null = null;
    try {
      root = new ProjectStore(deps.database).read(projectId).path;
    } catch { /* 没这个项目 —— 下面统一当「没有」处理 */ }
    if (root === null || root === "") return fail(404, "no-such-project");
    const excluded = new ProjectStore(deps.database).graphExcludes(projectId);

    if (pathname === "/api/graph") {
      const graph = readWorkspaceGraph({ root, excluded, trackedFiles });
      // `not-a-repo` 不是「出错了」，是「这个目录还不是仓库」—— 界面要分得清。
      return graph.ok ? { status: 200, body: graph } : fail(409, graph.reason);
    }
    const reading = readFileIngredients({ root, excluded, trackedFiles, path: params.get("path") ?? "" });
    if (reading.ok) return { status: 200, body: reading.ingredients };
    return fail(
      reading.reason === "path-outside" ? 403 : reading.reason === "not-a-repo" ? 409 : 404,
      reading.reason,
    );
  }

  /* ── 产物那两条 ───────────────────────────────────────────── */
  if (params.has("commit")) return fail(400, "commit-not-accepted");
  const context = contextFor(deps.database, params);
  if ("status" in context) return context;

  const wanted = requestedRound(params);
  if (wanted === "invalid") return fail(400, "round-invalid");
  if (pathname === "/api/stage-file" && wanted === null) return fail(400, "round-required");

  const modules = readWorkspaceModuleGraph({ root: context.root, excluded: context.excluded, trackedFiles });
  if (!modules.ok) return fail(409, modules.reason);
  const reading = roundsFor(deps, context);
  if ("status" in reading) return reading;
  const selected = selectRound(reading, wanted);
  if (selected === null) return fail(404, "round-unknown");
  const scene = layoutStageArtifacts({ current: selected.current, graph: modules.graph });
  const facts = gapFacts(deps.database, context, selected.current);

  if (pathname === "/api/stage-artifacts") {
    return {
      status: 200,
      body: {
        rounds: reading.artifacts,
        selectedRound: selected.selectedRound,
        incomplete: selected.incomplete,
        incompleteRounds: reading.incompleteRounds,
        scene,
        ...facts,
      },
    };
  }

  const path = params.get("path") ?? "";
  if (path === "") return fail(400, "path-required");
  if (selected.current === null) return fail(404, "round-incomplete");
  const file = readStageArtifact({ root: context.root, round: selected.current, path, repo: deps.repo });
  if (!file.ok) {
    return fail(
      file.reason === "path-outside" ? 403
        : file.reason === "file-too-large" ? 413
          : file.reason === "commit-mismatch" ? 400 : 404,
      file.reason,
    );
  }
  return {
    status: 200,
    body: { ...file, dependencies: selectedDependencies(scene, path), relatedGaps: facts.fileFacts[path] ?? [] },
  };
}
