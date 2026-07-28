import type { SubAgentThreadReader } from "./codex-subagent-attribution";
import type { CodexSubAgentThread } from "./codex-desktop-bridge-types";
import {
  attributeRoundSides,
  describeRoundAttributionViolation,
  type AttributedRoundSide,
  type RoundAttributionViolation,
  type SubAgentCandidate,
} from "./delegated-round-attribution";
import {
  describeServerOwnedJsonFailure,
  readServerOwnedJson,
} from "./server-owned-json-output";
import {
  BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
  validateBlueCritiqueOutput,
  type ParsedBlueCritiqueOutput,
} from "./spec-battle-ledger";
import {
  SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
  type SpecJudgeOutput,
} from "./spec-judge-output-schema";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import { readRoundOutput, type RoundOutputRead } from "./delegated-round-workspace";

/**
 * Assembles one delegated round from the files its three roles wrote, and
 * refuses the whole round if any part of it fails to hold up.
 *
 * ## Where the evidence comes from, and why not from anywhere else
 *
 * Everything here is read from something the judge cannot write:
 *
 *  - **that sides exist** -- `thread/list` filtered to `subAgentThreadSpawn`,
 *    matched on the `parent_thread_id` the app-server stamped. NOT from
 *    `subAgentActivity` items: those live only on the live notification stream
 *    and are entirely absent from the `thread/read` snapshot this server reads,
 *    so attributing from them reported a real delegated round as one that never
 *    delegated. That was observed, not theorised.
 *  - **which side is which** -- no label survives to the durable record
 *    (`agent_path` and `agent_role` both came back null on a real round, with
 *    auto-generated nicknames), so the role is DERIVED: each output file was
 *    written while exactly one child was running.
 *  - **that they took turns** -- from those same child windows.
 *  - **content** -- from the files, against server-owned schemas.
 *
 * ## Why nothing is persisted from here
 *
 * The round's parts land through separate writers into separate tables.
 * Validating each as it is written would leave a round that failed on blue
 * holding a committed red leg -- which reads, to every later query, as a critic
 * that found nothing. So this returns a complete round or a list of violations,
 * never a partial one.
 */

export type DelegatedRoundViolation =
  | RoundAttributionViolation
  /** A side ran but its output file is absent or unreadable. */
  | { code: "side_output_missing"; role: string; detail: string }
  /** A side wrote a file, but not the document its server-owned schema asked for. */
  | { code: "side_output_invalid"; role: string; detail: string }
  | { code: "judge_output_missing"; detail: string }
  | { code: "judge_output_invalid"; detail: string }
  /**
   * The judge answered criterion ids this rubric does not have.
   *
   * Checked HERE, before anything is written. The assessment store rejects
   * unknown ids too, but it only runs after red and blue have been committed --
   * which left CHG-006 with a failed round and two gaps already in the ledger,
   * the exact half-round this module exists to make impossible.
   */
  | { code: "judge_rubric_unknown_criteria"; criterionIds: string[] }
  /**
   * Blue answered criterion ids the CRITIC rubric does not have.
   *
   * Same rule as the judge's, and checked in the same place and for the same
   * reason: before anything is written. A blue whose rubric ids are rejected by
   * the assessment store AFTER red has been committed leaves the half-round this
   * module exists to make impossible.
   */
  | { code: "blue_rubric_unknown_criteria"; criterionIds: string[] }
  /** The judge stopped short of calling the round finished. */
  | { code: "judge_round_not_done" };

export interface DelegatedRound {
  /** Validated against the phase's own producer schema. */
  red: Record<string, unknown>;
  blue: ParsedBlueCritiqueOutput;
  judge: SpecJudgeOutput;
  /** Which sub-agent thread each side turned out to be. */
  sideThreads: Record<string, string>;
}

export type DelegatedRoundResult =
  | { ok: true; round: DelegatedRound }
  | { ok: false; violations: DelegatedRoundViolation[] };

const RED = "red";
const BLUE = "blue";

/** Discovers the sub-agents a judge thread spawned. */
export type SubAgentDiscovery = (parentThreadId: string) => Promise<CodexSubAgentThread[]>;

