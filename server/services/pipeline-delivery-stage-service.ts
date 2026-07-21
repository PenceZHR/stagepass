import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { changes } from "../db/schema";
import type { Change } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import { emitIdempotentEvent } from "./event-service";
import { runDocumentStage } from "./pipeline-document-stage-runner-service";
import {
  buildDeliveryKnownLimits,
  type DeliveryKnownLimitsFacts,
} from "./delivery-known-limits-service";
import {
  DELIVERY_BLOCK_NAMES,
  parseDeliveryLineProtocol,
  type DeliveryLinePayload,
} from "./delivery-line-protocol";
import { rubricOutcome, type RubricAssessmentDraft, type RubricCriterion } from "./rubric-assessment";
import type { RubricVerdict } from "./rubric-line-protocol";
import {
  indexCriteriaByScope,
  listRubricAssessmentsForScope,
  selectLatestAssessmentBatch,
} from "./rubric-service";
import { TIER1_CRITERION_KEYS, tier1CriteriaForScope } from "./rubric-tiers";

/**
 * The Done stage (design §3): the change's delivery note.
 *
 * `Done` used to be a UI label with no stage, no prompt and no rubric behind it
 * -- Retro finished and the change was terminal, and nothing in the repo ever
 * produced "how do I use this". This is the stage that does.
 *
 * Shaped like pipeline-release-retro-stage-service: one runDocumentStage call,
 * one .md artifact. It differs from every other document stage in one respect,
 * and that difference is the point: part of its artifact is not written by the
 * model at all. See delivery-known-limits-service for why.
 */

export const DELIVERY_ARTIFACT_FILE_NAME = "delivery.md";

/**
 * Second gate over the payload the line protocol assembles. Required, not
 * optional: `runDocumentStage` gates its whole ingest/validate/raw-capture block
 * on `if (config.outputSchema)`, so a `lineProtocol` without a schema parses
 * nothing, captures no raw output, and lets model-authored JSON through --
 * a silently inert stage.
 */
