import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  artifactMirrors,
  artifacts,
  changeProviderSessions,
  changes,
  events,
  projects,
  qaCommandResults,
  qaEvidence,
  qaRuns,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewReports,
  runs,
} from "../db/schema.ts";
import { createChange, deleteChange, deleteChangeRecords } from "./change-service.ts";

const PROJECT_ID = "PRJ-CHANGE-DELETE-SESSIONS";
const CHANGE_ID = "CHG-CHANGE-DELETE-SESSIONS";
const RUN_ID = "RUN-CHANGE-DELETE-SESSIONS";
const NOW = "2026-07-13T00:00:00.000Z";

const ARTIFACT_ID = "ART-CHANGE-DELETE-SESSIONS";
const ARTIFACT_MIRROR_ID = "AMR-CHANGE-DELETE-SESSIONS";
const REVIEW_ATTEMPT_ID = "RVA-CHANGE-DELETE-SESSIONS";
const REVIEW_REPORT_ID = "RVR-CHANGE-DELETE-SESSIONS";
const REVIEW_ARTIFACT_MIRROR_ID = "RAM-CHANGE-DELETE-SESSIONS";
const QA_RUN_ID = "QAR-CHANGE-DELETE-SESSIONS";

// Deletes every table the fixtures below touch, child rows before the rows they
// reference. Kept independent of change-service so a broken cascade fails the
// test it belongs to instead of poisoning the whole file's teardown.
function cleanupRows(): void {
  db.delete(reviewArtifactMirrors)
    .where(eq(reviewArtifactMirrors.changeId, CHANGE_ID))
    .run();
  db.delete(qaEvidence).where(eq(qaEvidence.qaRunId, QA_RUN_ID)).run();
  db.delete(qaCommandResults).where(eq(qaCommandResults.qaRunId, QA_RUN_ID)).run();
  db.delete(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(changeProviderSessions)
    .where(eq(changeProviderSessions.changeId, CHANGE_ID))
    .run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Change deletion sessions",
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
    title: "Delete provider sessions with change",
    status: "DONE",
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

// Seeds the FK edges the hand-written cascade is most likely to trip over: the
// QA rows that point at artifact_mirrors, and the review mirror rows that point
// at review_reports and artifacts.
function seedFullyPopulatedChange(): void {
  db.insert(runs).values({
    id: RUN_ID,
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: NOW,
    endedAt: NOW,
    provider: "codex",
  }).run();
  db.insert(artifacts).values({
    id: ARTIFACT_ID,
    changeId: CHANGE_ID,
    runId: RUN_ID,
    type: "stage_raw_output",
    path: ".ship/changes/CHG/raw.json",
    createdAt: NOW,
  }).run();
  db.insert(artifactMirrors).values({
    id: ARTIFACT_MIRROR_ID,
    changeId: CHANGE_ID,
    phase: "QA",
    artifactType: "qa_command_output",
    path: ".ship/changes/CHG/qa/cmd-1.log",
    contentHash: "sha256:qa-command-output",
    sourceDbHash: "qa-source-db-hash",
    schemaVersion: "qa/v1",
    mirrorStatus: "fresh",
    generatedAt: NOW,
  }).run();
  db.insert(reviewAttempts).values({
    id: REVIEW_ATTEMPT_ID,
    changeId: CHANGE_ID,
    runId: RUN_ID,
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-1",
    rawOutputArtifactId: ARTIFACT_ID,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(reviewReports).values({
    id: REVIEW_REPORT_ID,
    attemptId: REVIEW_ATTEMPT_ID,
    changeId: CHANGE_ID,
    reportVersion: 1,
    reportDbHash: "review-report-db-hash",
    gateStatus: "passed",
    qaAllowed: 1,
    generatedAt: NOW,
    createdAt: NOW,
  }).run();
  db.insert(reviewArtifactMirrors).values({
    id: REVIEW_ARTIFACT_MIRROR_ID,
    reportId: REVIEW_REPORT_ID,
    changeId: CHANGE_ID,
    artifactId: ARTIFACT_ID,
    kind: "review_report",
    path: ".ship/changes/CHG/review/report.json",
    createdAt: NOW,
  }).run();
  db.insert(qaRuns).values({
    id: QA_RUN_ID,
    changeId: CHANGE_ID,
    sourceReviewReportId: REVIEW_REPORT_ID,
    status: "passed",
    startedAt: NOW,
    completedAt: NOW,
  }).run();
  db.insert(qaCommandResults).values({
    id: "QAC-CHANGE-DELETE-SESSIONS",
    qaRunId: QA_RUN_ID,
    command: "pnpm test",
    commandOrder: 1,
    status: "passed",
    exitCode: 0,
    outputArtifactMirrorId: ARTIFACT_MIRROR_ID,
    completedAt: NOW,
  }).run();
  db.insert(qaEvidence).values({
    id: "QAE-CHANGE-DELETE-SESSIONS",
    qaRunId: QA_RUN_ID,
    evidenceType: "command_output",
    artifactMirrorId: ARTIFACT_MIRROR_ID,
    contentHash: "sha256:qa-command-output",
    createdAt: NOW,
  }).run();
}

beforeEach(() => {
  cleanupRows();
  seedChange();
});

afterEach(cleanupRows);

describe("change deletion provider sessions", () => {
  it("deletes provider sessions before their referenced runs", () => {
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "spec",
      status: "failed",
      startedAt: NOW,
      endedAt: NOW,
      provider: "codex",
    }).run();
    db.insert(changeProviderSessions).values({
      changeId: CHANGE_ID,
      provider: "codex",
      sessionKind: "general",
      externalSessionId: "codex-session",
      lastRunId: RUN_ID,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();

    deleteChangeRecords(CHANGE_ID);

    assert.equal(
      db.select().from(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("deletes a change that has provider sessions", async () => {
    db.insert(changeProviderSessions).values({
      changeId: CHANGE_ID,
      provider: "codex",
      sessionKind: "general",
      externalSessionId: "codex-session",
      lastRunId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();

    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
  });
});

describe("change deletion refuses to race a live run", () => {
  // DELIVERY_PENDING is both "parked waiting for a human to click 运行交付" and
  // pipeline-delivery-stage-service's `runningStatus`, and RUNNING_CHANGE_STATUSES
  // deliberately omits it (adding it would lock every sibling change in the
  // project). So the status alone cannot answer "is something running right now";
  // the runs table can. Verified against a copy of the production DB on
  // 2026-07-21: before this guard, DELETE returned 200 mid-delivery and took the
  // change, its runs and the on-disk .ship/changes/<id> directory with it.
  it("refuses while a delivery run is still in flight at DELIVERY_PENDING", async () => {
    db.update(changes).set({ status: "DELIVERY_PENDING" }).where(eq(changes.id, CHANGE_ID)).run();
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "delivery",
      status: "running",
      startedAt: NOW,
      summary: "{}",
    }).run();

    await assert.rejects(
      () => deleteChange(CHANGE_ID),
      /still in flight \(delivery\)/,
    );
    assert.equal(
      db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length,
      1,
      "the change must survive the refusal",
    );
  });

  it("still deletes once that run is no longer running", async () => {
    db.update(changes).set({ status: "DELIVERY_PENDING" }).where(eq(changes.id, CHANGE_ID)).run();
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "delivery",
      status: "failed",
      startedAt: NOW,
      endedAt: NOW,
      summary: "{}",
    }).run();

    // The guard must not become a trap: a change parked at DELIVERY_PENDING with
    // nothing running is exactly the case RUNNING_CHANGE_STATUSES leaves deletable.
    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
  });
});

// --- git branch takeover via recycled change ids ---------------------------
//
// These drive the real createChange/deleteChange against a throwaway `git init`
// repository under os.tmpdir(). Nothing here touches a real project checkout.

const GIT_PROJECT_ID = "PRJ-CHANGE-ID-REUSE";
const CHANGE_TITLE = "登录页重构";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

function makeThrowawayRepo(): string {
  const repo = fs.mkdtempSync(nodePath.join(os.tmpdir(), "change-service-idreuse-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  fs.writeFileSync(nodePath.join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base commit"]);
  return repo;
}

function seedGitProject(repoPath: string): void {
  db.insert(projects).values({
    id: GIT_PROJECT_ID,
    name: "Change id reuse",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 1,
    gitDefaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function cleanupGitProject(): void {
  for (const row of db.select().from(changes).where(eq(changes.projectId, GIT_PROJECT_ID)).all()) {
    db.delete(artifacts).where(eq(artifacts.changeId, row.id)).run();
    db.delete(events).where(eq(events.changeId, row.id)).run();
    db.delete(changes).where(eq(changes.id, row.id)).run();
  }
  db.delete(projects).where(eq(projects.id, GIT_PROJECT_ID)).run();
}

describe("a new change never inherits a deleted change's git branch", () => {
  let repo: string;

  beforeEach(() => {
    cleanupGitProject();
    repo = makeThrowawayRepo();
    seedGitProject(repo);
  });

  afterEach(() => {
    cleanupGitProject();
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  // The disambiguation must be a response to an actual collision, not a tax on
  // every change: the ordinary branch name has to survive untouched.
  it("uses the plain branch name when nothing holds it", async () => {
    const change = await createChange({ projectId: GIT_PROJECT_ID, title: CHANGE_TITLE });
    assert.equal(
      change.gitBranch,
      `ship/${change.id.toLowerCase()}/${CHANGE_TITLE}`,
      "an uncontested branch name must not be given a suffix",
    );
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), change.gitBranch);
  });

  // The defect, reproduced end to end on 2026-07-22 before the fix: nextChangeId
  // handed out the LOWEST FREE number rather than max+1, deleteChange leaves the
  // git branch in place, and createChange checks out a branch that already
  // exists. So create -> commit -> delete -> create returned the same CHG-001,
  // checked out ship/chg-001/登录页重构, and the deleted change's committed file
  // was sitting in the working tree as the new change's starting point.
  //
  // Asserted on the symptom rather than on nextChangeId's return value: what
  // must never happen is the second change starting from the first one's
  // commits, however the id is allocated.
  it("does not check out the deleted change's branch or its commits", async () => {
    const first = await createChange({ projectId: GIT_PROJECT_ID, title: CHANGE_TITLE });
    assert.ok(first.gitBranch, "the first change must get a branch");

    const leakedFile = "work-of-the-deleted-change.txt";
    fs.writeFileSync(nodePath.join(repo, leakedFile), "code from the FIRST change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "WORK FROM THE DELETED CHANGE"]);

    git(repo, ["checkout", "-q", "main"]);
    await deleteChange(first.id);

    // The branch deliberately survives the delete -- it can hold unmerged work.
    assert.match(git(repo, ["branch", "--list"]), new RegExp(first.gitBranch!));

    const second = await createChange({ projectId: GIT_PROJECT_ID, title: CHANGE_TITLE });

    // Deliberately NOT asserting that the id differs. Change ids are allocated
    // max+1 over the live rows, which is not a high-water mark: deleting the
    // newest change frees its number again, so `second.id` legitimately equals
    // `first.id` here. That is exactly why the branch name -- a pure function of
    // id and title -- cannot be trusted to be free, and why the fix is at the
    // branch seam rather than the id seam.
    assert.notEqual(
      second.gitBranch,
      first.gitBranch,
      "the new change must not be pointed at the deleted change's branch",
    );
    assert.equal(
      git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      second.gitBranch,
      "HEAD must be on the new change's own branch",
    );
    assert.equal(
      fs.existsSync(nodePath.join(repo, leakedFile)),
      false,
      "the deleted change's committed file must not be in the new change's working tree",
    );
    assert.doesNotMatch(
      git(repo, ["log", "--oneline"]),
      /WORK FROM THE DELETED CHANGE/,
      "the deleted change's commit must not be in the new change's history",
    );
  });

  // The test above steps to `main` before deleting. That is the tidy case, and
  // it is not the one a human produces: the delete button is clicked while you
  // are working on that change, so HEAD is standing on its branch. A distinct
  // branch NAME does not help there -- createBranch is `git checkout -b`, which
  // cuts from wherever HEAD is, so the new branch starts at the deleted
  // change's tip and inherits every commit a human just threw away.
  //
  // Fixed at the delete seam, not by cutting new branches from the default
  // branch: there is no `git merge` anywhere in this codebase, so changes
  // deliberately stack, each cut from the previous one's tip. Verified in the
  // shipped repo -- `main` holds one init commit and never advances, while
  // ship/chg-003 sits three commits ahead with HEAD parked on it. Cutting from
  // the default branch would start every change from an empty tree.
  it("does not let the next change stack on a change deleted while HEAD was on it", async () => {
    const first = await createChange({ projectId: GIT_PROJECT_ID, title: CHANGE_TITLE });
    const discarded = "discarded-work.txt";
    fs.writeFileSync(nodePath.join(repo, discarded), "code a human deleted\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "WORK THE HUMAN DISCARDED"]);

    // No checkout back to main: HEAD stays on the change being deleted.
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), first.gitBranch);
    await deleteChange(first.id);

    const second = await createChange({ projectId: GIT_PROJECT_ID, title: "另一个改动" });

    assert.doesNotMatch(
      git(repo, ["log", "--oneline"]),
      /WORK THE HUMAN DISCARDED/,
      "the new change must not inherit the deleted change's commits through ambient HEAD",
    );
    assert.equal(
      fs.existsSync(nodePath.join(repo, discarded)),
      false,
      "the deleted change's file must not be in the new change's working tree",
    );
    assert.equal(
      git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      second.gitBranch,
      "HEAD must end on the new change's own branch",
    );
  });

  // The other half of the rule, and the one a mutation caught me missing:
  // deleting a change must move HEAD only when HEAD is standing on THAT
  // change's branch. Deleting some other change while you are working on this
  // one must not yank the checkout out from under you. Removing the guard left
  // every other test in this file green, so without this case the fix could be
  // over-tightened silently.
  it("leaves HEAD alone when it is on a different change's branch", async () => {
    // Three changes, and HEAD parked on the MIDDLE one. That matters: with only
    // two, the branch the guard protects is also the one the survivor lookup
    // would pick, so removing the guard changed nothing observable and this
    // test passed against the mutation. Deleting the oldest while sitting on the
    // middle one makes the two answers differ -- unguarded, HEAD would jump to
    // the newest change's branch.
    const doomed = await createChange({ projectId: GIT_PROJECT_ID, title: CHANGE_TITLE });
    const working = await createChange({ projectId: GIT_PROJECT_ID, title: "我正在做的改动" });
    const newest = await createChange({ projectId: GIT_PROJECT_ID, title: "更晚的改动" });
    assert.notEqual(working.gitBranch, newest.gitBranch);

    git(repo, ["checkout", "-q", working.gitBranch!]);
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), working.gitBranch);
    await deleteChange(doomed.id);

    assert.equal(
      git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      working.gitBranch,
      "deleting an unrelated change must not move HEAD off the branch being worked on",
    );
  });

  // Branch names must stay distinct however many times the id is recycled --
  // one disambiguating suffix is not enough if the cycle repeats.
  it("gives every change in a repeated delete-and-recreate cycle its own branch", async () => {
    const branches: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const change = await createChange({ projectId: GIT_PROJECT_ID, title: CHANGE_TITLE });
      branches.push(change.gitBranch!);
      git(repo, ["checkout", "-q", "main"]);
      await deleteChange(change.id);
    }
    assert.equal(
      new Set(branches).size,
      branches.length,
      `branch names were reused: ${branches.join(", ")}`,
    );
    // Every one of them must be a branch that actually exists and was cut fresh.
    const listed = git(repo, ["branch", "--list"]);
    for (const branch of branches) assert.match(listed, new RegExp(branch));
  });

  // Change ids are allocated max+1 over live rows, so a gap in the middle stays
  // open. This pins the allocator's actual contract rather than the one the
  // lowest-free-gap version had.
  it("does not refill a gap left by deleting an earlier change", async () => {
    const first = await createChange({ projectId: GIT_PROJECT_ID, title: "第一个" });
    const second = await createChange({ projectId: GIT_PROJECT_ID, title: "第二个" });
    git(repo, ["checkout", "-q", "main"]);
    await deleteChange(first.id);

    const third = await createChange({ projectId: GIT_PROJECT_ID, title: "第三个" });
    assert.notEqual(third.id, first.id, "the freed gap must not be refilled");
    assert.notEqual(third.id, second.id);
  });
});

describe("change deletion cascade", () => {
  it("deletes a fully populated change without tripping a foreign key constraint", async () => {
    seedFullyPopulatedChange();

    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(qaEvidence).where(eq(qaEvidence.qaRunId, QA_RUN_ID)).all().length, 0);
    assert.equal(
      db.select().from(qaCommandResults).where(eq(qaCommandResults.qaRunId, QA_RUN_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(
      db.select().from(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
  });
});