export interface ReadDelegatedRoundInput {
  descriptor: DelegatedRoundPhase;
  changeId: string;
  repoPath: string;
  roundNo: number;
  /** The judge's own thread. Its children are this round's sides. */
  judgeThreadId: string;
  listSubAgents: SubAgentDiscovery;
  readThread: SubAgentThreadReader;
  /** Sub-agent threads earlier rounds of this change already spent. */
  usedAgentThreadIds?: ReadonlySet<string>;
  /**
   * Criterion ids the verdict rubric actually has. Omitted means the phase has
   * no verdict rubric, and the judge is then expected to answer none.
   */
  verdictCriterionIds?: readonly string[];
  /** The same, for the critic rubric blue answers. */
  criticCriterionIds?: readonly string[];
}

export async function readDelegatedRound(
  input: ReadDelegatedRoundInput,
): Promise<DelegatedRoundResult> {
  const violations: DelegatedRoundViolation[] = [];
  const scope = fileScope(input);

  const outputs = {
    red: readRoundOutput({ ...scope, role: "red" as const }),
    blue: readRoundOutput({ ...scope, role: "blue" as const }),
  };
  for (const [role, read] of Object.entries(outputs)) {
    if (!read.ok) violations.push({ code: "side_output_missing", role, detail: read.detail });
  }

  // Attribution needs the write times, so a missing file costs the ability to
  // attribute that side at all. The sides that DID write are still attributed,
  // so the operator learns every problem now rather than one per expensive
  // re-run.
  const attribution = attributeRoundSides({
    parentThreadId: input.judgeThreadId,
    candidates: await readCandidates(input),
    orderedSides: [
      ...(outputs.red.ok ? [{ role: RED, writtenAtMs: outputs.red.writtenAtMs }] : []),
      ...(outputs.blue.ok ? [{ role: BLUE, writtenAtMs: outputs.blue.writtenAtMs }] : []),
    ],
    expectedSideCount: 2,
    usedAgentThreadIds: input.usedAgentThreadIds,
  });
  if (!attribution.ok) violations.push(...attribution.violations);

  const sides: readonly AttributedRoundSide[] = attribution.ok ? attribution.sides : [];
  const sideThreads: Record<string, string> = {};
  let red: Record<string, unknown> | undefined;
  let blue: ParsedBlueCritiqueOutput | undefined;

  for (const side of sides) {
    sideThreads[side.role] = side.agentThreadId;
    const read = side.role === RED ? outputs.red : outputs.blue;
    if (!read.ok) continue;
    const parsed = readServerOwnedJson(
      read.text,
      side.role === RED ? input.descriptor.redOutputSchema : BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
    );
    if (!parsed.ok) {
      violations.push({
        code: "side_output_invalid",
        role: side.role,
        detail: describeServerOwnedJsonFailure(parsed.failure),
      });
      continue;
    }
    if (side.role === RED) {
      red = parsed.value;
      continue;
    }
    // Blue gets a second gate: the JSON schema settles shape, zod settles the
    // cross-field rules a schema cannot express (a `downgraded` verdict needs a
    // downgrade target, and so on).
    const validated = validateBlueCritiqueOutput(parsed.value);
    if (!validated.success) {
      violations.push({ code: "side_output_invalid", role: side.role, detail: validated.error.message });
      continue;
    }
    blue = validated.data;
    const unknown = unknownCriterionIds(validated.data.rubric, input.criticCriterionIds);
    if (unknown.length > 0) {
      violations.push({ code: "blue_rubric_unknown_criteria", criterionIds: unknown });
    }
  }

  const judge = readJudgeOutput(scope);
  if (!judge.ok) violations.push(...judge.violations);
  else {
    const unknown = unknownCriterionIds(judge.value.rubric, input.verdictCriterionIds);
    if (unknown.length > 0) {
      violations.push({ code: "judge_rubric_unknown_criteria", criterionIds: [...new Set(unknown)] });
    }
  }

  if (violations.length > 0 || !red || !blue || !judge.ok) {
    return {
      ok: false,
      violations: violations.length > 0
        ? violations
        // Unreachable in practice; kept so an empty violation list can never be
        // returned alongside ok:false and read as "no problems".
        : [{ code: "judge_output_invalid", detail: "round was incomplete for an unrecorded reason" }],
    };
  }
  return { ok: true, round: { red, blue, judge: judge.value, sideThreads } };
}

