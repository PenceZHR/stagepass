import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  changes,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projects,
} from "../db/schema";
import {
  completeGateDecision,
  GATE_DECISION_QUESTION_ID,
  GateDecisionCardError,
  openGateDecisionCard,
  resolveGateDecision,
} from "./gate-decision-card-service";

const NOW = "2026-07-28T00:00:00.000Z";

function seed(options: {
  kind?: string;
  status?: string;
  actionIds?: string[];
  withTurn?: boolean;
} = {}) {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  sqlite.pragma("foreign_keys = ON");
  const database = drizzle(sqlite, { schema });
  database.insert(projects).values({
    id: "PRJ-1",
    name: "Project",
    repoPath: "/tmp/gate-decision-card",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(changes).values({
    id: "CHG-1",
    projectId: "PRJ-1",
    title: "Change",
    status: "SPEC_READY",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(codexThreadBindings).values({
    bindingId: "BIND-1",
    // Stage-scoped, the shape a real presentation turn has. Its scopeId is the
    // compound `CHG-1:spec`, which is exactly the id the receipt path stopped
    // trying to reconstruct -- the card hands out projectId/changeId/threadId
    // instead, and those are what get verified.
    scopeKind: "change_stage",
    scopeId: "CHG-1:spec",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    threadId: "THREAD-1",
    title: "Change",
    status: "waiting_human",
    bridgeProtocolVersion: "v1",
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(codexInteractions).values({
    id: "INT-1",
    changeId: "CHG-1",
    bindingId: "BIND-1",
    codexThreadId: "THREAD-1",
    phase: "Spec",
    kind: (options.kind ?? "gate_decision") as "gate_decision",
    gateVersion: 7,
    sourceDbHash: "db-7",
    payloadJson: JSON.stringify({
      actionIds: options.actionIds
        ?? ["approve_spec", "reject_spec", "request_spec_changes"],
      title: "Spec 对抗已出结果，请裁决",
      summary: "第 2 轮已结算，没有阻断项。",
      payload: { roundNo: 2, blockers: [], openGaps: [] },
    }),
    status: (options.status ?? "pending") as "pending",
    requestHash: "req-hash-1",
    idempotencyKey: "interaction-key",
    expiresAt: "2026-07-29T00:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  if (options.withTurn !== false) {
    database.insert(pipelineJobs).values({
      id: "PJOB-1",
      changeId: "CHG-1",
      phase: "Spec",
      actionId: "present_interaction",
      idempotencyKey: "interaction_present:INT-1",
      status: "running",
      attemptNo: 1,
      provider: "codex",
      jobKind: "interaction_present",
      effectType: "interaction_present",
      interactionId: "INT-1",
      effectSchemaVersion: "stagepass.pipeline-effect/v1",
      effectPayloadJson: JSON.stringify({
        schemaVersion: "stagepass.pipeline-effect/v1",
        kind: "interaction_present",
        interactionId: "INT-1",
      }),
      nextTurnOrdinal: 1,
      effectDeadlineAt: "2026-07-29T00:00:00.000Z",
      createdAt: NOW,
    }).run();
    database.insert(codexLogicalTurns).values({
      logicalTurnId: "LT-1",
      pipelineJobId: "PJOB-1",
      bindingId: "BIND-1",
      interactionId: "INT-1",
      phase: "Spec",
      role: "interaction_present",
      round: 0,
      ordinal: 0,
      turnSlot: "slot-1",
      runCorrelationId: "corr-1",
      canonicalRequestJson: JSON.stringify({ prompt: "present" }),
      canonicalRequestHash: "hash-1",
      dispatchSurface: "follower_ipc",
      status: "running",
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
  }
  return { sqlite, database };
}

const deps = (database: ReturnType<typeof seed>["database"]) => ({
  database: database as never,
  now: () => new Date(NOW),
});

describe("gate decision card", () => {
  /**
   * The model is given one opaque id and gets back everything else. These four
   * identifiers are the point: the receipt is verified against them, so a model
   * that could supply them could aim a decision at another change or thread.
   */
  it("supplies the identifiers the receipt is verified against", () => {
    const { sqlite, database } = seed();
    try {
      const card = openGateDecisionCard("INT-1", deps(database));
      assert.equal(card.logicalTurnId, "LT-1");
      assert.equal(card.projectId, "PRJ-1");
      assert.equal(card.changeId, "CHG-1");
      assert.equal(card.threadId, "THREAD-1");
      assert.equal(card.stage, "Spec");
      assert.equal(card.questions[0].id, GATE_DECISION_QUESTION_ID);
      assert.deepEqual(
        card.questions[0].options.map((option) => option.id),
        ["approve_spec", "reject_spec", "request_spec_changes"],
      );
      // Labels come from the contract registry, not from the model.
      assert.equal(card.questions[0].options[0]!.label, "批准 Spec");
    } finally {
      sqlite.close();
    }
  });

  /**
   * Opening the card is what makes it shown. Leaving it `pending` is how the
   * previous version failed silently: the presentation job went green while
   * nothing anywhere recorded that a human had been shown anything.
   */
  it("moves the interaction from pending to presented", () => {
    const { sqlite, database } = seed();
    try {
      openGateDecisionCard("INT-1", deps(database));
      const row = database.select().from(codexInteractions)
        .where(eq(codexInteractions.id, "INT-1")).get();
      assert.equal(row?.status, "presented");
      assert.equal(row?.presentedAt, NOW);
    } finally {
      sqlite.close();
    }
  });

  it("re-opening an already presented card is not an error", () => {
    const { sqlite, database } = seed({ status: "presented" });
    try {
      assert.equal(
        openGateDecisionCard("INT-1", deps(database)).interactionId,
        "INT-1",
      );
    } finally {
      sqlite.close();
    }
  });

  /**
   * A decision that has been answered or has expired must not be shown again:
   * the human would be clicking against a gate that has since moved.
   */
  for (const status of ["completed", "expired", "cancelled"]) {
    it(`refuses to reopen a ${status} decision`, () => {
      const { sqlite, database } = seed({ status });
      try {
        assert.throws(
          () => openGateDecisionCard("INT-1", deps(database)),
          (error: unknown) =>
            error instanceof GateDecisionCardError
            && error.code === `gate_decision_card_${status}`,
        );
      } finally {
        sqlite.close();
      }
    });
  }

  it("refuses an interaction that is not a gate decision", () => {
    const { sqlite, database } = seed({ kind: "risk_waiver" });
    try {
      assert.throws(
        () => openGateDecisionCard("INT-1", deps(database)),
        (error: unknown) =>
          error instanceof GateDecisionCardError
          && error.code === "gate_decision_card_wrong_kind",
      );
    } finally {
      sqlite.close();
    }
  });

  /**
   * One option is not a decision, and the plugin's own validator refuses it as
   * a bare `invalid_options` that names neither card nor phase.
   */
  it("refuses a card with fewer than two options", () => {
    const { sqlite, database } = seed({ actionIds: ["approve_spec"] });
    try {
      assert.throws(
        () => openGateDecisionCard("INT-1", deps(database)),
        (error: unknown) =>
          error instanceof GateDecisionCardError
          && error.code === "gate_decision_card_too_few_options",
      );
    } finally {
      sqlite.close();
    }
  });

  it("refuses a card whose presentation turn does not exist", () => {
    const { sqlite, database } = seed({ withTurn: false });
    try {
      assert.throws(
        () => openGateDecisionCard("INT-1", deps(database)),
        (error: unknown) =>
          error instanceof GateDecisionCardError
          && error.code === "gate_decision_card_turn_not_found",
      );
    } finally {
      sqlite.close();
    }
  });

  it("reports an unknown interaction as not found, not as a crash", () => {
    const { sqlite, database } = seed();
    try {
      assert.throws(
        () => openGateDecisionCard("INT-NOPE", deps(database)),
        (error: unknown) =>
          error instanceof GateDecisionCardError
          && error.code === "gate_decision_card_not_found"
          && error.status === 404,
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("resolving a gate decision from a click", () => {
  it("resolves the chosen option to its action id", () => {
    const { sqlite, database } = seed();
    try {
      const decision = resolveGateDecision(
        "INT-1",
        [{
          questionId: GATE_DECISION_QUESTION_ID,
          selectedOptionIds: ["reject_spec"],
        }],
        deps(database),
      );
      assert.deepEqual(decision, {
        actionId: "reject_spec",
        changeId: "CHG-1",
        phase: "Spec",
      });
    } finally {
      sqlite.close();
    }
  });

  /**
   * The interaction is the whitelist. A receipt naming an action this card never
   * offered is refused before it can become a command.
   */
  it("refuses an action the card did not offer", () => {
    const { sqlite, database } = seed();
    try {
      assert.throws(
        () => resolveGateDecision(
          "INT-1",
          [{
            questionId: GATE_DECISION_QUESTION_ID,
            selectedOptionIds: ["approve_merge"],
          }],
          deps(database),
        ),
        (error: unknown) =>
          error instanceof GateDecisionCardError
          && error.code === "gate_decision_action_not_offered"
          && error.status === 403,
      );
    } finally {
      sqlite.close();
    }
  });

  /**
   * The real symptom to guard: the stage's own A/B approval card must keep
   * working. Its answers use a different question id and are resolved by
   * position, and a gate rule that claimed them would turn "A" into an action
   * lookup that fails -- silently breaking the one card that already worked.
   */
  it("does not claim the stage approval card's answers", () => {
    const { sqlite, database } = seed();
    try {
      assert.equal(
        resolveGateDecision(
          "INT-1",
          [{ questionId: "stagepass_stage_approval", selectedOptionIds: ["A"] }],
          deps(database),
        ),
        null,
      );
    } finally {
      sqlite.close();
    }
  });

  it("ignores a batch that is not a single decision", () => {
    const { sqlite, database } = seed();
    try {
      assert.equal(
        resolveGateDecision(
          "INT-1",
          [
            { questionId: GATE_DECISION_QUESTION_ID, selectedOptionIds: ["approve_spec"] },
            { questionId: "something_else", selectedOptionIds: ["A"] },
          ],
          deps(database),
        ),
        null,
      );
      assert.equal(
        resolveGateDecision(
          "INT-1",
          [{
            questionId: GATE_DECISION_QUESTION_ID,
            selectedOptionIds: ["approve_spec", "reject_spec"],
          }],
          deps(database),
        ),
        null,
      );
    } finally {
      sqlite.close();
    }
  });

  it("returns null for a card the model invented", () => {
    const { sqlite, database } = seed();
    try {
      assert.equal(
        resolveGateDecision(
          "card-the-model-made-up",
          [{
            questionId: GATE_DECISION_QUESTION_ID,
            selectedOptionIds: ["approve_spec"],
          }],
          deps(database),
        ),
        null,
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("closing a gate decision", () => {
  it("moves presented to completed", () => {
    const { sqlite, database } = seed({ status: "presented" });
    try {
      completeGateDecision("INT-1", deps(database));
      const row = database.select().from(codexInteractions)
        .where(eq(codexInteractions.id, "INT-1")).get();
      assert.equal(row?.status, "completed");
      assert.equal(row?.completedAt, NOW);
    } finally {
      sqlite.close();
    }
  });

  /**
   * A decision that was never shown cannot have been answered. Guarding the
   * transition keeps a stray receipt from closing a card the human never saw.
   */
  it("leaves a pending decision alone", () => {
    const { sqlite, database } = seed();
    try {
      completeGateDecision("INT-1", deps(database));
      assert.equal(
        database.select().from(codexInteractions)
          .where(eq(codexInteractions.id, "INT-1")).get()?.status,
        "pending",
      );
    } finally {
      sqlite.close();
    }
  });
});
