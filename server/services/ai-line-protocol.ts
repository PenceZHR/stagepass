import fs from "node:fs";
import path from "node:path";

import type { AiRunResult } from "./ai-engine-types";

/**
 * Shared primitives for line-protocol AI outputs.
 *
 * Project rule: models never author JSON. Every stage that needs structured
 * output defines a line-oriented protocol (prefixed single-line records plus
 * at most a few named singleton multi-line blocks); stagepass parses the
 * lines deterministically, assembles the payload itself, and validates it
 * against the stage's JSON schema as a second gate. This kills the entire
 * "model corrupts JSON text / repair pass fixes syntax but not semantics"
 * failure class observed live in e2e (`},{` fragments and `js1024` suffixes
 * leaking into QA-executed commands).
 *
 * Anything without a known prefix is ignored so the model may reason freely
 * around the protocol lines.
 *
 * ## Wiring a stage (read before adding one)
 *
 * There is no single canonical call site, because stages differ in ways that
 * matter. Pick by what the stage already is, and keep the engine's
 * `outputSchema` off the request in every case -- handing the model a schema is
 * the invitation to author JSON, and the schema's job is now the second gate
 * over the payload this toolkit assembles.
 *
 *  1. Stage runs through runDocumentStage (test_plan): set `lineProtocol` on
 *     the stage config. The runner applies the parser and installs the guard.
 *     Prefer this whenever the stage fits the runner.
 *  2. Stage owns its engine call and ingestion contract (generate_plan, review,
 *     spec_critic): call applyLineProtocol(), pass `.result` as the ingestion
 *     aiResult, and wrap the stage's schema check with
 *     guardLineProtocolSchema(). Keep any `providerFailed` short-circuit ahead
 *     of the guard -- a failed run has no reply worth parsing.
 *  3. Stage has its own runner AND a candidate-file recovery contract
 *     (prd_briefing_*): same as (2), but the guard must apply only while
 *     `result.success`. applyLineProtocol() returns an EMPTY state for a run
 *     with nothing to parse -- a failed run, or a "successful" one whose reply
 *     is empty -- and the guard rejects everything against an empty state, so
 *     guarding unconditionally silently kills the recovery path. An empty reply
 *     is attributed by ingestion (provider_empty_response), not by the parser.
 *  4. Stage is project-scoped rather than change-scoped (legacy PRD in
 *     prd-service): the change-scoped ingestion/raw-capture machinery does not
 *     apply -- `artifacts.change_id` is NOT NULL with an FK into `changes`.
 *     Parse directly, keep the parser as the ONLY branch that can produce a
 *     payload, and record the raw reply on the stage's own event so a settled
 *     run stays auditable.
 *
 * Cross-module contract worth knowing: guardLineProtocolSchema decides
 * authority by object identity, so ingestion must hand validateSchema the very
 * object it was given. A clone or JSON round-trip there would silently reject
 * every legitimate payload; stage-ai-output-ingestion-service.test.ts pins it.
 */

export interface LineProtocolContext {
  changeId: string;
  repoPath: string;
}

export type LineProtocolParseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string };

export interface ProtocolLine {
  lineNo: number;
  keyword: string;
  rest: string;
}

/** Strips an optional markdown bullet so `- COMMAND!: …` still parses. */
export function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*]\s+)?/, "").trimEnd();
}

export function splitFields(rest: string): string[] {
  return rest.split("|").map((field) => field.trim());
}

export function nullableField(value: string): string | null {
  return value === "-" || value === "" ? null : value;
}

/**
 * One tokenizer for the whole protocol: splits rawText into named block regions
 * and the top-level lines around them.
 *
 * A block is `NAME<<` … `>>NAME`. The terminator carries the block's name on
 * purpose. An unnamed `>>` has no identity, so any body line that happened to be
 * exactly `>>` — an empty nested blockquote, or a document quoting this protocol,
 * which stagepass's own PRDs do — closed the block early. The field was then
 * truncated with no error, and in a multi-block payload the rest of its body was
 * re-bound onto the NEXT block: exactly the silent-corruption class this protocol
 * exists to remove, passing both the parser and the schema. With `>>NAME` a body
 * may contain anything except its own terminator and a standalone opener for a
 * KNOWN block (see findStructuralBlockError: the latter would mis-bind, so it is
 * rejected; inline prose that mentions `NAME<<` is fine).
 *
 * Inside a block only that block's terminator is meaningful: bare `>>`, other
 * blocks' terminators, and openers for names this stage does not expect are all
 * ordinary content.
 */
export interface ProtocolBlock {
  name: string;
  content: string;
  openLineNo: number;
}

