import {
  findStructuralBlockError,
  findStructuralGarbage,
  scanProtocolLines,
  segmentProtocolText,
  splitFields,
  stripBullet,
} from "./ai-line-protocol";

/**
 * A single clarified requirement. Owned here rather than in refine-service so
 * the parser that assembles these is also the module that defines what one is;
 * refine-service re-exports it, so every existing importer is unaffected.
 */
export interface Requirement {
  id: string;
  category: "functional" | "non-functional" | "constraint";
  title: string;
  description: string;
  status: "confirmed" | "uncertain" | "new";
}

/**
 * Line-oriented output protocol for the refine stage.
 *
 * Like the legacy PRD stage (prd-line-protocol.ts), refine is a CHAT turn:
 * `summary` carries both the assistant's message to the human and the protocol
 * lines, so stripRefineProtocol() removes the protocol from what the user is
 * shown.
 *
 * What this replaces: refine used to instruct the model to emit a
 * ```requirements fenced JSON array, `JSON.parse` it, and accept the result if
 * `Array.isArray(parsed)` -- with NO per-item validation at all. A reply
 * carrying `[1, 2, 3]`, or items missing `category`/`status`, or items with a
 * category the UI has no branch for, all sailed through into
 * confirmRequirements(), which renders them straight into spec.md. Assembling
 * the array here and validating it against REFINE_OUTPUT_SCHEMA closes both
 * halves.
 *
 * Field order is `id | category | status | title | description`, NOT the
 * interface's declaration order. `description` is last precisely because it is
 * the free-est field, so it absorbs any surplus "|" (see the slice(4) join) and
 * a human-written description containing a pipe cannot shift every field after
 * it. The three fixed-vocabulary fields sit up front where a typo is a loud
 * enum error rather than a silent shift.
 */

export type RefineLineProtocolResult =
  | { ok: true; payload: { requirements: Requirement[] } }
  | { ok: false; message: string };

const KEYWORDS = ["REQ"] as const;

const CATEGORIES = new Set<Requirement["category"]>([
  "functional",
  "non-functional",
  "constraint",
]);
const STATUSES = new Set<Requirement["status"]>(["confirmed", "uncertain", "new"]);

const MAX_FIELD_LENGTH = 2_000;

/**
 * Removes the protocol from a chat reply so the human reads prose, not machine
 * syntax. Uses the shared tokenizer for the same reason prd-line-protocol does:
 * a second, subtly different scanner here could disagree with the parser about
 * which lines are protocol, and then the human would read something the parser
 * never saw.
 */
export function stripRefineProtocol(rawText: string): string {
  const keywordPattern = new RegExp(`^(?:${KEYWORDS.join("|")}):`);
  return segmentProtocolText(rawText)
    .topLevel
    .filter(({ text }) => !keywordPattern.test(stripBullet(text)))
    .map(({ text }) => text)
    .join("\n")
    .trim();
}

export function parseRefineLineProtocol(rawText: string): RefineLineProtocolResult {
  const structural = findStructuralBlockError(rawText, []);
  if (structural) return { ok: false, message: `refine line protocol rejected: ${structural}` };

  const requirements: Requirement[] = [];
  const errors: string[] = [];

  for (const { lineNo, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    const fields = splitFields(rest);
    if (fields.length < 5) {
      errors.push(
        `line ${lineNo}: REQ needs 5 "|" fields `
        + `(id | functional/non-functional/constraint | confirmed/uncertain/new | title | description), `
        + `got ${fields.length}`,
      );
      continue;
    }
    const [id, category, status, title] = fields as [string, string, string, string];
    const description = fields.slice(4).join(" | ").trim();
    if (!id || !title || !description) {
      errors.push(`line ${lineNo}: REQ has an empty id/title/description`);
      continue;
    }
    if (!CATEGORIES.has(category as Requirement["category"])) {
      errors.push(
        `line ${lineNo}: REQ category must be functional/non-functional/constraint, got "${category}"`,
      );
      continue;
    }
    if (!STATUSES.has(status as Requirement["status"])) {
      errors.push(
        `line ${lineNo}: REQ status must be confirmed/uncertain/new, got "${status}"`,
      );
      continue;
    }
    const overlong = [
      ["id", id],
      ["title", title],
      ["description", description],
    ].find(([, value]) => value!.length > MAX_FIELD_LENGTH);
    if (overlong) {
      errors.push(`line ${lineNo}: REQ ${overlong[0]} exceeds ${MAX_FIELD_LENGTH} chars`);
      continue;
    }
    const garbage = findStructuralGarbage(title) ?? findStructuralGarbage(description);
    if (garbage) {
      errors.push(`line ${lineNo}: REQ ${garbage}`);
      continue;
    }
    requirements.push({
      id,
      category: category as Requirement["category"],
      title,
      status: status as Requirement["status"],
      description,
    });
  }

  // Two REQ lines with the same id carry contradictory status/description that
  // both survive dedup-by-id (refineTurn keeps the LAST one), so the model would
  // silently lose a requirement it actually stated. Requirements must be
  // uniquely addressable -- the same rule prd-line-protocol applies to FR/AC ids.
  const duplicates = requirements
    .map((requirement) => requirement.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    errors.push(`duplicate REQ id: ${Array.from(new Set(duplicates)).join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `refine line protocol rejected: ${errors.join("; ")}` };
  }

  // Zero REQ lines is NOT an error. Refine is a conversation: a turn that only
  // asks clarifying questions has nothing to extract yet, and failing it would
  // throw away the assistant's reply to the human. That case is handled by the
  // caller's same-thread retry, exactly as it was before the protocol. A
  // MALFORMED line is a different thing entirely and is loud, above.
  return { ok: true, payload: { requirements } };
}
