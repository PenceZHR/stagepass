import {
  collectSingletonBlock,
  findStructuralBlockError,
  findStructuralGarbage,
  scanProtocolLines,
  splitFields,
  validateRepoRelativePath,
} from "./ai-line-protocol";

/**
 * Line-oriented output protocol for the Done (delivery) stage.
 * Shared primitives live in ai-line-protocol.ts; the project rule is that models
 * never author JSON.
 *
 * ## What this protocol deliberately does NOT contain
 *
 * There is no block for "已知限制与没做的事" as a whole. The delivery note's
 * fourth section has two halves and only one of them is the model's to write:
 *
 *  - the DB-derived half (open `requirement_gaps`, waived P1 findings, the
 *    `human_decisions` ledger) is composed by delivery-known-limits-service and
 *    spliced in by the caller. A model asked to recall "what did I not do" is
 *    being asked in the one direction it is least reliable in, and the answer
 *    would be unfalsifiable -- nothing downstream reads the delivery note, so a
 *    silently-omitted gap leaves no trace anywhere.
 *  - the narrative half (explicit non-goals, pitfalls hit along the way) has no
 *    row in any table, so KNOWN_LIMITS<< is the model's slot for exactly that.
 *
 * Because the DB half has no protocol slot, a reply that invents one
 * (`OPEN_GAPS<<`) is rejected by findStructuralBlockError as an off-script
 * block rather than quietly ignored.
 *
 * The payload key is `markdown` -- assembled by the caller, not here -- because
 * the document stage runner writes .md artifacts from `structuredOutput.markdown`
 * (markdownArtifactContentFromResult). Naming it anything else silently falls
 * back to the raw reply, which is how prd-delta.md once came to hold a JSON blob.
 */

export const DELIVERY_FILE_ROLES = ["entry", "internal", "test", "doc", "config"] as const;
export type DeliveryFileRole = (typeof DELIVERY_FILE_ROLES)[number];

export interface DeliveryFileMapEntry {
  path: string;
  role: DeliveryFileRole;
  purpose: string;
}

export interface DeliveryLinePayload {
  /** §3.2 item 1: entry point, dependencies, command, what success looks like. */
  howToRun: string;
  /** §3.2 item 2: capabilities added, visible change, how to verify it. */
  whatChanged: string;
  /** §3.2 item 3: one record per touched file. */
  fileMap: DeliveryFileMapEntry[];
  /** §3.2 item 4, model-authored half only. The DB half is spliced in by the caller. */
  knownLimitsNarrative: string;
}

export type DeliveryLineProtocolResult =
  | { ok: true; payload: DeliveryLinePayload }
  | { ok: false; message: string };

const KEYWORDS = ["FILEMAP", "DELIVERY_DONE"] as const;
const HOW_TO_RUN = "HOW_TO_RUN";
const WHAT_CHANGED = "WHAT_CHANGED";
const KNOWN_LIMITS = "KNOWN_LIMITS";
export const DELIVERY_BLOCK_NAMES = [HOW_TO_RUN, WHAT_CHANGED, KNOWN_LIMITS] as const;
const FILEMAP_FIELDS = 3;
const ROLES = new Set<string>(DELIVERY_FILE_ROLES);

/**
 * Each of the three blocks IS one of the delivery note's mandatory sections, so
 * unlike a record array none of them can legitimately be absent or blank: an
 * empty one ships a delivery note with a whole section missing. "Nothing to
 * report" is written as prose inside the block (「本次不涉及…」), which keeps the
 * distinction between "answered with nothing" and "did not answer" visible.
 */
function requireBlock(rawText: string, name: string, errors: string[]): string {
  const block = collectSingletonBlock(rawText, name);
  if (!block.ok) {
    errors.push(block.message);
    return "";
  }
  if (block.content === null) {
    errors.push(`missing ${name}<< block (it carries one of the delivery note's four sections)`);
    return "";
  }
  if (block.content.trim().length === 0) {
    errors.push(`${name}<< block is empty`);
    return "";
  }
  return block.content.trim();
}

