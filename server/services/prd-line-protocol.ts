import {
  collectSingletonBlock,
  findStructuralGarbage,
  nullableField,
  findStructuralBlockError,
  scanProtocolLines,
  segmentProtocolText,
  splitFields,
  stripBullet,
} from "./ai-line-protocol";
import type {
  PrdAcceptanceCriterion,
  PrdFunctionalRequirement,
  PrdOpenQuestion,
  PrdSourceReference,
  PrdUserStory,
  StructuredPrd,
} from "../types/prd";

/**
 * Line-oriented output protocol for the legacy PRD stage (prd-service).
 *
 * This stage differs from the other line-protocol stages: it is a chat turn, so
 * `summary` carries both the assistant's message to the human AND the protocol
 * lines. stripPrdProtocol() removes the protocol from what the user is shown.
 *
 * The assembled payload's shape is byte-for-byte what StructuredPrdSchema and
 * savePrd() already consume — only the authoring changes. `version` was always
 * the constant 1, so stagepass supplies it rather than asking the model to echo
 * it back.
 */

export type PrdLineProtocolResult =
  | { ok: true; payload: StructuredPrd }
  | { ok: false; message: string };

const PRIORITIES = new Set(["must", "should", "could"]);

const KEYWORDS = [
  "TITLE",
  "STORY",
  "FR",
  "AC",
  "OQ",
  "MODULE",
  "SOURCE",
  "ADOPTED",
  "REJECTED",
  "REJECTREASON",
  "PRD_DONE",
] as const;

/**
 * Free-prose fields. Only OVERVIEW and TARGETUSERS are required (their zod
 * fields are .min(1)); the rest default to "" exactly as the schema does.
 */
const BLOCKS = [
  "OVERVIEW",
  "TARGETUSERS",
  "NFR",
  "OUTOFSCOPE",
  "METRICS",
  "RISKS",
  "CONSTRAINTS",
  "CONTRACTS",
  "TESTSTRATEGY",
  "BOUNDARIES",
  "PHASECONSTRAINTS",
] as const;

type BlockName = (typeof BLOCKS)[number];

function parseBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Removes the protocol from a chat reply so the human sees only the prose. The
 * legacy PRD turn shows `summary` to the user, so leaving REVIEW-style lines in
 * would put machine syntax in the conversation.
 */
export function stripPrdProtocol(rawText: string): string {
  const keywordPattern = new RegExp(`^(?:${KEYWORDS.join("|")}):`);
  // Reuse the one tokenizer: a second, slightly different block scanner here
  // could disagree with the parser about where the blocks are, and then the
  // human would read something the parser never saw.
  return segmentProtocolText(rawText)
    .topLevel
    .filter(({ text }) => !keywordPattern.test(stripBullet(text)))
    .map(({ text }) => text)
    .join("\n")
    .trim();
}

