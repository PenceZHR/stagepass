import {
  findStructuralBlockError,
  findStructuralGarbage,
  scanProtocolLines,
  splitFields,
} from "./ai-line-protocol";

/**
 * Line-oriented output protocol for the tech_spec stage (TechSpec + API
 * snapshots). Shared primitives live in ai-line-protocol.ts.
 *
 * Before this existed, tech_spec was the last pipeline stage still asking the
 * model for "一个 JSON object" in the prompt, AND the only document stage with
 * no `outputSchema` at all -- so `runDocumentStage`'s entire ingestion block
 * was skipped, `structuredOutput` stayed undefined, and
 * persistTechSpecAndApiSnapshots fell back to the raw `summary` string. A reply
 * that was not parseable JSON therefore reached normalizeDesignSections as
 * prose and threw DesignSnapshotValidationError *after* the provider had gone
 * terminal, with no raw capture written to diff against. Both halves of that
 * are fixed by wiring this parser plus TECH_SPEC_OUTPUT_SCHEMA into the stage.
 *
 * ## Shape
 *
 * The payload is `{ techSpec, apiContract? }`, matching what
 * selectTechSpecCandidate / selectApiCandidate already read, so the persistence
 * path is unchanged.
 *
 * `apiContract` is OMITTED when the reply carries no API_* line. That is
 * deliberate: it preserves today's live behaviour, where selectApiCandidate
 * returns null and deriveApiContractFromTechSpec copies the tech spec into the
 * API snapshot. The one production change (CHG-001) has a byte-identical
 * api_snapshots.contract_json and techspec_snapshots.content_json, i.e. the
 * derive path is the path that actually runs. Requiring API_* lines would have
 * changed that silently.
 *
 * Record shapes track the sections already stored in production rather than
 * inventing new ones: interfaces are `{name, type, change}` (the only key set
 * present in CHG-001) and dataContracts are
 * `{name, requiredFields[], constraints[]}` (CHG-001 stores
 * `constraints,name,requiredFields`). Sections stay `unknown[]` in
 * NormalizedDesignSections and their only consumer JSON.stringify()s them into
 * Build/Review prompts, so nothing downstream is coupled to the record shape --
 * but matching it keeps old and new snapshots readable side by side.
 *
 * Separators: requiredFields split on ASCII "," and constraints on ASCII ";".
 * Both are safe against the CJK prose these fields actually carry, which uses
 * full-width "，" and "；".
 */

export interface DesignSectionsLinePayload {
  interfaces: Array<{ name: string; type: string; change: string }>;
  dataContracts: Array<{ name: string; requiredFields: string[]; constraints: string[] }>;
  migrationNotes: string[];
  buildInputs: string[];
  reviewInputs: string[];
}

export interface TechSpecLinePayload {
  techSpec: DesignSectionsLinePayload;
  apiContract?: DesignSectionsLinePayload;
}

export type TechSpecLineProtocolResult =
  | { ok: true; payload: TechSpecLinePayload }
  | { ok: false; message: string };

const KEYWORDS = [
  "API_INTERFACE",
  "API_CONTRACT",
  "API_MIGRATION",
  "API_BUILD",
  "API_REVIEW",
  "INTERFACE",
  "CONTRACT",
  "MIGRATION",
  "BUILD",
  "REVIEW",
] as const;

/** Guards against a model dumping an entire spec into one record. */
const MAX_FIELD_LENGTH = 2_000;

type SectionGroup = {
  interfaces: DesignSectionsLinePayload["interfaces"];
  dataContracts: DesignSectionsLinePayload["dataContracts"];
  migrationNotes: string[];
  buildInputs: string[];
  reviewInputs: string[];
  /** Whether any line at all addressed this group. */
  touched: boolean;
};

function emptyGroup(): SectionGroup {
  return {
    interfaces: [],
    dataContracts: [],
    migrationNotes: [],
    buildInputs: [],
    reviewInputs: [],
    touched: false,
  };
}

function toPayload(group: SectionGroup): DesignSectionsLinePayload {
  return {
    interfaces: group.interfaces,
    dataContracts: group.dataContracts,
    migrationNotes: group.migrationNotes,
    buildInputs: group.buildInputs,
    reviewInputs: group.reviewInputs,
  };
}

/** Text-field gate: the `},{` / unbalanced-quote class the protocol exists to kill. */
function fieldError(label: string, value: string): string | null {
  if (value.length > MAX_FIELD_LENGTH) {
    return `${label} exceeds ${MAX_FIELD_LENGTH} chars`;
  }
  const garbage = findStructuralGarbage(value);
  return garbage ? `${label} ${garbage}` : null;
}