/** Ids a role answered that its rubric does not contain, de-duplicated. */
function unknownCriterionIds(
  answers: readonly { criterionId: string }[],
  known: readonly string[] | undefined,
): string[] {
  const ids = new Set(known ?? []);
  return [...new Set(
    answers.map((entry) => entry.criterionId).filter((criterionId) => !ids.has(criterionId)),
  )];
}

function fileScope(input: {
  changeId: string;
  repoPath: string;
  roundNo: number;
  descriptor: DelegatedRoundPhase;
}): { changeId: string; repoPath: string; phase: string; roundNo: number } {
  return {
    changeId: input.changeId,
    repoPath: input.repoPath,
    phase: input.descriptor.phase,
    roundNo: input.roundNo,
  };
}

async function readCandidates(input: {
  judgeThreadId: string;
  listSubAgents: SubAgentDiscovery;
  readThread: SubAgentThreadReader;
}): Promise<SubAgentCandidate[]> {
  const threads = await input.listSubAgents(input.judgeThreadId);
  const candidates: SubAgentCandidate[] = [];
  for (const thread of threads) {
    try {
      candidates.push({ thread, read: await input.readThread(thread.threadId) });
    } catch {
      // An unreadable child yields no timing, which attributeRoundSides reports
      // as `sub_agent_timing_unknown`. "Cannot tell" must never read as "did",
      // so it is recorded as unknown rather than assumed good or dropped.
      candidates.push({ thread, read: { output: null, startedAt: null, completedAt: null } });
    }
  }
  return candidates;
}

function readJudgeOutput(scope: {
  changeId: string;
  repoPath: string;
  phase: string;
  roundNo: number;
}): { ok: true; value: SpecJudgeOutput } | { ok: false; violations: DelegatedRoundViolation[] } {
  const read: RoundOutputRead = readRoundOutput({ ...scope, role: "verdict" });
  if (!read.ok) {
    return { ok: false, violations: [{ code: "judge_output_missing", detail: read.detail }] };
  }
  const parsed = readServerOwnedJson(read.text, SPEC_JUDGE_OUTPUT_JSON_SCHEMA);
  if (!parsed.ok) {
    return {
      ok: false,
      violations: [{
        code: "judge_output_invalid",
        detail: describeServerOwnedJsonFailure(parsed.failure),
      }],
    };
  }
  const value = parsed.value as unknown as SpecJudgeOutput;
  // `roundDone: false` is the judge disowning its own verdict. Settling on it
  // would record a round its author said was unfinished.
  if (!value.roundDone) {
    return { ok: false, violations: [{ code: "judge_round_not_done" }] };
  }
  return { ok: true, value };
}

/** Operator-facing summary. One line per violation, in the order they occurred. */
export function describeDelegatedRoundViolations(
  violations: readonly DelegatedRoundViolation[],
): string {
  return violations.map((violation) => {
    switch (violation.code) {
      case "side_output_missing":
        return `${violation.role} 方没有写出产出文件：${violation.detail}`;
      case "side_output_invalid":
        return `${violation.role} 方的产出不符合服务端 Schema：${violation.detail}`;
      case "judge_output_missing":
        return `裁决者没有写出裁决文件：${violation.detail}`;
      case "judge_output_invalid":
        return `裁决者的裁决文件不符合服务端 Schema：${violation.detail}`;
      case "judge_round_not_done":
        return "裁决者未声明本轮完成";
      case "judge_rubric_unknown_criteria":
        return `裁决者判定了本 rubric 没有的 criterion：${violation.criterionIds.join(", ")}（必须逐字符照抄任务书里的 id）`;
      case "blue_rubric_unknown_criteria":
        return `蓝方判定了 critic rubric 没有的 criterion：${violation.criterionIds.join(", ")}（必须逐字符照抄任务书里的 id）`;
      default:
        return describeRoundAttributionViolation(violation);
    }
  }).join("；");
}
