import fs from "fs";
import path from "path";
import { createChildLogger } from "../logger";
import { resolveReadableFiles, type StageScope } from "./stage-guard-service";

const log = createChildLogger("prompt-service");

export type PromptPhase =
  | "plan"
  | "implement"
  | "review"
  | "fix"
  | "refine"
  | "prd"
  | "prd_briefing_questions"
  | "prd_briefing_draft"
  | "prd_briefing_final_review"
  | "intake"
  | "spec"
  | "spec_critic"
  | "spec_verdict"
  | "delegated_round_judge"
  | "spec_red_subagent"
  | "spec_blue_subagent"
  | "tech_spec_red_subagent"
  | "tech_spec_blue_subagent"
  | "plan_red_subagent"
  | "plan_blue_subagent"
  | "test_plan_red_subagent"
  | "test_plan_blue_subagent"
  | "tech_spec"
  | "test_plan"
  | "release"
  | "retro"
  | "delivery"
  | "init-context"
  | "init-context-select"
  | "init-context-generate";

interface PromptVariables {
  changeId: string;
  changeTitle?: string;
  repoPath: string;
}

function buildVariables(vars: PromptVariables): Record<string, string> {
  const shipDir = path.join(vars.repoPath, ".ship");
  const changeDir = path.join(shipDir, "changes", vars.changeId);

  return {
    changeId: vars.changeId,
    changeTitle: vars.changeTitle?.trim() || "（未提供）",
    repoPath: vars.repoPath,
    specPath: path.join(changeDir, "spec.md"),
    changeRequestPath: path.join(changeDir, "change-request.md"),
    prdIntentPath: path.join(changeDir, "prd-intent.md"),
    briefingQuestionsPath: path.join(changeDir, "briefing-questions.json"),
    prdDraftPath: path.join(changeDir, "prd-draft.md"),
    prdGatePath: path.join(changeDir, "prd-gate.json"),
    prdDeltaPath: path.join(changeDir, "prd-delta.md"),
    requirementGapsPath: path.join(changeDir, "requirement-gaps.json"),
    specReportPath: path.join(changeDir, "reports", "spec-report.md"),
    techSpecDeltaPath: path.join(changeDir, "tech-spec-delta.md"),
    apiSpecDeltaPath: path.join(changeDir, "api-spec-delta.md"),
    testPlanDeltaPath: path.join(changeDir, "test-plan-delta.md"),
    planPath: path.join(changeDir, "plan.md"),
    planJsonPath: path.join(changeDir, "plan.json"),
    findingsPath: path.join(changeDir, "findings.json"),
    checkPath: path.join(changeDir, "local-check.json"),
    releaseNotePath: path.join(changeDir, "release-note.md"),
    retroPath: path.join(changeDir, "retro.md"),
    deliveryPath: path.join(changeDir, "delivery.md"),
  };
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return vars[key] ?? match;
  });
}

const TEMPLATES_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "server", "templates");

const CONTEXT_DOCS = ["architecture.md", "coding-rules.md", "tech-stack.md", "file-guide.md", "prd.md"];

const PROMPT_TEMPLATE_FILES: Record<PromptPhase, string> = {
  plan: "plan.md",
  implement: "implement.md",
  review: "review.md",
  fix: "fix.md",
  refine: "refine.md",
  prd: "prd.md",
  delegated_round_judge: "delegated-round-judge.md",
  spec_red_subagent: "spec-red-subagent.md",
  spec_blue_subagent: "spec-blue-subagent.md",
  tech_spec_red_subagent: "tech-spec-red-subagent.md",
  tech_spec_blue_subagent: "tech-spec-blue-subagent.md",
  plan_red_subagent: "plan-red-subagent.md",
  plan_blue_subagent: "plan-blue-subagent.md",
  test_plan_red_subagent: "test-plan-red-subagent.md",
  test_plan_blue_subagent: "test-plan-blue-subagent.md",
  prd_briefing_questions: "prd-briefing-questions.md",
  prd_briefing_draft: "prd-briefing-draft.md",
  prd_briefing_final_review: "prd-briefing-final-review.md",
  intake: "intake.md",
  spec: "spec.md",
  spec_critic: "spec-critic.md",
  spec_verdict: "spec-verdict.md",
  tech_spec: "tech-spec.md",
  test_plan: "test-plan.md",
  release: "release.md",
  retro: "retro.md",
  delivery: "delivery.md",
  "init-context": "init-context.md",
  "init-context-select": "init-context-select.md",
  "init-context-generate": "init-context-generate.md",
};

