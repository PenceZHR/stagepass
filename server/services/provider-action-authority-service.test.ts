import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  artifacts,
  changes,
  planSnapshots,
  projects,
  runs,
  stageGates,
  stageRuns,
} from "../db/schema.ts";
import {
  evaluateProviderActionAuthority,
  isPassingGateStatus,
} from "./provider-action-authority-service.ts";

describe("provider action gate authority", () => {
  it("accepts every persisted successful gate status", () => {
    assert.equal(isPassingGateStatus("pass"), true);
    assert.equal(isPassingGateStatus("passed"), true);
    assert.equal(isPassingGateStatus("approved"), true);
    assert.equal(isPassingGateStatus("pending"), false);
    assert.equal(isPassingGateStatus("blocked"), false);
  });
});

/**
 * Plan authority must come from the plan_snapshots content hash, not from
 * pairing stage_runs.attemptNo with runs.attemptNo: the former is the
 * governance attempt (increments on every retry_plan and report recompute)
 * while the latter is the lease-fence attempt, hardcoded to 1 at enqueue.
 * Pairing them only worked for never-retried plans -- one retry_plan made
 * run_test_plan permanently 409 (authority_business_run_ambiguous) while
 * GET /gate kept showing the action enabled.
 */
describe("run_test_plan enqueue authority after a plan retry", () => {
  const PROJECT_ID = "PRJ-PLAN-RETRY";
  const CHANGE_ID = "CHG-PLAN-RETRY";
  const NOW = "2026-07-16T00:00:00.000Z";
  const LATER = "2026-07-16T00:05:00.000Z";
  const FIRST_HASH = "plan-content-hash-attempt-1";
  const RETRY_HASH = "plan-content-hash-attempt-2";

  function cleanupRows(): void {
    db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
    db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).run();
    db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  }

  function seedChange(): void {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "Plan retry authority",
      repoPath: process.cwd(),
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "Plan retry authority",
      status: "PLAN_APPROVED",
      provider: "codex",
      codexThreadId: null,
      fixIterations: 0,
      blockedPhase: null,
      reworkFromPhase: null,
      suspendedByPrd: 0,
      preSuspendStatus: null,
      gitBranch: null,
      gateState: null,
      docsComplete: 0,
      retroDone: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
  }

  function seedPlanStageRun(input: {
    id: string;
    attemptNo: number;
    status: string;
    outputDbHash: string;
    startedAt?: string;
  }): void {
    db.insert(stageRuns).values({
      id: input.id,
      changeId: CHANGE_ID,
      phase: "Plan",
      attemptNo: input.attemptNo,
      status: input.status,
      idempotencyKey: null,
      inputDbHash: input.outputDbHash,
      outputDbHash: input.outputDbHash,
      sourceLineageJson: null,
      errorCode: null,
      provider: "codex",
      startedAt: input.startedAt ?? NOW,
      completedAt: input.startedAt ?? NOW,
    }).run();
  }

  function seedBusinessPlanRun(id: string): void {
    // Lease-fence semantics: every enqueue writes attemptNo 1, retries included.
    db.insert(runs).values({
      id,
      changeId: CHANGE_ID,
      phase: "generate_plan",
      status: "completed",
      startedAt: NOW,
      endedAt: NOW,
      summary: "Plan generated",
      jobId: null,
      workerId: null,
      leaseToken: null,
      attemptNo: 1,
      provider: "codex",
    }).run();
  }

  function seedPlanGate(sourceDbHash: string, gateVersion: number): void {
    db.insert(stageGates).values({
      id: `STG-GATE-PLAN-${gateVersion}`,
      changeId: CHANGE_ID,
      phase: "Plan",
      status: "passed",
      blockersJson: null,
      freshnessJson: null,
      requiredActionsJson: null,
      sourceDbHash,
      gateVersion,
      computedAt: LATER,
    }).run();
  }

  function seedPlanSnapshot(input: { id: string; snapshotDbHash: string; createdAt: string }): void {
    db.insert(planSnapshots).values({
      id: input.id,
      changeId: CHANGE_ID,
      status: "ready",
      planName: "plan",
      sourceSpecHash: null,
      expectedFilesJson: "[]",
      forbiddenFilesJson: "[]",
      validationPolicyHash: null,
      approvedAt: null,
      approvalDecisionId: null,
      snapshotDbHash: input.snapshotDbHash,
      createdAt: input.createdAt,
    }).run();
  }

  function runTestPlanAuthority() {
    return evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "test_plan",
      actionId: "run_test_plan",
    });
  }

  beforeEach(() => {
    cleanupRows();
    seedChange();
  });

  afterEach(cleanupRows);

  it("authorizes run_test_plan when the gate matches the latest plan snapshot after a retry", () => {
    // First plan attempt found issues; retry_plan produced the passing plan.
    seedPlanSnapshot({ id: "PLAN-SNAP-1", snapshotDbHash: FIRST_HASH, createdAt: NOW });
    seedPlanSnapshot({ id: "PLAN-SNAP-2", snapshotDbHash: RETRY_HASH, createdAt: LATER });
    seedPlanStageRun({ id: "STG-RUN-PLAN-1", attemptNo: 1, status: "issues_found", outputDbHash: FIRST_HASH });
    seedPlanStageRun({ id: "STG-RUN-PLAN-2", attemptNo: 2, status: "passed", outputDbHash: RETRY_HASH, startedAt: LATER });
    seedBusinessPlanRun("RUN-PLAN-1");
    seedBusinessPlanRun("RUN-PLAN-2");
    seedPlanGate(RETRY_HASH, 2);

    const authority = runTestPlanAuthority();

    assert.equal(
      authority.reasonCode,
      null,
      "a retried plan must not brick run_test_plan: stage_runs.attemptNo (governance) has no " +
        "counterpart in runs.attemptNo (lease fence, always 1)",
    );
    assert.equal(authority.enabled, true);
    assert.equal(authority.sourceDbHash, RETRY_HASH);
    assert.equal(authority.gateVersion, "2");
  });

  it("authorizes run_test_plan when a report recompute duplicated the stage run for the same content", () => {
    // regeneratePlanReport re-persists an unchanged plan: same content hash,
    // new stage run, no business run. The old source-run uniqueness check
    // (outputDbHash -> exactly one stage run) called this ambiguous.
    seedPlanSnapshot({ id: "PLAN-SNAP-1", snapshotDbHash: RETRY_HASH, createdAt: NOW });
    seedPlanStageRun({ id: "STG-RUN-PLAN-1", attemptNo: 1, status: "passed", outputDbHash: RETRY_HASH });
    seedPlanStageRun({ id: "STG-RUN-PLAN-2", attemptNo: 2, status: "passed", outputDbHash: RETRY_HASH, startedAt: LATER });
    seedBusinessPlanRun("RUN-PLAN-1");
    seedPlanGate(RETRY_HASH, 2);

    const authority = runTestPlanAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });

  it("denies run_test_plan when the gate hash no longer matches the latest plan snapshot", () => {
    seedPlanSnapshot({ id: "PLAN-SNAP-1", snapshotDbHash: FIRST_HASH, createdAt: NOW });
    seedPlanSnapshot({ id: "PLAN-SNAP-2", snapshotDbHash: RETRY_HASH, createdAt: LATER });
    seedPlanStageRun({ id: "STG-RUN-PLAN-1", attemptNo: 1, status: "passed", outputDbHash: FIRST_HASH });
    seedBusinessPlanRun("RUN-PLAN-1");
    // Stale gate: still pointing at the superseded snapshot's content.
    seedPlanGate(FIRST_HASH, 1);

    const authority = runTestPlanAuthority();

    assert.equal(authority.enabled, false);
    assert.equal(authority.reasonCode, "authority_source_ambiguous");
  });

  it("falls back to legacy run pairing for changes that predate plan snapshots", () => {
    seedPlanStageRun({ id: "STG-RUN-PLAN-1", attemptNo: 1, status: "passed", outputDbHash: FIRST_HASH });
    seedBusinessPlanRun("RUN-PLAN-1");
    db.insert(artifacts).values({
      id: "ART-PLAN-1",
      changeId: CHANGE_ID,
      runId: "RUN-PLAN-1",
      type: "plan",
      path: "/tmp/plan.json",
      createdAt: NOW,
    }).run();
    seedPlanGate(FIRST_HASH, 1);

    const authority = runTestPlanAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });
});

