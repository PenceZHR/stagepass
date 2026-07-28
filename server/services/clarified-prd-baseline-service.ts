import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { prdBriefings, prdDrafts } from "../db/schema";
import {
  prdSourceDbHash,
  syncPrdStageAuthority,
} from "./prd-briefing-service";

/**
 * Record a PRD that converged through Codex cards as the change's PRD baseline.
 *
 * The pipeline is DB-first: every later stage reads the PRD from
 * `prd_briefings` / `prd_drafts`, compares the PRD gate hash against a fresh
 * hash of those rows, and refuses to start when either is missing. The card
 * loop changed how the PRD is decided, not what the PRD is, so it lands in the
 * same tables rather than teaching each downstream stage a second shape.
 *
 * The lock is honest here: the human answered every blocking question on the
 * cards and the stage only converged once none remained. What it skips is the
 * web questionnaire's own records (generated questions, review verdicts),
 * which never happened and are not claimed.
 */
export function writeClarifiedPrdBaseline(input: {
  changeId: string;
  document: string;
}): { sourceDbHash: string } {
  const now = new Date().toISOString();
  const document = input.document;
  const documentHash = createHash("sha256").update(document).digest("hex");

  db.transaction((tx) => {
    const existing = tx.select().from(prdBriefings)
      .where(eq(prdBriefings.changeId, input.changeId)).get();
    if (existing) {
      tx.update(prdBriefings).set({
        status: "locked",
        lockedAt: existing.lockedAt ?? now,
        updatedAt: now,
      }).where(eq(prdBriefings.id, existing.id)).run();
    } else {
      tx.insert(prdBriefings).values({
        id: `PRDB-${randomUUID()}`,
        changeId: input.changeId,
        status: "locked",
        intentText: "",
        finalReviewJson: null,
        sourceHashesJson: JSON.stringify({ source: "clarification_loop" }),
        lockedAt: now,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    const drafts = tx.select().from(prdDrafts)
      .where(eq(prdDrafts.changeId, input.changeId)).all();
    // Re-running a stage with the same reply must not stack identical drafts;
    // a changed reply is a new version of the baseline.
    if (!drafts.some((draft) => draft.draftHash === documentHash)) {
      tx.insert(prdDrafts).values({
        id: `PRDD-${randomUUID()}`,
        changeId: input.changeId,
        version: drafts.reduce((max, draft) => Math.max(max, draft.version), 0) + 1,
        markdown: document,
        sourceQuestionIdsJson: "[]",
        unresolvedQuestionIdsJson: "[]",
        draftHash: documentHash,
        createdAt: now,
      }).run();
    }
  });

  // Seal the gate through the questionnaire's own path so the hash it records
  // is the one downstream stages recompute.
  syncPrdStageAuthority(input.changeId);
  return { sourceDbHash: prdSourceDbHash(input.changeId) };
}
