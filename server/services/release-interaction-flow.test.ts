import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCodexNativeFlags } from "../config/codex-native-flags";
import {
  CODEX_DECISION_PHASES,
  isCodexDecisionSurfaceEnabled,
} from "../config/codex-decision-rollout";
import {
  projectMergeInteraction,
  projectQaInteraction,
  projectReviewInteraction,
} from "./human-interaction-broker";
import {
  ReleaseDecisionPayloads,
  isHumanDecisionAction,
  parseReleaseDecisionPayload,
} from "./pipeline-command-gateway";

describe("release interaction flow", () => {
  it("projects Review, QA, and Merge evidence without dropping source identity", () => {
    const contract = { gateVersion: "7", sourceDbHash: "db-7" };
    assert.deepEqual(
      projectReviewInteraction({
        changeId: "CHG-1",
        title: "Review decision",
        summary: "Review found one current P1",
        contract,
        facts: {
          reportId: "RPT-1",
          reportHash: "rpt-hash",
          sourceBuildRunId: "build-2",
          sourceHeadSha: "aaa",
          findings: [{
            id: "F-P1",
            severity: "P1",
            title: "Compatibility risk",
            status: "open",
            waiverEligible: true,
          }],
        },
      }).payload,
      {
        reportId: "RPT-1",
        reportHash: "rpt-hash",
        sourceBuildRunId: "build-2",
        sourceHeadSha: "aaa",
        findings: [{
          id: "F-P1",
          severity: "P1",
          title: "Compatibility risk",
          status: "open",
          waiverEligible: true,
        }],
      },
    );
    assert.equal(projectQaInteraction({
      changeId: "CHG-1",
      title: "QA decision",
      summary: "QA evidence",
      contract,
      facts: {
        testPlanSnapshotId: "TPS-1",
        testPlanHash: "tp-hash",
        qaRunId: "QA-1",
        sourceHeadSha: "aaa",
        commandResults: [{ id: "C-1", status: "failed", evidenceIds: ["E-1"] }],
        manualChecks: [{ id: "M-1", title: "Inspect UI", required: true }],
        freshness: { fresh: true },
      },
    }).payload?.qaRunId, "QA-1");
    assert.equal(projectMergeInteraction({
      changeId: "CHG-1",
      title: "Merge decision",
      summary: "Merge readiness",
      contract,
      facts: {
        readinessId: "MR-1",
        readinessHash: "mr-hash",
        sourceHeadSha: "aaa",
        blockers: [],
        acceptedRisk: [{ id: "F-P1", reason: "accepted" }],
        approvalEligible: true,
      },
    }).payload?.readinessHash, "mr-hash");
  });

  it("accepts exact release payloads and refuses invalid waiver/override payloads", () => {
    assert.deepEqual(parseReleaseDecisionPayload("waive_review_p1", {
      findingId: "F-P1",
      reason: "Accepted compatibility limitation",
    }), {
      findingId: "F-P1",
      reason: "Accepted compatibility limitation",
    });
    assert.deepEqual(parseReleaseDecisionPayload("retry_qa", {
      qaRunId: "QA-1",
      reason: "rerun after fix",
    }), {
      qaRunId: "QA-1",
      reason: "rerun after fix",
    });
    assert.throws(
      () => parseReleaseDecisionPayload("waive_review_p1", {
        findingId: "F-P1",
        reason: " ",
      }),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && error.code === "invalid_pipeline_command",
    );
    assert.throws(
      () => parseReleaseDecisionPayload("override_merge", {
        blockerIds: [],
        reason: "override",
        confirmation: true,
      }),
      /./,
    );
    assert.ok(ReleaseDecisionPayloads.record_qa_manual_check);
  });

  it("writes no human decision for retry_qa and records every release choice", () => {
    assert.equal(isHumanDecisionAction("retry_qa"), false);
    for (const actionId of [
      "waive_review_p1",
      "fix_blockers",
      "stop_change",
      "enter_qa",
      "record_qa_manual_check",
      "approve_merge",
      "reject_merge",
      "override_merge",
      "request_rework",
    ]) {
      assert.equal(isHumanDecisionAction(actionId), true, actionId);
    }
  });

  it("enables the complete eleven-phase rollout through the shared helper", () => {
    const flags = readCodexNativeFlags({
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: CODEX_DECISION_PHASES.join(","),
    });
    assert.deepEqual(flags.codexDecisionPhases, CODEX_DECISION_PHASES);
    for (const phase of CODEX_DECISION_PHASES) {
      assert.equal(isCodexDecisionSurfaceEnabled(phase, flags), true, phase);
    }
  });
});
