import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
  activeSpecBlocking,
  computeRoundDelta,
  parseBlueCritiqueOutput,
  parseRedSpecOutput,
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
  it("parseRedSpecOutput parses JSON with canonicalGapId claim protocol", () => {
    const parsed = parseRedSpecOutput(
      JSON.stringify({
        prdDeltaMarkdown: "## Delta\n- Add auth requirements.",
        fixClaims: [
          {
            canonicalGapId: "gap-auth",
            claimStatus: "fixed",
            claimSummary: "Added sign-in requirements.",
            evidence: "PRD now defines authentication behavior.",
            artifactPath: "prd.md",
          },
          {
            canonicalGapId: "gap-session",
            claimStatus: "partially_fixed",
            claimSummary: "Added partial session requirements.",
            evidence: "PRD now mentions session expiry.",
          },
        ],
      })
    );

    assert.equal(parsed.prdDeltaMarkdown, "## Delta\n- Add auth requirements.");
    assert.deepEqual(parsed.fixClaims, [
      {
        canonicalGapId: "gap-auth",
        claimStatus: "fixed",
        claimSummary: "Added sign-in requirements.",
        evidence: "PRD now defines authentication behavior.",
        artifactPath: "prd.md",
      },
      {
        canonicalGapId: "gap-session",
        claimStatus: "partially_fixed",
        claimSummary: "Added partial session requirements.",
        evidence: "PRD now mentions session expiry.",
        artifactPath: null,
      },
    ]);
  });

  it("parseRedSpecOutput keeps markdown-only output compatible", () => {
    const markdown = "## Delta\nPlain markdown from an older red prompt.";

    assert.deepEqual(parseRedSpecOutput(markdown), {
      prdDeltaMarkdown: markdown,
      fixClaims: [],
    });
  });

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
