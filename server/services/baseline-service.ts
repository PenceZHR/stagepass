import fs from "fs";
import path from "path";

export interface BaselineDocDefinition {
  name: string;
  title: string;
}

export interface BaselineDocSummary extends BaselineDocDefinition {
  status: "present" | "missing";
  size: number;
  updatedAt: string | null;
}

export interface BaselineDocContent extends BaselineDocSummary {
  content: string;
}

export interface ChangelogEntry {
  changeId: string;
  summary: string;
  createdAt?: string;
}

export interface DecisionEntry {
  changeId: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  createdAt?: string;
}

export const BASELINE_DOCS: BaselineDocDefinition[] = [
  { name: "prd.md", title: "Product Requirements Baseline" },
  { name: "tech-spec.md", title: "Technical Specification Baseline" },
  { name: "api-spec.md", title: "API Specification Baseline" },
  { name: "data-model.md", title: "Data Model Baseline" },
  { name: "state-machine.md", title: "State Machine Baseline" },
  { name: "error-codes.md", title: "Error Codes Baseline" },
  { name: "test-plan.md", title: "Test Plan Baseline" },
  { name: "decisions.md", title: "ADR Decisions" },
  { name: "changelog.md", title: "Changelog" },
  { name: "backlog.md", title: "Backlog" },
];

const BASELINE_TEMPLATES_DIR = path.join(process.cwd(), "server", "templates", "baseline");

function baselineDir(repoPath: string): string {
  return path.join(repoPath, ".ship", "baseline");
}

function fallbackBaselineContent(doc: BaselineDocDefinition): string {
  return [
    "---",
    `title: ${doc.title}`,
    "status: draft",
    "---",
    "",
    `# ${doc.title}`,
    "",
  ].join("\n");
}

function baselineTemplateContent(doc: BaselineDocDefinition): string {
  const templatePath = path.join(BASELINE_TEMPLATES_DIR, doc.name);
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf-8");
  }
  return fallbackBaselineContent(doc);
}

export function scaffoldBaseline(repoPath: string): string[] {
  const dir = baselineDir(repoPath);
  fs.mkdirSync(dir, { recursive: true });

  return BASELINE_DOCS.map((doc) => {
    const filePath = path.join(dir, doc.name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, baselineTemplateContent(doc), "utf-8");
    }
    return filePath;
  });
}

function getBaselineDocDefinition(docName: string): BaselineDocDefinition {
  const doc = BASELINE_DOCS.find((candidate) => candidate.name === docName);
  if (!doc) {
    throw new Error("Invalid baseline document name");
  }
  return doc;
}

function summarizeBaselineDoc(repoPath: string, doc: BaselineDocDefinition): BaselineDocSummary {
  const filePath = path.join(baselineDir(repoPath), doc.name);
  if (!fs.existsSync(filePath)) {
    return { ...doc, status: "missing", size: 0, updatedAt: null };
  }

  const stat = fs.statSync(filePath);
  return {
    ...doc,
    status: "present",
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function listBaselineDocs(repoPath: string): BaselineDocSummary[] {
  scaffoldBaseline(repoPath);
  return BASELINE_DOCS.map((doc) => summarizeBaselineDoc(repoPath, doc));
}

export function readBaselineDoc(repoPath: string, docName: string): BaselineDocContent {
  const doc = getBaselineDocDefinition(docName);
  scaffoldBaseline(repoPath);
  const filePath = path.join(baselineDir(repoPath), doc.name);

  return {
    ...summarizeBaselineDoc(repoPath, doc),
    content: fs.readFileSync(filePath, "utf-8"),
  };
}

export function updateChangelog(repoPath: string, entry: ChangelogEntry): string {
  const changelogPath = path.join(baselineDir(repoPath), "changelog.md");
  fs.mkdirSync(path.dirname(changelogPath), { recursive: true });

  const prefix = fs.existsSync(changelogPath) ? "\n\n" : "# Changelog\n";
  const content = [
    `${prefix}## ${entry.changeId} - ${entry.createdAt ?? new Date().toISOString()}`,
    entry.summary.trim(),
    "",
  ].join("\n");

  fs.appendFileSync(changelogPath, content);
  return changelogPath;
}

export function recordDecision(repoPath: string, entry: DecisionEntry): string {
  const decisionsPath = path.join(baselineDir(repoPath), "decisions.md");
  fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });

  const prefix = fs.existsSync(decisionsPath) ? "\n\n" : "# Decisions\n";
  const content = [
    `${prefix}## ADR: ${entry.title}`,
    "",
    `- Change: ${entry.changeId}`,
    `- Date: ${entry.createdAt ?? new Date().toISOString()}`,
    "",
    "### Context",
    entry.context.trim(),
    "",
    "### Decision",
    entry.decision.trim(),
    "",
    "### Consequences",
    entry.consequences.trim(),
    "",
  ].join("\n");

  fs.appendFileSync(decisionsPath, content);
  return decisionsPath;
}
