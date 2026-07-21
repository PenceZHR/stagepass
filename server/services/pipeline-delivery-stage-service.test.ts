import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  artifactMirrors,
  artifacts,
  changeProviderSessions,
  changes,
  events,
  findings,
  humanDecisions,
  pipelineJobs,
  projects,
  providerRunProcesses,
  releaseNoteState,
  requirementGaps,
  rubricAssessments,
  rubricCriteria,
  rubrics,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema.ts";
import type { ChangeStatus } from "../types/enums.ts";
import type { JobExecutionContext } from "./job-execution-context.ts";
import { runDelivery, runRetro, setPipelineEngineFactoryForTest } from "./pipeline-service.ts";
import { computeActions } from "./action-contract-service.ts";
import { ALLOWED_TRANSITIONS, RUNNING_CHANGE_STATUSES } from "../state-machine/transitions.ts";
import { DELIVERY_KNOWN_LIMITS_PROVENANCE } from "./delivery-known-limits-service.ts";
import { ensureFactoryRubrics, getCurrentRubric, saveRubricVersion } from "./rubric-service.ts";
import { TIER1_CRITERION_KEYS } from "./rubric-tiers.ts";

const PROJECT_ID = "PRJ-DELIVERY";
const CHANGE_ID = "CHG-DELIVERY";
/** The 「为什么放行」 of a waived P1 -- the one fact section 4.1 exists to keep. */
const WAIVER_REASON = "本轮先发，下一轮补测试";

let repoPath = "";
let contextSequence = 0;

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * A delivery reply in line-protocol form. Mocked engines speak protocol lines in
 * `summary`; model-authored structuredOutput is not accepted anywhere.
 */
function deliveryLineProtocolText(overrides: {
  knownLimits?: string;
  extraLines?: string[];
} = {}): string {
  return [
    "我读了仓库，下面是交付单。",
    "HOW_TO_RUN<<",
    "在仓库根目录执行 `npm run dev`，然后打开 http://localhost:3000。",
    "启动成功后首页顶部应显示流水线阶段条。",
    ">>HOW_TO_RUN",
    "WHAT_CHANGED<<",
    "新增了 Done 交付阶段：Retro 跑完后会多出一个「生成交付单」按钮。",
    "验证方式：把一个 change 跑到 Retro 之后，确认阶段条上出现 Done。",
    ">>WHAT_CHANGED",
    "FILEMAP: server/services/pipeline-delivery-stage-service.ts | entry | 交付阶段入口",
    "FILEMAP: server/services/delivery-line-protocol.ts | internal | 交付单的行协议解析器",
    ...(overrides.extraLines ?? []),
    "KNOWN_LIMITS<<",
    overrides.knownLimits ?? "本次不做交付单的历史对比视图。",
    ">>KNOWN_LIMITS",
    "DELIVERY_DONE: true",
  ].join("\n");
}

/**
 * A lazy summary is evaluated INSIDE engine.run, i.e. after runDocumentStage
 * has already resolved (and, on first contact, seeded) the Done producer
 * rubric -- which is what lets a stubbed reply answer RUBRIC lines against
 * criterion ids that only exist once the run is underway.
 */
function stubEngine(summary: string | (() => string), success = true): void {
  setPipelineEngineFactoryForTest(() => ({
    async run(input) {
      return {
        threadId: `${input.changeId}-thread`,
        runId: "ENGINE-RUN",
        summary: typeof summary === "function" ? summary() : summary,
        success,
        changedFiles: [],
        structuredOutput: undefined,
        items: [],
      };
    },
    async *runStreamed() {},
  }));
}

/** §3.4's tier-1 clause: the one Done criterion allowed to hold completion. */
const TIER1_DONE_KEY = "RBK-factory-Done-producer-01";

