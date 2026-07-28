import crypto from "crypto";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { blueGapReviews, redFixClaims, requirementGaps } from "../db/schema";
import type { DelegatedLedgerPhase } from "./delegated-round-ledger";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import type {
  ParsedBlueCritiqueOutput,
  RedFixClaimInput,
} from "./spec-battle-ledger";
import {
  isMergeBlockingGap,
  isSpecBlockingGap,
  type RuleGap,
} from "./spec-battle-rules";
import { toRuleGap } from "./spec-battle-row-readers";

/**
 * Red's fix claims and blue's gap ledger for a delegated round, for any phase
 * except Spec.
 *
 * ## Why this is not `completeBlueCritique` with a phase argument
 *
 * `completeBlueCritique` does five things besides the gap ledger: it validates
 * the round is Spec's current one, writes `.ship/.../blue.json` at a Spec path,
 * flips the change to `SPEC_READY`, syncs the Spec stage authority, and
 * refreshes the Spec mirrors. Four of the five are the wrong act for TechSpec,
 * and the handoff's §5.0 is explicit about why the fifth matters more than the
 * saving: Spec's is the only path with real runtime evidence behind it, and
 * turning it into a parameterised service puts that evidence at risk to avoid
 * writing this file.
 *
 * What IS shared is the part worth sharing -- the canonicalGapId upsert and the
 * verdict-to-status rules -- and those live in `spec-battle-rules`, which both
 * ledgers call. The duplication here is the transaction shape, not the policy.
 *
 * ## Why one transaction
 *
 * A round that wrote red's claims and then failed on blue would leave a
 * committed producer leg with no critic, which reads to every later query as a
 * critic that found nothing. Both legs land together or neither does.
 */