export function parseDeliveryLineProtocol(rawText: string): DeliveryLineProtocolResult {
  const structural = findStructuralBlockError(rawText, DELIVERY_BLOCK_NAMES);
  if (structural) return { ok: false, message: `delivery line protocol rejected: ${structural}` };

  const errors: string[] = [];
  const fileMap: DeliveryFileMapEntry[] = [];
  const doneMarkers: string[] = [];

  const howToRun = requireBlock(rawText, HOW_TO_RUN, errors);
  const whatChanged = requireBlock(rawText, WHAT_CHANGED, errors);
  const knownLimitsNarrative = requireBlock(rawText, KNOWN_LIMITS, errors);

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "DELIVERY_DONE") {
      if (rest === "true") doneMarkers.push(rest);
      else errors.push(`line ${lineNo}: DELIVERY_DONE must be true, got "${rest}"`);
      continue;
    }

    const fields = splitFields(rest);
    if (fields.length !== FILEMAP_FIELDS) {
      errors.push(
        `line ${lineNo}: FILEMAP needs exactly ${FILEMAP_FIELDS} "|" fields `
        + `(path | ${DELIVERY_FILE_ROLES.join("/")} | purpose), got ${fields.length}. 文本字段不得含 "|"`,
      );
      continue;
    }
    const [filePath, role, purpose] = fields as [string, string, string];
    if (!filePath) {
      errors.push(`line ${lineNo}: FILEMAP path is empty`);
      continue;
    }
    const pathError = validateRepoRelativePath(filePath);
    if (pathError) {
      errors.push(`line ${lineNo}: FILEMAP path ${pathError}: ${filePath}`);
      continue;
    }
    if (!ROLES.has(role)) {
      errors.push(
        `line ${lineNo}: FILEMAP role must be one of ${DELIVERY_FILE_ROLES.join("/")}, got "${role}"`,
      );
      continue;
    }
    if (!purpose) {
      errors.push(`line ${lineNo}: FILEMAP purpose is empty`);
      continue;
    }
    const garbage = findStructuralGarbage(purpose);
    if (garbage) {
      errors.push(`line ${lineNo}: FILEMAP purpose ${garbage}: ${purpose}`);
      continue;
    }
    fileMap.push({ path: filePath, role: role as DeliveryFileRole, purpose });
  }

  const duplicatePaths = fileMap
    .map((entry) => entry.path)
    .filter((value, index, all) => all.indexOf(value) !== index);
  if (duplicatePaths.length > 0) {
    errors.push(`duplicate FILEMAP path: ${Array.from(new Set(duplicatePaths)).join(", ")}`);
  }

  // Zero FILEMAP lines is NOT legal, and the judge is rubric-line-protocol.ts's:
  // "does silence have a ledger slot downstream that would block?". It does not.
  // The file map is one of the four sections this stage exists to produce, and
  // no gate, mirror or hash reads delivery.md -- so an empty map would ship a
  // delivery note silently missing a quarter of its content. Nor is it ever
  // legitimate: a change with no touched files is not a change.
  if (fileMap.length === 0) {
    errors.push(
      "expected at least 1 FILEMAP line (the file map is one of the delivery note's four sections)",
    );
  }

  // FILEMAP records and KNOWN_LIMITS trail two potentially very large blocks, so
  // a reply truncated after them still parses as a structurally complete
  // document with a short file map. The marker is written last, so truncation
  // takes it too and the stage fails loudly instead.
  if (doneMarkers.length !== 1) {
    errors.push(`expected exactly 1 DELIVERY_DONE: true line, got ${doneMarkers.length}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `delivery line protocol rejected: ${errors.join("; ")}` };
  }

  return { ok: true, payload: { howToRun, whatChanged, fileMap, knownLimitsNarrative } };
}