function splitList(value: string, separator: string): string[] {
  if (value === "-" || value === "") return [];
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseTechSpecLineProtocol(rawText: string): TechSpecLineProtocolResult {
  const structural = findStructuralBlockError(rawText, []);
  if (structural) return { ok: false, message: `tech-spec line protocol rejected: ${structural}` };

  const techSpec = emptyGroup();
  const api = emptyGroup();
  const errors: string[] = [];

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    const isApi = keyword.startsWith("API_");
    const group = isApi ? api : techSpec;
    const kind = isApi ? keyword.slice("API_".length) : keyword;
    group.touched = true;

    if (kind === "INTERFACE") {
      const fields = splitFields(rest);
      if (fields.length < 3) {
        errors.push(
          `line ${lineNo}: ${keyword} needs 3 "|" fields (name | type | change), got ${fields.length}`,
        );
        continue;
      }
      const [name, type] = fields as [string, string];
      const change = fields.slice(2).join(" | ").trim();
      if (!name || !type || !change) {
        errors.push(`line ${lineNo}: ${keyword} has an empty name/type/change`);
        continue;
      }
      const bad = fieldError(`${keyword} change`, change) ?? fieldError(`${keyword} name`, name);
      if (bad) {
        errors.push(`line ${lineNo}: ${bad}`);
        continue;
      }
      group.interfaces.push({ name, type, change });
      continue;
    }

    if (kind === "CONTRACT") {
      const fields = splitFields(rest);
      if (fields.length < 3) {
        errors.push(
          `line ${lineNo}: ${keyword} needs 3 "|" fields `
          + `(name | requiredFields 逗号分隔或 - | constraints 分号分隔或 -), got ${fields.length}`,
        );
        continue;
      }
      const [name, requiredRaw] = fields as [string, string];
      const constraintsRaw = fields.slice(2).join(" | ").trim();
      if (!name) {
        errors.push(`line ${lineNo}: ${keyword} has an empty name`);
        continue;
      }
      const bad = fieldError(`${keyword} name`, name)
        ?? fieldError(`${keyword} requiredFields`, requiredRaw)
        ?? fieldError(`${keyword} constraints`, constraintsRaw);
      if (bad) {
        errors.push(`line ${lineNo}: ${bad}`);
        continue;
      }
      group.dataContracts.push({
        name,
        requiredFields: splitList(requiredRaw, ","),
        constraints: splitList(constraintsRaw, ";"),
      });
      continue;
    }

    // MIGRATION / BUILD / REVIEW: the whole rest is one free-prose note, so "|"
    // is legal inside it.
    if (!rest) {
      errors.push(`line ${lineNo}: ${keyword} is empty`);
      continue;
    }
    const bad = fieldError(keyword, rest);
    if (bad) {
      errors.push(`line ${lineNo}: ${bad}`);
      continue;
    }
    if (kind === "MIGRATION") group.migrationNotes.push(rest);
    else if (kind === "BUILD") group.buildInputs.push(rest);
    else group.reviewInputs.push(rest);
  }

  // The three sections downstream stages actually consume: interfaces is the
  // design itself, buildInputs feeds Build, reviewInputs feeds Review. A tech
  // spec missing any of them settles a TechSpec gate that tells the next stage
  // nothing. dataContracts/migrationNotes may legitimately be empty (a pure-UI
  // change adds no contract and migrates nothing).
  if (techSpec.interfaces.length === 0) errors.push("expected at least 1 INTERFACE line");
  if (techSpec.buildInputs.length === 0) errors.push("expected at least 1 BUILD line");
  if (techSpec.reviewInputs.length === 0) errors.push("expected at least 1 REVIEW line");

  // A partial API group is the truncation fingerprint: the model opened an API
  // contract and stopped. Writing no API_* line at all stays legal and derives
  // the contract from the tech spec, so there is always a way to say "no
  // separate API contract" without tripping this.
  if (api.touched && api.interfaces.length === 0) {
    errors.push(
      "API_* lines are present but no API_INTERFACE line: an API contract with no interface is not a contract. "
      + "Either add API_INTERFACE, or drop every API_* line to derive the contract from the tech spec",
    );
  }

  if (errors.length > 0) {
    return { ok: false, message: `tech-spec line protocol rejected: ${errors.join("; ")}` };
  }

  const payload: TechSpecLinePayload = { techSpec: toPayload(techSpec) };
  if (api.touched) payload.apiContract = toPayload(api);
  return { ok: true, payload };
}
