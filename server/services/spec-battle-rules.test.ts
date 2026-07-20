import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeGapCounts,
  effectiveSeverity,
  getSpecActionAvailability,
  isLegalDowngrade,
  isMergeBlockingGap,
  isSpecBlockingGap,
  type RuleGap,
} from "./spec-battle-rules.ts";

function gap(overrides: Partial<RuleGap> = {}): RuleGap {
  return {
    id: "gap-1",
    severity: "P0",
    originalSeverity: "P0",
    downgradedTo: null,
    status: "open",
    ...overrides,
  };
}

describe("spec-battle-rules", () => {
  it("treats an open P0 as blocking for Spec and Merge", () => {
    const openP0 = gap();

    assert.equal(effectiveSeverity(openP0), "P0");
    assert.equal(isSpecBlockingGap(openP0), true);
    assert.equal(isMergeBlockingGap(openP0), true);
  });

  it("lets overridden P0 pass Spec while keeping it merge-blocking", () => {
    const overriddenP0 = gap({ status: "overridden" });

    assert.equal(isSpecBlockingGap(overriddenP0), false);
    assert.equal(isMergeBlockingGap(overriddenP0), true);
  });

  it("treats open P1 as blocking until waived or downgraded below P1", () => {
    const openP1 = gap({ severity: "P1", originalSeverity: "P1" });
    const waivedP1 = gap({ severity: "P1", originalSeverity: "P1", status: "waived" });
    const downgradedP1 = gap({
      severity: "P1",
      originalSeverity: "P1",
      downgradedTo: "P2",
      status: "downgraded",
    });

    assert.equal(isSpecBlockingGap(openP1), true);
    assert.equal(isMergeBlockingGap(openP1), true);
    assert.equal(isSpecBlockingGap(waivedP1), false);
    assert.equal(isMergeBlockingGap(waivedP1), false);
    assert.equal(effectiveSeverity(downgradedP1), "P2");
    assert.equal(isSpecBlockingGap(downgradedP1), false);
    assert.equal(isMergeBlockingGap(downgradedP1), false);
  });

  it("never treats open P2 as blocking", () => {
    const openP2 = gap({ severity: "P2", originalSeverity: "P2" });

    assert.equal(isSpecBlockingGap(openP2), false);
    assert.equal(isMergeBlockingGap(openP2), false);
  });

  it("rejects illegal P0 to P2 downgrade", () => {
    assert.equal(isLegalDowngrade("P0", "P1"), true);
    assert.equal(isLegalDowngrade("P1", "P2"), true);
    assert.equal(isLegalDowngrade("P0", "P2"), false);
    assert.equal(isLegalDowngrade("P2", "P1"), false);
  });

  it("computes report counts from Spec blocking semantics", () => {
    const counts = computeGapCounts([
      gap({ id: "p0" }),
      gap({ id: "p1", severity: "P1", originalSeverity: "P1" }),
      gap({ id: "p2", severity: "P2", originalSeverity: "P2" }),
      gap({ id: "resolved-p2", severity: "P2", originalSeverity: "P2", status: "resolved" }),
      gap({ id: "overridden", status: "overridden" }),
      gap({ id: "waived", severity: "P1", originalSeverity: "P1", status: "waived" }),
    ]);

    assert.deepEqual(counts, {
      blockingP0: 1,
      blockingP1: 1,
      nonBlockingP2: 1,
      overriddenP0: 1,
      openRequirementGaps: 4,
      mergeBlockingRequirementGaps: 3,
    });
  });

  it("blocks approving an old report after Waive P1 makes the report stale", () => {
    const availability = getSpecActionAvailability({
      gaps: [gap({ severity: "P1", originalSeverity: "P1", status: "waived" })],
      reportFresh: false,
      currentRoundNo: 1,
      maxSpecRounds: 2,
      allowP1Waiver: true,
    });

    assert.equal(availability.approve.available, false);
    assert.equal(availability.approve.reason, "report_stale");
  });

  it("allows a human to continue on the final round with an open P0", () => {
    const availability = getSpecActionAvailability({
      gaps: [gap()],
      reportFresh: true,
      currentRoundNo: 2,
      maxSpecRounds: 2,
      allowP1Waiver: true,
    });

    assert.equal(availability.approve.available, false);
    assert.equal(availability.approve.reason, "gate_blocked");
    assert.equal(availability.requestChanges.available, true);
    assert.equal(availability.returnToSpec.available, true);
    assert.equal(availability.waiveP1.available, false);
    assert.equal(availability.waiveP1.reason, "not_applicable");
    assert.equal(availability.terminalBlock, false);
  });

  it("allows request changes for only P2 before the final round", () => {
    const availability = getSpecActionAvailability({
      gaps: [gap({ severity: "P2", originalSeverity: "P2" })],
      reportFresh: true,
      currentRoundNo: 1,
      maxSpecRounds: 2,
      allowP1Waiver: true,
    });

    assert.equal(availability.approve.available, true);
    assert.equal(availability.requestChanges.available, true);
    assert.equal(availability.returnToSpec.available, false);
    assert.equal(availability.terminalBlock, false);
  });

  it("allows a human to request another pass on a final-round P1 blocker", () => {
    const availability = getSpecActionAvailability({
      gaps: [gap({ severity: "P1", originalSeverity: "P1" })],
      reportFresh: true,
      currentRoundNo: 2,
      maxSpecRounds: 2,
      allowP1Waiver: true,
    });

    assert.equal(availability.approve.available, false);
    assert.equal(availability.approve.reason, "gate_blocked");
    assert.equal(availability.requestChanges.available, true);
    assert.equal(availability.returnToSpec.available, true);
    assert.equal(availability.waiveP1.available, true);
    assert.equal(availability.terminalBlock, false);
  });

  it("allows final round approval when only P2 remains and the report is fresh", () => {
    const availability = getSpecActionAvailability({
      gaps: [gap({ severity: "P2", originalSeverity: "P2" })],
      reportFresh: true,
      currentRoundNo: 2,
      maxSpecRounds: 2,
      allowP1Waiver: true,
    });

    assert.equal(availability.approve.available, true);
    assert.equal(availability.requestChanges.available, true);
    assert.equal(availability.returnToSpec.available, false);
    assert.equal(availability.terminalBlock, false);
  });
});
