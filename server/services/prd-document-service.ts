import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import {
  StructuredPrdSchema,
  type StructuredPrd,
  type PrdValidationResult,
  type PrdValidationIssue,
} from "../types/prd";
import { createChildLogger } from "../logger";

const log = createChildLogger("prd-document-service");

function nowISO(): string {
  return new Date().toISOString();
}

function shipDir(repoPath: string): string {
  return path.join(repoPath, ".ship");
}

function ensureShipDir(repoPath: string): void {
  const dir = shipDir(repoPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// --- Read ---

export function readStructuredPrd(projectId: string): StructuredPrd | null {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.prdJson) return null;
  try {
    return StructuredPrdSchema.parse(JSON.parse(project.prdJson));
  } catch (err) {
    log.warn({ projectId, err }, "Failed to parse stored prdJson");
    return null;
  }
}

// --- Write (single point of truth) ---

export function savePrd(projectId: string, structured: StructuredPrd, repoPath: string): void {
  const jsonStr = JSON.stringify(structured, null, 2);
  const markdown = renderMarkdown(structured);

  db.update(projects)
    .set({ prdJson: jsonStr, prdMarkdown: markdown, updatedAt: nowISO() })
    .where(eq(projects.id, projectId))
    .run();

  ensureShipDir(repoPath);
  fs.writeFileSync(path.join(shipDir(repoPath), "prd.json"), jsonStr, "utf-8");
  fs.writeFileSync(path.join(shipDir(repoPath), "prd.md"), markdown, "utf-8");

  if (structured.sources.length > 0) {
    fs.writeFileSync(
      path.join(shipDir(repoPath), "prd-sources.md"),
      renderSourcesMarkdown(structured),
      "utf-8"
    );
  }

  log.info({ projectId }, "PRD saved (DB + .ship files)");
}

// --- Validate ---

export function validatePrd(prd: StructuredPrd): PrdValidationResult {
  const issues: PrdValidationIssue[] = [];

  if (!prd.body.title.trim()) {
    issues.push({ field: "body.title", severity: "error", message: "标题不能为空" });
  }
  if (!prd.body.overview.trim()) {
    issues.push({ field: "body.overview", severity: "error", message: "概述不能为空" });
  }
  if (!prd.body.targetUsers.trim()) {
    issues.push({ field: "body.targetUsers", severity: "error", message: "目标用户不能为空" });
  }
  if (prd.body.functionalRequirements.length === 0) {
    issues.push({ field: "body.functionalRequirements", severity: "error", message: "至少需要一条功能需求" });
  }
  if (!prd.body.outOfScope.trim()) {
    issues.push({ field: "body.outOfScope", severity: "warning", message: "建议明确非目标范围" });
  }
  if (!prd.body.risks.trim()) {
    issues.push({ field: "body.risks", severity: "warning", message: "建议列明风险" });
  }

  for (const req of prd.body.functionalRequirements) {
    if (req.acceptanceCriteria.length === 0) {
      issues.push({
        field: `body.functionalRequirements.${req.id}.acceptanceCriteria`,
        severity: "error",
        message: `功能 "${req.title}" 缺少验收标准`,
      });
    }
  }

  const blockingQuestions = prd.body.openQuestions.filter((q) => q.blocking && !q.answer);
  for (const q of blockingQuestions) {
    issues.push({
      field: `body.openQuestions.${q.id}`,
      severity: "error",
      message: `阻塞性开放问题未解答: "${q.question}"`,
    });
  }

  return { valid: issues.filter((i) => i.severity === "error").length === 0, issues };
}

// --- Upgrade legacy markdown to structured PRD draft ---

export function upgradeLegacyMarkdown(markdown: string): StructuredPrd {
  const lines = markdown.split("\n");
  let title = "";
  let overview = "";
  let targetUsers = "";
  let outOfScope = "";
  let risks = "";
  let nonFunctional = "";

  let currentSection = "";
  const sectionContent: Record<string, string[]> = {};

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);

    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      currentSection = h2[1].trim().toLowerCase();
      if (!sectionContent[currentSection]) sectionContent[currentSection] = [];
      continue;
    }
    if (currentSection) {
      sectionContent[currentSection]?.push(line);
    }
  }

  const join = (key: string) => (sectionContent[key] || []).join("\n").trim();

  overview = join("概述") || join("overview") || join("简介");
  targetUsers = join("目标用户") || join("target users");
  outOfScope = join("非目标") || join("非功能范围") || join("out of scope");
  risks = join("风险") || join("risks");
  nonFunctional = join("非功能性需求") || join("non-functional requirements") || join("非功能需求");

  const functionalSections = Object.entries(sectionContent)
    .filter(([k]) => k.startsWith("功能") || k.startsWith("核心功能"));
  const functionalRequirements = functionalSections.map(([k, v], i) => ({
    id: `FR-${String(i + 1).padStart(3, "0")}`,
    title: k,
    description: v.join("\n").trim(),
    priority: "must" as const,
    acceptanceCriteria: [],
  }));

  return {
    version: 1,
    body: {
      title,
      overview,
      targetUsers,
      userStories: [],
      functionalRequirements,
      nonFunctionalRequirements: nonFunctional,
      outOfScope,
      successMetrics: "",
      risks,
      openQuestions: [],
    },
    aiAppendix: {
      implementationConstraints: "",
      affectedModules: [],
      interfaceContracts: "",
      testStrategy: "",
      boundaryConditions: "",
      phaseConstraints: "",
    },
    sources: [],
  };
}

