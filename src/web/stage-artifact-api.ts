import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";

import {
  isRepoRelativePath,
  materializeStageRound,
  type MaterializedStageRound,
  type StageRoundArtifact,
} from "../domain/stage-artifact";
import { isPhase, type Phase } from "../domain/phase";
import { roundFromLedger } from "../domain/round";
import { readStageArtifact } from "../graph/read-stage-artifact";
import { reconstructStageArtifacts } from "../graph/reconstruct-stage-artifact";
import {
  layoutStageArtifacts,
  selectedDependencies,
} from "../graph/stage-artifact-layout";
import { readWorkspaceModuleGraph } from "../graph/read-workspace";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { StageArtifactStore } from "../store/stage-artifact-store";
import type { RepoOps } from "../work/repo";

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

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function fail(response: ServerResponse, status: number, error: string): true {
  json(response, { error }, status);
  return true;
}

function contextFor(
  database: Database.Database,
  url: URL,
): StageContext | { error: string; status: number } {
  const changeId = url.searchParams.get("change") ?? "";
  if (changeId === "") return { error: "change-required", status: 400 };
  const phaseName = url.searchParams.get("phase") ?? "";
  if (!isPhase(phaseName)) return { error: "phase-invalid", status: 400 };
  const changes = new ChangeStore(database);
  let change: ReturnType<ChangeStore["read"]>;
  try {
    change = changes.read(changeId);
  } catch {
    return { error: "change-unknown", status: 404 };
  }
  if (change.projectId === null) return { error: "project-mismatch", status: 409 };
  const projects = new ProjectStore(database);
  let project: ReturnType<ProjectStore["read"]>;
  try {
    project = projects.read(change.projectId);
  } catch {
    return { error: "project-mismatch", status: 409 };
  }
  if (project.path === null) return { error: "no-path", status: 409 };
  return {
    changeId,
    phase: phaseName,
    root: project.path,
    excluded: projects.graphExcludes(project.id),
    changes,
  };
}

function roundsFor(input: {
  database: Database.Database;
  context: StageContext;
  repo: RepoOps;
}): RoundReading | { error: string; status: number } {
  const store = new StageArtifactStore(input.database);
  const recorded = store.list(input.context.changeId, input.context.phase);
  if (recorded.length > 0) return { artifacts: recorded, incompleteRounds: [] };

  const evidence = new EvidenceStore(input.database).read(
    input.context.changeId, input.context.phase,
  );
  const updated = input.database.prepare(
    "SELECT updated_at FROM change_evidence WHERE change_id = ? AND phase = ?",
  ).get(input.context.changeId, input.context.phase) as { updated_at: string } | undefined;
  const reconstructed = reconstructStageArtifacts({
    root: input.context.root,
    changeId: input.context.changeId,
    phase: input.context.phase,
    knownRound: roundFromLedger(
      input.context.changes.ledger(input.context.changeId), input.context.phase,
    ),
    evidenceArtifactIds: evidence.artifactIds,
    evidenceUpdatedAt: updated?.updated_at ?? null,
    repo: input.repo,
  });
  if (reconstructed.reason !== null) {
    return { error: reconstructed.reason, status: 409 };
  }
  return reconstructed;
}

function requestedRound(url: URL): number | null | "invalid" {
  const raw = url.searchParams.get("round");
  if (raw === null || raw === "") return null;
  const round = Number(raw);
  return Number.isInteger(round) && round >= 1 ? round : "invalid";
}

function selectRound(
  reading: RoundReading,
  wanted: number | null,
): {
  selectedRound: number | null;
  current: MaterializedStageRound | null;
  incomplete: boolean;
} | null {
  const selectedRound = wanted ?? reading.artifacts[0]?.round ?? null;
  if (selectedRound === null) return { selectedRound: null, current: null, incomplete: false };
  const exists = reading.artifacts.some((artifact) => artifact.round === selectedRound);
  if (exists) {
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

export function createStageArtifactApi(input: {
  database: Database.Database;
  repo: RepoOps;
}): (
  url: URL, request: IncomingMessage, response: ServerResponse,
) => Promise<boolean> {
  return async (url, request, response) => {
    if (url.pathname !== "/api/stage-artifacts" && url.pathname !== "/api/stage-file") {
      return false;
    }
    if (request.method !== "GET") return fail(response, 405, "method-not-allowed");
    if (url.searchParams.has("commit")) return fail(response, 400, "commit-not-accepted");
    const context = contextFor(input.database, url);
    if ("error" in context) return fail(response, context.status, context.error);
    const wanted = requestedRound(url);
    if (wanted === "invalid") return fail(response, 400, "round-invalid");
    if (url.pathname === "/api/stage-file" && wanted === null) {
      return fail(response, 400, "round-required");
    }
    const modules = readWorkspaceModuleGraph({
      root: context.root,
      excluded: context.excluded,
      trackedFiles: (cwd) => input.repo.trackedFiles(cwd),
    });
    if (!modules.ok) return fail(response, 409, modules.reason);
    const reading = roundsFor({ database: input.database, context, repo: input.repo });
    if ("error" in reading) return fail(response, reading.status, reading.error);
    const selected = selectRound(reading, wanted);
    if (selected === null) return fail(response, 404, "round-unknown");
    const scene = layoutStageArtifacts({ current: selected.current, graph: modules.graph });
    const facts = gapFacts(input.database, context, selected.current);

    if (url.pathname === "/api/stage-artifacts") {
      json(response, {
        rounds: reading.artifacts,
        selectedRound: selected.selectedRound,
        incomplete: selected.incomplete,
        incompleteRounds: reading.incompleteRounds,
        scene,
        ...facts,
      });
      return true;
    }

    const path = url.searchParams.get("path") ?? "";
    if (path === "") return fail(response, 400, "path-required");
    if (selected.current === null) return fail(response, 404, "round-incomplete");
    const file = readStageArtifact({
      root: context.root,
      round: selected.current,
      path,
      repo: input.repo,
    });
    if (!file.ok) {
      const status = file.reason === "path-outside" ? 403
        : file.reason === "file-too-large" ? 413
          : file.reason === "commit-mismatch" ? 400 : 404;
      return fail(response, status, file.reason);
    }
    json(response, {
      ...file,
      dependencies: selectedDependencies(scene, path),
      relatedGaps: facts.fileFacts[path] ?? [],
    });
    return true;
  };
}