export const DELIVERY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["markdown", "howToRun", "whatChanged", "fileMap", "knownLimitsNarrative"],
  additionalProperties: true,
  properties: {
    // The runner writes .md artifacts from `structuredOutput.markdown`
    // (markdownArtifactContentFromResult); any other key silently degrades to
    // the raw reply.
    markdown: { type: "string", minLength: 1 },
    howToRun: { type: "string", minLength: 1 },
    whatChanged: { type: "string", minLength: 1 },
    knownLimitsNarrative: { type: "string", minLength: 1 },
    fileMap: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["path", "role", "purpose"],
        additionalProperties: true,
        properties: {
          path: { type: "string", minLength: 1 },
          role: { type: "string", minLength: 1 },
          purpose: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

const ROLE_LABELS: Record<string, string> = {
  entry: "入口",
  internal: "内部实现",
  test: "测试",
  doc: "文档",
  config: "配置",
};

/**
 * Assembles the delivery note.
 *
 * Sections 1-3 and 4.2 are the model's; section 4.1 is `knownLimitsMarkdown`,
 * which the caller read out of the database. Splicing here rather than inside
 * the parser keeps delivery-line-protocol.ts DB-free (the same split
 * rubric-assessment.ts keeps from its persistence layer) and keeps the
 * substitution visible at one call site.
 *
 * If someone ever "simplifies" this by using `payload.knownLimitsNarrative` for
 * section 4.1, the delivery note goes back to being the model's account of its
 * own omissions. pipeline-delivery-stage-service.test.ts pins it.
 */
export function composeDeliveryMarkdown(input: {
  changeId: string;
  changeTitle: string | null;
  payload: DeliveryLinePayload;
  knownLimitsMarkdown: string;
}): string {
  const fileMapRows = input.payload.fileMap.map((entry) =>
    `| \`${entry.path}\` | ${ROLE_LABELS[entry.role] ?? entry.role} | ${entry.purpose} |`);

  return [
    `# 交付单 · ${input.changeId}`,
    "",
    input.changeTitle ? `**本次改动**：${input.changeTitle}` : "**本次改动**：（无标题）",
    "",
    "## 1. 怎么跑起来",
    "",
    input.payload.howToRun,
    "",
    "## 2. 本次改动带来了什么",
    "",
    input.payload.whatChanged,
    "",
    "## 3. 文件地图",
    "",
    "| 文件 | 角色 | 作用 |",
    "| --- | --- | --- |",
    ...fileMapRows,
    "",
    "## 4. 已知限制与没做的事",
    "",
    input.knownLimitsMarkdown,
    "",
    "### 4.2 明确不做的与踩到的坑",
    "",
    input.payload.knownLimitsNarrative,
    "",
  ].join("\n");
}

export interface DeliveryStageResult {
  result: AiRunResult;
  knownLimits: DeliveryKnownLimitsFacts;
}

/**
 * One Done producer verdict as this run's own batch judged it, keyed by
 * `criterionKey` (identity across rubric versions, §5.1).
 */
export interface DeliveryTier1JudgedCriterion {
  criterionKey: string;
  text: string;
  /** `blocking` as stored in the version that was judged. */
  blocking: boolean;
  verdict: RubricVerdict;
  evidence: string | null;
}

export interface DeliveryTier1Violation {
  criterionKey: string;
  text: string;
  /**
   * `missing` means this run's batch holds NO row for a tier-1 criterion at
   * all -- the run never resolved a Done producer rubric, or its harvest never
   * landed. Distinct from `not_assessed`, which is a recorded refusal.
   */
  verdict: RubricVerdict | "missing";
  evidence: string | null;
}

/**
 * The Done completion gate, tier-1 only (user decision 2026-07-21).
 *
 * Done's blocking CHANNEL stays "none" (rubric-gate-adapters.ts, the 2.9
 * conclusion): a tier-2/3 Done criterion answered `no` is recorded and shown
 * and stops nothing, because a rubric-derived P0 on a terminal phase would
 * strand the change with no exit a human is allowed to take. Tier-1 is the
 * deliberate exception -- §2.1's 恒阻断 with NO human exit. The user chose
 * deadlock over an escape hatch, twice, with the counter-evidence on the
 * table: the only way past a tier-1 `no` here is re-running delivery and
 * being judged `yes`. Do not add a waiver, an override, or a channel.
 *
 * Semantics are deliberately not re-implemented: `rubricOutcome` decides what
 * blocks (`no`, and `not_assessed` on a blocking criterion), and the gate
 * merely intersects its `blockingCriterionIds` with `TIER1_CRITERION_KEYS`.
 * The one correction applied first is the same one
 * `blockingCriterionKeysInForce` documents: a tier-1 row written before the
 * tier existed may still carry `blocking = 0`, and reading that stale flag
 * would give 恒阻断 a silent opt-out, so tier-1 membership coerces the flag.
 *
 * Fails closed on ABSENCE: a tier-1 criterion with no row in this run's batch
 * is a violation (`missing`), because "no rows" is indistinguishable from
 * "this phase has no rubric", which reads as a pass -- the exact silent
 * fail-open this whole mechanism exists to prevent, and the same rule the
 * recovery path applies (recovery-business-evidence.ts, delivery branch).
 *
 * Pure over an already-selected batch so the live gate and the recovery path
 * share one definition instead of two that drift.
 */
export function deliveryTier1Violations(
  judged: readonly DeliveryTier1JudgedCriterion[],
): DeliveryTier1Violation[] {
  const expected = tier1CriteriaForScope("Done", "producer");
  if (expected.length === 0) return [];

  const byKey = new Map(judged.map((entry) => [entry.criterionKey, entry]));
  const criteria: RubricCriterion[] = judged.map((entry, ordinal) => ({
    id: entry.criterionKey,
    criterionKey: entry.criterionKey,
    ordinal,
    text: entry.text,
    blocking: entry.blocking || TIER1_CRITERION_KEYS.has(entry.criterionKey),
  }));
  const drafts: RubricAssessmentDraft[] = judged.map((entry) => ({
    criterionId: entry.criterionKey,
    verdict: entry.verdict,
    evidence: entry.evidence,
  }));
  const blocked = new Set(rubricOutcome(criteria, drafts).blockingCriterionIds);

  const violations: DeliveryTier1Violation[] = [];
  for (const criterion of expected) {
    const entry = byKey.get(criterion.criterionKey);
    if (!entry) {
      violations.push({
        criterionKey: criterion.criterionKey,
        text: criterion.text,
        verdict: "missing",
        evidence: null,
      });
    } else if (blocked.has(criterion.criterionKey)) {
      violations.push({
        criterionKey: entry.criterionKey,
        text: entry.text,
        verdict: entry.verdict,
        evidence: entry.evidence,
      });
    }
  }
  return violations;
}

/**
 * This run's OWN Done producer batch, resolved to criterion keys.
 *
 * Filtered on `rubric_assessments.run_id` BEFORE the batch selection, so the
 * gate can never inherit another run's verdicts -- the same inheritance bug
 * the build-run time-window check (2.7) exists to prevent, replayed on
 * rubric rows instead of build rows. `selectLatestAssessmentBatch` still does
 * the batch arithmetic (round/run semantics stay defined in one place); the
 * run filter only narrows WHOSE rows it may pick from.
 */
function judgedDoneProducerRubricForRun(input: {
  projectId: string;
  changeId: string;
  runId: string;
}): DeliveryTier1JudgedCriterion[] {
  const scope = {
    projectId: input.projectId,
    changeId: input.changeId,
    phase: "Done" as const,
    role: "producer" as const,
  };
  const ownRows = listRubricAssessmentsForScope(scope)
    .filter((row) => row.runId === input.runId);
  const batch = selectLatestAssessmentBatch(ownRows, { roundId: null });
  if (batch.length === 0) return [];

  const criteriaById = indexCriteriaByScope(scope);
  return batch.flatMap((row) => {
    const resolved = criteriaById.get(row.criterionId);
    // An unattributable verdict names no standard; dropping it can only make
    // the tier-1 key read as `missing`, which blocks -- the safe direction.
    if (!resolved) return [];
    return [{
      criterionKey: resolved.criterion.criterionKey,
      text: resolved.criterion.text,
      blocking: resolved.criterion.blocking,
      verdict: row.verdict,
      evidence: row.evidence,
    }];
  });
}

/**
 * Throws when this run's tier-1 verdicts do not clear the gate, which lands
 * as the stage's ordinary failure shape: runStageWithLedger fails the run
 * with this message as its summary and rolls the change to `failureStatus`.
 * For delivery failureStatus == the entry status (DELIVERY_PENDING, the 2.8
 * semantics), so `run_delivery` stays clickable and the loop -- fix, re-run,
 * be judged yes -- is always available. The event below is the greppable
 * record of WHICH criterion held the change and what the verdict was.
 *
 * Thrown from `afterSuccessfulResult`, i.e. after the rubric harvest and
 * schema validation but BEFORE the artifact write: a blocked run hands over
 * no delivery.md and registers no artifact row, so recovery cannot mistake
 * it for a completed delivery either.
 */
function assertDeliveryTier1Gate(input: {
  projectId: string;
  changeId: string;
  runId: string;
}): void {
  const violations = deliveryTier1Violations(judgedDoneProducerRubricForRun(input));
  if (violations.length === 0) return;

  const detail = violations
    .map((violation) => `${violation.criterionKey} 判定为 ${violation.verdict}（${violation.text}）`)
    .join("；");
  const message = `Done 一级评判标准未放行，change 停在 DELIVERY_PENDING：${detail}。`
    + "一级条款无人工出口：重跑 delivery 并让该标准被判 yes 后才落 DONE。";
  try {
    emitIdempotentEvent({
      id: `EVT-delivery-tier1-${createHash("sha256").update(input.runId).digest("hex")}`,
      changeId: input.changeId,
      runId: input.runId,
      type: "delivery_tier1_blocked",
      message,
      rawJson: {
        deliveryTier1Blocked: {
          schemaVersion: "delivery_tier1_block/v1",
          runId: input.runId,
          violations,
        },
      },
    });
  } catch {
    // Diagnostic only: the failed run's summary carries the same facts.
  }
  throw new Error(message);
}

export async function runDelivery(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);

  // Read once, before the run, and use the same snapshot for the artifact. The
  // stage's sandbox is read-only and it writes no DB rows, so nothing it does
  // can move these facts under it.
  const knownLimits = buildDeliveryKnownLimits(changeId);

  return runDocumentStage(changeId, {
    phase: "delivery",
    promptPhase: "delivery",
    allowedStatuses: ["DELIVERY_PENDING"],
    // Delivery, like retro, has no earlier status to fall back to: Retro is
    // already finished and its status was consumed. So running status ==
    // failure status == the entry status, and recoverStrandedRunningStatus
    // correctly declines to "recover" it (no_rollback_target) -- a failed
    // delivery simply stays clickable.
    runningStatus: "DELIVERY_PENDING",
    successStatus: "DONE",
    failureStatus: "DELIVERY_PENDING",
    artifactType: "delivery",
    artifactFileName: DELIVERY_ARTIFACT_FILE_NAME,
    successSummary: "Delivery note completed",
    provider,
    sessionKind: "general",
    // §3.4: delivery is Done's producer, and the phase has no critic. Done owns
    // no `stage_gates` row, so tier-2/3 verdicts are recorded and displayed but
    // cannot block -- the same shape as Retro (see RUBRIC_ROLE_ANSWERED_BY).
    // Tier-1 is the exception, enforced by afterSuccessfulResult below rather
    // than by a blocking channel: see deliveryTier1Violations.
    rubricPhase: "Done",
    // The tier-1 completion gate. Runs after the rubric harvest has stored
    // this run's verdicts and throws on a violation, so the run fails, no
    // artifact is written, and the change never transitions to DONE.
    afterSuccessfulResult: async ({ runId }) => {
      assertDeliveryTier1Gate({ projectId: change.projectId, changeId, runId });
    },
    resumeThread: false,
    outputSchema: DELIVERY_OUTPUT_SCHEMA,
    // The model writes protocol lines, never JSON; the schema above is the
    // second gate over the deterministically assembled payload. Setting either
    // one alone is not enough -- see DELIVERY_OUTPUT_SCHEMA.
    lineProtocol: {
      // The Done rubric's harvest runs first, over the whole reply, through the
      // same structural check. Without these names it rejects this stage's own
      // blocks as off-script and every run fails before the parser below sees
      // the text.
      blockNames: DELIVERY_BLOCK_NAMES,
      parse: (rawText) => {
        const parsed = parseDeliveryLineProtocol(rawText);
        if (!parsed.ok) return parsed;
        return {
          ok: true,
          payload: {
            ...parsed.payload,
            markdown: composeDeliveryMarkdown({
              changeId,
              changeTitle: change.title ?? null,
              payload: parsed.payload,
              knownLimitsMarkdown: knownLimits.markdown,
            }),
          } as unknown as Record<string, unknown>,
        };
      },
    },
  });
}