function doneProducerCriteria() {
  // Idempotent: inside a run this has already happened via resolveStageRubric.
  ensureFactoryRubrics(PROJECT_ID);
  const rubric = getCurrentRubric({
    projectId: PROJECT_ID,
    changeId: null,
    phase: "Done",
    role: "producer",
  });
  assert.ok(rubric, "the Done producer rubric must exist before it can be answered");
  return rubric.criteria;
}

/**
 * RUBRIC answer lines for the CURRENT Done producer rubric. `null` from
 * `verdictFor` skips the line, which the harvest records as `not_assessed`.
 */
function doneRubricAnswers(
  verdictFor: (criterion: { criterionKey: string }) => "yes" | "no" | null = () => "yes",
): string[] {
  return doneProducerCriteria().flatMap((criterion) => {
    const verdict = verdictFor(criterion);
    if (!verdict) return [];
    return [`RUBRIC: ${criterion.id} | ${verdict} | 我在当前仓库状态下逐条核对过这一项`];
  });
}

/**
 * The fixture most cases want: a protocol-complete delivery reply whose Done
 * producer rubric is answered (all `yes` unless overridden), because with the
 * tier-1 completion gate a reply that stays silent on the rubric can no longer
 * reach DONE. Rubric lines go last, outside every block, exactly where the
 * prompts place them.
 */
function deliveryReplyWithRubric(
  overrides: Parameters<typeof deliveryLineProtocolText>[0] = {},
  verdictFor?: (criterion: { criterionKey: string }) => "yes" | "no" | null,
): () => string {
  return () => [deliveryLineProtocolText(overrides), ...doneRubricAnswers(verdictFor)].join("\n");
}

function makeContext(label: string, phase: string, actionId: string): JobExecutionContext {
  contextSequence += 1;
  const key = `${label}-${contextSequence}`;
  const context = {
    jobId: `PJOB-${key}`,
    workerId: `worker-${key}`,
    leaseToken: `lease-${key}`,
    attemptNo: 1,
  };
  db.insert(pipelineJobs).values({
    id: context.jobId,
    changeId: CHANGE_ID,
    phase,
    actionId,
    idempotencyKey: context.jobId,
    status: "running",
    leasedBy: context.workerId,
    leaseExpiresAt: "2099-07-10T10:30:00.000Z",
    heartbeatAt: nowISO(),
    attemptNo: context.attemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: nowISO(),
    startedAt: nowISO(),
    endedAt: null,
    leaseToken: context.leaseToken,
    workerNonce: `nonce-${key}`,
  }).run();
  return context;
}

function seedChange(status: ChangeStatus): void {
  const now = nowISO();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Delivery stage fixture",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "把 Done 变成真实交付阶段",
    status,
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: null,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
  fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID), { recursive: true });
}

/** The facts resolveRetroActionAuthority demands before runRetro may start. */
function seedRetroReleaseAuthority(): void {
  const now = nowISO();
  const releaseRunId = "RUN-DELIVERY-RELEASE";
  db.insert(stageGates).values({
    id: "GATE-DELIVERY-MERGE",
    changeId: CHANGE_ID,
    phase: "Merge",
    status: "passed",
    blockersJson: "[]",
    freshnessJson: "{\"fresh\":true}",
    requiredActionsJson: "[]",
    sourceDbHash: "delivery-merge-source-hash",
    gateVersion: 1,
    computedAt: now,
  }).run();
  db.insert(runs).values({
    id: releaseRunId,
    changeId: CHANGE_ID,
    phase: "release",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "release completed for retro authority",
  }).run();
  const changeDir = path.join(path.resolve(repoPath), ".ship", "changes", CHANGE_ID);
  const runDir = path.join(changeDir, "runs", releaseRunId);
  fs.mkdirSync(runDir, { recursive: true });
  const releaseNote = "# Release note\n\nDelivery fixture.\n";
  const runNotePath = path.join(runDir, "release-note.md");
  fs.writeFileSync(runNotePath, releaseNote);
  fs.writeFileSync(path.join(changeDir, "release-note.md"), releaseNote);
  db.insert(artifacts).values({
    id: "ART-DELIVERY-RELEASE-NOTE",
    changeId: CHANGE_ID,
    runId: releaseRunId,
    type: "release_note",
    path: runNotePath,
    createdAt: now,
  }).run();
  db.insert(releaseNoteState).values({
    id: "RNS-DELIVERY-RELEASE-NOTE",
    changeId: CHANGE_ID,
    runId: releaseRunId,
    artifactId: "ART-DELIVERY-RELEASE-NOTE",
    approvedContentHash: createHash("sha256").update(releaseNote).digest("hex"),
    createdAt: now,
  }).run();
}

