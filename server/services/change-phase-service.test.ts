import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CONTENT_PHASES,
  buildPhaseReview,
  normalizeReviewPhase,
} from "./change-phase-service.ts";

const repoPath = "/tmp/repo";
const changeId = "CHG-001";
const changeDir = path.join(repoPath, ".ship", "changes", changeId);
const now = "2026-06-20T00:00:00.000Z";

describe("change-phase-service phase review aggregation", () => {
  it("exposes content-backed v2 review phases", () => {
    assert.deepEqual(CONTENT_PHASES, [
      "Refine",
      "Intake",
      "Spec",
      "TechSpec",
      "Plan",
      "TestPlan",
      "Build",
      "Implement",
      "Review",
      "Check",
      "Fix",
      "Merge",
      // Done joined the list when design §3 turned it into a real stage that
      // produces delivery.md; before that it had no records of its own.
      "Retro",
      "Done",
    ]);
    assert.equal(normalizeReviewPhase("plan"), "Plan");
    assert.equal(normalizeReviewPhase("techspec"), "TechSpec");
    assert.equal(normalizeReviewPhase("Approve"), null);
    assert.equal(normalizeReviewPhase("Ready"), null);
  });

  it("returns phase review overviews in product pipeline order", () => {
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Refine",
      runs: [],
      events: [],
      artifacts: [],
    });

    assert.deepEqual(
      result.phases.map((phase) => phase.phase),
      [
        "Refine",
        "Intake",
        "Spec",
        "TechSpec",
        "Plan",
        "TestPlan",
        "Build",
        "Implement",
        "Review",
        "Check",
        "Fix",
        "Merge",
        "Retro",
        "Done",
      ]
    );
  });

  it("groups plan artifacts, runs, and events by generate_plan run", () => {
    const planPath = path.join(changeDir, "plan.md");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Plan",
      runs: [
        {
          id: "RUN-001",
          changeId,
          phase: "generate_plan",
          status: "completed",
          startedAt: now,
          endedAt: now,
          summary: "Plan generated",
        },
        {
          id: "RUN-002",
          changeId,
          phase: "implement",
          status: "completed",
          startedAt: now,
          endedAt: now,
          summary: "Implemented",
        },
      ],
      events: [
        {
          id: "EVT-001",
          changeId,
          runId: "RUN-001",
          type: "run_started",
          message: "planning",
          rawJson: null,
          createdAt: now,
        },
        {
          id: "EVT-002",
          changeId,
          runId: "RUN-002",
          type: "run_started",
          message: "implementing",
          rawJson: null,
          createdAt: now,
        },
      ],
      artifacts: [
        {
          id: "ART-001",
          changeId,
          runId: "RUN-001",
          type: "plan_md",
          path: planPath,
          createdAt: now,
        },
      ],
      fileContents: {
        [planPath]: "# Plan",
      },
    });

    assert.equal(result.selected.phase, "Plan");
    assert.equal(result.selected.runs.length, 1);
    assert.equal(result.selected.runs[0].id, "RUN-001");
    assert.equal(result.selected.events.length, 1);
    assert.equal(result.selected.events[0].id, "EVT-001");
    assert.equal(result.selected.artifacts.length, 1);
    assert.equal(result.selected.artifacts[0].content, "# Plan");
  });

  it("shows Plan sandbox artifacts while keeping critique and report read-only", () => {
    const paths = {
      planMd: path.join(changeDir, "plan.md"),
      planJson: path.join(changeDir, "plan.json"),
      planCritique: path.join(changeDir, "plan-critique.json"),
      planReport: path.join(changeDir, "reports", "plan-report.md"),
    };
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Plan",
      runs: [],
      events: [],
      artifacts: [],
      fileContents: {
        [paths.planMd]: "# Plan",
        [paths.planJson]: "{\"allowedFiles\":[]}",
        [paths.planCritique]: "{\"risks\":[]}",
        [paths.planReport]: "# Plan Report",
      },
    });

    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.type), [
      "plan_md",
      "plan_json",
      "plan_critique",
      "plan_report",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.impactLabel), [
      "实施计划说明",
      "实施范围与验证命令",
      "反方计划审查",
      "Plan 作战沙盘报告",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.editablePath), [
      paths.planMd,
      paths.planJson,
      null,
      null,
    ]);
    assert.equal(result.selected.artifacts[3].path, paths.planReport);
    assert.equal(result.selected.artifacts[3].content, "# Plan Report");
  });

  it("shows legacy import metadata without treating it as current artifact authority", () => {
    const legacyPath = path.join(changeDir, "plan.json");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Plan",
      runs: [],
      events: [],
      artifacts: [],
      fileContents: {
        [legacyPath]: "{\"expectedFiles\":[]}",
      },
      legacyImports: [
        {
          id: "LEGACY-PLAN-001",
          changeId,
          phase: "Plan",
          sourcePath: legacyPath,
          sourceArtifactHash: "legacy-hash",
          schemaVersion: "legacy-plan/v1",
          importStatus: "legacy_candidate",
          importResultJson: JSON.stringify({ sourceLineage: { sourceSpecHash: "old-spec" } }),
          importedAt: now,
        },
      ],
    });

    assert.equal(result.phases.find((phase) => phase.phase === "Plan")?.legacyWarning, true);
    assert.deepEqual(result.selected.legacyImports, [
      {
        id: "LEGACY-PLAN-001",
        phase: "Plan",
        sourcePath: legacyPath,
        sourceArtifactHash: "legacy-hash",
        schemaVersion: "legacy-plan/v1",
        importStatus: "legacy_candidate",
        importedAt: now,
      },
    ]);
    assert.equal(result.selected.artifacts[0].source, "current");
    assert.equal(result.selected.artifacts[0].id, "current:Plan:plan.json");
  });

  it("exposes v2 review phases while retaining legacy phase names", () => {
    const phases: readonly string[] = CONTENT_PHASES;
    assert.deepEqual(
      [
        "Intake",
        "Spec",
        "TechSpec",
        "TestPlan",
        "Build",
        "Review",
        "Check",
        "Fix",
        "Merge",
        "Retro",
      ].every((phase) => phases.includes(phase)),
      true
    );
    assert.equal(normalizeReviewPhase("build"), "Build");
    assert.equal(normalizeReviewPhase("Implement"), "Implement");
  });

  it("maps v2 runs, artifacts, and status events to their review phases", () => {
    const paths = {
      changeRequest: path.join(changeDir, "change-request.md"),
      prdDelta: path.join(changeDir, "prd-delta.md"),
      techSpecDelta: path.join(changeDir, "tech-spec-delta.md"),
      testPlanDelta: path.join(changeDir, "test-plan-delta.md"),
      buildSummary: path.join(changeDir, "implement-summary.md"),
      reviewReport: path.join(changeDir, "review-report.md"),
      releaseNote: path.join(changeDir, "release-note.md"),
      retro: path.join(changeDir, "retro.md"),
    };
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Build",
      runs: [
        { id: "RUN-001", changeId, phase: "intake", status: "completed", startedAt: now, endedAt: now, summary: "intake" },
        { id: "RUN-002", changeId, phase: "spec", status: "completed", startedAt: now, endedAt: now, summary: "spec" },
        { id: "RUN-003", changeId, phase: "tech_spec", status: "completed", startedAt: now, endedAt: now, summary: "tech" },
        { id: "RUN-004", changeId, phase: "test_plan", status: "completed", startedAt: now, endedAt: now, summary: "tests" },
        { id: "RUN-005", changeId, phase: "implement", status: "completed", startedAt: now, endedAt: now, summary: "build" },
        { id: "RUN-006", changeId, phase: "review", status: "completed", startedAt: now, endedAt: now, summary: "review" },
        { id: "RUN-007", changeId, phase: "release", status: "completed", startedAt: now, endedAt: now, summary: "release" },
        { id: "RUN-008", changeId, phase: "retro", status: "completed", startedAt: now, endedAt: now, summary: "retro" },
      ],
      events: [
        {
          id: "EVT-001",
          changeId,
          runId: null,
          type: "change_status_changed",
          message: "Status -> MERGE_READY",
          rawJson: JSON.stringify({ to: "MERGE_READY" }),
          createdAt: now,
        },
      ],
      artifacts: [
        { id: "ART-001", changeId, runId: null, type: "change_request", path: paths.changeRequest, createdAt: now },
        { id: "ART-002", changeId, runId: null, type: "prd_delta", path: paths.prdDelta, createdAt: now },
        { id: "ART-003", changeId, runId: null, type: "tech_spec_delta", path: paths.techSpecDelta, createdAt: now },
        { id: "ART-004", changeId, runId: null, type: "test_plan_delta", path: paths.testPlanDelta, createdAt: now },
        { id: "ART-005", changeId, runId: null, type: "implement_summary", path: paths.buildSummary, createdAt: now },
        { id: "ART-006", changeId, runId: null, type: "review_report", path: paths.reviewReport, createdAt: now },
        { id: "ART-007", changeId, runId: null, type: "release_note", path: paths.releaseNote, createdAt: now },
        { id: "ART-008", changeId, runId: null, type: "retro", path: paths.retro, createdAt: now },
      ],
      fileContents: Object.fromEntries(
        Object.values(paths).map((filePath) => [filePath, path.basename(filePath)])
      ),
    });

    const overview = new Map(result.phases.map((phase) => [phase.phase, phase]));
    assert.equal(overview.get("Intake")?.runCount, 1);
    assert.equal(overview.get("Spec")?.artifactCount, 1);
    assert.equal(overview.get("TechSpec")?.runCount, 1);
    assert.equal(overview.get("TestPlan")?.runCount, 1);
    assert.equal(overview.get("Build")?.runCount, 1);
    assert.equal(overview.get("Review")?.artifactCount, 1);
    assert.equal(overview.get("Merge")?.eventCount, 1);
    assert.equal(overview.get("Retro")?.runCount, 1);
    assert.deepEqual(result.selected.runs.map((run) => run.id), ["RUN-005"]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.id), [
      "current:Build:implement-summary.md",
    ]);
    assert.equal(result.selected.artifacts[0].source, "current");
  });

  it("shows PRD briefing current artifacts in Intake phase review", () => {
    const paths = {
      prdIntent: path.join(changeDir, "prd-intent.md"),
      briefingQuestions: path.join(changeDir, "briefing-questions.json"),
      prdDraft: path.join(changeDir, "prd-draft.md"),
      prdGate: path.join(changeDir, "prd-gate.json"),
    };
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Intake",
      runs: [],
      events: [],
      artifacts: [],
      fileContents: {
        [paths.prdIntent]: "# Intent",
        [paths.briefingQuestions]: "{\"questions\":[]}",
        [paths.prdDraft]: "# Draft",
        [paths.prdGate]: "{\"passed\":true}",
      },
    });

    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.type), [
      "prd_intent",
      "briefing_questions",
      "prd_draft",
      "prd_gate",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.source), [
      "current",
      "current",
      "current",
      "current",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.impactLabel), [
      "PRD 需求意图",
      "PRD 澄清问题",
      "PRD 草稿",
      "PRD 锁定门禁",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.editablePath), [
      paths.prdIntent,
      paths.briefingQuestions,
      paths.prdDraft,
      paths.prdGate,
    ]);
  });

  it("maps PRD briefing artifact rows to Intake without requiring a run", () => {
    const paths = {
      prdIntent: path.join(changeDir, "runs", "RUN-001", "prd-intent.md"),
      briefingQuestions: path.join(changeDir, "runs", "RUN-001", "briefing-questions.json"),
      prdDraft: path.join(changeDir, "runs", "RUN-001", "prd-draft.md"),
      prdGate: path.join(changeDir, "runs", "RUN-001", "prd-gate.json"),
    };
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Intake",
      runs: [],
      events: [],
      artifacts: [
        { id: "ART-001", changeId, runId: null, type: "prd_intent", path: paths.prdIntent, createdAt: now },
        {
          id: "ART-002",
          changeId,
          runId: null,
          type: "briefing_questions",
          path: paths.briefingQuestions,
          createdAt: now,
        },
        { id: "ART-003", changeId, runId: null, type: "prd_draft", path: paths.prdDraft, createdAt: now },
        { id: "ART-004", changeId, runId: null, type: "prd_gate", path: paths.prdGate, createdAt: now },
      ],
      fileContents: {
        [paths.prdIntent]: "# Intent",
        [paths.briefingQuestions]: "{\"questions\":[]}",
        [paths.prdDraft]: "# Draft",
        [paths.prdGate]: "{\"passed\":true}",
      },
    });

    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.id), [
      "ART-001",
      "ART-002",
      "ART-003",
      "ART-004",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.type), [
      "prd_intent",
      "briefing_questions",
      "prd_draft",
      "prd_gate",
    ]);
    assert.equal(result.phases.find((phase) => phase.phase === "Intake")?.artifactCount, 4);
  });

  it("returns canonical current artifacts with impact labels before run snapshots", () => {
    const repoPath = "/repo";
    const currentPrdPath = "/repo/.ship/changes/CHG-001/prd-delta.md";
    const runPrdPath = "/repo/.ship/changes/CHG-001/runs/RUN-001/prd-delta.md";

    const result = buildPhaseReview({
      changeId: "CHG-001",
      repoPath,
      selectedPhase: "Spec",
      runs: [
        {
          id: "RUN-001",
          changeId: "CHG-001",
          phase: "spec",
          status: "completed",
          startedAt: "2026-06-24T00:00:00.000Z",
          endedAt: "2026-06-24T00:01:00.000Z",
          summary: "done",
        },
      ],
      events: [],
      artifacts: [
        {
          id: "ART-001",
          changeId: "CHG-001",
          runId: "RUN-001",
          type: "prd_delta",
          path: runPrdPath,
          createdAt: "2026-06-24T00:01:00.000Z",
        },
      ],
      fileContents: {
        [currentPrdPath]: "# Current PRD",
        [runPrdPath]: "# Run PRD",
      },
    });

    assert.equal(result.selected.artifacts[0].source, "current");
    assert.equal(result.selected.artifacts[0].path, currentPrdPath);
    assert.equal(result.selected.artifacts[0].editablePath, currentPrdPath);
    assert.equal(result.selected.artifacts[0].impactLabel, "产品需求变更");
    assert.equal(result.selected.artifacts[0].content, "# Current PRD");
    assert.equal(result.selected.artifacts[1].source, "artifact");
    assert.equal(result.selected.artifacts[1].path, runPrdPath);
    assert.equal(result.selected.artifacts[1].editablePath, null);
    assert.equal(result.selected.artifacts[1].content, "# Run PRD");
  });

  it("assigns refine spec artifact and chat events without requiring a run", () => {
    const specPath = path.join(changeDir, "spec.md");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Refine",
      runs: [],
      events: [
        {
          id: "EVT-001",
          changeId,
          runId: null,
          type: "chat_user",
          message: "idea",
          rawJson: null,
          createdAt: now,
        },
        {
          id: "EVT-002",
          changeId,
          runId: null,
          type: "change_status_changed",
          message: "Status -> DRAFT",
          rawJson: null,
          createdAt: now,
        },
      ],
      artifacts: [
        {
          id: "ART-001",
          changeId,
          runId: null,
          type: "spec",
          path: specPath,
          createdAt: now,
        },
      ],
      fileContents: {
        [specPath]: "# Spec",
      },
    });

    assert.equal(result.selected.phase, "Refine");
    assert.equal(result.selected.artifacts.length, 1);
    assert.equal(result.selected.artifacts[0].type, "spec");
    assert.deepEqual(result.selected.events.map((event) => event.id), ["EVT-001"]);
  });

  it("creates current check artifacts from known change files and omits missing files", () => {
    const localCheckPath = path.join(changeDir, "local-check.json");
    const findingsPath = path.join(changeDir, "findings.json");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Check",
      runs: [
        {
          id: "RUN-001",
          changeId,
          phase: "local_check",
          status: "failed",
          startedAt: now,
          endedAt: now,
          summary: "Checks: CHECK_FAILED",
        },
      ],
      events: [],
      artifacts: [],
      fileContents: {
        [localCheckPath]: "{\"success\":false}",
        [findingsPath]: undefined,
      },
    });

    assert.equal(result.selected.phase, "Check");
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.type), [
      "local_check",
    ]);
    assert.equal(result.selected.artifacts[0].source, "current");
    assert.equal(result.selected.artifacts[0].editablePath, localCheckPath);
    assert.equal(result.selected.artifacts[0].impactLabel, "本地检查结果");
    assert.equal(result.selected.artifacts[0].content, "{\"success\":false}");
  });

  it("does not expose raw Review output content through phase review artifacts", () => {
    const rawOutputPath = path.join(changeDir, "runs", "RUN-001", "raw-review-output.json");
    const stageRawOutputPath = path.join(changeDir, "runs", "RUN-001", "raw-ai-output.json");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Review",
      runs: [
        {
          id: "RUN-001",
          changeId,
          phase: "review",
          status: "completed",
          startedAt: now,
          endedAt: now,
          summary: "review",
        },
      ],
      events: [],
      artifacts: [
        {
          id: "ART-RAW",
          changeId,
          runId: "RUN-001",
          type: "raw_review_output",
          path: rawOutputPath,
          createdAt: now,
        },
        {
          id: "ART-STAGE-RAW",
          changeId,
          runId: "RUN-001",
          type: "stage_raw_output",
          path: stageRawOutputPath,
          createdAt: now,
        },
      ],
      fileContents: {
        [rawOutputPath]: "{\"raw\":\"full provider transcript with secrets\"}",
        [stageRawOutputPath]: "{\"rawText\":\"full provider transcript with secrets\"}",
      },
    });

    assert.equal(result.selected.artifacts.length, 2);
    assert.equal(result.selected.artifacts[0].type, "raw_review_output");
    assert.equal(result.selected.artifacts[0].content, null);
    assert.equal(result.selected.artifacts[0].editablePath, null);
    assert.equal(result.selected.artifacts[0].advanced, true);
    assert.equal(result.selected.artifacts[0].missing, false);
    assert.equal(result.selected.artifacts[1].type, "stage_raw_output");
    assert.equal(result.selected.artifacts[1].content, null);
    assert.equal(result.selected.artifacts[1].editablePath, null);
    assert.equal(result.selected.artifacts[1].advanced, true);
    assert.equal(result.selected.artifacts[1].missing, false);
  });

  it("keeps Review mirror artifacts metadata-only and read-only", () => {
    const reviewReportPath = path.join(changeDir, "review-report.md");
    const reviewFindingsPath = path.join(changeDir, "review-findings.json");
    const runReviewReportPath = path.join(changeDir, "runs", "RUN-001", "review-report.md");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Review",
      runs: [],
      events: [],
      artifacts: [
        {
          id: "ART-REPORT",
          changeId,
          runId: null,
          type: "review_report",
          path: runReviewReportPath,
          createdAt: now,
        },
      ],
      fileContents: {
        [reviewReportPath]: "# Full DB mirror report",
        [reviewFindingsPath]: "[{\"severity\":\"P1\",\"evidence\":\"full evidence\"}]",
        [runReviewReportPath]: "# Historical mirror report",
      },
    });

    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.id), [
      "current:Review:review-report.md",
      "current:Review:review-findings.json",
      "ART-REPORT",
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.content), [
      null,
      null,
      null,
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.editablePath), [
      null,
      null,
      null,
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.advanced), [
      true,
      true,
      true,
    ]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.missing), [
      false,
      false,
      false,
    ]);
  });

  it("keeps nested report current artifacts read-only", () => {
    const specReportPath = path.join(changeDir, "reports", "spec-report.md");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Spec",
      runs: [],
      events: [],
      artifacts: [],
      fileContents: {
        [specReportPath]: "# Spec Report",
      },
    });

    const report = result.selected.artifacts.find((artifact) => artifact.fileName === "reports/spec-report.md");
    assert.ok(report);
    assert.equal(report.editablePath, null);
  });

  it("selects the latest run by default and filters artifacts and events to that run", () => {
    const olderPath = path.join(changeDir, "runs", "RUN-001", "plan.md");
    const newerPath = path.join(changeDir, "runs", "RUN-002", "plan.md");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Plan",
      runs: [
        {
          id: "RUN-001",
          changeId,
          phase: "generate_plan",
          status: "completed",
          startedAt: "2026-06-20T00:00:00.000Z",
          endedAt: "2026-06-20T00:00:01.000Z",
          summary: "Older plan",
        },
        {
          id: "RUN-002",
          changeId,
          phase: "generate_plan",
          status: "completed",
          startedAt: "2026-06-20T00:01:00.000Z",
          endedAt: "2026-06-20T00:01:01.000Z",
          summary: "Newer plan",
        },
      ],
      events: [
        { id: "EVT-001", changeId, runId: "RUN-001", type: "run_completed", message: "older", rawJson: null, createdAt: now },
        { id: "EVT-002", changeId, runId: "RUN-002", type: "run_completed", message: "newer", rawJson: null, createdAt: now },
      ],
      artifacts: [
        { id: "ART-001", changeId, runId: "RUN-001", type: "plan_md", path: olderPath, createdAt: now },
        { id: "ART-002", changeId, runId: "RUN-002", type: "plan_md", path: newerPath, createdAt: now },
      ],
      fileContents: {
        [olderPath]: "# Older",
        [newerPath]: "# Newer",
      },
    });

    assert.equal(result.selected.selectedRunId, "RUN-002");
    assert.deepEqual(result.selected.runs.map((run) => run.id), ["RUN-001", "RUN-002"]);
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.id), ["ART-002"]);
    assert.deepEqual(result.selected.events.map((event) => event.id), ["EVT-002"]);
  });

  it("can select a specific run for a phase", () => {
    const olderPath = path.join(changeDir, "runs", "RUN-001", "plan.md");
    const newerPath = path.join(changeDir, "runs", "RUN-002", "plan.md");
    const result = buildPhaseReview({
      changeId,
      repoPath,
      selectedPhase: "Plan",
      selectedRunId: "RUN-001",
      runs: [
        { id: "RUN-001", changeId, phase: "generate_plan", status: "completed", startedAt: "2026-06-20T00:00:00.000Z", endedAt: now, summary: "Older" },
        { id: "RUN-002", changeId, phase: "generate_plan", status: "completed", startedAt: "2026-06-20T00:01:00.000Z", endedAt: now, summary: "Newer" },
      ],
      events: [
        { id: "EVT-001", changeId, runId: "RUN-001", type: "run_completed", message: "older", rawJson: null, createdAt: now },
        { id: "EVT-002", changeId, runId: "RUN-002", type: "run_completed", message: "newer", rawJson: null, createdAt: now },
      ],
      artifacts: [
        { id: "ART-001", changeId, runId: "RUN-001", type: "plan_md", path: olderPath, createdAt: now },
        { id: "ART-002", changeId, runId: "RUN-002", type: "plan_md", path: newerPath, createdAt: now },
      ],
      fileContents: {
        [olderPath]: "# Older",
        [newerPath]: "# Newer",
      },
    });

    assert.equal(result.selected.selectedRunId, "RUN-001");
    assert.deepEqual(result.selected.artifacts.map((artifact) => artifact.id), ["ART-001"]);
    assert.deepEqual(result.selected.events.map((event) => event.id), ["EVT-001"]);
  });
});

