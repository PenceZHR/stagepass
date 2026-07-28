import type { PromptPhase } from "./prompt-service";
import type { RubricPhase } from "./rubric-assessment";
import type { RunPhase } from "../types";
import { RED_SPEC_OUTPUT_JSON_SCHEMA } from "./spec-battle-ledger";
import {
  TECH_SPEC_OUTPUT_SCHEMA,
  TESTPLAN_OUTPUT_SCHEMA,
} from "./design-stage-output-schemas";
import { PLAN_JSON_SCHEMA } from "./plan-output-schema";
import { withRedFixClaims } from "./delegated-round-red-schema";

/**
 * The four design phases that run as a delegated round, and what differs
 * between them.
 *
 * ## Why a descriptor rather than four copies
 *
 * Spec, TechSpec, Plan and TestPlan are the same shape: a judge spawns a
 * producer, waits, spawns a supervisor with the producer's output, waits, and
 * judges. Everything that makes that trustworthy -- attribution by sub-agent
 * thread, turn-taking proved from thread timings, server-owned schemas, whole
 * round refused on any violation -- is identical, and identical is the point:
 * it is the part a copy would erode first. Four copies of the judge's
 * anti-fabrication rules would be four places for one of them to drift into
 * "the judge may summarise its sides".
 *
 * So the judge PROMPT is one shared template parameterised by this descriptor,
 * and only the two sub-agent briefs -- which carry genuinely phase-specific
 * craft -- are written per phase.
 *
 * ## What is deliberately per-phase
 *
 * `redOutputSchema` only. Blue always produces gaps plus reviews of the prior
 * round's fix claims, and the judge always produces verdict/rubric/roundDone,
 * so those two schemas are shared. Red produces the phase's own artifact, which
 * is the one thing that genuinely differs -- and each phase already had a
 * producer schema before it had a critic, so this reuses it rather than
 * inventing a second definition of the same document.
 *
 * What is NOT per-phase is red's answer to the previous round's gaps.
 * `withRedFixClaims` adds that field to every phase's producer schema from one
 * definition. It has to be added rather than assumed: the producer schemas are
 * `additionalProperties: false`, so before this wrap three of the four phases
 * could not have carried a fix claim even if red had volunteered one -- and the
 * judge's first shared check is precisely 「红方声称 fixed、蓝方未确认的按未解决
 * 处理」, which would have had nothing to read.
 */
export interface DelegatedRoundPhase {
  /** Rubric and battle-round phase label, e.g. "TechSpec". */
  phase: RubricPhase;
  /** What the prompts call this phase, in the user's language. */
  label: string;
  /** Run-ledger phase, e.g. "tech_spec". */
  runPhase: RunPhase;
  /** The producer's codename, recorded as `battle_rounds.red_unit`. */
  redUnit: string;
  /** The supervisor's codename, recorded as `battle_rounds.blue_unit`. */
  blueUnit: string;
  /**
   * The schema red must fill -- the phase's existing producer output schema.
   * Enforced server-side only: `spawn_agent` takes no output schema, so this
   * travels in red's brief and is validated on the way back.
   */
  redOutputSchema: Record<string, unknown>;
  /** Per-phase sub-agent briefs. The judge template is shared. */
  redPromptPhase: PromptPhase;
  bluePromptPhase: PromptPhase;
  /**
   * What the judge is told to check, injected into the shared judge template.
   *
   * Phase-specific by necessity: "red claimed fixed but blue says still open"
   * is universal, but what counts as a real gap in a test plan is not what
   * counts as one in an API contract.
   */
  verdictChecklist: readonly string[];
}

/**
 * Shared across every phase: blue always reviews the prior round's fix claims
 * and proposes gaps, whatever the artifact under review was.
 */
export const DELEGATED_ROUND_ROLES = { red: "red", blue: "blue" } as const;

const SHARED_VERDICT_CHECKS = [
  "红方的自证不等于事实。红方声称 `fixed`、而蓝方未确认或判为 `still_open` 的，按未解决处理。",
  "蓝方提出的每一个 open gap，红方是否都有过回应（修复或说明理由）。",
] as const;

