import fs from "node:fs";
import path from "node:path";

import type { RubricPhase } from "./rubric-assessment";
import {
  DEFAULT_BLOCKED_PATTERNS,
  DEFAULT_STAGE_SCOPES,
  loadPolicy,
} from "./stage-guard-service";
import type { RunPhase } from "../types/enums";

/**
 * 一级确定性条款的只读呈现（design §2.1, 实施顺序第 2 步）。
 *
 * 这个模块**不新增任何拦截**。每一项都是对一个已经在跑的代码检查的描述，
 * `enforcedBy` 指向真正执行它的函数与调用点。面板把它们渲染成只读清单，
 * 让用户看得见「不能碰的是哪几条」——强制本身发生在别处，改这里改变不了
 * 任何行为，这正是它可以纯读派生、不碰 DB 的原因。
 *
 * ## 每个 enforcedBy 都是核对过的真实调用点
 *
 *  - `validatePlannedChanges`：pipeline-document-stage-runner-service.ts:607
 *    （runDocumentStage，scope 来自 defaultScopeForPhase → DEFAULT_STAGE_SCOPES），
 *    pipeline-spec-stage-service.ts:565/639（红蓝双方，scope "spec"），
 *    pipeline-prd-briefing-stage-service.ts:415（scope "intake"）。
 *  - `validateReadOnlyStage`：pipeline-plan-stage-service.ts:294（generate_plan），
 *    refine-service.ts:108（refine）。
 *  - `evaluateBuildGate`：build-workspace-service.ts:727，收集 Build 工作区
 *    产物时评估；plan 来自 loadDbPlanScope，policy 来自 loadPolicy。
 *  - `validateFixScope`：pipeline-build-stage-service.ts:1144（fix_findings）。
 *  - `runScopeCheck`：pipeline-qa-stage-service.ts:223（QA 期全量范围核对）。
 *  - `validateLocalCheckScope`：pipeline-qa-stage-service.ts:226（QA 阶段自身
 *    的写文件范围）。
 *
 * ## 为什么「策略文件缺失」是一个条目而不是空列表
 *
 * `loadPolicy` 对不存在的 `.ship/policy.json` 静默返回内置默认，所以只展示
 * 它的返回值会把「项目没写策略文件」和「策略文件里就是这些」画成同一个样子。
 * 缺失和空是两回事：缺失时内置默认仍然生效，必须写出来，而不是让一个空列表
 * 看起来像「没有限制」。
 */

export interface Tier1DeterministicItem {
  /** Stable within one phase's list; the UI keys rows on it. */
  id: string;
  title: string;
  detail: string;
  /** The real execution point, service · function（调用点）. */
  enforcedBy: string;
}

/**
 * The RunPhase whose write-scope guard covers one rubric phase's producing
 * stage. Deliberately spelled out rather than derived from
 * RUBRIC_ROLE_ANSWERED_BY: that map answers "which stage answers this rubric"
 * (PRD 的答案是 prd_briefing_draft，不是 RunPhase)，而这里要的是「哪个
 * RunPhase 的 scope 在管这个阶段写文件」。两个问题在 PRD 上给出不同答案。
 */
const WRITE_SCOPE_RUN_PHASE: Partial<Record<RubricPhase, RunPhase>> = {
  PRD: "intake",
  Spec: "spec",
  TechSpec: "tech_spec",
  TestPlan: "test_plan",
  Retro: "retro",
  Done: "delivery",
};

const VALIDATE_PLANNED_CHANGES_CALLERS: Partial<Record<RubricPhase, string>> = {
  PRD: "pipeline-prd-briefing-stage-service",
  Spec: "pipeline-spec-stage-service（红蓝双方）",
  TechSpec: "pipeline-document-stage-runner-service",
  TestPlan: "pipeline-document-stage-runner-service",
  Retro: "pipeline-document-stage-runner-service",
  Done: "pipeline-document-stage-runner-service",
};

function stageWriteScopeItem(phase: RubricPhase): Tier1DeterministicItem | null {
  const runPhase = WRITE_SCOPE_RUN_PHASE[phase];
  if (!runPhase) return null;
  const writable = DEFAULT_STAGE_SCOPES[runPhase].writableFiles;
  return {
    id: "stage-write-scope",
    title: "本阶段只允许写这些文件",
    detail:
      `${phase} 的产出阶段（${runPhase}）结束时对比工作区快照，` +
      `落在以下范围之外的改动一律阻断：${writable.join("、")}。` +
      "（.ship/** 的流水线自身记录不计入。）",
    enforcedBy: `stage-guard-service · validatePlannedChanges（${VALIDATE_PLANNED_CHANGES_CALLERS[phase]}）`,
  };
}

/**
 * The `.ship/policy.json` blockedGlobs, exactly the set build-gate-service is
 * handed（loadPolicy 把 blockedFiles 与内置默认并进 blockedGlobs）。
 */