export interface ProtocolSegments {
  blocks: ProtocolBlock[];
  /** Lines outside every block, in source order. */
  topLevel: Array<{ lineNo: number; text: string }>;
  unterminated: string | null;
  /**
   * Top-level lines that look like a terminator (`>>NAME`) but close no open
   * block. A block whose body contained its own terminator closes early and
   * leaves the real terminator stranded here — that is the fingerprint of a
   * silent truncation, so it is surfaced rather than dropped.
   */
  strayTerminators: Array<{ name: string; lineNo: number }>;
}

const BLOCK_OPENER = /^([A-Z][A-Z0-9_]*)<<$/;
const BLOCK_TERMINATOR = /^>>([A-Z][A-Z0-9_]*)$/;

export function blockTerminator(name: string): string {
  return `>>${name}`;
}

export function segmentProtocolText(rawText: string): ProtocolSegments {
  const lines = (rawText ?? "").split(/\r?\n/);
  const blocks: ProtocolBlock[] = [];
  const topLevel: Array<{ lineNo: number; text: string }> = [];
  const strayTerminators: Array<{ name: string; lineNo: number }> = [];
  let open: { name: string; openLineNo: number; buffer: string[] } | null = null;

  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    const line = lines[lineNo - 1] ?? "";
    if (open) {
      if (stripBullet(line) === blockTerminator(open.name)) {
        blocks.push({ name: open.name, content: open.buffer.join("\n"), openLineNo: open.openLineNo });
        open = null;
        continue;
      }
      open.buffer.push(line);
      continue;
    }
    const bare = stripBullet(line);
    const opener = BLOCK_OPENER.exec(bare);
    if (opener) {
      open = { name: opener[1]!, openLineNo: lineNo, buffer: [] };
      continue;
    }
    const terminator = BLOCK_TERMINATOR.exec(bare);
    if (terminator) {
      strayTerminators.push({ name: terminator[1]!, lineNo });
      continue;
    }
    topLevel.push({ lineNo, text: line });
  }

  return { blocks, topLevel, unterminated: open ? open.name : null, strayTerminators };
}

/**
 * The single structural gate every parser calls before reading records or
 * blocks. It catches three silent-truncation shapes segmentProtocolText can
 * otherwise swallow:
 *
 *  - an unterminated block (`NAME<<` with no `>>NAME`) swallows every following
 *    line into its body, so a record-only stage would settle with the tail
 *    dropped;
 *  - a stray terminator (`>>NAME` at top level) means a block closed early
 *    because its body contained its own terminator, dropping the rest;
 *  - a well-formed but UNEXPECTED block (`NOTE<<` … `>>NOTE` in a stage that
 *    declares no NOTE block) swallows every record between its opener and
 *    terminator into a body no stage field reads. This is the balanced twin of
 *    the unterminated case: structurally valid, invisible to the schema, silent.
 *
 * `expectedBlockNames` is each stage's own set of legitimate block names (empty
 * for record-only stages). Passing it turns any off-script block into a loud
 * error. Omitting it skips only that check — collectSingletonBlock calls it that
 * way because it validates one block at a time and cannot know the full set.
 *
 * All three are the corruption class the line protocol exists to remove, so they
 * become a loud, retryable error here rather than a short payload.
 */
export function findStructuralBlockError(
  rawText: string,
  expectedBlockNames?: readonly string[],
): string | null {
  const segments = segmentProtocolText(rawText);
  if (segments.unterminated !== null) {
    return `unterminated ${segments.unterminated}<< block (missing ${blockTerminator(segments.unterminated)})`;
  }
  const stray = segments.strayTerminators[0];
  if (stray) {
    return (
      `stray "${blockTerminator(stray.name)}" at line ${stray.lineNo} closes no open ${stray.name}<< block — `
      + `the ${stray.name}<< block likely closed early because its body contained a "${blockTerminator(stray.name)}" line`
    );
  }
  if (expectedBlockNames) {
    const allowed = new Set(expectedBlockNames);
    const unexpected = segments.blocks.find((block) => !allowed.has(block.name));
    if (unexpected) {
      return (
        `unexpected ${unexpected.name}<< block (line ${unexpected.openLineNo}) is not part of this stage — `
        + "its body would be dropped, so any records inside it are lost. Remove the block and write records as plain lines"
      );
    }
    // A standalone line that is a KNOWN block's opener, sitting inside another
    // block's body, does not nest — it is absorbed as content, so that block's
    // field silently mis-binds (its text lands under the outer block, its own
    // field goes empty). Only a *standalone* known opener is flagged; inline
    // prose that mentions `NAME<<` is left alone, preserving the escape hatch.
    for (const block of segments.blocks) {
      for (const raw of block.content.split("\n")) {
        const inner = BLOCK_OPENER.exec(stripBullet(raw));
        if (inner && allowed.has(inner[1]!)) {
          return (
            `${inner[1]}<< appears on its own line inside the ${block.name}<< block body — `
            + `blocks do not nest, so its content would mis-bind into ${block.name}. `
            + `Close ${block.name} first and write ${inner[1]} as its own top-level block`
          );
        }
      }
    }
  }
  return null;
}

