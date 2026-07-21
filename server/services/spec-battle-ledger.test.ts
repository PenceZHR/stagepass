import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
  activeSpecBlocking,
  computeRoundDelta,
  parseBlueCritiqueOutput,
  validateBlueCritiqueOutput,
  type LedgerGap,
} from "./spec-battle-ledger.ts";

function gap(overrides: Partial<LedgerGap> = {}): LedgerGap {
  return {
    id: "gap-1",
    canonicalGapId: "gap-auth",
    severity: "P0",
    originalSeverity: "P0",
    downgradedTo: null,
    status: "open",
    firstSeenRoundId: "round-1",
    lastEvaluatedRoundId: "round-1",
    ...overrides,
  };
}

describe("spec-battle-ledger", () => {
  // Two parseRedSpecOutput cases lived here until red moved to its line
  // protocol (spec-red-line-protocol.ts).
  //
  // The first pinned that valid JSON yields claims -- now covered by the
  // protocol's own tests, against lines instead of JSON.
  //
  // The second, "keeps markdown-only output compatible", pinned that anything
  // JSON.parse rejected became {prdDeltaMarkdown: raw, fixClaims: []}. That is
  // the data-loss path itself, frozen as intended behaviour: it left an
  // unparseable payload indistinguishable from a legitimate markdown-only
  // reply, so no test could ever catch a round losing its claims. Production
  // round 7 carried 11 claims one stray line away from exactly that. Handing
  // over a plain document is still supported, but as an explicit
  // completeRedSpecRound({markdown}) variant that never parses anything.

  it("parseBlueCritiqueOutput parses gapReviews and requirementGaps with canonicalGapId protocol", () => {
    const parsed = parseBlueCritiqueOutput(
      JSON.stringify({
        gapReviews: [
          {
            canonicalGapId: "gap-auth",
            verdict: "still_open",
            reviewSummary: "Session expiry is still missing.",
            evidence: "PRD still omits session expiry.",
            resolutionEvidence: "PRD still omits session expiry.",
            downgradedTo: null,
          },
          {
            canonicalGapId: "gap-rate-limit",
            verdict: "resolved",
            reviewSummary: "Rate limit behavior is covered.",
            evidence: "PRD defines per-user rate limits.",
            resolutionEvidence: null,
            downgradedTo: null,
          },
        ],
        requirementGaps: [
          {
            canonicalGapId: "gap-session-expiry",
            title: "Session expiry missing",
            category: "security",
            severity: "P1",
            evidence: "No session expiry behavior is specified.",
            affectedArtifacts: ["prd.md"],
            proposedSpecPatch: "- Define session expiry behavior.",
            specBlocking: true,
            mergeBlocking: true,
          },
          {
            canonicalGapId: "gap-lockout",
            title: "Lockout behavior missing",
            category: "security",
            severity: "P2",
            evidence: "No lockout behavior is specified.",
            affectedArtifacts: [],
            proposedSpecPatch: null,
            specBlocking: false,
            mergeBlocking: false,
          },
        ],
      })
    );

    assert.deepEqual(parsed.gapReviews, [
      {
        canonicalGapId: "gap-auth",
        verdict: "still_open",
        reviewSummary: "Session expiry is still missing.",
        evidence: "PRD still omits session expiry.",
        resolutionEvidence: "PRD still omits session expiry.",
        downgradedTo: null,
      },
      {
        canonicalGapId: "gap-rate-limit",
        verdict: "resolved",
        reviewSummary: "Rate limit behavior is covered.",
        evidence: "PRD defines per-user rate limits.",
        resolutionEvidence: null,
        downgradedTo: null,
      },
    ]);
    assert.deepEqual(parsed.requirementGaps, [
      {
        canonicalGapId: "gap-session-expiry",
        title: "Session expiry missing",
        category: "security",
        severity: "P1",
        evidence: "No session expiry behavior is specified.",
        affectedArtifacts: ["prd.md"],
        proposedSpecPatch: "- Define session expiry behavior.",
        specBlocking: true,
        mergeBlocking: true,
      },
      {
        canonicalGapId: "gap-lockout",
        title: "Lockout behavior missing",
        category: "security",
        severity: "P2",
        evidence: "No lockout behavior is specified.",
        affectedArtifacts: [],
        proposedSpecPatch: null,
        specBlocking: false,
        mergeBlocking: false,
      },
    ]);
  });

  it("validates blue critique output only when required top-level arrays are explicit", () => {
    assert.equal(validateBlueCritiqueOutput({}).success, false);
    assert.equal(
      validateBlueCritiqueOutput({
        gapReviews: [],
        requirementGaps: [],
      }).success,
      true
    );
  });

  it("requires nullable and default-like blue critique item fields explicitly", () => {
    assert.equal(
      validateBlueCritiqueOutput({
        gapReviews: [
          {
            canonicalGapId: "gap-auth",
            verdict: "resolved",
            reviewSummary: "Covered.",
            evidence: "Spec covers it.",
          },
        ],
        requirementGaps: [],
      }).success,
      false
    );
    assert.equal(
      validateBlueCritiqueOutput({
        gapReviews: [],
        requirementGaps: [
          {
            canonicalGapId: "gap-session",
            title: "Session expiry missing",
            category: "security",
            severity: "P1",
            evidence: "No expiry requirement.",
          },
        ],
      }).success,
      false
    );
    assert.equal(
      validateBlueCritiqueOutput({
        gapReviews: [
          {
            canonicalGapId: "gap-auth",
            verdict: "resolved",
            reviewSummary: "Covered.",
            evidence: "Spec covers it.",
            resolutionEvidence: null,
            downgradedTo: null,
          },
        ],
        requirementGaps: [
          {
            canonicalGapId: "gap-session",
            title: "Session expiry missing",
            category: "security",
            severity: "P1",
            evidence: "No expiry requirement.",
            affectedArtifacts: [],
            proposedSpecPatch: null,
            specBlocking: true,
            mergeBlocking: true,
          },
        ],
      }).success,
      true
    );
  });

  // verdict and downgradedTo are one discriminated fact, not two independent
  // fields. Read separately, a null downgradedTo means both "this is not a
  // downgrade" (true for resolved/still_open) and "this IS a downgrade, target
  // missing" -- and completeBlueCritique's branch table hit neither case, so the
  // round updated the gap ledger not at all while still recording the verdict.
  it("rejects a downgraded gap review that carries no downgrade target", () => {
    const review = (downgradedTo: unknown) => ({
      gapReviews: [
        {
          canonicalGapId: "gap-auth",
          verdict: "downgraded",
          reviewSummary: "Severity lowered.",
          evidence: "Only cosmetic impact remains.",
          resolutionEvidence: "Scope narrowed.",
          downgradedTo,
        },
      ],
      requirementGaps: [],
    });

    assert.equal(validateBlueCritiqueOutput(review(null)).success, false);
    assert.match(
      validateBlueCritiqueOutput(review(null)).error?.message ?? "",
      /downgradedTo/
    );
    assert.equal(validateBlueCritiqueOutput(review("P1")).success, true);
    assert.equal(validateBlueCritiqueOutput(review("P2")).success, true);
    assert.equal(validateBlueCritiqueOutput(review("P0")).success, false);
  });

  // The other direction: a null target is the only legal value for every
  // non-downgrade verdict, and tightening the rule must not cost them.
  it("keeps a null downgrade target legal for every non-downgrade verdict", () => {
    for (const verdict of ["resolved", "still_open", "needs_human_decision"]) {
      const result = validateBlueCritiqueOutput({
        gapReviews: [
          {
            canonicalGapId: "gap-auth",
            verdict,
            reviewSummary: "Reviewed.",
            evidence: "Checked the PRD.",
            resolutionEvidence: null,
            downgradedTo: null,
          },
        ],
        requirementGaps: [],
      });
      assert.equal(result.success, true, `${verdict} with a null target must stay legal`);
    }
  });

  it("rejects a non-downgrade verdict that smuggles in a downgrade target", () => {
    assert.equal(
      validateBlueCritiqueOutput({
        gapReviews: [
          {
            canonicalGapId: "gap-auth",
            verdict: "still_open",
            reviewSummary: "Still open.",
            evidence: "Nothing changed.",
            resolutionEvidence: null,
            downgradedTo: "P2",
          },
        ],
        requirementGaps: [],
      }).success,
      false
    );
  });

  it("exports a strict blue critique JSON schema with all object properties required", () => {
    const properties = BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA.properties as Record<string, {
      items: { required: string[] };
    }>;

    assert.deepEqual(BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA.required, ["gapReviews", "requirementGaps"]);
    assert.deepEqual(properties.gapReviews.items.required, [
      "canonicalGapId",
      "verdict",
      "reviewSummary",
      "evidence",
      "resolutionEvidence",
      "downgradedTo",
    ]);
    assert.deepEqual(properties.requirementGaps.items.required, [
      "canonicalGapId",
      "title",
      "category",
      "severity",
      "evidence",
      "affectedArtifacts",
      "proposedSpecPatch",
      "specBlocking",
      "mergeBlocking",
    ]);
  });

  it("keeps an omitted old blocking gap in notRechecked and stillOpen", () => {
    const oldGap = gap({ id: "db-gap-1", canonicalGapId: "gap-auth" });
    const delta = computeRoundDelta({
      roundId: "round-2",
      previousBlockingGaps: [oldGap],
      fixClaims: [],
      gapReviews: [],
      newGaps: [],
    });

    assert.deepEqual(delta.resolvedThisRound, []);
    assert.deepEqual(delta.notRechecked, [oldGap]);
    assert.deepEqual(delta.stillOpen, [oldGap]);
    assert.deepEqual(delta.newlyFound, []);
  });

  it("moves an old blocking gap to resolvedThisRound when blue resolves it by canonicalGapId", () => {
    const oldGap = gap({ id: "db-gap-1", canonicalGapId: "gap-auth" });
    const delta = computeRoundDelta({
      roundId: "round-2",
      previousBlockingGaps: [oldGap],
      fixClaims: [],
      gapReviews: [
        {
          canonicalGapId: "gap-auth",
          verdict: "resolved",
          reviewSummary: "The requirement is covered.",
          evidence: "PRD defines authentication behavior.",
        },
      ],
      newGaps: [],
    });

    assert.deepEqual(delta.resolvedThisRound, [oldGap]);
    assert.deepEqual(delta.stillOpen, []);
    assert.deepEqual(delta.notRechecked, []);
  });

  it("activeSpecBlocking follows effective severity and terminal statuses", () => {
    assert.equal(activeSpecBlocking(gap({ severity: "P0" })), true);
    assert.equal(activeSpecBlocking(gap({ severity: "P0", status: "resolved" })), false);
    assert.equal(activeSpecBlocking(gap({ severity: "P0", status: "waived" })), true);
    assert.equal(activeSpecBlocking(gap({ severity: "P1", status: "waived" })), false);
    assert.equal(activeSpecBlocking(gap({ severity: "P0", status: "overridden" })), false);
    assert.equal(activeSpecBlocking(gap({ severity: "P1", status: "downgraded", downgradedTo: "P2" })), false);
    assert.equal(activeSpecBlocking(gap({ severity: "P2" })), false);
  });
});
