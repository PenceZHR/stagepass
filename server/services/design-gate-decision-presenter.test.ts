import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The gate decision existed on neither surface.
 *
 * The web refuses to route `approve_*` / `waive_*` on purpose -- those belong to
 * the Codex decision surface -- and nothing in the pipeline ever asked Codex for
 * one: `SELECT count(*) FROM codex_interactions WHERE kind='gate_decision'` was
 * 0 across the whole database, on a project that had settled four Spec rounds.
 * The broker that opens such a card was complete and simply had no caller.
 *
 * These are source-level assertions rather than behavioural ones, and that is
 * the point: the bug was never that the mechanism misbehaved, it was that
 * nothing invoked it. A test that mocks the broker and checks it does the right
 * thing when called would have passed throughout, which is exactly how this
 * survived.
 */

const SOURCE = (relative: string) =>
  fs.readFileSync(path.join(process.cwd(), "server", "services", relative), "utf-8");

describe("every settled design round asks for a human decision", () => {
  const SETTLE_PATHS = [
    // Spec keeps its own settle path (the handoff's §5.0).
    "pipeline-spec-stage-service.ts",
    // TechSpec, Plan and TestPlan share one.
    "pipeline-delegated-phase-round.ts",
  ];

  for (const file of SETTLE_PATHS) {
    it(`${file} opens the decision card when its round settles`, () => {
      const source = SOURCE(file);
      assert.match(
        source,
        /presentDesignGateDecision\(/,
        "a settled round with no decision card dead-ends: the web will not route the "
        + "approval and Codex was never asked for it",
      );
    });
  }

  /**
   * The card is built from the gate the human will act against, so it must be
   * opened after the gate is written -- a card carrying a superseded
   * (gateVersion, sourceDbHash) is refused as `interaction_source_contract_stale`.
   */
  it("opens the card after the gate is written, never before", () => {
    const source = SOURCE("pipeline-delegated-phase-round.ts");
    assert.ok(
      source.indexOf("syncDelegatedRoundStageAuthority({")
        < source.indexOf("presentDesignGateDecision({"),
      "the card would carry a gate version the contract has already moved past",
    );
  });

  /**
   * Every phase that can raise a decision needs an entry. A phase missing from
   * the map would compile and then silently open a card with no actions on it.
   */
  it("covers every design phase that can hold a gate decision", () => {
    const source = SOURCE("design-gate-decision-presenter.ts");
    for (const phase of ["Spec", "TechSpec", "Plan", "TestPlan"]) {
      assert.match(
        source,
        new RegExp(`\\n\\s*${phase}: \\[`),
        `${phase} has no decision-action list`,
      );
    }
  });

  /**
   * The card's actions and its (gateVersion, sourceDbHash) must come from a
   * COMPUTED contract, never from the `stage_actions` cache.
   *
   * That cache is written whenever something last called getActions, and a
   * just-settled round has moved the gate past it -- measured at gate 37 against
   * rows stamped 34. Reading it made every decision action look absent, so the
   * presenter logged "nothing to decide" and opened no card at all: the exact
   * dead end it was written to remove, reintroduced one layer down.
   */
  it("computes the contract instead of reading the stage_actions cache", () => {
    const source = SOURCE("design-gate-decision-presenter.ts");
    assert.match(source, /getActions\(/, "the contract has to be recomputed");
    assert.doesNotMatch(
      source,
      /from\(stageActions\)/,
      "the persisted action rows lag the gate a settled round just moved",
    );
    assert.match(
      source,
      /if \(!contract\)/,
      "a card with no actionable option interrupts the human for nothing",
    );
  });

  /**
   * The gate identity travels with the actions it was computed against. Reading
   * the gate separately reopens the window where the two disagree, which
   * `ensureInteraction` rejects as `interaction_source_contract_stale`.
   */
  it("takes the gate identity from the same contract as the actions", () => {
    const source = SOURCE("design-gate-decision-presenter.ts");
    assert.match(source, /contract: \{ gateVersion, sourceDbHash \}/);
  });

  /**
   * The card's presentation turn must carry `prompt`.
   *
   * `readLogicalTurnForStart` refuses a canonical request whose prompt is
   * missing or blank, so the orchestrator's `instruction:` field meant every
   * presentation job failed the instant it was leased. Nothing noticed for as
   * long as nothing created a gate-decision card: the field was wrong from the
   * start and only became reachable once the cards existed.
   */
  /**
   * A turn that ran is not a card that was shown.
   *
   * Measured: the presentation job went green while the model had replied
   * 「可用工具中没有 present_stagepass_interaction」. The interaction stayed
   * `pending`, nothing anywhere said the human had been shown nothing, and the
   * green job was read -- by me -- as proof the card had arrived. The host's
   * status is the evidence; the turn's own terminal is not.
   */
  it("leaves a trace when the turn ends with the card still pending", () => {
    const source = SOURCE("interaction-presentation-orchestrator.ts");
    assert.match(source, /current\.status === "pending"/);
    assert.match(source, /log\.warn\(/);
    // Pending here is legitimate -- the host facade owns pending -> presented on
    // its own channel -- so this must never throw. An earlier attempt did, and
    // broke that contract.
    assert.doesNotMatch(source, /interaction_not_presented/);
  });

  it("gives the presentation turn a prompt the engine will accept", () => {
    const source = SOURCE("interaction-presentation-orchestrator.ts");
    assert.match(source, /\n\s*prompt:\s*\n?\s*`StagePass has a human interaction ready/);
    // The id is in the prompt text itself, not deferred to a "structured
    // context" the model reported empty.
    assert.match(source, /interactionId = \$\{allocated\.interaction\.id\}/);
    assert.doesNotMatch(
      source,
      /\n\s*instruction:/,
      "a field the turn reader does not read leaves the request with no prompt",
    );
  });
});
