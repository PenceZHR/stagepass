import { eq } from "drizzle-orm";
import { db } from "../db";
import { changes } from "../db/schema";
import type { Change } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
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
    // no `stage_gates` row, so its verdicts are recorded and displayed but
    // cannot block -- the same shape as Retro (see RUBRIC_ROLE_ANSWERED_BY).
    rubricPhase: "Done",
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