function seedOpenGap(input: {
  canonicalGapId: string;
  title: string;
  status?: string;
  severity?: string;
}): void {
  const now = nowISO();
  db.insert(requirementGaps).values({
    id: `GAP-${input.canonicalGapId}`,
    changeId: CHANGE_ID,
    canonicalGapId: input.canonicalGapId,
    firstSeenRoundId: "ROUND-1",
    lastEvaluatedRoundId: "ROUND-1",
    resolvedByRoundId: null,
    sourcePhase: "Spec",
    sourceUnit: "REQUIREMENT_CRITIC",
    title: input.title,
    category: "missing_requirement",
    evidence: "fixture evidence",
    affectedArtifactsJson: "[]",
    proposedSpecPatch: null,
    severity: input.severity ?? "P1",
    originalSeverity: input.severity ?? "P1",
    downgradedTo: null,
    status: input.status ?? "open",
    resolutionEvidence: null,
    waiverReason: input.status === "waived" ? "用户接受该风险" : null,
    downgradeReason: null,
    overrideReason: null,
    specBlocking: 0,
    mergeBlocking: 0,
    sourceHashesJson: "{}",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  }).run();
}

function readDeliveryNote(): string {
  return fs.readFileSync(
    path.join(repoPath, ".ship", "changes", CHANGE_ID, "delivery.md"),
    "utf-8",
  );
}

function currentStatus(): ChangeStatus {
  const row = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
  assert.ok(row);
  return row.status as ChangeStatus;
}

/** Children before parents: every table here has an FK into a later one. */
function cleanupRows(): void {
  db.delete(rubricAssessments).run();
  db.delete(rubricCriteria).run();
  db.delete(rubrics).run();
  db.delete(releaseNoteState).run();
  db.delete(artifactMirrors).run();
  db.delete(artifacts).run();
  db.delete(findings).run();
  db.delete(humanDecisions).run();
  db.delete(requirementGaps).run();
  db.delete(events).run();
  db.delete(stageGates).run();
  db.delete(stageActions).run();
  db.delete(stageRuns).run();
  db.delete(stageReports).run();
  db.delete(stageStates).run();
  db.delete(changeProviderSessions).run();
  db.delete(providerRunProcesses).run();
  db.delete(runs).run();
  db.delete(pipelineJobs).run();
  db.delete(changes).run();
  db.delete(projects).run();
}