export const SPEC_DELEGATED_ROUND: DelegatedRoundPhase = {
  phase: "Spec",
  label: "Spec",
  runPhase: "spec",
  redUnit: "SPEC_WRITER",
  blueUnit: "REQUIREMENT_CRITIC",
  redOutputSchema: RED_SPEC_OUTPUT_JSON_SCHEMA,
  redPromptPhase: "spec_red_subagent",
  bluePromptPhase: "spec_blue_subagent",
  verdictChecklist: [
    ...SHARED_VERDICT_CHECKS,
    "红方是否把实现细节包装成需求，或遗漏了真正需要人类拍板的决策点。",
    "本轮 PRD delta 的验收标准是否足以指导后续 TechSpec / TestPlan。",
  ],
};

export const TECH_SPEC_DELEGATED_ROUND: DelegatedRoundPhase = {
  phase: "TechSpec",
  label: "TechSpec",
  runPhase: "tech_spec",
  redUnit: "TECH_SPEC_WRITER",
  blueUnit: "TECH_SPEC_CRITIC",
  redOutputSchema: withRedFixClaims(TECH_SPEC_OUTPUT_SCHEMA),
  redPromptPhase: "tech_spec_red_subagent",
  bluePromptPhase: "tech_spec_blue_subagent",
  verdictChecklist: [
    ...SHARED_VERDICT_CHECKS,
    "接口、数据契约和迁移说明是否足够具体到可以据此施工，而不是复述需求。",
    "状态的唯一事实来源、并发写入和失败回滚是否都有明确方案。",
    "是否有任何一处把「以后再定」当成了技术决策。",
  ],
};

export const PLAN_DELEGATED_ROUND: DelegatedRoundPhase = {
  phase: "Plan",
  label: "Plan",
  runPhase: "generate_plan",
  redUnit: "PLAN_WRITER",
  blueUnit: "PLAN_CRITIC",
  redOutputSchema: withRedFixClaims(PLAN_JSON_SCHEMA),
  redPromptPhase: "plan_red_subagent",
  bluePromptPhase: "plan_blue_subagent",
  verdictChecklist: [
    ...SHARED_VERDICT_CHECKS,
    "每一步是否都有输入、产出、验证方式，以及失败后的恢复路径。",
    "步骤顺序是否真的可执行——后一步依赖的东西，前一步是否已经产出。",
    "验证命令是否足以证明这一步做到了，而不是只证明它没报错。",
  ],
};

export const TEST_PLAN_DELEGATED_ROUND: DelegatedRoundPhase = {
  phase: "TestPlan",
  label: "TestPlan",
  runPhase: "test_plan",
  redUnit: "TEST_PLAN_WRITER",
  blueUnit: "TEST_PLAN_CRITIC",
  redOutputSchema: withRedFixClaims(TESTPLAN_OUTPUT_SCHEMA),
  redPromptPhase: "test_plan_red_subagent",
  bluePromptPhase: "test_plan_blue_subagent",
  verdictChecklist: [
    ...SHARED_VERDICT_CHECKS,
    "每个会阻止交付的关键风险，是否都有一条能真的跑起来的测试覆盖。",
    "通过或失败的判据是否客观可判，而不是「人工看一下」。",
    "覆盖项是否对得上已批准的验收标准，而不是测了一堆无关的东西。",
  ],
};

export const DELEGATED_ROUND_PHASES: readonly DelegatedRoundPhase[] = [
  SPEC_DELEGATED_ROUND,
  TECH_SPEC_DELEGATED_ROUND,
  PLAN_DELEGATED_ROUND,
  TEST_PLAN_DELEGATED_ROUND,
];

export function delegatedRoundPhase(phase: RubricPhase): DelegatedRoundPhase | undefined {
  return DELEGATED_ROUND_PHASES.find((entry) => entry.phase === phase);
}
