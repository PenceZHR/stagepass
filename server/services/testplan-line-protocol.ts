import {
  type LineProtocolContext,
  nullableField,
  findStructuralBlockError,
  scanProtocolLines,
  splitFields,
  validateRepoCommand,
} from "./ai-line-protocol";

/**
 * Line-oriented output protocol for the test_plan stage (the first stage
 * migrated to the project-wide "models never author JSON" rule; shared
 * primitives live in ai-line-protocol.ts).
 *
 * INTENT / COVERAGE / RISK / COMMAND! / COMMAND? / MANUAL! / MANUAL? lines
 * are parsed deterministically into the snapshot payload. Commands are
 * semantically validated with file-existence checks because QA executes them
 * verbatim — this is what killed the `},{` / `js1024` corruption observed
 * live before the protocol existed.
 */

export type TestPlanLineProtocolContext = LineProtocolContext;

export type TestPlanLineProtocolResult =
  | { ok: true; payload: TestPlanLinePayload }
  | { ok: false; message: string };

export interface TestPlanLinePayload {
  testIntent: string;
  coverageItems: Array<{
    itemKey: string;
    title: string;
    requirementRef: string | null;
    testType: string;
    priority: "P0" | "P1" | "P2";
  }>;
  riskMappings: Array<{
    coverageItemKey: string;
    riskRef: string;
    severity: "P0" | "P1" | "P2";
    mitigation: string;
  }>;
  requiredCommands: Array<{ command: string; required: boolean }>;
  manualChecks: Array<{ title: string; description: string | null; required: boolean }>;
}

const PRIORITIES = new Set(["P0", "P1", "P2"]);
const MAX_COMMANDS = 32;

const KEYWORDS = [
  "INTENT",
  "COVERAGE",
  "RISK",
  "COMMAND!",
  "COMMAND?",
  "MANUAL!",
  "MANUAL?",
] as const;

/** QA executes these verbatim, so referenced files must already exist. */
export function validateTestPlanCommand(
  command: string,
  ctx: TestPlanLineProtocolContext,
): string | null {
  return validateRepoCommand(command, ctx, { checkFileExistence: true });
}

export function parseTestPlanLineProtocol(
  rawText: string,
  ctx: TestPlanLineProtocolContext,
): TestPlanLineProtocolResult {
  const structural = findStructuralBlockError(rawText, []);
  if (structural) return { ok: false, message: `test-plan line protocol rejected: ${structural}` };
  const intents: string[] = [];
  const coverageItems: TestPlanLinePayload["coverageItems"] = [];
  const riskMappings: TestPlanLinePayload["riskMappings"] = [];
  const requiredCommands: TestPlanLinePayload["requiredCommands"] = [];
  const manualChecks: TestPlanLinePayload["manualChecks"] = [];
  const errors: string[] = [];

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "INTENT") {
      if (rest) intents.push(rest);
      else errors.push(`line ${lineNo}: INTENT is empty`);
      continue;
    }

    if (keyword === "COVERAGE") {
      const fields = splitFields(rest);
      if (fields.length !== 5) {
        errors.push(`line ${lineNo}: COVERAGE needs exactly 5 "|" fields (itemKey | title | requirementRef 或 - | testType | P0/P1/P2), got ${fields.length}`);
        continue;
      }
      const [itemKey, title, requirementRef, testType, priority] = fields as [string, string, string, string, string];
      if (!itemKey || !title || !testType) {
        errors.push(`line ${lineNo}: COVERAGE has empty itemKey/title/testType`);
        continue;
      }
      if (!PRIORITIES.has(priority)) {
        errors.push(`line ${lineNo}: COVERAGE priority must be P0/P1/P2, got "${priority}"`);
        continue;
      }
      coverageItems.push({
        itemKey,
        title,
        requirementRef: nullableField(requirementRef),
        testType,
        priority: priority as "P0" | "P1" | "P2",
      });
      continue;
    }

    if (keyword === "RISK") {
      const fields = splitFields(rest);
      if (fields.length < 4) {
        errors.push(`line ${lineNo}: RISK needs 4 "|" fields (coverageItemKey | riskRef | P0/P1/P2 | mitigation), got ${fields.length}`);
        continue;
      }
      const [coverageItemKey, riskRef, severity] = fields as [string, string, string];
      const mitigation = fields.slice(3).join(" | ").trim();
      if (!coverageItemKey || !riskRef || !mitigation) {
        errors.push(`line ${lineNo}: RISK has empty coverageItemKey/riskRef/mitigation`);
        continue;
      }
      if (!PRIORITIES.has(severity)) {
        errors.push(`line ${lineNo}: RISK severity must be P0/P1/P2, got "${severity}"`);
        continue;
      }
      riskMappings.push({
        coverageItemKey,
        riskRef,
        severity: severity as "P0" | "P1" | "P2",
        mitigation,
      });
      continue;
    }

    if (keyword.startsWith("COMMAND")) {
      if (!rest) {
        errors.push(`line ${lineNo}: COMMAND is empty`);
        continue;
      }
      const commandError = validateTestPlanCommand(rest, ctx);
      if (commandError) {
        errors.push(`line ${lineNo}: ${commandError}`);
        continue;
      }
      requiredCommands.push({ command: rest, required: keyword === "COMMAND!" });
      continue;
    }

    if (keyword.startsWith("MANUAL")) {
      const fields = splitFields(rest);
      const title = fields[0] ?? "";
      if (!title) {
        errors.push(`line ${lineNo}: MANUAL has empty title`);
        continue;
      }
      const description = fields.length > 1 ? nullableField(fields.slice(1).join(" | ").trim()) : null;
      manualChecks.push({ title, description, required: keyword === "MANUAL!" });
      continue;
    }
  }

  if (intents.length !== 1) {
    errors.push(`expected exactly 1 INTENT line, got ${intents.length}`);
  }
  if (coverageItems.length === 0) {
    errors.push("expected at least 1 COVERAGE line");
  }
  if (!requiredCommands.some((entry) => entry.required)) {
    errors.push("expected at least 1 COMMAND! (required command) line");
  }
  if (requiredCommands.length > MAX_COMMANDS) {
    errors.push(`too many COMMAND lines (${requiredCommands.length} > ${MAX_COMMANDS})`);
  }
  const coverageKeys = new Set(coverageItems.map((item) => item.itemKey));
  for (const mapping of riskMappings) {
    if (!coverageKeys.has(mapping.coverageItemKey)) {
      errors.push(`RISK references unknown coverageItemKey "${mapping.coverageItemKey}"`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, message: `test-plan line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      testIntent: intents[0]!,
      coverageItems,
      riskMappings,
      requiredCommands,
      manualChecks,
    },
  };
}