function policyBlockedGlobsItem(repoPath: string): Tier1DeterministicItem {
  const title = "永远不许碰的文件（.ship/policy.json blockedGlobs）";
  const enforcedBy =
    "build-gate-service · evaluateBuildGate（build-workspace-service）；"
    + "scope-check-service · runScopeCheck（pipeline-qa-stage-service）";
  const policyPath = repoPath ? path.join(repoPath, ".ship", "policy.json") : "";

  if (!policyPath || !fs.existsSync(policyPath)) {
    return {
      id: "policy-blocked-globs",
      title,
      detail:
        "策略文件缺失：读不到 .ship/policy.json。缺失不等于没有限制——内置默认"
        + `仍然生效：${DEFAULT_BLOCKED_PATTERNS.join("、")}。`,
      enforcedBy,
    };
  }

  try {
    const policy = loadPolicy(repoPath);
    return {
      id: "policy-blocked-globs",
      title,
      detail:
        `命中以下任一 glob 的改动直接阻断（含策略文件与内置默认的并集）：`
        + `${policy.blockedGlobs.join("、")}。`,
      enforcedBy,
    };
  } catch {
    return {
      id: "policy-blocked-globs",
      title,
      detail:
        "策略文件无法解析：.ship/policy.json 存在但不是合法 JSON，按缺失处理。"
        + `内置默认仍然生效：${DEFAULT_BLOCKED_PATTERNS.join("、")}。`,
      enforcedBy,
    };
  }
}

/**
 * 一个阶段的一级确定性条款：全部是既有检查的只读投影，按阶段过滤。
 *
 * 返回空数组是一个真实答案（该阶段没有确定性守卫，例如 Merge 只做算术、
 * 不跑模型也不写文件），面板对空列表不渲染这一节。
 */
export function tier1DeterministicChecks(input: {
  phase: RubricPhase;
  repoPath: string;
}): Tier1DeterministicItem[] {
  const { phase, repoPath } = input;

  const writeScope = stageWriteScopeItem(phase);
  if (writeScope) return [writeScope];

  switch (phase) {
    case "Refine":
      return [
        {
          id: "readonly-stage",
          title: "Refine 阶段是只读的",
          detail:
            "Refine 对话结束时对比工作区快照，除 .ship/** 之外的任何文件改动都会被拦下。",
          enforcedBy: "stage-guard-service · validateReadOnlyStage（refine-service）",
        },
      ];
    case "Plan":
      return [
        {
          id: "readonly-stage",
          title: "Plan 阶段是只读的",
          detail:
            "generate_plan 结束时对比工作区快照，除 .ship/** 之外的任何文件改动都会被拦下；"
            + "计划本身写进 DB，不写工作区。",
          enforcedBy: "stage-guard-service · validateReadOnlyStage（pipeline-plan-stage-service）",
        },
      ];
    case "Build":
      return [
        {
          id: "plan-scope",
          title: "只许改计划 expectedFiles 里的文件",
          detail:
            "Build 工作区收集产物时逐个文件评估：命中计划 forbiddenFiles、策略 blockedGlobs "
            + "或硬阻断模式（.git/**、.env*、**/*.pem、**/*.key、secrets/**）的直接 gate_blocked；"
            + "在 expectedFiles 之外的记为 deviation 交人裁决。",
          enforcedBy: "build-gate-service · evaluateBuildGate（build-workspace-service）",
        },
        policyBlockedGlobsItem(repoPath),
      ];
    case "Fix":
      return [
        {
          id: "fix-scope",
          title: "修复只许碰 open finding 指到的文件",
          detail:
            "fix_findings 结束时对比工作区快照：改动必须落在未关闭 finding 指到的文件里"
            + "（存在不指文件的 finding 时放宽到计划 expectedFiles），"
            + "命中计划 forbiddenFiles 或策略 blockedGlobs 的直接阻断。",
          enforcedBy: "stage-guard-service · validateFixScope（pipeline-build-stage-service）",
        },
        policyBlockedGlobsItem(repoPath),
      ];
    case "QA":
      return [
        {
          id: "qa-scope-check",
          title: "QA 期全量范围核对",
          detail:
            "QA 用 git status 列出全部改动文件（含新建与已暂存的），逐个对照计划 "
            + "expectedFiles / forbiddenFiles 与策略 blockedGlobs：命中 blocked 记 BLOCKER，"
            + "越界记 P1 finding；仓库读不了时同样 BLOCKER（fail closed，查不了不等于没问题）。",
          enforcedBy: "scope-check-service · runScopeCheck（pipeline-qa-stage-service）",
        },
        {
          id: "qa-write-scope",
          title: "QA 阶段自己只许写检查报告",
          detail:
            "local_check 结束时对比工作区快照，"
            + "在 .ship/changes/<changeId>/** 之外的改动一律阻断。",
          enforcedBy: "stage-guard-service · validateLocalCheckScope（pipeline-qa-stage-service）",
        },
        policyBlockedGlobsItem(repoPath),
      ];
    default:
      // Merge: computeMergeReadiness 是纯算术，不跑模型也不写文件，没有可呈现
      // 的文件守卫。返回空而不是编造一条。
      return [];
  }
}