// --- Render to Markdown ---

export function renderMarkdown(prd: StructuredPrd): string {
  const lines: string[] = [];

  lines.push(`# ${prd.body.title}`);
  lines.push("");
  lines.push("## 概述");
  lines.push("");
  lines.push(prd.body.overview);
  lines.push("");
  lines.push("## 目标用户");
  lines.push("");
  lines.push(prd.body.targetUsers);
  lines.push("");

  if (prd.body.userStories.length > 0) {
    lines.push("## 用户故事");
    lines.push("");
    for (const story of prd.body.userStories) {
      lines.push(`- 作为 **${story.persona}**，我想要 ${story.action}，以便 ${story.benefit}`);
    }
    lines.push("");
  }

  if (prd.body.functionalRequirements.length > 0) {
    lines.push("## 功能需求");
    lines.push("");
    for (const req of prd.body.functionalRequirements) {
      lines.push(`### ${req.id}: ${req.title} [${req.priority}]`);
      lines.push("");
      lines.push(req.description);
      lines.push("");
      if (req.acceptanceCriteria.length > 0) {
        lines.push("**验收标准：**");
        for (const ac of req.acceptanceCriteria) {
          lines.push(`- ${ac.description}`);
        }
        lines.push("");
      }
    }
  }

  if (prd.body.nonFunctionalRequirements) {
    lines.push("## 非功能性需求");
    lines.push("");
    lines.push(prd.body.nonFunctionalRequirements);
    lines.push("");
  }

  if (prd.body.outOfScope) {
    lines.push("## 非目标");
    lines.push("");
    lines.push(prd.body.outOfScope);
    lines.push("");
  }

  if (prd.body.successMetrics) {
    lines.push("## 成功指标");
    lines.push("");
    lines.push(prd.body.successMetrics);
    lines.push("");
  }

  if (prd.body.risks) {
    lines.push("## 风险");
    lines.push("");
    lines.push(prd.body.risks);
    lines.push("");
  }

  if (prd.body.openQuestions.length > 0) {
    lines.push("## 开放问题");
    lines.push("");
    for (const q of prd.body.openQuestions) {
      const status = q.answer ? "✅" : q.blocking ? "🚫" : "❓";
      lines.push(`- ${status} ${q.question}${q.answer ? ` → ${q.answer}` : ""}${q.blocking && !q.answer ? " (阻塞)" : ""}`);
    }
    lines.push("");
  }

  // AI Appendix
  lines.push("---");
  lines.push("");
  lines.push("## AI 执行附录");
  lines.push("");

  if (prd.aiAppendix.implementationConstraints) {
    lines.push("### 实现约束");
    lines.push("");
    lines.push(prd.aiAppendix.implementationConstraints);
    lines.push("");
  }

  if (prd.aiAppendix.affectedModules.length > 0) {
    lines.push("### 影响模块");
    lines.push("");
    for (const m of prd.aiAppendix.affectedModules) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }

  if (prd.aiAppendix.interfaceContracts) {
    lines.push("### 接口契约");
    lines.push("");
    lines.push(prd.aiAppendix.interfaceContracts);
    lines.push("");
  }

  if (prd.aiAppendix.testStrategy) {
    lines.push("### 测试策略");
    lines.push("");
    lines.push(prd.aiAppendix.testStrategy);
    lines.push("");
  }

  if (prd.aiAppendix.boundaryConditions) {
    lines.push("### 边界条件");
    lines.push("");
    lines.push(prd.aiAppendix.boundaryConditions);
    lines.push("");
  }

  if (prd.aiAppendix.phaseConstraints) {
    lines.push("### 阶段约束");
    lines.push("");
    lines.push(prd.aiAppendix.phaseConstraints);
    lines.push("");
  }

  return lines.join("\n");
}

function renderSourcesMarkdown(prd: StructuredPrd): string {
  const lines: string[] = [];
  lines.push("# PRD 参考来源");
  lines.push("");

  for (const src of prd.sources) {
    lines.push(`## ${src.name}`);
    lines.push("");
    lines.push(`链接: ${src.url}`);
    lines.push("");
    if (src.adopted.length > 0) {
      lines.push("**采纳：**");
      for (const a of src.adopted) lines.push(`- ${a}`);
      lines.push("");
    }
    if (src.rejected.length > 0) {
      lines.push("**舍弃：**");
      for (let i = 0; i < src.rejected.length; i++) {
        lines.push(`- ${src.rejected[i]}${src.rejectionReasons[i] ? ` — 原因: ${src.rejectionReasons[i]}` : ""}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