describe("phase review page source", () => {
  const pageSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/page.tsx"
    ),
    "utf-8"
  );
  const phaseRailSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/phase-rail.tsx"
    ),
    "utf-8"
  );
  const pipelinePageShellSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx"
    ),
    "utf-8"
  );
  const phaseReviewPanelSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/phase-review-panel.tsx"
    ),
    "utf-8"
  );
  const changePhaseMapSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/change-phase-map.ts"
    ),
    "utf-8"
  );
  const gatePanelSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/gate-panel.tsx"
    ),
    "utf-8"
  );
  const gateTypesSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/gate-types.ts"
    ),
    "utf-8"
  );
  const changeApiSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/change-api-client.ts"
    ),
    "utf-8"
  );
  const changeCommandsSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/use-change-commands.ts"
    ),
    "utf-8"
  );
  const pipelineActionsSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/use-pipeline-actions.ts"
    ),
    "utf-8"
  );
  // Request building and the gate-version-drift retry live here rather than in
  // the hook, so they can be exercised without a React renderer.
  const pipelineActionRunnerSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/pipeline-action-runner.ts"
    ),
    "utf-8"
  );
  const pipelineActionCommandsSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/pipeline-action-commands.ts"
    ),
    "utf-8"
  );
  const specBattlefieldSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "app/projects/[id]/changes/[changeId]/spec-battlefield.tsx"
    ),
    "utf-8"
  );

  it("renders phase bar items as buttons that can select review phases", () => {
    const phaseBarStart = phaseRailSource.indexOf("function PhaseBar");
    assert.notEqual(phaseBarStart, -1, "PhaseBar should exist");

    const phaseBarEnd = phaseRailSource.indexOf("function VerticalPhaseRail", phaseBarStart);
    const phaseBarSource = phaseRailSource.slice(phaseBarStart, phaseBarEnd);

    assert.match(phaseBarSource, /onSelectPhase/);
    assert.match(phaseBarSource, /selectedPhase/);
    assert.match(phaseBarSource, /<PipelineStageItem/);
  });

  it("keeps selectedPhase as local page state for in-page switching", () => {
    assert.match(pageSource, /const \[selectedPhase, setSelectedPhase\] = useState/);
    assert.match(pageSource, /<PipelinePageShell[\s\S]*selectedPhase=\{activeSelectedPhase\}[\s\S]*onSelectPhase=\{handleSelectPhase\}/);
  });

  it("renders a desktop vertical phase rail in a sticky right sidebar", () => {
    const railStart = phaseRailSource.indexOf("function VerticalPhaseRail");
    assert.notEqual(railStart, -1, "VerticalPhaseRail should exist");

    const railSource = phaseRailSource.slice(railStart);

    assert.match(railSource, /onSelectPhase/);
    assert.match(railSource, /selectedPhase/);
    assert.match(railSource, /<PipelineStageItem/);
    assert.match(pipelinePageShellSource, /<aside className="hidden lg:block">/);
    assert.match(pipelinePageShellSource, /className="sticky top-6"/);
  });

  it("fetches read-only phase review data through the phases endpoint", () => {
    const panelStart = phaseReviewPanelSource.indexOf("export function PhaseReviewPanel");
    assert.notEqual(panelStart, -1, "PhaseReviewPanel should exist");

    const panelSource = phaseReviewPanelSource.slice(panelStart);

    assert.match(panelSource, /new URLSearchParams\(\{ phase \}\)/);
    assert.match(panelSource, /\/phases\?\$\{query\.toString\(\)\}/);
    assert.doesNotMatch(panelSource, /handleAction/);
    assert.doesNotMatch(panelSource, /ACTION_ENDPOINTS/);
  });

  it("renders the v2 pipeline phases in the change phase bar", () => {
    assert.match(changePhaseMapSource, /Intake/);
    assert.match(changePhaseMapSource, /TechSpec/);
    assert.match(changePhaseMapSource, /TestPlan/);
    assert.match(changePhaseMapSource, /Merge/);
    assert.match(changePhaseMapSource, /Retro/);
    assert.match(changePhaseMapSource, /INTAKE_READY/);
    assert.match(changePhaseMapSource, /MERGE_READY/);
  });

  it("loads and renders gate confirmation state with artifact preview", () => {
    assert.match(gateTypesSource, /interface GateStatus/);
    assert.match(changeApiSource, /\/gate`/);
    assert.match(gatePanelSource, /待确认/);
    assert.match(pageSource, /gateStageActions/);
    assert.match(pageSource, /gateApproveLabel/);
    assert.match(pageSource, /gateRejectLabel/);
    assert.match(gatePanelSource, /pendingArtifact/);
    assert.match(gatePanelSource, /formatArtifactHint\(gateStatus\.pendingArtifact\)/);
    assert.doesNotMatch(gatePanelSource, /\{gateStatus\.pendingArtifact\}\s*<\/pre>/);
  });

  it("approves gates through gate api while keeping Spec start explicit", () => {
    assert.match(pageSource, /useChangeCommands\(\{/);
    // The page hands handleApproveGate to buildGateStageActions, which wires it
    // onto the approve button.
    assert.match(pageSource, /onApprove: handleApproveGate/);
    assert.match(gatePanelSource, /onAction: input\.onApprove/);
    assert.match(changeCommandsSource, /GATE_NEXT_STAGE_ENDPOINTS/);
    assert.match(changeCommandsSource, /intake:\s*"spec"/);
    assert.match(changeCommandsSource, /spec:\s*"tech-spec"/);
    assert.match(changeCommandsSource, /tech_spec:\s*"plan"/);
    assert.doesNotMatch(changeCommandsSource, /tech_spec:\s*"test-plan"/);
    assert.match(changeCommandsSource, /merge:\s*"release"/);
    assert.match(changeCommandsSource, /\/gate\/approve/);
    assert.match(changeCommandsSource, /\/gate\/reject/);
    assert.match(changeCommandsSource, /if \(gateStatus\.gate !== "spec"\)/);
    assert.match(gatePanelSource, /function gateApprovalActionId/);
    assert.match(changeCommandsSource, /GATE_NEXT_STAGE_ACTION_IDS/);
    assert.match(changeCommandsSource, /intake:\s*"run_spec"/);
    assert.match(changeCommandsSource, /spec:\s*"run_tech_spec"/);
    assert.match(changeCommandsSource, /tech_spec:\s*"run_plan"/);
    assert.match(changeCommandsSource, /const approveAction = gateApprovalAction\(gateStatus\)/);
    assert.match(gatePanelSource, /approveAction=\{approveAction\}/);
    assert.match(gatePanelSource, /pipelineActionDisabledReason\(approveAction\)/);
    assert.match(changeCommandsSource, /expectedGateVersion: approveAction\?\.gateVersion/);
    assert.match(changeCommandsSource, /expectedSourceDbHash: approveAction\?\.sourceDbHash/);
    assert.match(changeCommandsSource, /const nextAction = nextActionId \? findPipelineAction\(latestGateStatus\.actions, nextActionId\) : null/);
    assert.match(changeCommandsSource, /createPipelinePreflightPayload\(nextAction\)/);
    assert.match(specBattlefieldSource, /const canApproveGate = approveAction\?\.enabled === true/);
    assert.doesNotMatch(specBattlefieldSource, /const canApproveGate = specBattle\.actions\.approve\.available/);
    assert.doesNotMatch(pipelineActionsSource, /const ACTION_ENDPOINTS/);
    assert.match(pipelineActionCommandsSource, /run_tech_spec: "tech-spec"/);
    assert.match(pipelineActionCommandsSource, /retry_tech_spec: "tech-spec"/);
    assert.doesNotMatch(pipelineActionCommandsSource, /approve_tech_spec: "tech-spec"/);
    assert.match(pipelineActionCommandsSource, /run_test_plan: "test-plan"/);
    assert.match(pageSource, /visibleContractActions/);
    assert.doesNotMatch(pageSource, /change\.status === "SPEC_READY" && change\.gateState !== "spec"/);
    assert.match(pipelineActionRunnerSource, /resolvePipelineActionCommand\(actionId\)/);
    assert.match(pipelineActionRunnerSource, /findPipelineAction\(actions, actionId\)/);
    // A failed action has to release the busy state and re-read the server, or
    // the button that triggered it stays disabled with nothing explaining why.
    assert.match(pipelineActionsSource, /setRunning\(effect\.running\);[\s\S]*if \(effect\.refresh\) void refresh\(\);/);
    assert.match(pipelineActionRunnerSource, /running: false,[\s\S]*refresh: result\.outcome === "rejected"/);
  });

  it("renders Spec Battle as a two-panel battlefield and calls battle APIs", () => {
    const gateStart = gatePanelSource.indexOf("function GatePanel");
    assert.notEqual(gateStart, -1, "GatePanel should exist");
    const gateSource = gatePanelSource.slice(gateStart);
    const specBranchStart = gateSource.indexOf("const specBattle = gateStatus?.specBattle ?? specBattleFallback");
    assert.notEqual(specBranchStart, -1, "Spec battle branch should exist");
    const specBranchEnd = gateSource.indexOf("if (!gateStatus?.atGate)", specBranchStart);
    const specBranch = gateSource.slice(specBranchStart, specBranchEnd);

    assert.match(gatePanelSource, /import \{ SpecBattlefield \} from "\.\/spec-battlefield";/);
    assert.match(specBranch, /specBattleFallback/);
    assert.match(specBranch, /gateStatus\?\.specBattle \?\? specBattleFallback/);
    assert.match(specBranch, /<SpecBattlefield/);
    assert.match(specBranch, /onAcceptRisk=\{onAcceptRisk\}/);
    assert.match(specBranch, /onStopBattle=\{onStopBattle\}/);
    assert.match(specBranch, /onBattleDecision=\{onBattleDecision\}/);
    assert.match(specBranch, /onRestartBattle=\{onRestartBattle\}/);
    assert.match(specBranch, /onRegenerateReport=\{onRegenerateReport\}/);
    assert.match(specBranch, /battleState=\{specBattleState\}/);
    assert.doesNotMatch(specBranch, />Approve</);
    assert.doesNotMatch(specBranch, />打回</);
    assert.doesNotMatch(specBranch, /产物预览/);
    assert.match(changeApiSource, /\/spec-battle`/);
    assert.doesNotMatch(pageSource, /<h4 className="text-sm font-medium">Spec Battle<\/h4>/);
    assert.match(specBattlefieldSource, /Spec 回合战场/);
    assert.match(specBattlefieldSource, />战场</);
    assert.match(specBattlefieldSource, />本轮战报</);
    assert.match(specBattlefieldSource, /继续对抗一轮/);
    assert.match(specBattlefieldSource, /继续追加一轮/);
    assert.match(specBattlefieldSource, /重跑本轮/);
    assert.match(specBattlefieldSource, /onRestartBattle\(\)/);
    assert.match(specBattlefieldSource, /刷新战报/);
    assert.match(specBattlefieldSource, /接受风险并通过/);
    assert.match(specBattlefieldSource, /终止 Battle/);
    assert.match(specBattlefieldSource, /高级详情/);
    assert.doesNotMatch(specBattlefieldSource, /Spec Battle RTS Command/);
    assert.doesNotMatch(specBattlefieldSource, /固定单位/);
    assert.doesNotMatch(specBattlefieldSource, /要求修改/);
    assert.doesNotMatch(specBattlefieldSource, /退回 Spec/);
    assert.doesNotMatch(specBattlefieldSource, /豁免 P1/);
    assert.doesNotMatch(specBattlefieldSource, /P1 豁免目标/);
    assert.doesNotMatch(specBattlefieldSource, /证据链/);
    assert.doesNotMatch(specBattlefieldSource, /人工命令记录/);
    assert.doesNotMatch(specBattlefieldSource, /approve \/ request \/ return \/ waive/);
    assert.doesNotMatch(specBattlefieldSource, /onBattleDecision\("approve"\)/);
    assert.doesNotMatch(specBattlefieldSource, /onBattleDecision\("reject"\)/);
    assert.match(pageSource, /\/spec-battle\/report/);
    assert.match(pageSource, /\/spec-battle\/decision/);
    assert.match(pageSource, /\/spec/);
    assert.match(gatePanelSource, /requirementGapsPassed/);
    assert.match(gatePanelSource, /mergeBlockingRequirementGaps/);
  });

  it("keeps the Spec battlefield visible while a battle round is running", () => {
    assert.match(pageSource, /buildRunningSpecBattleGateState/);
    assert.match(pageSource, /activeSpecBattleFallback/);
    assert.match(pageSource, /change\.status === "SPECCING"/);
    assert.match(pageSource, /change\.status === "BLOCKED" && change\.blockedPhase === "spec"/);
    assert.match(gatePanelSource, /battleState\?\.latestRound/);
    assert.match(gatePanelSource, /\["not_started", "red_running", "blue_running", "failed"\]\.includes\(latestRound\.status\)/);
    assert.match(pageSource, /specBattleFallback=\{activeSpecBattleFallback\}/);
    assert.match(gatePanelSource, /gateStatus\?\.specBattle \?\? specBattleFallback/);
    assert.match(specBattlefieldSource, /Battle 失败/);
    assert.match(specBattlefieldSource, /等待启动/);
  });

  it("starts waiting and restarts failed Spec Battle rounds through the Spec preflight contract", () => {
    const restartStart = changeCommandsSource.indexOf("const handleRestartSpecBattle");
    assert.notEqual(restartStart, -1, "handleRestartSpecBattle should exist");
    const restartEnd = changeCommandsSource.indexOf("const handleApprovePlanSandbox", restartStart);
    const restartSource = changeCommandsSource.slice(restartStart, restartEnd);

    assert.match(restartSource, /findPipelineAction\(gateStatus\?\.actions, "run_spec"\)/);
    assert.match(restartSource, /findPipelineAction\(gateStatus\?\.actions, "retry_spec"\)/);
    assert.match(restartSource, /const action = retryAction\?\.enabled \? retryAction : runAction/);
    assert.match(restartSource, /pipelineActionDisabledReason\(action\)/);
    assert.match(restartSource, /\/spec`/);
    assert.match(restartSource, /headers: \{ "Content-Type": "application\/json" \}/);
    assert.match(restartSource, /createPipelinePreflightPayload\(action, \{ provider: selectedProvider \}\)/);
    assert.doesNotMatch(restartSource, /fetch\(`[^`]+\/spec`,\s*\{\s*method: "POST",\s*\}\)/);
    assert.match(pageSource, /onRestartBattle=\{handleRestartSpecBattle\}/);
  });

  it("stops Spec Battle through the block endpoint instead of gate rejection", () => {
    const stopStart = pageSource.indexOf("const handleStopSpecBattle");
    assert.notEqual(stopStart, -1, "handleStopSpecBattle should exist");
    const stopEnd = pageSource.indexOf("const handleRegenerateSpecBattleReport", stopStart);
    const stopSource = pageSource.slice(stopStart, stopEnd);

    assert.match(stopSource, /\/block/);
    assert.match(stopSource, /phase: "spec"/);
    assert.match(stopSource, /Spec Battle terminated by human/);
    assert.match(pageSource, /onStopBattle=\{handleStopSpecBattle\}/);
    assert.doesNotMatch(pageSource, /onStopBattle=\{handleRejectGate\}/);
  });

  it("keeps P1 risk target selection inside advanced details", () => {
    assert.match(specBattlefieldSource, /<details className=/);
    assert.match(specBattlefieldSource, /id="accept-risk-gap"/);
    assert.match(specBattlefieldSource, /p1Targets\.map/);
    assert.match(specBattlefieldSource, /selectedP1Gap/);
    assert.doesNotMatch(specBattlefieldSource, /waive-gap-target/);
    assert.doesNotMatch(specBattlefieldSource, /waiveUnavailableReason/);
    assert.doesNotMatch(specBattlefieldSource, /targetId.*<input/);
    assert.doesNotMatch(specBattlefieldSource, /gap id/i);
    // Inside the details, but never below two candidates: at `> 1` a lone
    // waivable P1 was accepted without the screen ever naming it. The rendered
    // proof lives in phase-review.test.ts.
    assert.match(specBattlefieldSource, /\{p1Targets\.length > 0 && \(/);
    assert.doesNotMatch(specBattlefieldSource, /p1Targets\.length > 1/);
    assert.match(specBattlefieldSource, /waiveP1GapHint\(p1Targets\.length\)/);
  });

  it("refreshes both gate and battle state after report and human battle commands", () => {
    const reportStart = pageSource.indexOf("const handleRegenerateSpecBattleReport");
    assert.notEqual(reportStart, -1, "handleRegenerateSpecBattleReport should exist");
    const reportEnd = pageSource.indexOf("const handleSpecBattleDecision", reportStart);
    const reportSource = pageSource.slice(reportStart, reportEnd);

    assert.match(reportSource, /\/spec-battle\/report/);
    assert.match(reportSource, /loadGateStatus\(\)/);
    assert.match(reportSource, /loadSpecBattleState\(\)/);

    const decisionStart = pageSource.indexOf("const handleSpecBattleDecision");
    assert.notEqual(decisionStart, -1, "handleSpecBattleDecision should exist");
    const decisionEnd = pageSource.indexOf("const handleSelectPhase", decisionStart);
    const decisionSource = pageSource.slice(decisionStart, decisionEnd);

    assert.match(decisionSource, /\/spec-battle\/decision/);
    assert.match(decisionSource, /load\(\)/);
    assert.match(decisionSource, /loadGateStatus\(\)/);
    assert.match(decisionSource, /loadSpecBattleState\(\)/);
  });

  it("accepts P1 risk through waive, report refresh, and fresh approve", () => {
    const acceptStart = pageSource.indexOf("const handleAcceptSpecBattleRisk");
    assert.notEqual(acceptStart, -1, "handleAcceptSpecBattleRisk should exist");
    const acceptEnd = pageSource.indexOf("const handleSelectPhase", acceptStart);
    const acceptSource = pageSource.slice(acceptStart, acceptEnd);

    assert.match(acceptSource, /action: "waive_p1"/);
    assert.match(acceptSource, /\/spec-battle\/report/);
    assert.match(acceptSource, /\/gate\/approve/);
    assert.match(acceptSource, /expectedGateVersion: approveAction\?\.gateVersion/);
    assert.match(acceptSource, /expectedSourceDbHash: approveAction\?\.sourceDbHash/);
    assert.doesNotMatch(acceptSource, /action: "approve"/);
    assert.match(pageSource, /onAcceptRisk=\{handleAcceptSpecBattleRisk\}/);
  });
});
