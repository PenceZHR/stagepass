import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  briefingQuestions,
  changes,
  prdBriefings,
  projects,
} from "../db/schema";
import {
  ACTION_DEFINITIONS,
} from "./action-contract-registry-service";
import {
  parsePrdInteractionPayload,
} from "./pipeline-command-gateway";
import {
  orchestrateAfterCommand,
} from "./pipeline-command-orchestration";
import type {
  PipelineCommand,
  PipelineCommandResult,
} from "./pipeline-command-types";
import {
  applyBriefingQuestionCommandWithDb,
  PrdBriefingError,
} from "./prd-briefing-service";

const NOW = "2026-07-24T00:00:00.000Z";

function fixture() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  const database = drizzle(sqlite, { schema });
  database.insert(projects).values({
    id: "PRJ-1",
    name: "Project",
    repoPath: "/tmp/stagepass-task11",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(changes).values({
    id: "CHG-1",
    projectId: "PRJ-1",
    title: "Change",
    status: "INTAKE_PENDING",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(prdBriefings).values({
    id: "PBR-1",
    changeId: "CHG-1",
    status: "questions_ready",
    intentText: "Ship the flow",
    finalReviewJson: null,
    sourceHashesJson: "{}",
    lockedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  for (const [id, severity, suggestedDefault] of [
    ["Q1", "important", null],
    ["Q2", "important", "Server default"],
    ["Q3", "optional", null],
    ["CRITICAL", "critical", null],
  ] as const) {
    database.insert(briefingQuestions).values({
      id,
      changeId: "CHG-1",
      phase: "PRD",
      roundNo: 1,
      category: "scope",
      severity,
      question: id,
      whyItMatters: id,
      suggestedDefault,
      status: "open",
      answer: null,
      source: "ai_blue",
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
  }
  return { sqlite, database };
}

describe("PRD and Intake interaction flow", () => {
  it("answers, accepts the Server assumption, and defers only non-critical questions", () => {
    const { sqlite, database } = fixture();
    try {
      applyBriefingQuestionCommandWithDb(database, {
        changeId: "CHG-1",
        questionId: "Q1",
        command: { action: "answer", answer: "B2B teams" },
      });
      applyBriefingQuestionCommandWithDb(database, {
        changeId: "CHG-1",
        questionId: "Q2",
        command: { action: "accept_assumption" },
      });
      applyBriefingQuestionCommandWithDb(database, {
        changeId: "CHG-1",
        questionId: "Q3",
        command: { action: "defer", reason: "Post-MVP" },
      });
      const rows = database.select().from(briefingQuestions).all();
      const question = (id: string) => rows.find((row) => row.id === id)!;
      assert.equal(question("Q1").status, "answered");
      assert.equal(question("Q2").status, "assumption_accepted");
      assert.equal(question("Q2").answer, "Server default");
      assert.equal(question("Q3").status, "deferred");
      assert.throws(
        () => applyBriefingQuestionCommandWithDb(database, {
          changeId: "CHG-1",
          questionId: "CRITICAL",
          command: { action: "defer", reason: "skip" },
        }),
        (error) => error instanceof PrdBriefingError
          && error.code === "critical_question_cannot_defer",
      );
    } finally {
      sqlite.close();
    }
  });

  it("registers exact payload contracts and approving Intake enqueues Spec", async () => {
    const actionIds = new Set(ACTION_DEFINITIONS.map((entry) => entry.actionId));
    for (const actionId of [
      "answer_prd_question",
      "accept_prd_assumption",
      "defer_prd_question",
      "lock_prd_briefing",
    ]) assert.equal(actionIds.has(actionId), true);
    assert.deepEqual(
      parsePrdInteractionPayload("approve_intake", { confirmation: true }),
      { confirmation: true },
    );
    assert.throws(
      () => parsePrdInteractionPayload("approve_intake", {}),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "invalid_pipeline_command"
      ),
    );

    const command = {
      actionId: "approve_intake",
      changeId: "CHG-1",
      idempotencyKey: "idem",
    } as PipelineCommand;
    const completed = {
      commandId: "CMD-1",
      status: "completed",
      changeStatus: "SPECCING",
      gateVersion: "1",
      sourceDbHash: "hash",
      sourceHeadSha: null,
      interactionId: "INT-1",
      humanDecisionId: "DEC-1",
      enqueuedJobId: null,
    } satisfies PipelineCommandResult;
    const enqueued: string[] = [];
    const result = await orchestrateAfterCommand({
      command,
      previousStatus: "INTAKE_READY",
      execute: async () => completed,
      refreshAction: () => ({ actionId: "run_spec" }) as never,
      enqueue: (input) => {
        enqueued.push(input.actionId);
        return { job: { id: "PJOB-SPEC" } };
      },
    });
    assert.notEqual(result.humanDecisionId, null);
    assert.deepEqual(enqueued, ["run_spec"]);
  });
});