/**
 * The contract, the enqueue authority and the stage runner have to agree on
 * which statuses `retry_tech_spec` is legal from, or the button is a lie in one
 * direction or the other.
 *
 * Live (CHG-015): `retry_tech_spec` carried no requiredStatus at all, so the
 * authority enabled it everywhere and POST returned 202, while runTechSpec
 * accepted only SPEC_READY -- the job then failed with "Invalid status:
 * TECHSPECCING. Expected: SPEC_READY", three times, with nothing else to press.
 *
 * a9a953f2 fixed the same shape for retry_test_plan by narrowing the contract
 * to the runner. Narrowing alone is wrong here: TECHSPECCING is precisely where
 * the user is stuck, so dropping it would swap a failing button for no button.
 * The runner learned to recover a stranded TECHSPECCING instead
 * (recoverStrandedRunningStatus), and the contract now advertises exactly the
 * two statuses it accepts.
 */
describe("retry_tech_spec enqueue authority", () => {
  const PROJECT_ID = "PRJ-TECHSPEC-RETRY";
  const CHANGE_ID = "CHG-TECHSPEC-RETRY";
  const NOW = "2026-07-19T00:00:00.000Z";
  const SPEC_HASH = "spec-gate-source-hash";

  function cleanupRows(): void {
    db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  }

  function seedChangeAt(status: string): void {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "TechSpec retry authority",
      repoPath: process.cwd(),
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "TechSpec retry authority",
      status,
      provider: "codex",
      codexThreadId: null,
      fixIterations: 0,
      blockedPhase: null,
      reworkFromPhase: null,
      suspendedByPrd: 0,
      preSuspendStatus: null,
      gitBranch: null,
      gateState: "spec",
      docsComplete: 0,
      retroDone: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(stageGates).values({
      id: "STG-GATE-SPEC-1",
      changeId: CHANGE_ID,
      phase: "Spec",
      status: "passed",
      blockersJson: null,
      freshnessJson: null,
      requiredActionsJson: null,
      sourceDbHash: SPEC_HASH,
      gateVersion: 1,
      computedAt: NOW,
    }).run();
    // retry_tech_spec carries snapshotPhase "Spec", so the authority also
    // demands the governance stage run the Spec gate was computed from.
    db.insert(stageRuns).values({
      id: "STG-RUN-SPEC-1",
      changeId: CHANGE_ID,
      phase: "Spec",
      attemptNo: 1,
      status: "passed",
      idempotencyKey: null,
      inputDbHash: SPEC_HASH,
      outputDbHash: SPEC_HASH,
      sourceLineageJson: null,
      errorCode: null,
      provider: "codex",
      startedAt: NOW,
      completedAt: NOW,
    }).run();
  }

  function retryTechSpecAuthority() {
    return evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "tech_spec",
      actionId: "retry_tech_spec",
    });
  }

  afterEach(cleanupRows);

  it("authorizes retry_tech_spec for a change stranded at TECHSPECCING", () => {
    cleanupRows();
    seedChangeAt("TECHSPECCING");

    // The dead end this whole fix exists for: if the authority refuses here,
    // the user has no way out of a killed TechSpec run.
    const authority = retryTechSpecAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });

  it("authorizes retry_tech_spec at SPEC_READY", () => {
    cleanupRows();
    seedChangeAt("SPEC_READY");

    const authority = retryTechSpecAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });

  for (const status of ["TECHSPEC_READY", "PLANNING", "IMPLEMENTING", "DONE"]) {
    it(`refuses retry_tech_spec at ${status} instead of promising a job that cannot run`, () => {
      cleanupRows();
      seedChangeAt(status);

      // runTechSpec rejects all of these, so advertising the retry here is the
      // phantom-button shape a9a953f2 named.
      const authority = retryTechSpecAuthority();

      assert.equal(authority.enabled, false);
      assert.equal(authority.reasonCode, "change_status_mismatch");
    });
  }
});

