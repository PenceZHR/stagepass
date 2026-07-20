import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  BASELINE_DOCS,
  listBaselineDocs,
  readBaselineDoc,
  recordDecision,
  scaffoldBaseline,
  updateChangelog,
} from "./baseline-service.ts";

const BASELINE_TEMPLATES_DIR = path.join(process.cwd(), "server", "templates", "baseline");

describe("baseline-service scaffold", () => {
  it("creates the baseline document set without overwriting existing content", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-scaffold-"));

    try {
      const baselineDir = path.join(repoPath, ".ship", "baseline");
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(path.join(baselineDir, "prd.md"), "# Existing PRD\n", "utf-8");

      const files = scaffoldBaseline(repoPath);

      assert.equal(files.length, BASELINE_DOCS.length);
      for (const doc of BASELINE_DOCS) {
        const filePath = path.join(baselineDir, doc.name);
        assert.equal(fs.existsSync(filePath), true, `${doc.name} should exist`);
      }
      assert.equal(fs.readFileSync(path.join(baselineDir, "prd.md"), "utf-8"), "# Existing PRD\n");
      assert.match(
        fs.readFileSync(path.join(baselineDir, "tech-spec.md"), "utf-8"),
        /template: baseline\/tech-spec\.md/
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("baseline-service templates", () => {
  it("ships one frontmatter template for every baseline document", () => {
    for (const doc of BASELINE_DOCS) {
      const templatePath = path.join(BASELINE_TEMPLATES_DIR, doc.name);
      assert.equal(fs.existsSync(templatePath), true, `${doc.name} template should exist`);

      const content = fs.readFileSync(templatePath, "utf-8");
      assert.match(content, /^---\n/);
      assert.match(content, new RegExp(`template: baseline/${doc.name.replace(".", "\\.")}`));
      assert.match(content, new RegExp(`# ${doc.title}`));
    }
  });
});

describe("baseline-service readers", () => {
  it("lists and reads scaffolded baseline documents", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-readers-"));

    try {
      const docs = listBaselineDocs(repoPath);
      assert.equal(docs.length, BASELINE_DOCS.length);
      assert.equal(docs.every((doc) => doc.status === "present"), true);

      const techSpec = readBaselineDoc(repoPath, "tech-spec.md");
      assert.equal(techSpec.name, "tech-spec.md");
      assert.match(techSpec.content, /# Technical Specification Baseline/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects unknown baseline document names", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-invalid-"));

    try {
      assert.throws(
        () => readBaselineDoc(repoPath, "../secrets.md"),
        /Invalid baseline document name/
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("baseline-service changelog", () => {
  it("creates and appends a changelog entry under .ship/baseline", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-service-"));

    try {
      const changelogPath = updateChangelog(repoPath, {
        changeId: "CHG-T41",
        summary: "用户可见变化：新增人工门 UI",
        createdAt: "2026-06-23T00:00:00.000Z",
      });
      const changelog = fs.readFileSync(changelogPath, "utf-8");

      assert.equal(changelogPath, path.join(repoPath, ".ship", "baseline", "changelog.md"));
      assert.match(changelog, /^# Changelog/);
      assert.match(changelog, /CHG-T41/);
      assert.match(changelog, /用户可见变化：新增人工门 UI/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe("baseline-service ADR decisions", () => {
  it("records a tech decision as an ADR under .ship/baseline", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-decision-"));

    try {
      const decisionsPath = recordDecision(repoPath, {
        changeId: "CHG-T42",
        title: "Use gate status as stage entry",
        context: "Gate approval must not skip T2.7 stage preconditions.",
        decision: "Keep *_READY statuses as the canonical next stage entry.",
        consequences: "Frontend approves gate, then starts the corresponding stage route.",
        createdAt: "2026-06-23T00:00:00.000Z",
      });
      const decisions = fs.readFileSync(decisionsPath, "utf-8");

      assert.equal(decisionsPath, path.join(repoPath, ".ship", "baseline", "decisions.md"));
      assert.match(decisions, /^# Decisions/);
      assert.match(decisions, /ADR: Use gate status as stage entry/);
      assert.match(decisions, /CHG-T42/);
      assert.match(decisions, /Keep \*_READY statuses as the canonical next stage entry/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
