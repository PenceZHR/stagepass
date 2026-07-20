import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactType,
  BattleRoundStatus,
  BattleTemplate,
  BattleUnit,
  ChangeStatus,
  EventType,
  FindingSeverity,
  FindingSource,
  HumanDecisionAction,
  Phase,
  RequirementGapStatus,
  RunPhase,
  WarReportStatus,
} from "../types/enums.ts";

describe("v2 pipeline enum contracts", () => {
  it("includes every v2 change status", () => {
    const expected = [
      "INTAKE_PENDING",
      "INTAKE_READY",
      "SPECCING",
      "SPEC_READY",
      "TECHSPECCING",
      "TECHSPEC_READY",
      "TESTPLANNING",
      "TESTPLAN_DONE",
      "MERGE_READY",
      "MERGING",
      "RETRO_PENDING",
      "DONE",
    ];

    for (const status of expected) {
      assert.equal(ChangeStatus.safeParse(status).success, true, status);
    }
  });

  it("includes every v2 run phase", () => {
    const expected = [
      "intake",
      "spec",
      "tech_spec",
      "test_plan",
      "release",
      "retro",
    ];

    for (const phase of expected) {
      assert.equal(RunPhase.safeParse(phase).success, true, phase);
    }
  });

  it("includes the v2 pipeline display phases", () => {
    const expected = [
      "Intake",
      "Spec",
      "TechSpec",
      "TestPlan",
      "Build",
      "Review",
      "QA",
      "Merge",
      "Retro",
    ];

    for (const phase of expected) {
      assert.equal(Phase.safeParse(phase).success, true, phase);
    }
  });

  it("includes the v2 artifact types", () => {
    const expected = [
      "change_request",
      "prd_intent",
      "briefing_questions",
      "prd_draft",
      "prd_gate",
      "prd_delta",
      "tech_spec_delta",
      "api_spec_delta",
      "test_plan_delta",
      "review_report",
      "review_raw_output",
      "release_note",
      "retro",
      "stage_scope",
    ];

    for (const artifactType of expected) {
      assert.equal(ArtifactType.safeParse(artifactType).success, true, artifactType);
    }
  });

  it("includes PRD Briefing event types", () => {
    assert.equal(EventType.safeParse("prd_briefing_locked").success, true);
  });

  it("includes stage_progress event type", () => {
    assert.equal(EventType.safeParse("stage_progress").success, true);
  });

  it("includes the Spec Battle enum contracts", () => {
    for (const severity of ["P0", "P1", "P2"]) {
      assert.equal(FindingSeverity.safeParse(severity).success, true, severity);
    }
    assert.equal(FindingSource.safeParse("requirement_critic").success, true);

    for (const artifactType of [
      "spec_report",
      "war_report",
      "requirement_gaps",
      "battle_round",
      "human_decisions",
    ]) {
      assert.equal(ArtifactType.safeParse(artifactType).success, true, artifactType);
    }

    for (const unit of [
      "SPEC_WRITER",
      "REQUIREMENT_CRITIC",
      "BATTLE_REPORTER",
      "HUMAN_COMMANDER",
    ]) {
      assert.equal(BattleUnit.safeParse(unit).success, true, unit);
    }

    assert.equal(BattleTemplate.safeParse("SPEC_BATTLE_MVP").success, true);
    assert.equal(BattleTemplate.safeParse("CUSTOM_TEMPLATE").success, false);

    for (const status of [
      "not_started",
      "red_running",
      "red_done",
      "blue_running",
      "blue_done",
      "report_ready",
      "closed",
      "superseded",
      "failed",
    ]) {
      assert.equal(BattleRoundStatus.safeParse(status).success, true, status);
    }

    for (const status of ["open", "resolved", "waived", "downgraded", "overridden"]) {
      assert.equal(RequirementGapStatus.safeParse(status).success, true, status);
    }

    for (const action of ["approve", "request_changes", "return_to_spec", "waive_p1"]) {
      assert.equal(HumanDecisionAction.safeParse(action).success, true, action);
    }

    for (const status of ["generated", "stale", "approved"]) {
      assert.equal(WarReportStatus.safeParse(status).success, true, status);
    }
  });
});