function nowISO(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export interface DelegatedRoundLedgerWrite {
  changeId: string;
  descriptor: DelegatedRoundPhase & { phase: DelegatedLedgerPhase };
  roundId: string;
  red: { fixClaims: readonly RedFixClaimInput[] };
  blue: ParsedBlueCritiqueOutput;
  /** Hash of red's document, recorded as the claims' provenance. */
  redHash: string;
}

export function writeDelegatedRoundGapLedger(input: DelegatedRoundLedgerWrite): {
  blueHash: string;
} {
  const now = nowISO();
  const blueHash = sha256Text(JSON.stringify(input.blue));
  const sourceHashesJson = JSON.stringify({ roundId: input.roundId, blueHash });
  const phase = input.descriptor.phase;

  db.transaction((tx) => {
    const gapByCanonicalId = (canonicalGapId: string) =>
      tx
        .select()
        .from(requirementGaps)
        .where(and(
          eq(requirementGaps.changeId, input.changeId),
          eq(requirementGaps.sourcePhase, phase),
          eq(requirementGaps.canonicalGapId, canonicalGapId),
        ))
        .get();

    for (const claim of input.red.fixClaims) {
      const gap = gapByCanonicalId(claim.canonicalGapId);
      tx.insert(redFixClaims).values({
        id: nextId("RFC"),
        changeId: input.changeId,
        roundId: input.roundId,
        gapId: gap?.id ?? null,
        canonicalGapId: claim.canonicalGapId,
        claimStatus: claim.claimStatus,
        claimSummary: claim.claimSummary,
        evidence: claim.evidence,
        artifactPath: claim.artifactPath,
        sourceHashesJson: JSON.stringify({ roundId: input.roundId, redHash: input.redHash }),
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    const resolvedThisRound = new Set<string>();
    for (const review of input.blue.gapReviews) {
      const gap = gapByCanonicalId(review.canonicalGapId);
      tx.insert(blueGapReviews).values({
        id: nextId("BGR"),
        changeId: input.changeId,
        roundId: input.roundId,
        gapId: gap?.id ?? null,
        canonicalGapId: review.canonicalGapId,
        verdict: review.verdict,
        reviewSummary: review.reviewSummary,
        evidence: review.evidence,
        resolutionEvidence: review.resolutionEvidence,
        downgradedTo: review.downgradedTo,
        sourceHashesJson,
        createdAt: now,
        updatedAt: now,
      }).run();
      // A review of a gap this phase never raised is recorded and does nothing
      // else. It is not an error -- blue may cite something from upstream -- but
      // it must not silently create a gap row nobody opened.
      if (!gap) continue;

      if (review.verdict === "resolved") {
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            resolvedByRoundId: input.roundId,
            status: "resolved",
            resolutionEvidence: review.resolutionEvidence ?? review.evidence,
            specBlocking: 0,
            mergeBlocking: 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: now,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
        resolvedThisRound.add(review.canonicalGapId);
        continue;
      }

      if (review.verdict === "downgraded") {
        const ruleGap: RuleGap = {
          id: gap.id,
          originalSeverity: gap.originalSeverity as RuleGap["originalSeverity"],
          severity: gap.severity as RuleGap["severity"],
          downgradedTo: review.downgradedTo,
          status: "downgraded",
        };
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            status: "downgraded",
            downgradedTo: review.downgradedTo,
            downgradeReason: review.reviewSummary,
            specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
            mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: null,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
        continue;
      }

      if (review.verdict === "still_open" || review.verdict === "needs_human_decision") {
        const ruleGap: RuleGap = { ...toRuleGap(gap), status: "open" };
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            status: "open",
            evidence: review.evidence,
            specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
            mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: null,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
        continue;
      }

      // Typed `never`, so adding a verdict without giving it a branch stops
      // compiling here rather than silently no-opping in production -- the
      // failure mode that once let a round record a verdict and update the gap
      // ledger not at all.
      const unreachable: never = review;
      throw new Error(`unhandled blue review verdict: ${JSON.stringify(unreachable)}`);
    }

    for (const item of input.blue.requirementGaps) {
      // Blue resolving a gap and re-proposing it in the same round is blue
      // contradicting itself; the resolution is the more specific statement.
      if (resolvedThisRound.has(item.canonicalGapId)) continue;

      const existing = gapByCanonicalId(item.canonicalGapId);
      const ruleGap: RuleGap = {
        id: existing?.id ?? item.canonicalGapId,
        severity: item.severity,
        originalSeverity:
          (existing?.originalSeverity as RuleGap["originalSeverity"] | undefined) ?? item.severity,
        downgradedTo: (existing?.downgradedTo as RuleGap["downgradedTo"] | undefined) ?? null,
        status: "open",
      };
      const patch = {
        lastEvaluatedRoundId: input.roundId,
        title: item.title,
        category: item.category,
        evidence: item.evidence,
        affectedArtifactsJson: JSON.stringify(item.affectedArtifacts ?? []),
        proposedSpecPatch: item.proposedSpecPatch ?? null,
        severity: item.severity,
        status: "open",
        specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
        mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
        sourceHashesJson,
        updatedAt: now,
        closedAt: null,
      };

      if (existing) {
        tx.update(requirementGaps).set(patch).where(eq(requirementGaps.id, existing.id)).run();
        continue;
      }
      tx.insert(requirementGaps).values({
        id: nextId("GAP"),
        changeId: input.changeId,
        canonicalGapId: item.canonicalGapId,
        firstSeenRoundId: input.roundId,
        lastEvaluatedRoundId: input.roundId,
        resolvedByRoundId: null,
        // The column every phase-scoped reader selects on. Getting this wrong
        // does not fail here -- it silently lands the gap in another phase's
        // gate.
        sourcePhase: phase,
        sourceUnit: input.descriptor.blueUnit,
        title: item.title,
        category: item.category,
        evidence: item.evidence,
        affectedArtifactsJson: JSON.stringify(item.affectedArtifacts ?? []),
        proposedSpecPatch: item.proposedSpecPatch ?? null,
        severity: item.severity,
        originalSeverity: item.severity,
        downgradedTo: null,
        status: "open",
        resolutionEvidence: null,
        waiverReason: null,
        downgradeReason: null,
        overrideReason: null,
        specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
        mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
        sourceHashesJson,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      }).run();
    }
  });

  return { blueHash };
}