function readContextDocs(repoPath: string): string {
  const shipDir = path.join(repoPath, ".ship");
  const sections: string[] = [];

  for (const doc of CONTEXT_DOCS) {
    const filePath = path.join(shipDir, doc);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content && !content.includes("（待生成）")) {
        sections.push(`--- ${doc} ---\n${content}`);
      }
    }
  }

  if (sections.length === 0) return "";
  return `# 项目上下文\n\n${sections.join("\n\n")}\n\n---\n\n`;
}

function isInsideRepo(repoPath: string, filePath: string): boolean {
  const resolvedRepo = path.resolve(repoPath);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile === resolvedRepo || resolvedFile.startsWith(`${resolvedRepo}${path.sep}`);
}

function scopeReadableFilesToChange(scope: StageScope, changeId: string): StageScope {
  const changesPrefix = ".ship/changes/**/";
  return {
    ...scope,
    readableFiles: scope.readableFiles.map((pattern) => {
      if (pattern === ".ship/changes/**") {
        return `.ship/changes/${changeId}/**`;
      }
      if (pattern.startsWith(changesPrefix)) {
        return `.ship/changes/${changeId}/${pattern.slice(changesPrefix.length)}`;
      }
      return pattern;
    }),
  };
}

function readScopedContext(repoPath: string, scope: StageScope, changeId: string): string {
  const sections: string[] = [];

  const changeScope = scopeReadableFilesToChange(scope, changeId);
  for (const relativePath of resolveReadableFiles(repoPath, changeScope)) {
    const filePath = path.join(repoPath, relativePath);
    if (!isInsideRepo(repoPath, filePath) || !fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (content) {
      sections.push(`--- ${relativePath} ---\n${content}`);
    }
  }

  if (sections.length === 0) return "";
  return `# 阶段可读上下文\n\n${sections.join("\n\n")}\n\n---\n\n`;
}

function resolvePromptPath(phase: PromptPhase, repoPath: string): string {
  const templateFile = PROMPT_TEMPLATE_FILES[phase];
  const projectPromptPath = path.join(repoPath, ".ship", "prompts", templateFile);
  const legacyProjectPromptPath = path.join(repoPath, ".ship", "prompts", `${phase}.md`);
  const fallbackPath = path.join(TEMPLATES_DIR, "prompts", templateFile);

  if (phase === "implement") {
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }
    throw new Error(`Prompt template not found: ${fallbackPath}`);
  }

  if (fs.existsSync(projectPromptPath)) {
    return projectPromptPath;
  }

  if (legacyProjectPromptPath !== projectPromptPath && fs.existsSync(legacyProjectPromptPath)) {
    return legacyProjectPromptPath;
  }

  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  throw new Error(`Prompt template not found: ${projectPromptPath}`);
}

/**
 * Renders a template with the standard variables and NOTHING else -- no stage
 * context prefix.
 *
 * Exists for the sub-agent briefs the Spec judge hands to red and blue. Those
 * are quoted verbatim inside the judge's own prompt, which already carries the
 * stage context, so rendering them through assemblePrompt would paste the whole
 * context block in three times.
 */
export function renderPromptTemplate(
  phase: PromptPhase,
  vars: PromptVariables,
): string {
  return substitute(
    fs.readFileSync(resolvePromptPath(phase, vars.repoPath), "utf-8"),
    buildVariables(vars),
  );
}

export function assemblePrompt(
  phase: PromptPhase,
  vars: PromptVariables,
  scope?: StageScope,
  /**
   * Server-authored values the template may reference beyond the standard set.
   *
   * The Spec judge uses this to inline the exact briefs it must hand to its
   * sub-agents. They travel as data the server wrote, not as something the
   * judge composes -- a judge free to paraphrase its sub-agents' instructions
   * is a judge free to change their schema.
   */
  extraVariables?: Record<string, string>,
): string {
  const promptPath = resolvePromptPath(phase, vars.repoPath);

  const template = fs.readFileSync(promptPath, "utf-8");
  const resolved = substitute(template, {
    ...buildVariables(vars),
    ...extraVariables,
  });

  const contextPrefix = scope
    ? readScopedContext(vars.repoPath, scope, vars.changeId)
    : (phase === "init-context" || phase === "prd" || phase === "implement" || phase === "review") ? "" : readContextDocs(vars.repoPath);

  log.info({ phase, changeId: vars.changeId, hasContext: contextPrefix.length > 0 }, "Prompt assembled");
  return contextPrefix + resolved;
}