describe("Done delivery stage", () => {
  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-stage-"));
  });

  afterEach(() => {
    setPipelineEngineFactoryForTest(null);
    cleanupRows();
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  // Done was a UI label; the pipeline ended at Retro and nothing produced "how
  // do I use this". Retro must now hand over rather than declare the change
  // finished, or the delivery stage has no status to run from.
  it("lands Retro on DELIVERY_PENDING instead of DONE", async () => {
    seedChange("RETRO_PENDING");
    seedRetroReleaseAuthority();
    stubEngine("# Retro\n\n本次没有返工。\n");

    await runRetro(CHANGE_ID, makeContext("retro", "retro", "run_retro"));

    assert.equal(currentStatus(), "DELIVERY_PENDING");
  });

  it("pins the state machine around the new status", () => {
    assert.deepEqual(
      [...(ALLOWED_TRANSITIONS.get("RETRO_PENDING") ?? [])].sort(),
      ["BLOCKED", "DELIVERY_PENDING"],
      "Retro may no longer jump straight to DONE",
    );
    assert.deepEqual(
      [...(ALLOWED_TRANSITIONS.get("DELIVERY_PENDING") ?? [])].sort(),
      ["BLOCKED", "DONE"],
    );
    assert.ok(
      ALLOWED_TRANSITIONS.get("BLOCKED")?.has("DELIVERY_PENDING"),
      "a change blocked during delivery must be recoverable back to DELIVERY_PENDING",
    );
    // DELIVERY_PENDING is a waiting status, exactly like RETRO_PENDING is meant
    // to be: nothing is running, a human has to press the button. Adding it to
    // the running set would lock every sibling change in the project until
    // somebody reads the delivery note.
    assert.equal(RUNNING_CHANGE_STATUSES.has("DELIVERY_PENDING"), false);
  });

  it("writes a delivery note with all four sections and reaches DONE", async () => {
    seedChange("DELIVERY_PENDING");
    stubEngine(deliveryReplyWithRubric());

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    assert.equal(currentStatus(), "DONE");
    const note = readDeliveryNote();
    assert.match(note, /## 1\. 怎么跑起来/);
    assert.match(note, /## 2\. 本次改动带来了什么/);
    assert.match(note, /## 3\. 文件地图/);
    assert.match(note, /## 4\. 已知限制与没做的事/);
    assert.match(note, /npm run dev/);
    assert.match(note, /pipeline-delivery-stage-service\.ts/);
    assert.match(note, /本次不做交付单的历史对比视图/);
    // The artifact must come from structuredOutput.markdown, not the raw reply:
    // markdownArtifactContentFromResult only reads the `markdown` key and
    // silently falls back to the raw text otherwise.
    assert.doesNotMatch(note, /DELIVERY_DONE: true/);
    assert.doesNotMatch(note, /HOW_TO_RUN<</);
  });

  it("registers delivery.md as the stage's artifact", async () => {
    seedChange("DELIVERY_PENDING");
    stubEngine(deliveryReplyWithRubric());

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    const rows = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all()
      .filter((artifact) => artifact.type === "delivery");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.path, /delivery\.md$/);
  });

  // The point of the whole stage. §4.1 is generated from the database, so an
  // open gap appears whether or not the model mentions it -- and a model that
  // claims there are none does not get to erase it.
  it("fills section 4 from the database, not from the model's account of itself", async () => {
    seedChange("DELIVERY_PENDING");
    seedOpenGap({
      canonicalGapId: "GAP-OPEN-A",
      title: "导出功能没有覆盖失败路径",
    });
    seedOpenGap({
      canonicalGapId: "GAP-WAIVED-B",
      title: "批量导入的并发上限未定义",
      status: "waived",
    });
    const now = nowISO();
    // Shaped exactly like review-waiver-service.ts writes a P1 waiver: gate is
    // lowercase "review", the action literal is "review_p1_waiver" (NOT the
    // spec-battle "waive_p1"), and the finding points back at the decision
    // through waiver_decision_id -- findings has no reason column, so that FK is
    // the only route from a waived P1 to the reason it was let through. The
    // decision row goes in first because foreign_keys is ON (server/db/index.ts).
    db.insert(humanDecisions).values({
      id: "HD-001",
      changeId: CHANGE_ID,
      roundId: null,
      gate: "review",
      action: "review_p1_waiver",
      targetType: "finding",
      targetId: "FND-WAIVED-P1",
      reason: WAIVER_REASON,
      reportHash: "a".repeat(64),
      createdBy: "human",
      createdAt: now,
    }).run();
    db.insert(findings).values({
      id: "FND-WAIVED-P1",
      changeId: CHANGE_ID,
      runId: null,
      roundId: null,
      phase: "Review",
      source: "review",
      severity: "P1",
      category: "correctness",
      title: "重试次数上限没有测试覆盖",
      file: "server/services/retry.ts",
      line: 42,
      evidence: "fixture evidence",
      requiredFix: "add a test",
      status: "waived",
      createdAt: now,
      updatedAt: now,
      waivable: 1,
      waivedBy: "human",
      waivedAt: now,
      waiverDecisionId: "HD-001",
      findingVersion: 2,
    }).run();

    stubEngine(deliveryReplyWithRubric({
      knownLimits: "本次没有任何未关闭的 gap，也没有被豁免的 P1。",
    }));

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    const note = readDeliveryNote();
    assert.match(note, new RegExp(DELIVERY_KNOWN_LIMITS_PROVENANCE.slice(0, 20)));
    assert.match(note, /GAP-OPEN-A/, "the open gap must appear even though the model never mentioned it");
    assert.match(note, /导出功能没有覆盖失败路径/);
    assert.match(note, /GAP-WAIVED-B/);
    assert.match(note, /FND-WAIVED-P1/, "the waived P1 finding must appear");
    assert.match(note, /重试次数上限没有测试覆盖/);
    // The model's contradicting claim is still printed -- in its own subsection,
    // clearly downstream of the facts, so a reader can see the disagreement.
    assert.match(note, /### 4\.2 明确不做的与踩到的坑/);
    const dbSection = note.slice(note.indexOf("### 4.1"), note.indexOf("### 4.2"));
    assert.doesNotMatch(
      dbSection,
      /本次没有任何未关闭的 gap/,
      "the model's self-report must never be the source of section 4.1",
    );
    assert.match(dbSection, /review_p1_waiver/, "the human decision ledger must appear");
    assert.match(
      dbSection,
      new RegExp(WAIVER_REASON),
      "the reason a blocking P1 was let through must survive into the note",
    );
    // The failure this section is built to prevent: the DB holds a waiver and
    // the note says there were none. Wrong is worse than silent here, because
    // 4.1 opens by claiming it came straight from the database.
    assert.doesNotMatch(
      dbSection,
      /没有豁免或打回类的人工决定记录/,
      "a waived P1 in the DB must never be reported as no human decisions at all",
    );
  });

  // The vocabulary is an allowlist, so the failure mode is silent: a waiver
  // action missing from it does not error, it makes 4.1 assert there were none.
  // This pins the partition so adding a literal forces a deliberate choice.
  it("reports waivers and send-backs, and stays quiet about routine approvals", async () => {
    seedChange("DELIVERY_PENDING");
    const now = nowISO();
    const decisions: Array<{ action: string; gate: string; reason: string }> = [
      { action: "review_p1_waiver", gate: "review", reason: "REASON-REVIEW-P1-WAIVER" },
      { action: "waive_p1", gate: "spec", reason: "REASON-WAIVE-P1" },
      { action: "request_changes", gate: "spec", reason: "REASON-REQUEST-CHANGES" },
      { action: "return_to_spec", gate: "spec", reason: "REASON-RETURN-TO-SPEC" },
      { action: "approve", gate: "spec", reason: "REASON-APPROVE" },
      { action: "approve_plan", gate: "Plan", reason: "REASON-APPROVE-PLAN" },
      { action: "approve_merge", gate: "merge", reason: "REASON-APPROVE-MERGE" },
    ];
    decisions.forEach((decision, index) => {
      db.insert(humanDecisions).values({
        id: `HD-${String(index + 1).padStart(3, "0")}`,
        changeId: CHANGE_ID,
        roundId: null,
        gate: decision.gate,
        action: decision.action,
        targetType: null,
        targetId: null,
        reason: decision.reason,
        reportHash: null,
        createdBy: "human",
        createdAt: now,
      }).run();
    });
    stubEngine(deliveryReplyWithRubric());

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    const note = readDeliveryNote();
    const dbSection = note.slice(note.indexOf("### 4.1"), note.indexOf("### 4.2"));
    for (const action of ["review_p1_waiver", "waive_p1", "request_changes", "return_to_spec"]) {
      assert.match(dbSection, new RegExp(action), `${action} lets something through or sends it back`);
    }
    for (const action of ["approve", "approve_plan", "approve_merge"]) {
      assert.doesNotMatch(
        dbSection,
        new RegExp(`· ${action}（`),
        `${action} is a routine approval and would bury the exceptional decisions`,
      );
    }
  });

  it("says so explicitly when the database has nothing open", async () => {
    seedChange("DELIVERY_PENDING");
    stubEngine(deliveryReplyWithRubric());

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    const note = readDeliveryNote();
    // Absence of a bullet and "there were none" must not look the same.
    assert.match(note, /没有未关闭的需求 gap/);
    assert.match(note, /没有被豁免的 P0\/P1 finding/);
  });

  it("refuses an empty reply instead of finishing the stage on silence", async () => {
    seedChange("DELIVERY_PENDING");
    stubEngine("");

    await assert.rejects(
      () => runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery")),
      /empty|structuredOutput|invalid/i,
    );
    assert.equal(currentStatus(), "DELIVERY_PENDING");
    assert.equal(
      fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "delivery.md")),
      false,
    );
  });

  it("refuses a reply that violates the line protocol", async () => {
    seedChange("DELIVERY_PENDING");
    // Truncated after the file map: structurally complete-looking, no marker.
    stubEngine(deliveryLineProtocolText().split("KNOWN_LIMITS<<")[0]!);

    await assert.rejects(
      () => runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery")),
    );
    assert.equal(currentStatus(), "DELIVERY_PENDING");
    assert.equal(
      fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "delivery.md")),
      false,
    );
  });

  // A stage the backend can run and the interface never offers is the failure
  // mode this repo keeps paying for (a9a953f2's phantom-button shape, in
  // reverse). Both directions are pinned: offered exactly where runDelivery's
  // own assertStatus would accept it, and nowhere else.
  it("offers run_delivery once Retro has finished, and not before", async () => {
    seedChange("RETRO_PENDING");
    seedRetroReleaseAuthority();
    stubEngine("# Retro\n\n本次没有返工。\n");

    const beforeRetro = computeActions(CHANGE_ID)
      .find((action) => action.actionId === "run_delivery");
    assert.ok(beforeRetro, "run_delivery must be in the action contract at every status");
    assert.equal(beforeRetro.enabled, false, "delivery must not be clickable before Retro finishes");

    await runRetro(CHANGE_ID, makeContext("retro", "retro", "run_retro"));
    assert.equal(currentStatus(), "DELIVERY_PENDING");

    const afterRetro = computeActions(CHANGE_ID)
      .find((action) => action.actionId === "run_delivery");
    assert.ok(afterRetro);
    assert.equal(afterRetro.enabled, true, afterRetro.reasonCode ?? "");
    assert.ok(afterRetro.sourceDbHash, "the dispatch fence needs a source hash");
  });

  it("records a Done producer rubric verdict for the run", async () => {
    seedChange("DELIVERY_PENDING");
    stubEngine(deliveryReplyWithRubric());

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    const doneRubric = db.select().from(rubrics).all()
      .find((rubric) => rubric.phase === "Done" && rubric.role === "producer");
    assert.ok(doneRubric, "the Done producer rubric must be seeded and resolved for this stage");
    const criteria = db.select().from(rubricCriteria)
      .where(eq(rubricCriteria.rubricId, doneRubric.id)).all();
    assert.ok(criteria.length >= 5 && criteria.length <= 12, `expected 5-12 criteria, got ${criteria.length}`);
    // This assertion used to read "every factory Done criterion ships
    // non-blocking" and pinned §4.5's advisory-on-arrival rule. That rule now
    // has exactly one deliberate exception (user decision 2026-07-21): the
    // tier-1 clause is 恒阻断 and seeds with the flag already set, because a
    // tier the user cannot opt out of must not depend on somebody ticking a
    // box. Every OTHER factory Done criterion still ships advisory, and that
    // half of the old pin is kept, so widening the seed beyond tier-1 fails
    // here.
    for (const criterion of criteria) {
      assert.equal(
        criterion.blocking,
        TIER1_CRITERION_KEYS.has(criterion.criterionKey) ? 1 : 0,
        `${criterion.criterionKey}: only the tier-1 clause may seed as blocking`,
      );
    }
    assert.ok(
      criteria.some((criterion) => criterion.criterionKey === TIER1_DONE_KEY),
      "the §3.4 tier-1 clause must be part of the seeded Done producer rubric",
    );
    const assessed = db.select().from(rubricAssessments).all()
      .filter((assessment) => criteria.some((criterion) => criterion.id === assessment.criterionId));
    assert.equal(
      assessed.length,
      criteria.length,
      "every criterion must get a verdict row for the run",
    );
  });

  // The tier-1 completion gate (§2.2 + §3.4). Both failure verdicts are
  // exercised: an explicit `no` here, and silence (`not_assessed`) in the
  // next case. And the loop out of the deadlock is proven in the same test:
  // re-run delivery, answer `yes`, reach DONE. There is deliberately no
  // human exit to test -- the user chose deadlock over an escape hatch.
  it("holds the change at DELIVERY_PENDING on a tier-1 `no`, and a yes re-run releases it", async () => {
    seedChange("DELIVERY_PENDING");
    // run_delivery's dispatch authority: retro finished (the retroDone flag
    // plus exactly one completed retro run). Seeded so the 保持可点 assertion
    // below observes the gate's own effect, not a missing-retro blocker.
    db.update(changes).set({ retroDone: 1 }).where(eq(changes.id, CHANGE_ID)).run();
    db.insert(runs).values({
      id: "RUN-DELIVERY-RETRO-AUTHORITY",
      changeId: CHANGE_ID,
      phase: "retro",
      status: "completed",
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T00:01:00.000Z",
      summary: "retro completed",
    }).run();
    stubEngine(deliveryReplyWithRubric({}, (criterion) =>
      criterion.criterionKey === TIER1_DONE_KEY ? "no" : "yes"));

    const blockedContext = makeContext("delivery", "delivery", "run_delivery");
    await assert.rejects(
      () => runDelivery(CHANGE_ID, blockedContext),
      new RegExp(TIER1_DONE_KEY),
      "the failure must name the tier-1 criterion that held the change",
    );
    // What the job runner does when the stage throws; the fixture's job row
    // must not keep claiming to run, or the action contract reports
    // provider_job_running instead of the state under test.
    db.update(pipelineJobs)
      .set({ status: "failed", endedAt: nowISO(), errorCode: "pipeline_job_failed" })
      .where(eq(pipelineJobs.id, blockedContext.jobId)).run();

    assert.equal(currentStatus(), "DELIVERY_PENDING", "a tier-1 no must not land DONE");
    assert.equal(
      fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "delivery.md")),
      false,
      "a blocked run must not hand over a delivery note",
    );

    // Observability: the run's own summary and a greppable event both carry
    // which criterion blocked and what the verdict was.
    const blockedRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((run) => run.phase === "delivery");
    assert.ok(blockedRun);
    assert.equal(blockedRun.status, "failed");
    assert.match(blockedRun.summary ?? "", new RegExp(TIER1_DONE_KEY));
    assert.match(blockedRun.summary ?? "", /判定为 no/);
    const blockedEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) => event.type === "delivery_tier1_blocked");
    assert.ok(blockedEvent, "the block must leave a delivery_tier1_blocked event");
    assert.match(blockedEvent.message, new RegExp(TIER1_DONE_KEY));

    // The failed delivery keeps its entry status, so the button stays live:
    // the only exit is the pipeline's own loop, and it must remain reachable.
    const retryAction = computeActions(CHANGE_ID)
      .find((action) => action.actionId === "run_delivery");
    assert.equal(retryAction?.enabled, true, retryAction?.reasonCode ?? "");

    stubEngine(deliveryReplyWithRubric());
    await runDelivery(CHANGE_ID, makeContext("delivery-retry", "delivery", "run_delivery"));
    assert.equal(currentStatus(), "DONE", "a yes re-run is the one way past a tier-1 no");
  });

  it("treats tier-1 silence as blocking: a reply with no RUBRIC lines cannot reach DONE", async () => {
    seedChange("DELIVERY_PENDING");
    // Protocol-complete delivery reply, zero RUBRIC lines: every criterion is
    // recorded not_assessed, and not_assessed on the tier-1 clause blocks.
    stubEngine(deliveryLineProtocolText());

    await assert.rejects(
      () => runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery")),
      new RegExp(TIER1_DONE_KEY),
    );

    assert.equal(currentStatus(), "DELIVERY_PENDING");
    assert.equal(
      fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "delivery.md")),
      false,
    );
    // The fail-closed record survives the failed run: silence is stored as
    // not_assessed per criterion, not dropped.
    const doneRubric = db.select().from(rubrics).all()
      .find((rubric) => rubric.phase === "Done" && rubric.role === "producer");
    assert.ok(doneRubric);
    const criteria = db.select().from(rubricCriteria)
      .where(eq(rubricCriteria.rubricId, doneRubric.id)).all();
    const assessed = db.select().from(rubricAssessments).all()
      .filter((assessment) => criteria.some((criterion) => criterion.id === assessment.criterionId));
    assert.equal(assessed.length, criteria.length);
    assert.ok(assessed.every((assessment) => assessment.verdict === "not_assessed"));
  });

  // Pins the 2.9 boundary the gate must NOT widen past: Done's blocking
  // channel stays "none" for everything below tier-1. A factory tier-2
  // criterion, deliberately ticked blocking by the user, answered `no`, is
  // recorded -- and the change still lands DONE. A gate rewritten to block on
  // every blockingCriterionId (not just tier-1) turns this red.
  it("does not widen the gate: a blocking tier-2 Done `no` is recorded but does not stop DONE", async () => {
    seedChange("DELIVERY_PENDING");
    ensureFactoryRubrics(PROJECT_ID);
    const seeded = getCurrentRubric({
      projectId: PROJECT_ID, changeId: null, phase: "Done", role: "producer",
    });
    assert.ok(seeded);
    const TIER2_KEY = "RBK-factory-Done-producer-02";
    // The user ticks 阻断 on a tier-2 factory criterion: identity carried by
    // key round-trip, exactly as the drawer's editor saves.
    saveRubricVersion({
      projectId: PROJECT_ID,
      changeId: null,
      phase: "Done",
      role: "producer",
      criteria: seeded.criteria.map((criterion) => ({
        text: criterion.text,
        criterionKey: criterion.criterionKey,
        blocking: criterion.criterionKey === TIER2_KEY ? true : criterion.blocking,
      })),
    });
    stubEngine(deliveryReplyWithRubric({}, (criterion) =>
      criterion.criterionKey === TIER2_KEY ? "no" : "yes"));

    await runDelivery(CHANGE_ID, makeContext("delivery", "delivery", "run_delivery"));

    assert.equal(
      currentStatus(),
      "DONE",
      "only tier-1 may hold completion; a tier-2 blocking `no` records and stops nothing (2.9)",
    );
    // ...and the `no` really was recorded rather than lost.
    const current = getCurrentRubric({
      projectId: PROJECT_ID, changeId: null, phase: "Done", role: "producer",
    });
    assert.ok(current);
    const tier2 = current.criteria.find((criterion) => criterion.criterionKey === TIER2_KEY);
    assert.ok(tier2);
    assert.equal(tier2.blocking, true, "precondition: the tick persisted");
    const verdicts = db.select().from(rubricAssessments).all()
      .filter((assessment) => assessment.criterionId === tier2.id);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.verdict, "no");
  });
});