/**
 * The third instance of the phantom-action family (a9a953f2 retry_test_plan,
 * 8ac5c4ec retry_tech_spec), and the one 8ac5c4ec explicitly flagged as the
 * highest remaining priority: `retry_plan` declared no requiredStatus at all,
 * so the enqueue authority green-lit it at every status and POST returned 202
 * with a jobId, while generatePlan accepts only PLAN_READY and TECHSPEC_READY
 * (pipeline-plan-stage-service assertStatus). Every dispatch then failed with
 * "Invalid status: <status>. Expected: PLAN_READY, TECHSPEC_READY" -- a
 * permanent deadlock with no user-visible escape.
 *
 * Narrowing to just those two would have restored a different dead end:
 * PLANNING is exactly where a killed Plan run leaves the change, so dropping it
 * swaps a failing button for no button. generatePlan now recovers a stranded
 * PLANNING first (recoverStrandedRunningStatus), and the contract advertises
 * exactly the three statuses that can reach a run.
 */
describe("retry_plan enqueue authority", () => {
  const PROJECT_ID = "PRJ-PLAN-RETRY-AUTH";
  const CHANGE_ID = "CHG-PLAN-RETRY-AUTH";
  const NOW = "2026-07-19T00:00:00.000Z";
  const TECHSPEC_HASH = "techspec-gate-source-hash";

  function cleanupRows(): void {
    db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
    db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  }

  function seedChangeAt(status: string): void {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "Plan retry authority",
      repoPath: process.cwd(),
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "Plan retry authority",
      status,
      provider: "codex",
      codexThreadId: null,
      fixIterations: 0,
      blockedPhase: null,
      reworkFromPhase: null,
      suspendedByPrd: 0,
      preSuspendStatus: null,
      gitBranch: null,
      gateState: "tech_spec",
      docsComplete: 0,
      retroDone: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(stageGates).values({
      id: "STG-GATE-TECHSPEC-PLAN-1",
      changeId: CHANGE_ID,
      phase: "TechSpec",
      status: "passed",
      blockersJson: null,
      freshnessJson: null,
      requiredActionsJson: null,
      sourceDbHash: TECHSPEC_HASH,
      gateVersion: 1,
      computedAt: NOW,
    }).run();
    // retry_plan carries snapshotPhase "TechSpec", so the authority also demands
    // the governance stage run the TechSpec gate was computed from, plus the
    // business run and artifact it pairs with.
    db.insert(stageRuns).values({
      id: "STG-RUN-TECHSPEC-PLAN-1",
      changeId: CHANGE_ID,
      phase: "TechSpec",
      attemptNo: 1,
      status: "passed",
      idempotencyKey: null,
      inputDbHash: TECHSPEC_HASH,
      outputDbHash: TECHSPEC_HASH,
      sourceLineageJson: null,
      errorCode: null,
      provider: "codex",
      startedAt: NOW,
      completedAt: NOW,
    }).run();
    db.insert(runs).values({
      id: "RUN-TECHSPEC-PLAN-1",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      status: "completed",
      startedAt: NOW,
      endedAt: NOW,
      summary: "tech spec generated",
      attemptNo: 1,
      provider: "codex",
    }).run();
    db.insert(artifacts).values({
      id: "ART-TECHSPEC-PLAN-1",
      changeId: CHANGE_ID,
      runId: "RUN-TECHSPEC-PLAN-1",
      type: "markdown",
      path: "tech-spec-delta.md",
      createdAt: NOW,
    }).run();
  }

  function retryPlanAuthority() {
    return evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "generate_plan",
      actionId: "retry_plan",
    });
  }

  afterEach(cleanupRows);

  it("authorizes retry_plan for a change stranded at PLANNING", () => {
    cleanupRows();
    seedChangeAt("PLANNING");

    // The dead end this whole fix exists for: if the authority refuses here,
    // the user has no way out of a killed Plan run.
    const authority = retryPlanAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });

  for (const status of ["TECHSPEC_READY", "PLAN_READY"]) {
    it(`authorizes retry_plan at ${status}`, () => {
      cleanupRows();
      seedChangeAt(status);

      // Exactly the pair generatePlan's assertStatus accepts; narrowing past
      // either of these would break the normal Plan (re)generation path.
      const authority = retryPlanAuthority();

      assert.equal(authority.reasonCode, null);
      assert.equal(authority.enabled, true);
    });
  }

  for (const status of ["PLAN_APPROVED", "TESTPLAN_DONE", "IMPLEMENTING", "BLOCKED", "DONE"]) {
    it(`refuses retry_plan at ${status} instead of promising a job that cannot run`, () => {
      cleanupRows();
      seedChangeAt(status);

      // generatePlan rejects all of these, so advertising the retry here is the
      // phantom-button shape a9a953f2 named. BLOCKED is called out on purpose:
      // retry_prd and retry_spec both accept it, so it is the tempting status
      // to copy across -- but the Plan runner does not.
      const authority = retryPlanAuthority();

      assert.equal(authority.enabled, false);
      assert.equal(authority.reasonCode, "change_status_mismatch");
    });
  }
});