export function parsePrdLineProtocol(rawText: string): PrdLineProtocolResult {
  const structural = findStructuralBlockError(rawText, BLOCKS);
  if (structural) return { ok: false, message: `prd line protocol rejected: ${structural}` };
  const titles: string[] = [];
  const doneMarkers: string[] = [];
  const userStories: PrdUserStory[] = [];
  const requirements: Array<PrdFunctionalRequirement & { acceptanceCriteria: PrdAcceptanceCriterion[] }> = [];
  const criteriaByRequirement = new Map<string, PrdAcceptanceCriterion[]>();
  const openQuestions: PrdOpenQuestion[] = [];
  const affectedModules: string[] = [];
  const sources: Array<Omit<PrdSourceReference, "adopted" | "rejected" | "rejectionReasons">> = [];
  const sourceLists = {
    ADOPTED: new Map<string, string[]>(),
    REJECTED: new Map<string, string[]>(),
    REJECTREASON: new Map<string, string[]>(),
  };
  const errors: string[] = [];

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "PRD_DONE") {
      if (rest === "true") doneMarkers.push(rest);
      else errors.push(`line ${lineNo}: PRD_DONE must be true, got "${rest}"`);
      continue;
    }

    if (keyword === "TITLE") {
      if (!rest) errors.push(`line ${lineNo}: TITLE is empty`);
      else titles.push(rest);
      continue;
    }

    if (keyword === "MODULE") {
      if (!rest) {
        errors.push(`line ${lineNo}: MODULE is empty`);
        continue;
      }
      const garbage = findStructuralGarbage(rest);
      if (garbage) {
        errors.push(`line ${lineNo}: MODULE ${garbage}: ${rest}`);
        continue;
      }
      affectedModules.push(rest);
      continue;
    }

    if (keyword === "STORY") {
      const fields = splitFields(rest);
      if (fields.length !== 4) {
        errors.push(
          `line ${lineNo}: STORY needs exactly 4 "|" fields (id | persona | action | benefit), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [id, persona, action, benefit] = fields as [string, string, string, string];
      if (!id || !persona || !action || !benefit) {
        errors.push(`line ${lineNo}: STORY has an empty id/persona/action/benefit`);
        continue;
      }
      userStories.push({ id, persona, action, benefit });
      continue;
    }

    if (keyword === "FR") {
      const fields = splitFields(rest);
      if (fields.length !== 4) {
        errors.push(
          `line ${lineNo}: FR needs exactly 4 "|" fields (id | title | description | must/should/could), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [id, title, description, priority] = fields as [string, string, string, string];
      if (!id || !title || !description) {
        errors.push(`line ${lineNo}: FR has an empty id/title/description`);
        continue;
      }
      if (!PRIORITIES.has(priority)) {
        errors.push(`line ${lineNo}: FR priority must be must/should/could, got "${priority}"`);
        continue;
      }
      requirements.push({
        id,
        title,
        description,
        priority: priority as PrdFunctionalRequirement["priority"],
        acceptanceCriteria: [],
      });
      continue;
    }

    if (keyword === "AC") {
      const fields = splitFields(rest);
      if (fields.length !== 4) {
        errors.push(
          `line ${lineNo}: AC needs exactly 4 "|" fields (frId | id | description | testable true/false), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [frId, id, description, testableRaw] = fields as [string, string, string, string];
      if (!frId || !id || !description) {
        errors.push(`line ${lineNo}: AC has an empty frId/id/description`);
        continue;
      }
      const testable = parseBoolean(testableRaw);
      if (testable === null) {
        errors.push(`line ${lineNo}: AC testable must be true or false, got "${testableRaw}"`);
        continue;
      }
      const bucket = criteriaByRequirement.get(frId);
      const criterion: PrdAcceptanceCriterion = { id, description, testable };
      if (bucket) bucket.push(criterion);
      else criteriaByRequirement.set(frId, [criterion]);
      continue;
    }

    if (keyword === "OQ") {
      const fields = splitFields(rest);
      if (fields.length !== 4) {
        errors.push(
          `line ${lineNo}: OQ needs exactly 4 "|" fields (id | question | blocking true/false | answer 或 -), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [id, question, blockingRaw, answerRaw] = fields as [string, string, string, string];
      if (!id || !question) {
        errors.push(`line ${lineNo}: OQ has an empty id/question`);
        continue;
      }
      const blocking = parseBoolean(blockingRaw);
      if (blocking === null) {
        errors.push(`line ${lineNo}: OQ blocking must be true or false, got "${blockingRaw}"`);
        continue;
      }
      openQuestions.push({ id, question, blocking, answer: nullableField(answerRaw) });
      continue;
    }

    if (keyword === "SOURCE") {
      const fields = splitFields(rest);
      if (fields.length !== 2) {
        errors.push(
          `line ${lineNo}: SOURCE needs exactly 2 "|" fields (name | url), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [name, url] = fields as [string, string];
      if (!name) {
        errors.push(`line ${lineNo}: SOURCE name is empty`);
        continue;
      }
      sources.push({ name, url });
      continue;
    }

    // ADOPTED / REJECTED / REJECTREASON
    const fields = splitFields(rest);
    if (fields.length !== 2) {
      errors.push(
        `line ${lineNo}: ${keyword} needs exactly 2 "|" fields (sourceName | 文本), got ${fields.length}. 文本字段不得含 "|"`,
      );
      continue;
    }
    const [sourceName, text] = fields as [string, string];
    if (!sourceName || !text) {
      errors.push(`line ${lineNo}: ${keyword} has an empty sourceName/文本`);
      continue;
    }
    const bucket = sourceLists[keyword as keyof typeof sourceLists];
    const existing = bucket.get(sourceName);
    if (existing) existing.push(text);
    else bucket.set(sourceName, [text]);
  }

  const blockContent = {} as Record<BlockName, string>;
  for (const name of BLOCKS) {
    const block = collectSingletonBlock(rawText, name);
    if (!block.ok) {
      errors.push(block.message);
      blockContent[name] = "";
      continue;
    }
    blockContent[name] = (block.content ?? "").trim();
  }

  // Only these three are required: their zod fields are .min(1). Every other
  // prose field defaults to "" in the schema, so an absent block is legal and a
  // draft PRD stays draftable.
  if (titles.length !== 1) {
    errors.push(`expected exactly 1 TITLE line, got ${titles.length}`);
  }
  if (!blockContent.OVERVIEW) {
    errors.push("expected a non-empty OVERVIEW<< … >>OVERVIEW block");
  }
  if (!blockContent.TARGETUSERS) {
    errors.push("expected a non-empty TARGETUSERS<< … >>TARGETUSERS block");
  }

  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  for (const frId of criteriaByRequirement.keys()) {
    if (!requirementIds.has(frId)) {
      errors.push(`AC references unknown FR id "${frId}"`);
    }
  }
  const sourceNames = new Set(sources.map((source) => source.name));
  for (const [keyword, bucket] of Object.entries(sourceLists)) {
    for (const sourceName of bucket.keys()) {
      if (!sourceNames.has(sourceName)) {
        errors.push(`${keyword} references unknown SOURCE name "${sourceName}"`);
      }
    }
  }
  for (const [label, ids] of [
    ["FR", requirements.map((requirement) => requirement.id)],
    ["STORY", userStories.map((story) => story.id)],
    ["OQ", openQuestions.map((question) => question.id)],
    ["SOURCE", sources.map((source) => source.name)],
  ] as Array<[string, string[]]>) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      errors.push(`duplicate ${label} id: ${Array.from(new Set(duplicates)).join(", ")}`);
    }
  }
  // Two AC lines with the same id under one FR carry contradictory testable
  // flags that both survive; acceptance criteria must be uniquely addressable.
  for (const [frId, criteria] of criteriaByRequirement) {
    const acIds = criteria.map((criterion) => criterion.id);
    const duplicates = acIds.filter((id, index) => acIds.indexOf(id) !== index);
    if (duplicates.length > 0) {
      errors.push(`duplicate AC id under ${frId}: ${Array.from(new Set(duplicates)).join(", ")}`);
    }
  }

  // savePrd() overwrites the whole stored PRD, so a reply truncated after the
  // required fields would silently persist a partial document. PRD_DONE is
  // written last: losing it fails the turn and leaves the stored PRD untouched.
  if (doneMarkers.length !== 1) {
    errors.push(`expected exactly 1 PRD_DONE: true line, got ${doneMarkers.length}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `prd line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      version: 1,
      body: {
        title: titles[0]!,
        overview: blockContent.OVERVIEW,
        targetUsers: blockContent.TARGETUSERS,
        userStories,
        functionalRequirements: requirements.map((requirement) => ({
          ...requirement,
          acceptanceCriteria: criteriaByRequirement.get(requirement.id) ?? [],
        })),
        nonFunctionalRequirements: blockContent.NFR,
        outOfScope: blockContent.OUTOFSCOPE,
        successMetrics: blockContent.METRICS,
        risks: blockContent.RISKS,
        openQuestions,
      },
      aiAppendix: {
        implementationConstraints: blockContent.CONSTRAINTS,
        affectedModules,
        interfaceContracts: blockContent.CONTRACTS,
        testStrategy: blockContent.TESTSTRATEGY,
        boundaryConditions: blockContent.BOUNDARIES,
        phaseConstraints: blockContent.PHASECONSTRAINTS,
      },
      sources: sources.map((source) => ({
        ...source,
        adopted: sourceLists.ADOPTED.get(source.name) ?? [],
        rejected: sourceLists.REJECTED.get(source.name) ?? [],
        rejectionReasons: sourceLists.REJECTREASON.get(source.name) ?? [],
      })),
    },
  };
}
