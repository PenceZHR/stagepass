import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requireActionDefinition } from "./action-contract-registry-service";
import {
  projectDesignInteraction,
} from "./human-interaction-broker";
import {
  parseDesignDecisionPayload,
  requireFreshDesignReport,
} from "./pipeline-command-gateway";
import {
  projectInteractionPhase,
  resolveInteractionAction,
} from "./pipeline-command-action-map";
import { orchestrateAfterCommand } from "./pipeline-command-orchestration";
import type {
  PipelineCommand,
  PipelineCommandResult,
} from "./pipeline-command-types";

const cases = [
  ["supply_spec_fact", "request_spec_changes", "Spec", "Spec"],
  ["dispute_spec_gap", "request_spec_changes", "Spec", "Spec"],
  ["return_to_spec", "return_to_spec", "Spec", "Spec"],
  ["waive_spec_p1", "waive_spec_p1", "Spec", "Spec"],
  ["approve_spec", "approve_spec", "Spec", "Spec"],
  ["reject_spec", "reject_spec", "Spec", "Spec"],
  ["approve_tech_spec", "approve_tech_spec", "TechSpec", "TechSpec"],
  ["reject_tech_spec", "reject_tech_spec", "TechSpec", "TechSpec"],
  ["waive_plan_p1", "waive_plan_p1", "Plan", "Plan"],
  ["approve_plan", "approve_plan", "Plan", "Plan"],
  ["reject_plan", "reject_plan", "Plan", "Plan"],
  ["approve_test_plan", "approve_plan", "TestPlan", "Plan"],
  ["reject_test_plan", "reject_test_plan", "TestPlan", "TestPlan"],
] as const;

function completed(commandId: string): PipelineCommandResult {
  return {
    commandId,
    status: "completed",
    changeStatus: "PLAN_APPROVED",
    gateVersion: "7",
    sourceDbHash: "fresh",
    sourceHeadSha: null,
    interactionId: "INT-1",
    humanDecisionId: "DEC-1",
    enqueuedJobId: null,
  };
}

function command(actionId: string): PipelineCommand {
  return {
    commandId: `CMD-${actionId}`,
    projectId: "PRJ-1",
    changeId: "CHG-1",
    actionId,
    expectedGateVersion: "7",
    expectedSourceDbHash: "fresh",
    expectedHeadSha: null,
    idempotencyKey: `idem-${actionId}`,
    requestHash: "request-hash",
    actor: { kind: "human", surface: "codex_mcp_app" },
    payload: {},
  };
}

describe("design-stage interaction flow", () => {
  it("keeps external phase identity while routing policy through canonical definitions", () => {
    for (
      const [
        externalId,
        canonicalId,
        interactionPhase,
        canonicalPhase,
      ] of cases
    ) {
      assert.deepEqual(resolveInteractionAction(externalId), {
        externalId,
        canonicalId,
      });
      assert.equal(projectInteractionPhase(externalId), interactionPhase);
      assert.equal(requireActionDefinition(canonicalId).phase, canonicalPhase);
    }
  });

  it("enforces exact payloads, fresh reports, and P1-only waiver targets", () => {
    assert.deepEqual(
      parseDesignDecisionPayload("supply_spec_fact", {
        fact: "The API is server-owned",
        affectedArtifactIds: ["SPEC-1"],
      }),
      {
        fact: "The API is server-owned",
        affectedArtifactIds: ["SPEC-1"],
      },
    );
    assert.throws(
      () => parseDesignDecisionPayload("waive_spec_p1", {
        gapId: "P0-GAP",
        reason: "skip",
      }, {
        currentReportHash: "report-1",
        expectedReportHash: "report-1",
        gapSeverity: "P0",
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "p0_cannot_be_waived"
      ),
    );
    assert.throws(
      () => parseDesignDecisionPayload("waive_spec_p1", {
        gapId: "P1-GAP",
        reason: "",
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "invalid_pipeline_command"
      ),
    );
    assert.throws(
      () => requireFreshDesignReport("report-new", "report-old"),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "design_report_hash_drift"
      ),
    );
  });

  it("projects Spec and document-stage facts with the current contract identity", () => {
    const spec = projectDesignInteraction({
      changeId: "CHG-1",
      phase: "Spec",
      kind: "gate_decision",
      title: "Spec decision",
      summary: "Review the current Spec",
      actionIds: ["approve_spec", "waive_spec_p1"],
      contract: { gateVersion: "7", sourceDbHash: "spec-source" },
      facts: {
        roundNo: 3,
        reportHash: "spec-report",
        openGaps: [{
          id: "GAP-1",
          severity: "P1",
          evidenceIds: ["E-1"],
          proposedPatch: "Clarify retry ownership",
        }],
        blockers: [{ id: "GAP-1", severity: "P1", title: "Retry ownership" }],
        risks: [],
        freshness: { fresh: true },
      },
    });
    assert.equal(spec.gateVersion, "7");
    assert.equal(spec.sourceDbHash, "spec-source");
    assert.deepEqual(spec.payload.currentRound, 3);
    assert.deepEqual(spec.payload.reportHash, "spec-report");
    assert.deepEqual(spec.payload.openGaps, [{
      id: "GAP-1",
      severity: "P1",
      evidenceIds: ["E-1"],
      proposedPatch: "Clarify retry ownership",
    }]);

    const plan = projectDesignInteraction({
      changeId: "CHG-1",
      phase: "Plan",
      kind: "risk_waiver",
      title: "Plan decision",
      summary: "Review the current Plan",
      actionIds: ["approve_plan", "waive_plan_p1"],
      contract: { gateVersion: "9", sourceDbHash: "plan-source" },
      facts: {
        artifactContentHash: "plan-content",
        blockers: [],
        risks: [{ id: "RISK-1", severity: "P1", title: "Delivery risk" }],
        freshness: { fresh: true, checkedAt: "2026-07-24T00:00:00.000Z" },
      },
    });
    assert.equal(plan.payload.artifactContentHash, "plan-content");
    assert.deepEqual(plan.payload.risks, [{
      id: "RISK-1",
      severity: "P1",
      title: "Delivery risk",
    }]);
    assert.deepEqual(plan.payload.freshness, {
      fresh: true,
      checkedAt: "2026-07-24T00:00:00.000Z",
    });
  });

  it("routes Plan approval to TestPlan and TestPlan confirmation to Build exactly once", async () => {
    const enqueued: string[] = [];
    const run = async (actionId: string, previousStatus: string) =>
      orchestrateAfterCommand({
        command: command(actionId),
        previousStatus,
        execute: async (input) => completed(input.commandId),
        refreshAction: (_changeId, nextActionId) => ({
          actionId: nextActionId,
        }) as never,
        enqueue: (input) => {
          enqueued.push(input.actionId);
          return { job: { id: `PJOB-${input.actionId}` } };
        },
      });

    const plan = await run("approve_plan", "PLAN_READY");
    assert.deepEqual(plan.enqueued.map((item) => item.actionId), [
      "run_test_plan",
    ]);
    const testPlan = await run("approve_test_plan", "TESTPLAN_DONE");
    assert.deepEqual(testPlan.enqueued.map((item) => item.actionId), [
      "run_build",
    ]);
    assert.deepEqual(enqueued, ["run_test_plan", "run_build"]);
  });
});
