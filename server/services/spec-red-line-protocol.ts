import {
  collectSingletonBlock,
  findStructuralBlockError,
  findStructuralGarbage,
  nullableField,
  scanProtocolLines,
  splitFields,
} from "./ai-line-protocol";
import type { RedFixClaim } from "./spec-battle-ledger";

/**
 * Line-oriented output protocol for the spec battle red draft (SPEC_WRITER).
 * Shared primitives live in ai-line-protocol.ts; the project rule is that models
 * never author JSON.
 *
 * Red was the last stage still parsing its reply with JSON.parse, and it did so
 * behind a bare catch that degraded to "the whole reply is the PRD delta, zero
 * fixClaims". Production round 7 carried 11 claims through that path; a single
 * trailing line -- a rubric line, a code fence, one sentence of preamble --
 * would have dropped all 11 with no error, no event and no gate signal.
 *
 * The payload key is `markdown`, not `prdDeltaMarkdown`, because the document
 * stage runner writes .md artifacts from `structuredOutput.markdown`
 * (markdownArtifactContentFromResult). Naming it anything else silently falls
 * back to the raw reply, which is how prd-delta.md came to hold a JSON blob.
 * The ledger's own vocabulary (`prdDeltaMarkdown`) is mapped at the call site.
 */

export interface SpecRedLinePayload {
  markdown: string;
  fixClaims: RedFixClaim[];
}

export type SpecRedLineProtocolResult =
  | { ok: true; payload: SpecRedLinePayload }
  | { ok: false; message: string };

const CLAIM_STATUSES = new Set([
  "fixed",
  "partially_fixed",
  "not_fixed",
  "needs_human_decision",
]);

const KEYWORDS = ["FIXCLAIM", "SPEC_DONE"] as const;
const BLOCK_NAME = "PRD_DELTA";
const FIXCLAIM_FIELDS = 5;

/** Ids key a cross-round upsert, so they must survive verbatim round-tripping. */
function validateCanonicalGapId(value: string): string | null {
  if (!value) return "canonicalGapId is empty";
  const garbage = findStructuralGarbage(value);
  if (garbage) return `canonicalGapId ${garbage}`;
  if (/\s/.test(value)) return "canonicalGapId contains whitespace (it must be a short stable id)";
  return null;
}

export function parseSpecRedLineProtocol(rawText: string): SpecRedLineProtocolResult {
  const structural = findStructuralBlockError(rawText, [BLOCK_NAME]);
  if (structural) return { ok: false, message: `spec red line protocol rejected: ${structural}` };

  const errors: string[] = [];
  const fixClaims: RedFixClaim[] = [];
  const doneMarkers: string[] = [];

  const block = collectSingletonBlock(rawText, BLOCK_NAME);
  if (!block.ok) {
    return { ok: false, message: `spec red line protocol rejected: ${block.message}` };
  }
  // The block is the stage's entire document, so unlike the record arrays it can
  // never legitimately be absent or blank: prd-delta.md is the Spec gate's
  // pending artifact and the readable input of four later stages. An empty one
  // would sail through the gate as a stamped, content-free delta.
  if (block.content === null) {
    errors.push(`missing ${BLOCK_NAME}<< block (it carries the whole PRD delta document)`);
  } else if (block.content.trim().length === 0) {
    errors.push(`${BLOCK_NAME}<< block is empty`);
  }

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "SPEC_DONE") {
      if (rest === "true") doneMarkers.push(rest);
      else errors.push(`line ${lineNo}: SPEC_DONE must be true, got "${rest}"`);
      continue;
    }

    const fields = splitFields(rest);
    if (fields.length !== FIXCLAIM_FIELDS) {
      errors.push(
        `line ${lineNo}: FIXCLAIM needs exactly ${FIXCLAIM_FIELDS} "|" fields (canonicalGapId | claimStatus | claimSummary | evidence | artifactPath 或 -), got ${fields.length}. 文本字段不得含 "|"`,
      );
      continue;
    }
    const [canonicalGapId, claimStatus, claimSummary, evidence, artifactRaw] = fields as [
      string, string, string, string, string,
    ];
    const idError = validateCanonicalGapId(canonicalGapId);
    if (idError) {
      errors.push(`line ${lineNo}: FIXCLAIM ${idError}`);
      continue;
    }
    if (!CLAIM_STATUSES.has(claimStatus)) {
      errors.push(
        `line ${lineNo}: FIXCLAIM claimStatus must be fixed/partially_fixed/not_fixed/needs_human_decision, got "${claimStatus}"`,
      );
      continue;
    }
    if (!claimSummary) {
      errors.push(`line ${lineNo}: FIXCLAIM claimSummary is empty`);
      continue;
    }
    if (!evidence) {
      errors.push(`line ${lineNo}: FIXCLAIM evidence is empty`);
      continue;
    }
    const artifactPath = nullableField(artifactRaw);
    if (artifactPath) {
      const garbage = findStructuralGarbage(artifactPath);
      if (garbage) {
        errors.push(`line ${lineNo}: FIXCLAIM artifactPath ${garbage}: ${artifactPath}`);
        continue;
      }
    }
    fixClaims.push({
      canonicalGapId,
      claimStatus: claimStatus as RedFixClaim["claimStatus"],
      claimSummary,
      evidence,
      artifactPath,
    });
  }

  // Two claims for one gap carry contradictory statuses (fixed vs not_fixed)
  // and both land in red_fix_claims, leaving blue to review a gap that claims
  // both at once.
  const duplicateIds = fixClaims
    .map((claim) => claim.canonicalGapId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    errors.push(`duplicate FIXCLAIM canonicalGapId: ${Array.from(new Set(duplicateIds)).join(", ")}`);
  }

  // Zero FIXCLAIM lines is legal -- round 1 has no prior gaps to claim against,
  // and production round 1 produced exactly that. But the claims trail a very
  // large block, so a reply truncated just after the block still parses as a
  // structurally complete document with no claims: the same silent claim loss
  // this protocol exists to end. The marker is written last, so truncation
  // takes it too and the round fails loudly instead.
  if (doneMarkers.length !== 1) {
    errors.push(`expected exactly 1 SPEC_DONE: true line, got ${doneMarkers.length}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `spec red line protocol rejected: ${errors.join("; ")}` };
  }

  return { ok: true, payload: { markdown: block.content as string, fixClaims } };
}
