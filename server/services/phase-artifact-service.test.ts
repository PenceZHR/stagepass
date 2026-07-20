import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  PHASE_ARTIFACT_DEFINITIONS,
  canEditPhaseArtifacts,
  resolveEditablePhaseArtifactPath,
  savePhaseArtifactContent,
  toPhaseArtifactMirrorDisplayMetadata,
} from "./phase-artifact-service.ts";
import { markdownArtifactContentFromResult } from "./markdown-artifact-content-service.ts";

describe("phase-artifact-service", () => {
  function assertBareMarkdown(content: string): void {
    assert.equal(content.startsWith("{"), false);
    assert.match(content, /^#/);
  }

  it("defines labels for the core pipeline phase artifacts", () => {
    const byFile = new Map(PHASE_ARTIFACT_DEFINITIONS.map((item) => [item.fileName, item]));

    assert.equal(byFile.get("change-request.md")?.label, "需求入口 / 变更请求");
    assert.equal(byFile.get("prd-intent.md")?.label, "PRD 需求意图");
    assert.equal(byFile.get("briefing-questions.json")?.label, "PRD 澄清问题");
    assert.equal(byFile.get("prd-draft.md")?.label, "PRD 草稿");
    assert.equal(byFile.get("prd-gate.json")?.label, "PRD 锁定门禁");
    assert.equal(byFile.get("prd-delta.md")?.label, "产品需求变更");
    assert.equal(byFile.get("tech-spec-delta.md")?.label, "技术方案变更");
    assert.equal(byFile.get("test-plan-delta.md")?.label, "测试计划变更");
    assert.equal(byFile.get("plan.json")?.label, "实施范围与验证命令");
    assert.equal(byFile.get("release-note.md")?.label, "发布与交付说明");
    assert.equal(byFile.get("retro.md")?.label, "复盘与债务回流");
    assert.equal(byFile.get("reports/spec-report.md")?.label, "Spec 对抗战报");
    assert.equal(byFile.get("reports/war-report.md")?.label, "变更总战报");
    assert.equal(byFile.get("plan-critique.json")?.label, "反方计划审查");
    assert.equal(byFile.get("reports/plan-report.md")?.label, "Plan 作战沙盘报告");
  });

  it("resolves only whitelisted files inside the current change directory", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const resolved = resolveEditablePhaseArtifactPath(repoPath, "CHG-001", ".ship/changes/CHG-001/prd-delta.md");

    assert.equal(resolved, path.join(repoPath, ".ship", "changes", "CHG-001", "prd-delta.md"));
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", ".ship/changes/CHG-001/unknown.md"),
      /not an editable phase artifact/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", ".ship/changes/CHG-002/prd-delta.md"),
      /outside this change/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(
        repoPath,
        "CHG-001",
        ".ship/changes/CHG-001/runs/RUN-001/prd-delta.md"
      ),
      /runs directory/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", ".ship/changes/CHG-001/subdir/prd-delta.md"),
      /root artifact/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", ".ship/changes/CHG-001/reports/spec-report.md"),
      /root artifact/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", "../package.json"),
      /outside the repository/
    );
  });

  it("keeps Plan critique and nested Plan report read-only", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    fs.mkdirSync(path.join(changeDir, "reports"), { recursive: true });

    const planMarkdownPath = path.join(changeDir, "plan.md");
    const planJsonPath = path.join(changeDir, "plan.json");
    const critiquePath = path.join(changeDir, "plan-critique.json");
    const reportPath = path.join(changeDir, "reports", "plan-report.md");

    assert.equal(resolveEditablePhaseArtifactPath(repoPath, "CHG-001", planMarkdownPath), planMarkdownPath);
    assert.equal(resolveEditablePhaseArtifactPath(repoPath, "CHG-001", planJsonPath), planJsonPath);
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", critiquePath),
      /not an editable phase artifact/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", reportPath),
      /root artifact|not an editable phase artifact/
    );

    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: critiquePath,
          content: "{\"risks\":[]}",
        }),
      /not an editable phase artifact/
    );
    assert.equal(fs.existsSync(critiquePath), false);

    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: reportPath,
          content: "# Report\n",
        }),
      /root artifact|not an editable phase artifact/
    );
    assert.equal(fs.existsSync(reportPath), false);
  });

  it("keeps Review DB mirror artifacts read-only", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    fs.mkdirSync(changeDir, { recursive: true });

    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", path.join(changeDir, "review-report.md")),
      /not an editable phase artifact/
    );
    assert.throws(
      () => resolveEditablePhaseArtifactPath(repoPath, "CHG-001", path.join(changeDir, "review-findings.json")),
      /not an editable phase artifact/
    );
  });

  it("formats mirror display data as metadata without using artifact content as stage state", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const mirrorPath = path.join(repoPath, ".ship", "changes", "CHG-001", "plan.json");
    const display = toPhaseArtifactMirrorDisplayMetadata({
      id: "AMR-001",
      changeId: "CHG-001",
      phase: "Plan",
      artifactType: "plan_json",
      path: mirrorPath,
      contentHash: "content-hash",
      sourceDbHash: "source-db-hash",
      schemaVersion: "plan/v1",
      mirrorStatus: "mismatch",
      generatedAt: "2026-06-29T00:00:00.000Z",
    });

    assert.deepEqual(display, {
      id: "AMR-001",
      changeId: "CHG-001",
      phase: "Plan",
      artifactType: "plan_json",
      path: mirrorPath,
      fileName: "plan.json",
      impactLabel: "实施范围与验证命令",
      contentHash: "content-hash",
      sourceDbHash: "source-db-hash",
      schemaVersion: "plan/v1",
      mirrorStatus: "mismatch",
      warnings: ["mirror_mismatch"],
      generatedAt: "2026-06-29T00:00:00.000Z",
      rebuildActionMetadata: {
        changeId: "CHG-001",
        phase: "Plan",
        artifactType: "plan_json",
        path: mirrorPath,
        sourceDbHash: "source-db-hash",
        schemaVersion: "plan/v1",
      },
    });
    assert.equal("content" in display, false);
    assert.equal("passed" in display, false);
    assert.equal("stagePassed" in display, false);
  });

  it("keeps deleted mirror display rebuildable from metadata", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const mirrorPath = path.join(repoPath, ".ship", "changes", "CHG-001", "reports", "plan-report.md");
    const display = toPhaseArtifactMirrorDisplayMetadata({
      id: "AMR-002",
      changeId: "CHG-001",
      phase: "Plan",
      artifactType: "plan_report",
      path: mirrorPath,
      contentHash: "content-hash",
      sourceDbHash: "source-db-hash",
      schemaVersion: "plan-report/v1",
      mirrorStatus: "missing",
      generatedAt: "2026-06-29T00:00:00.000Z",
    });

    assert.equal(fs.existsSync(mirrorPath), false);
    assert.equal(display.fileName, "reports/plan-report.md");
    assert.equal(display.mirrorStatus, "missing");
    assert.deepEqual(display.warnings, ["mirror_missing"]);
    assert.deepEqual(display.rebuildActionMetadata, {
      changeId: "CHG-001",
      phase: "Plan",
      artifactType: "plan_report",
      path: mirrorPath,
      sourceDbHash: "source-db-hash",
      schemaVersion: "plan-report/v1",
    });
  });

  it("blocks editing while the change or latest run is active", () => {
    assert.equal(canEditPhaseArtifacts({ status: "SPEC_READY", latestRunStatus: "completed" }), true);
    const runningStatuses = [
      "REFINING",
      "INTAKE_PENDING",
      "PLANNING",
      "IMPLEMENTING",
      "REVIEWING",
      "CHECKING",
      "FIXING",
      "SPECCING",
      "TECHSPECCING",
      "TESTPLANNING",
      "MERGING",
      "RETRO_PENDING",
    ];

    for (const status of runningStatuses) {
      assert.equal(canEditPhaseArtifacts({ status, latestRunStatus: "completed" }), false, status);
    }
    assert.equal(canEditPhaseArtifacts({ status: "SPEC_READY", latestRunStatus: "running" }), false);
  });

  it("saves markdown artifacts and validates json artifacts before writing", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    fs.mkdirSync(changeDir, { recursive: true });

    const markdownPath = path.join(changeDir, "prd-delta.md");
    savePhaseArtifactContent({
      repoPath,
      changeId: "CHG-001",
      artifactPath: markdownPath,
      content: "# Updated PRD\n",
    });
    assert.equal(fs.readFileSync(markdownPath, "utf-8"), "# Updated PRD\n");

    const jsonPath = path.join(changeDir, "plan.json");
    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: jsonPath,
          content: "{broken",
        }),
      /Invalid JSON/
    );
    assert.equal(fs.existsSync(jsonPath), false);

    savePhaseArtifactContent({
      repoPath,
      changeId: "CHG-001",
      artifactPath: jsonPath,
      content: "{\"allowedFiles\":[]}",
    });
    assert.equal(fs.readFileSync(jsonPath, "utf-8"), "{\"allowedFiles\":[]}");

    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: jsonPath,
          content: "{\"allowedFiles\":",
        }),
      /Invalid JSON/
    );
    assert.equal(fs.readFileSync(jsonPath, "utf-8"), "{\"allowedFiles\":[]}");

    const briefingQuestionsPath = path.join(changeDir, "briefing-questions.json");
    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: briefingQuestionsPath,
          content: "{broken",
        }),
      /Invalid JSON/
    );
    assert.equal(fs.existsSync(briefingQuestionsPath), false);

    const prdGatePath = path.join(changeDir, "prd-gate.json");
    savePhaseArtifactContent({
      repoPath,
      changeId: "CHG-001",
      artifactPath: prdGatePath,
      content: "{\"status\":\"pass\"}",
    });
    assert.equal(fs.readFileSync(prdGatePath, "utf-8"), "{\"status\":\"pass\"}");
  });

  it("saves core markdown mirrors as bare Markdown instead of JSON envelopes", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    fs.mkdirSync(changeDir, { recursive: true });

    const cases = [
      { fileName: "prd-draft.md", content: "# PRD Draft\n\nDraft body.\n" },
      { fileName: "release-note.md", content: "# Release\n\nRelease body.\n" },
      { fileName: "retro.md", content: "# Retro\n\nRetro body.\n" },
    ];

    for (const item of cases) {
      const artifactPath = path.join(changeDir, item.fileName);
      savePhaseArtifactContent({
        repoPath,
        changeId: "CHG-001",
        artifactPath,
        content: item.content,
      });

      assertBareMarkdown(fs.readFileSync(artifactPath, "utf-8"));
    }
  });

  it("unwraps markdown envelopes before document-stage markdown artifacts are written", () => {
    const content = markdownArtifactContentFromResult({
      summary: JSON.stringify({ markdown: "# Wrapped Markdown\n" }),
      structuredOutput: { markdown: "# Wrapped Markdown\n" },
    });

    assert.equal(content.startsWith("{"), false);
    assert.match(content, /^#/);
    assert.equal(content, "# Wrapped Markdown\n");
  });

  it("rejects symlink artifacts that escape the repository", (t) => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-outside-"));
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    fs.mkdirSync(changeDir, { recursive: true });

    const externalFile = path.join(externalDir, "plan.json");
    const symlinkPath = path.join(changeDir, "plan.json");
    fs.writeFileSync(externalFile, "{\"outside\":true}", "utf-8");

    try {
      fs.symlinkSync(externalFile, symlinkPath);
    } catch (error) {
      t.skip(`symlink creation is not supported here: ${String(error)}`);
      return;
    }

    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: symlinkPath,
          content: "{\"allowedFiles\":[]}",
        }),
      /symlink|outside/
    );
    assert.equal(fs.readFileSync(externalFile, "utf-8"), "{\"outside\":true}");

    const externalChangeDir = path.join(externalDir, "linked-change");
    const linkedChangeDir = path.join(repoPath, ".ship", "changes", "CHG-002");
    fs.mkdirSync(externalChangeDir);
    fs.writeFileSync(path.join(externalChangeDir, "plan.json"), "{\"linked\":true}", "utf-8");

    try {
      fs.symlinkSync(externalChangeDir, linkedChangeDir, "dir");
    } catch (error) {
      t.skip(`directory symlink creation is not supported here: ${String(error)}`);
      return;
    }

    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-002",
          artifactPath: path.join(linkedChangeDir, "plan.json"),
          content: "{\"allowedFiles\":[]}",
        }),
      /symlink|outside/
    );
    assert.equal(fs.readFileSync(path.join(externalChangeDir, "plan.json"), "utf-8"), "{\"linked\":true}");
  });

  it("rejects when the current change directory is a symlink to another change", (t) => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-artifact-"));
    const changesDir = path.join(repoPath, ".ship", "changes");
    const realChangeDir = path.join(changesDir, "CHG-002");
    const linkedChangeDir = path.join(changesDir, "CHG-001");
    fs.mkdirSync(realChangeDir, { recursive: true });

    const targetPlanPath = path.join(realChangeDir, "plan.json");
    fs.writeFileSync(targetPlanPath, "{\"target\":true}", "utf-8");

    try {
      fs.symlinkSync(realChangeDir, linkedChangeDir, "dir");
    } catch (error) {
      t.skip(`directory symlink creation is not supported here: ${String(error)}`);
      return;
    }

    assert.throws(
      () =>
        savePhaseArtifactContent({
          repoPath,
          changeId: "CHG-001",
          artifactPath: path.join(linkedChangeDir, "plan.json"),
          content: "{\"allowedFiles\":[]}",
        }),
      /symlink/
    );
    assert.equal(fs.readFileSync(targetPlanPath, "utf-8"), "{\"target\":true}");
  });
});