/**
 * The same family as retry_plan/retry_tech_spec above, but failing in the
 * opposite direction -- the mirror dead end 8ac5c4ec's own comment predicted.
 *
 * a9a953f2 narrowed retry_test_plan to `PLAN_APPROVED` because the contract was
 * advertising it at statuses runTestPlan rejects. That was right at the time,
 * but TestPlan runs through runDocumentStage, and 8ac5c4ec later taught that
 * runner to repair a change stranded at its own running status
 * (recoverStrandedRunningStatus). So the runner has been able to recover
 * TESTPLANNING ever since, while the contract kept refusing to enqueue the one
 * action that performs the recovery: a test-plan run killed mid-flight had no
 * way out at all -- not a failing button, no button.
 *
 * requiredStatus is therefore `allowedStatuses` plus the running status the
 * recovery can repair, exactly as retry_plan's is.
 */
describe("retry_test_plan enqueue authority", () => {
  const PROJECT_ID = "PRJ-TESTPLAN-RETRY-AUTH";
  const CHANGE_ID = "CHG-TESTPLAN-RETRY-AUTH";
  const NOW = "2026-07-19T00:00:00.000Z";
  const PLAN_HASH = "plan-gate-source-hash";

  function cleanupRows(): void {
    db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
    db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).run();
    db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  }

  function seedChangeAt(status: string): void {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "TestPlan retry authority",
      repoPath: process.cwd(),
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "TestPlan retry authority",
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
      docsComplete: 0,
      retroDone: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    // retry_test_plan carries snapshotPhase "Plan", so the authority also
    // demands the Plan gate, the governance stage run it was computed from, and
    // the business run plus artifact that pair with it.
    db.insert(stageGates).values({
      id: "STG-GATE-PLAN-TESTPLAN-1",
      changeId: CHANGE_ID,
      phase: "Plan",
      status: "passed",
      blockersJson: null,
      freshnessJson: null,
      requiredActionsJson: null,
      sourceDbHash: PLAN_HASH,
      gateVersion: 1,
      computedAt: NOW,
    }).run();
    db.insert(stageRuns).values({
      id: "STG-RUN-PLAN-TESTPLAN-1",
      changeId: CHANGE_ID,
      phase: "Plan",
      attemptNo: 1,
      status: "passed",
      idempotencyKey: null,
      inputDbHash: PLAN_HASH,
      outputDbHash: PLAN_HASH,
      sourceLineageJson: null,
      errorCode: null,
      provider: "codex",
      startedAt: NOW,
      completedAt: NOW,
    }).run();
    db.insert(runs).values({
      id: "RUN-PLAN-TESTPLAN-1",
      changeId: CHANGE_ID,
      phase: "generate_plan",
      status: "completed",
      startedAt: NOW,
      endedAt: NOW,
      summary: "plan generated",
      attemptNo: 1,
      provider: "codex",
    }).run();
    db.insert(artifacts).values({
      id: "ART-PLAN-TESTPLAN-1",
      changeId: CHANGE_ID,
      runId: "RUN-PLAN-TESTPLAN-1",
      type: "plan",
      path: "plan.json",
      createdAt: NOW,
    }).run();
  }

  function retryTestPlanAuthority() {
    return evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "test_plan",
      actionId: "retry_test_plan",
    });
  }

  afterEach(cleanupRows);

  it("authorizes retry_test_plan for a change stranded at TESTPLANNING", () => {
    cleanupRows();
    seedChangeAt("TESTPLANNING");

    // The dead end this fix exists for. runDocumentStage recovers the stranded
    // claim and reruns, so refusing here leaves a killed TestPlan run with no
    // exit whatsoever.
    const authority = retryTestPlanAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });

  it("authorizes retry_test_plan at PLAN_APPROVED", () => {
    cleanupRows();
    seedChangeAt("PLAN_APPROVED");

    // The normal re-run entry, and the single status a9a953f2 narrowed to.
    // Widening must not cost it.
    const authority = retryTestPlanAuthority();

    assert.equal(authority.reasonCode, null);
    assert.equal(authority.enabled, true);
  });

  for (const status of ["PLAN_READY", "TESTPLAN_DONE", "IMPLEMENTING", "CHECK_FAILED", "BLOCKED", "DONE"]) {
    it(`refuses retry_test_plan at ${status} instead of promising a job that cannot run`, () => {
      cleanupRows();
      seedChangeAt(status);

      // runTestPlan rejects every one of these and the recovery does not apply
      // (it only repairs the stage's own running status), so advertising the
      // retry here is the a9a953f2 phantom-button shape. CHECK_FAILED is called
      // out on purpose: that is where it was observed live.
      const authority = retryTestPlanAuthority();

      assert.equal(authority.enabled, false);
      assert.equal(authority.reasonCode, "change_status_mismatch");
    });
  }
});