/**
 * Scans rawText for `KEYWORD: rest` lines. Keywords may carry a trailing
 * `!` or `?` variant marker (e.g. COMMAND! / COMMAND?), which is preserved in
 * the returned keyword.
 *
 * Block bodies are excluded. They used to be scanned too, so a model recapping
 * its findings inside a SUMMARY block had that prose harvested as extra records
 * — a phantom P0 that blocks the QA gate while also sitting in the summary text.
 */
export function scanProtocolLines(rawText: string, keywords: readonly string[]): ProtocolLine[] {
  const pattern = new RegExp(
    `^(${keywords.map((keyword) => keyword.replace(/[!?]/g, "\\$&")).join("|")}):\\s*(.*)$`,
  );
  const results: ProtocolLine[] = [];
  for (const { lineNo, text } of segmentProtocolText(rawText).topLevel) {
    const match = pattern.exec(stripBullet(text));
    if (!match) continue;
    results.push({ lineNo, keyword: match[1]!, rest: match[2]!.trim() });
  }
  return results;
}

/**
 * Collects a named singleton multi-line block:
 *
 *   NAME<<
 *   ...content...
 *   >>NAME
 *
 * Returns content `null` when the block is absent; an unterminated or
 * duplicated block is an error. Singleton blocks keep multi-line fields
 * (markdown bodies, long summaries) unambiguous — records stay single-line.
 */
export function collectSingletonBlock(
  rawText: string,
  name: string,
): { ok: true; content: string | null } | { ok: false; message: string } {
  // Self-defensive: surface unterminated blocks and stray terminators even when
  // called standalone, so a body line equal to this block's own terminator
  // (which closes it early and strands the real terminator) fails loud instead
  // of returning a truncated string.
  const structural = findStructuralBlockError(rawText);
  if (structural) return { ok: false, message: structural };
  const matches = segmentProtocolText(rawText).blocks.filter((block) => block.name === name);
  if (matches.length > 1) {
    return { ok: false, message: `duplicate ${name}<< block (line ${matches[1]!.openLineNo})` };
  }
  return { ok: true, content: matches.length === 0 ? null : matches[0]!.content };
}

export interface RepoCommandOptions {
  /**
   * Whether path-ish tokens must already exist in the repo. QA-executed
   * commands (test plan) demand it; plan-stage commands may legitimately
   * reference files the build has not created yet.
   */
  checkFileExistence: boolean;
  maxLength?: number;
}

const DEFAULT_MAX_COMMAND_LENGTH = 500;

/**
 * Command-level semantic validation: a schema can only assert "this is a
 * string"; these checks assert the string is a plausible repo-rooted shell
 * command. Returns an error message or null.
 */
export function validateRepoCommand(
  command: string,
  ctx: LineProtocolContext,
  options: RepoCommandOptions,
): string | null {
  const maxLength = options.maxLength ?? DEFAULT_MAX_COMMAND_LENGTH;
  if (command.length > maxLength) {
    return `command exceeds ${maxLength} chars`;
  }
  const garbage = findStructuralGarbage(command);
  if (garbage) return `${garbage}: ${command}`;
  if (command.includes("`")) {
    return `command contains backticks (command substitution is not allowed): ${command}`;
  }
  if (!options.checkFileExistence) return null;

  // Path-ish tokens (contain "/", no shell variables/globs/URLs) must exist in
  // the repo. This is what catches `test/foo.test.js1024`-class corruption
  // even when the surrounding syntax is valid shell.
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']+|["']+$/g, "");
    if (!token.includes("/")) continue;
    if (token.includes("$") || token.includes("://")) continue;
    if (token.startsWith("-")) continue;
    if (/[<>;&]/.test(token)) continue;
    if (token.includes("*")) {
      const globDir = token.slice(0, token.indexOf("*")).replace(/[^/]*$/, "");
      const dirToCheck = globDir === "" ? "." : globDir;
      if (!fs.existsSync(path.resolve(ctx.repoPath, dirToCheck))) {
        return `command references a glob under a missing directory (${dirToCheck}): ${command}`;
      }
      continue;
    }
    if (path.isAbsolute(token)) {
      // Absolute paths (e.g. /dev/null) are environment concerns, not repo
      // references.
      continue;
    }
    if (!fs.existsSync(path.resolve(ctx.repoPath, token))) {
      return `command references a file that does not exist in the repo (${token}): ${command}`;
    }
  }
  return null;
}

