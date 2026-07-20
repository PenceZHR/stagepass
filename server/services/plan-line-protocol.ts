import {
  type LineProtocolContext,
  findStructuralBlockError,
  scanProtocolLines,
  splitFields,
  validateRepoCommand,
  validateRepoRelativePath,
} from "./ai-line-protocol";
import type { PlanJson, PlanStep } from "./pipeline-plan-stage-service";

/**
 * Line-oriented output protocol for the generate_plan stage.
 *
 * PLAN / EXPECT / FORBID / STEP / TEST / COMMAND / RISK lines are parsed
 * deterministically into PlanJson — the model never authors plan JSON.
 * STEP files must be declared in EXPECT, which turns the plan-sandbox P0
 * interceptor's "step touches an undeclared file" round-trip (observed 5×
 * in a row live with codex) into an immediate, precisely-worded retryable
 * parse error. Plan commands get structural garbage checks but NOT
 * file-existence checks: they may legitimately reference files the build
 * has not created yet.
 */

export type PlanLineProtocolResult =
  | { ok: true; payload: PlanJson }
  | { ok: false; message: string };

const STEP_STATUSES = new Set(["pending", "blocked", "done"]);

const KEYWORDS = ["PLAN", "EXPECT", "FORBID", "STEP", "TEST", "COMMAND", "RISK"] as const;

export function parsePlanLineProtocol(
  rawText: string,
  ctx: LineProtocolContext,
): PlanLineProtocolResult {
  const structural = findStructuralBlockError(rawText, []);
  if (structural) return { ok: false, message: `plan line protocol rejected: ${structural}` };
  const names: string[] = [];
  const expectedFiles: string[] = [];
  const forbiddenFiles: string[] = [];
  const steps: PlanStep[] = [];
  const testPlan: string[] = [];
  const validationCommands: string[] = [];
  const risks: string[] = [];
  const errors: string[] = [];

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "PLAN") {
      if (rest) names.push(rest);
      else errors.push(`line ${lineNo}: PLAN is empty`);
      continue;
    }

    if (keyword === "EXPECT" || keyword === "FORBID") {
      if (!rest) {
        errors.push(`line ${lineNo}: ${keyword} is empty`);
        continue;
      }
      const pathError = validateRepoRelativePath(rest);
      if (pathError) {
        errors.push(`line ${lineNo}: ${keyword} path ${pathError}: ${rest}`);
        continue;
      }
      (keyword === "EXPECT" ? expectedFiles : forbiddenFiles).push(rest);
      continue;
    }

    if (keyword === "STEP") {
      const fields = splitFields(rest);
      if (fields.length < 4) {
        errors.push(`line ${lineNo}: STEP needs 4 "|" fields (编号 | 文件 | pending/blocked/done | 具体描述), got ${fields.length}`);
        continue;
      }
      const [stepNoRaw, file, status] = fields as [string, string, string];
      const description = fields.slice(3).join(" | ").trim();
      const stepNo = Number(stepNoRaw);
      if (!Number.isInteger(stepNo) || stepNo <= 0) {
        errors.push(`line ${lineNo}: STEP 编号必须是正整数, got "${stepNoRaw}"`);
        continue;
      }
      if (!STEP_STATUSES.has(status)) {
        errors.push(`line ${lineNo}: STEP status must be pending/blocked/done, got "${status}"`);
        continue;
      }
      const pathError = validateRepoRelativePath(file);
      if (pathError) {
        errors.push(`line ${lineNo}: STEP file ${pathError}: ${file}`);
        continue;
      }
      if (!description) {
        errors.push(`line ${lineNo}: STEP 描述为空`);
        continue;
      }
      steps.push({
        step: stepNo,
        file,
        status: status as PlanStep["status"],
        description,
      });
      continue;
    }

    if (keyword === "TEST" || keyword === "RISK") {
      if (rest) (keyword === "TEST" ? testPlan : risks).push(rest);
      else errors.push(`line ${lineNo}: ${keyword} is empty`);
      continue;
    }

    if (keyword === "COMMAND") {
      if (!rest) {
        errors.push(`line ${lineNo}: COMMAND is empty`);
        continue;
      }
      const commandError = validateRepoCommand(rest, ctx, { checkFileExistence: false });
      if (commandError) {
        errors.push(`line ${lineNo}: ${commandError}`);
        continue;
      }
      validationCommands.push(rest);
      continue;
    }
  }

  if (names.length !== 1) {
    errors.push(`expected exactly 1 PLAN line, got ${names.length}`);
  }
  if (expectedFiles.length === 0) {
    errors.push("expected at least 1 EXPECT line");
  }
  if (steps.length === 0) {
    errors.push("expected at least 1 STEP line");
  }

  const expectedSet = new Set(expectedFiles);
  const forbiddenSet = new Set(forbiddenFiles);
  for (const file of expectedSet) {
    if (forbiddenSet.has(file)) {
      errors.push(`file listed in both EXPECT and FORBID: ${file}`);
    }
  }
  const seenSteps = new Set<number>();
  for (const step of steps) {
    if (seenSteps.has(step.step)) {
      errors.push(`duplicate STEP 编号 ${step.step}`);
    }
    seenSteps.add(step.step);
    if (step.file && !expectedSet.has(step.file)) {
      errors.push(`STEP ${step.step} 的文件未在 EXPECT 中声明: ${step.file}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, message: `plan line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      planName: names[0]!,
      expectedFiles,
      forbiddenFiles,
      implementationSteps: [...steps].sort((left, right) => left.step - right.step),
      testPlan,
      validationCommands,
      risks,
    },
  };
}
