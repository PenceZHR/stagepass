import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { like } from "drizzle-orm";
import type { FindingScope, PlanScope, WorkspaceMutation } from "./stage-guard-service";

import { db } from "../db/index.ts";
import {
  changes,
  planSnapshots,
  projects,
  requiredValidationCommands,
} from "../db/schema.ts";
import {
  DEFAULT_STAGE_SCOPES,
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  loadDbPlanScope,
  loadPolicy,
  matchesGlob,
  resolveReadableFiles,
  validatePlannedChanges,
  validateFixScope,
  validateImplementScope,
  validateLocalCheckScope,
  validateReadOnlyStage,
} from "./stage-guard-service.ts";

const PROJECT_ID_PREFIX = "PRJ-STAGE-GUARD-";
const CHANGE_ID_PREFIX = "CHG-STAGE-GUARD-";
let testCounter = 0;
let projectId = `${PROJECT_ID_PREFIX}initial`;
let changeId = `${CHANGE_ID_PREFIX}initial`;

function writeFile(root: string, file: string, content: string) {
  const filePath = path.join(root, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function cleanupDbRows() {
  db.delete(requiredValidationCommands)
    .where(like(requiredValidationCommands.changeId, `${CHANGE_ID_PREFIX}%`))
    .run();
  db.delete(planSnapshots).where(like(planSnapshots.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(changes).where(like(changes.id, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(projects).where(like(projects.id, `${PROJECT_ID_PREFIX}%`)).run();
}

function seedChange(repoPath: string) {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: projectId,
    name: "Stage Guard",
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
    id: changeId,
    projectId,
    title: "Stage guard change",
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
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe("stage-guard-service", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupDbRows();
    testCounter += 1;
    projectId = `${PROJECT_ID_PREFIX}${process.pid}-${testCounter}`;
    changeId = `${CHANGE_ID_PREFIX}${process.pid}-${testCounter}`;
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stage-guard-"));
    writeFile(repoPath, ".ship/policy.json", JSON.stringify({
      blockedFiles: [],
      blockedGlobs: ["secrets/**"],
    }));
    writeFile(repoPath, "src/app.ts", "export const value = 1;\n");
  });

  afterEach(() => {
    cleanupDbRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("detects created, modified, and deleted files without requiring git", () => {
    const before = captureWorkspaceSnapshot(repoPath);

    writeFile(repoPath, "src/app.ts", "export const value = 2;\n");
    writeFile(repoPath, "src/new.ts", "export const created = true;\n");
    fs.rmSync(path.join(repoPath, ".ship/policy.json"));

    const after = captureWorkspaceSnapshot(repoPath);
    const mutations = diffWorkspaceSnapshots(before, after);

    assert.deepEqual(
      mutations.map((mutation: WorkspaceMutation) => `${mutation.kind}:${mutation.path}`).sort(),
      [
        "created:src/new.ts",
        "deleted:.ship/policy.json",
        "modified:src/app.ts",
      ]
    );
  });

  it("matches exact files, star patterns, and directory globs", () => {
    assert.equal(matchesGlob("package.json", "package.json"), true);
    assert.equal(matchesGlob(".env.local", ".env*"), true);
    assert.equal(matchesGlob(".github/workflows/ci.yml", ".github/workflows/**"), true);
    assert.equal(matchesGlob("src/app.ts", "src/**"), true);
    assert.equal(matchesGlob("src/app.ts", "server/**"), false);
  });

  it("loads policy and includes built-in blocked patterns", () => {
    const policy = loadPolicy(repoPath);

    assert.equal(policy.blockedGlobs.includes("secrets/**"), true);
    assert.equal(policy.blockedGlobs.includes("package.json"), true);
    assert.equal(policy.blockedGlobs.includes(".env*"), true);
  });

  it("blocks any source mutation in read-only stages", () => {
    const violation = validateReadOnlyStage("generate_plan", [
      { kind: "modified", path: "src/app.ts" },
    ]);

    assert.equal(violation.blocked, true);
    assert.match(violation.message, /generate_plan/);
    assert.deepEqual(violation.files, ["src/app.ts"]);
  });

  it("allows read-only stages to ignore declared system artifacts", () => {
    const violation = validateReadOnlyStage(
      "generate_plan",
      [{ kind: "created", path: ".ship/changes/CHG-001/plan.json" }],
      [".ship/changes/CHG-001/plan.json"]
    );

    assert.equal(violation.blocked, false);
  });

  it("blocks implement changes outside plan.allowedFiles or inside forbidden policy", () => {
    const plan: PlanScope = {
      allowedFiles: ["src/app.ts"],
      forbiddenFiles: ["src/secret.ts"],
    };
    const policy = loadPolicy(repoPath);

    const violation = validateImplementScope(
      [
        { kind: "modified", path: "src/app.ts" },
        { kind: "modified", path: "src/other.ts" },
        { kind: "created", path: "package.json" },
      ],
      plan,
      policy
    );

    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files.sort(), ["package.json", "src/other.ts"]);
  });

  it("blocks implement changes when plan has no allowed files", () => {
    const violation = validateImplementScope(
      [{ kind: "modified", path: "src/app.ts" }],
      { allowedFiles: [], forbiddenFiles: [] },
      loadPolicy(repoPath)
    );

    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files, ["src/app.ts"]);
  });

  it("loads Build scope from the approved DB Plan snapshot instead of tampered plan.json", () => {
    seedChange(repoPath);
    writeFile(
      repoPath,
      `.ship/changes/${changeId}/plan.json`,
      JSON.stringify(
        {
          expectedFiles: ["src/forbidden.ts"],
          forbiddenFiles: [],
          validationCommands: ["echo tampered"],
        },
        null,
        2
      )
    );
    const now = new Date().toISOString();
    db.insert(planSnapshots).values({
      id: `PLAN-SNAP-${process.pid}-${testCounter}`,
      changeId,
      status: "approved",
      sourceSpecHash: "spec-hash",
      expectedFilesJson: JSON.stringify(["src/app.ts"]),
      forbiddenFilesJson: JSON.stringify(["src/forbidden.ts"]),
      validationPolicyHash: "validation-hash",
      approvedAt: now,
      approvalDecisionId: null,
      snapshotDbHash: "db-scope-hash",
      createdAt: now,
    }).run();
    db.insert(requiredValidationCommands).values({
      id: `VAL-CMD-${process.pid}-${testCounter}`,
      changeId,
      phase: "Plan",
      sourceSnapshotId: `PLAN-SNAP-${process.pid}-${testCounter}`,
      command: "pnpm test",
      commandOrder: 1,
      required: 1,
      createdAt: now,
    }).run();

    const scope = loadDbPlanScope(changeId);
    const violation = validateImplementScope(
      [
        { kind: "modified", path: "src/app.ts" },
        { kind: "modified", path: "src/forbidden.ts" },
      ],
      scope,
      loadPolicy(repoPath)
    );

    assert.deepEqual(scope.expectedFiles, ["src/app.ts"]);
    assert.deepEqual(scope.forbiddenFiles, ["src/forbidden.ts"]);
    assert.deepEqual(scope.validationCommands, ["pnpm test"]);
    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files, ["src/forbidden.ts"]);
  });

  it("allows fix changes only for finding files, falling back to plan allowed files when finding file is missing", () => {
    const plan: PlanScope = {
      allowedFiles: ["src/app.ts", "src/from-plan.ts"],
      forbiddenFiles: [],
    };
    const findings: FindingScope[] = [
      { status: "open", file: "src/app.ts" },
      { status: "open" },
      { status: "fixed", file: "src/fixed.ts" },
    ];
    const policy = loadPolicy(repoPath);

    const violation = validateFixScope(
      [
        { kind: "modified", path: "src/app.ts" },
        { kind: "modified", path: "src/from-plan.ts" },
        { kind: "modified", path: "src/fixed.ts" },
      ],
      findings,
      plan,
      policy
    );

    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files, ["src/fixed.ts"]);
  });

  it("blocks fix changes when there are no open finding files or plan fallback files", () => {
    const violation = validateFixScope(
      [{ kind: "modified", path: "src/app.ts" }],
      [],
      { allowedFiles: [], forbiddenFiles: [] },
      loadPolicy(repoPath)
    );

    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files, ["src/app.ts"]);
  });

  it("allows local_check reports but blocks source edits", () => {
    const violation = validateLocalCheckScope("CHG-001", [
      { kind: "created", path: ".ship/changes/CHG-001/local-check.json" },
      { kind: "modified", path: "src/app.ts" },
    ]);

    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files, ["src/app.ts"]);
  });

  it("defines default read/write scopes for every run phase", () => {
    assert.deepEqual(
      [
        "refine",
        "generate_plan",
        "implement",
        "review",
        "local_check",
        "fix_findings",
        "intake",
        "spec",
        "tech_spec",
        "test_plan",
        "release",
        "retro",
      ].filter((phase) => !(phase in DEFAULT_STAGE_SCOPES)),
      []
    );
  });

  it("resolves readable files using the stage read boundary", () => {
    writeFile(repoPath, ".ship/changes/CHG-001/prd-delta.md", "# PRD\n");
    writeFile(repoPath, "src/secret.ts", "export const secret = true;\n");

    const readable = resolveReadableFiles(repoPath, {
      phase: "tech_spec",
      readableFiles: [".ship/changes/CHG-001/prd-delta.md", "src/app.ts"],
      writableFiles: [".ship/changes/CHG-001/tech-spec-delta.md"],
    });

    assert.deepEqual(readable.sort(), [
      ".ship/changes/CHG-001/prd-delta.md",
      "src/app.ts",
    ]);
  });

  it("blocks mutations outside plannedChanges and writableFiles", () => {
    const violation = validatePlannedChanges(
      [
        { kind: "modified", path: "src/app.ts" },
        { kind: "modified", path: "src/other.ts" },
      ],
      {
        phase: "implement",
        readableFiles: ["**"],
        writableFiles: ["src/generated.ts"],
        plannedChanges: ["src/app.ts"],
      }
    );

    assert.equal(violation.blocked, true);
    assert.deepEqual(violation.files, ["src/other.ts"]);
  });

  it("allows .ship mutations outside plannedChanges", () => {
    const violation = validatePlannedChanges(
      [
        { kind: "modified", path: "src/app.ts" },
        { kind: "created", path: ".ship/changes/CHG-001/build-scope.json" },
      ],
      {
        phase: "implement",
        readableFiles: ["**"],
        writableFiles: [],
        plannedChanges: ["src/app.ts"],
      }
    );

    assert.equal(violation.blocked, false);
  });

  it("exempts .ship mutations from legacy scope validators", () => {
    const mutations: WorkspaceMutation[] = [
      { kind: "created", path: ".ship/changes/CHG-001/spec.md" },
    ];
    const policy = loadPolicy(repoPath);

    assert.equal(validateReadOnlyStage("generate_plan", mutations).blocked, false);
    assert.equal(
      validateImplementScope(mutations, { allowedFiles: [], forbiddenFiles: [] }, policy).blocked,
      false
    );
    assert.equal(
      validateFixScope(mutations, [], { allowedFiles: [], forbiddenFiles: [] }, policy).blocked,
      false
    );
    assert.equal(validateLocalCheckScope("CHG-001", mutations).blocked, false);
  });
});