/**
 * retry_build's outer status bound. Unlike the retries above it is not a flat
 * question -- whether an IMPLEMENTING change may be retried depends on whether
 * the Build run behind it is provably finished (inspectStaleBuildRun) -- so the
 * inspection stays authoritative and requiredStatus only has to stop the
 * authority green-lighting statuses no inspection would ever be consulted for.
 *
 * Without it this layer skipped its status filter entirely, the a9a953f2
 * phantom shape: the other two enforcement points (retryBuildDecision at GET
 * /gate, assertRetryBuildCanStart in the implement route) already refused, so
 * this was the one that disagreed.
 */
describe("retry_build enqueue authority status bound", () => {
  const PROJECT_ID = "PRJ-BUILD-RETRY-AUTH";
  const CHANGE_ID = "CHG-BUILD-RETRY-AUTH";
  const NOW = "2026-07-19T00:00:00.000Z";

  function cleanupRows(): void {
    db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
    db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  }

  function seedChangeAt(status: string): void {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "Build retry authority",
      repoPath: process.cwd(),
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "Build retry authority",
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
      docsComplete: 0,
      retroDone: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
  }

  function retryBuildAuthority() {
    return evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "implement",
      actionId: "retry_build",
    });
  }

  afterEach(cleanupRows);

  for (const status of ["PLAN_APPROVED", "IMPLEMENTING"]) {
    it(`does not refuse retry_build at ${status} on status grounds`, () => {
      cleanupRows();
      seedChangeAt(status);

      // Both statuses have to survive this layer, or the inspection that
      // actually decides them never runs.
      assert.notEqual(retryBuildAuthority().reasonCode, "change_status_mismatch");
    });
  }

  for (const status of ["TECHSPEC_READY", "PLAN_READY", "TESTPLAN_DONE", "IMPLEMENTED", "CHECK_FAILED", "BLOCKED", "DONE"]) {
    it(`refuses retry_build at ${status} instead of promising a job that cannot run`, () => {
      cleanupRows();
      seedChangeAt(status);

      // retryBuildStreamed rejects every one of these outright: it only accepts
      // PLAN_APPROVED, or IMPLEMENTING that recovers first.
      const authority = retryBuildAuthority();

      assert.equal(authority.enabled, false);
      assert.equal(authority.reasonCode, "change_status_mismatch");
    });
  }
});