/** JSON-fragment and quote-balance checks shared by parser and DB-door gates. */
export function findStructuralGarbage(value: string): string | null {
  if (value.includes("},{") || value.includes("],[")) {
    return "contains JSON fragment garbage";
  }
  if ((value.match(/"/g) ?? []).length % 2 !== 0 || (value.match(/'/g) ?? []).length % 2 !== 0) {
    return "has unbalanced quotes";
  }
  return null;
}

/**
 * Validates a repo-relative file path declaration (plan EXPECT/FORBID lines,
 * review file references): repo-rooted, no traversal, no structural garbage.
 * Existence is intentionally not required — declared files may be created
 * later in the pipeline.
 */
export function validateRepoRelativePath(value: string): string | null {
  const garbage = findStructuralGarbage(value);
  if (garbage) return garbage;
  if (value.includes("\\")) return "uses backslashes";
  if (path.isAbsolute(value)) return "must be repo-relative, not absolute";
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith("..")) return "escapes the repo root";
  if (/\s/.test(value)) return "contains whitespace";
  return null;
}

export interface LineProtocolState {
  payload?: Record<string, unknown>;
  failure?: string;
}


/**
 * Applies a stage's line-protocol parser to a successful AiRunResult: on
 * success the deterministically assembled payload replaces any model-declared
 * structured output (source "line_protocol"); on failure the structured
 * output is cleared so ingestion cannot fall back to model-authored JSON.
 * Returns the adjusted result plus the state guardLineProtocolSchema() needs.
 *
 * Order matters: "did the provider deliver a reply?" is asked BEFORE "is the
 * reply well-formed?". A run that returned nothing is not a protocol violation
 * and must never be described as one -- see the empty-reply short-circuit below.
 */
export function applyLineProtocol(
  result: AiRunResult,
  parse: (rawText: string, ctx: LineProtocolContext) => LineProtocolParseResult,
  ctx: LineProtocolContext,
): { result: AiRunResult; state: LineProtocolState } {
  // Two ways to have nothing worth parsing: the run failed, or it "succeeded"
  // with an empty reply. The second is the shape a killed provider produces
  // (macOS sleep -> supervisor SIGTERM -> codex exits having emitted reasoning
  // items but no agent_message). Testing only `success` let that empty string
  // through to the parser, which reported the only thing it could -- "expected a
  // MARKDOWN<< ... >>MARKDOWN block" -- and then the result was stamped
  // structuredOutputSource: "line_protocol", asserting the model had authored
  // protocol text it never wrote. That false provenance is what steered every
  // downstream label onto the model. Both cases return an EMPTY state, which
  // callers already handle (see the wiring shapes above).
  if (!result.success || (result.summary ?? "").trim().length === 0) {
    return { result, state: {} };
  }
  const parsed = parse(result.summary ?? "", ctx);
  if (parsed.ok) {
    return {
      result: { ...result, structuredOutput: parsed.payload, structuredOutputSource: "line_protocol" },
      state: { payload: parsed.payload },
    };
  }
  // Keep a sentinel candidate on the result so ingestion is guaranteed to run
  // validateSchema at least once — otherwise (prose-only summaries) the parse
  // error would never surface in the failure detail. The guard fails every
  // candidate with the parse message, so the sentinel can never persist.
  return {
    result: { ...result, structuredOutput: {}, structuredOutputSource: "line_protocol" },
    state: { failure: parsed.message },
  };
}

/**
 * Wraps a stage's validateSchema contract so the line protocol stays
 * authoritative: a parse failure fails every candidate (retryable invalid
 * output, raw text captured), and only the parser-assembled payload — by
 * reference — is accepted, so fenced/naked/repair extraction can never
 * resurrect model-authored JSON.
 */
export function guardLineProtocolSchema(
  state: LineProtocolState,
  base: (value: unknown) => true | { ok: false; message: string },
  phase: string,
): (value: unknown) => true | { ok: false; message: string } {
  return (value) => {
    if (state.failure) return { ok: false, message: state.failure };
    if (value !== state.payload) {
      return {
        ok: false,
        message: `${phase} line protocol is authoritative; model-authored JSON is not accepted`,
      };
    }
    return base(value);
  };
}
