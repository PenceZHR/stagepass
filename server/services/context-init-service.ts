import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { projects } from "../db/schema";
import { getAiEngine } from "./ai-engine-adapter";
import type { AiProvider, AiRunResult } from "./ai-engine-types";
import { createChildLogger } from "../logger";
import {
  runStaticAnalysis,
  formatAnalysisForPrompt,
  type AnalysisResult,
  type ProgressCallback,
} from "./static-analyzer";
import { parseDocBlock, parseFileSelectionJson } from "./context-parsers";
import {
  DEFAULT_AI_PROVIDER_TIMEOUT_MS,
  resolveAiProviderTimeoutMs,
} from "./ai-timeout-policy";
import { readCodexNativeFlags } from "../config/codex-native-flags";
import {
  acquireProjectAiRunLease,
  createProjectAiRun,
  markProjectAiRunFailed,
  markProjectAiRunRunning,
  markProjectAiRunSucceeded,
  type ProjectAiRunFence,
} from "./project-ai-run-service";
import { resolveLogicalTurn } from "./codex-logical-turn-service";
import {
  ensureCodexThreadBinding,
  readCodexThreadBinding,
} from "./codex-thread-binding-service";
import { getProductionCodexDesktopBridge } from "./codex-desktop-engine";

const log = createChildLogger("context-init-service");

const MAX_FILE_LINES = 500;
const TRUNCATED_LINES = 300;
const DEFAULT_CONTEXT_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;
const DEFAULT_SELECTED_FILES = [
  "server/services/pipeline-service.ts",
  "server/services/codex-desktop-engine.ts",
  "server/services/context-init-service.ts",
  "server/db/schema.ts",
  "server/types/enums.ts",
  "server/types/models.ts",
];

interface ContextProgress {
  stage: "static-analysis" | "ai-select" | "ai-generate" | "merge";
  percent: number;
  currentFile?: string;
  message: string;
  provider?: AiProvider;
}

function nowISO(): string {
  return new Date().toISOString();
}

function getContextTimeoutMs(): number {
  return resolveAiProviderTimeoutMs("STAGEPASS_CONTEXT_TIMEOUT_MS", DEFAULT_CONTEXT_TIMEOUT_MS);
}

function assertProviderRunSucceeded(
  stage: "selection" | "generation",
  result: AiRunResult,
): void {
  if (result.success === true) return;
  const detail = result.providerErrorDetail?.trim() || result.summary?.trim() || "provider run failed";
  throw new Error(`Context ${stage} failed: ${detail}`);
}

function writeProgress(shipDir: string, progress: ContextProgress): void {
  const progressPath = path.join(shipDir, "context-progress.json");
  fs.writeFileSync(progressPath, JSON.stringify(progress), "utf-8");
}

function readPromptTemplate(templateName: string): string {
  const templatePath = path.join(
    process.cwd(), "server", "templates", "prompts", `${templateName}.md`
  );
  return fs.readFileSync(templatePath, "utf-8");
}

function readFileWithTruncation(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  if (lines.length <= MAX_FILE_LINES) return content;
  const truncated = lines.slice(0, TRUNCATED_LINES);
  truncated.push(`\n... [truncated ${lines.length - TRUNCATED_LINES} lines, total ${lines.length} lines] ...`);
  return truncated.join("\n");
}

export async function initializeProjectContext(
  projectId: string,
  provider: AiProvider = "codex",
  requestKey?: string,
): Promise<void> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const shipDir = path.join(project.repoPath, ".ship");
  const desktopBridgeEnabled = readCodexNativeFlags().desktopBridge;
  let projectRunFence: ProjectAiRunFence | null = null;
  let projectAiRunId: string | null = null;

  if (desktopBridgeEnabled) {
    const run = await createProjectAiRun({
      projectId,
      kind: "context_init",
      requestKey: requestKey ?? `context:${project.updatedAt}`,
    });
    const leased = await acquireProjectAiRunLease(
      run.id,
      `context:${process.pid}`,
      { leaseMs: 15 * 60_000 },
    );
    projectRunFence = leased.fence;
    projectAiRunId = run.id;
    await markProjectAiRunRunning(projectRunFence);
    if (!readCodexThreadBinding({
      kind: "project_context",
      scopeId: projectId,
      projectId,
    })) {
      await ensureCodexThreadBinding({
        scope: {
          kind: "project_context",
          scopeId: projectId,
          projectId,
        },
        bridge: await getProductionCodexDesktopBridge(),
      });
    }
  }

  db.update(projects)
    .set({ contextStatus: "generating", updatedAt: nowISO() })
    .where(eq(projects.id, projectId))
    .run();

  log.info({ projectId, provider }, "Starting 4-stage context initialization");

  try {
    // ═══════════════════════════════════════════
    // Stage 1: Static Analysis
    // ═══════════════════════════════════════════
    writeProgress(shipDir, {
      stage: "static-analysis",
      percent: 0,
      message: "正在进行静态分析...",
      provider,
    });

    const onProgress: ProgressCallback = (stage, file) => {
      writeProgress(shipDir, {
        stage: "static-analysis",
        percent: 10,
        currentFile: file,
        message: `静态分析: ${file || stage}`,
        provider,
      });
    };

    const analysisResult = await runStaticAnalysis(project.repoPath, onProgress);
    const analysisData = formatAnalysisForPrompt(analysisResult);

    writeProgress(shipDir, {
      stage: "static-analysis",
      percent: 25,
      message: `静态分析完成，发现 ${analysisResult.coreFiles.length} 个核心文件`,
      provider,
    });

    log.info(
      { projectId, coreFiles: analysisResult.coreFiles.length, peripheralFiles: analysisResult.peripheralFiles.length },
      "Stage 1 (static analysis) complete"
    );

    // ═══════════════════════════════════════════
    // Stage 2: AI Select Files for Deep Reading
    // ═══════════════════════════════════════════
    writeProgress(shipDir, {
      stage: "ai-select",
      percent: 30,
      message: "AI 正在挑选需要深入阅读的文件...",
      provider,
    });

    const engine = getAiEngine();
    const timeoutMs = getContextTimeoutMs();
    const selectTemplate = readPromptTemplate("init-context-select");
    const selectPrompt = selectTemplate
      .replace("{directoryTree}", analysisResult.tree)
      .replace("{analysisData}", analysisData);

    const selectLogicalTurnId = desktopBridgeEnabled
      ? (await resolveLogicalTurn({
          owner: { kind: "project_ai_run", projectAiRunId: projectAiRunId! },
          phase: "Context",
          role: "context_select",
          round: 0,
          ordinal: 0,
          request: { prompt: selectPrompt, sandboxMode: "read-only" },
        })).logicalTurnId
      : null;
    const selectResult = await engine.run(desktopBridgeEnabled ? {
      logicalTurnId: selectLogicalTurnId!,
    } as never : {
      changeId: `${projectId}-context-select`,
      repoPath: project.repoPath,
      phase: "plan",
      prompt: selectPrompt,
      sandboxMode: "read-only",
      timeoutMs,
    });
    assertProviderRunSucceeded("selection", selectResult);

    let selectedFiles = parseFileSelectionJson(selectResult.summary || "");
    if (selectedFiles.length === 0) {
      log.warn({ projectId }, "AI file selection failed, using defaults");
      selectedFiles = DEFAULT_SELECTED_FILES.filter(f =>
        fs.existsSync(path.join(project.repoPath, f))
      );
    }

    writeProgress(shipDir, {
      stage: "ai-select",
      percent: 50,
      message: `AI 选中 ${selectedFiles.length} 个文件进行深入分析`,
      provider,
    });

    log.info({ projectId, selectedFiles: selectedFiles.length }, "Stage 2 (AI select) complete");

    // ═══════════════════════════════════════════
    // Stage 3: AI Generate Documentation Skeleton
    // ═══════════════════════════════════════════
    writeProgress(shipDir, {
      stage: "ai-generate",
      percent: 55,
      message: "AI 正在深入分析并生成文档...",
      provider,
    });

    const fileContentsSections: string[] = [];
    for (const relPath of selectedFiles) {
      const absPath = path.join(project.repoPath, relPath);
      if (!fs.existsSync(absPath)) continue;

      writeProgress(shipDir, {
        stage: "ai-generate",
        percent: 55 + Math.round((fileContentsSections.length / selectedFiles.length) * 10),
        currentFile: relPath,
        message: `正在读取 ${relPath}...`,
        provider,
      });

      const content = readFileWithTruncation(absPath);
      fileContentsSections.push(`### ${relPath}\n\`\`\`typescript\n${content}\n\`\`\``);
    }

    const generateTemplate = readPromptTemplate("init-context-generate");
    const generatePrompt = generateTemplate
      .replace("{repoPath}", project.repoPath)
      .replace("{analysisData}", analysisData)
      .replace("{fileContents}", fileContentsSections.join("\n\n"));

    writeProgress(shipDir, {
      stage: "ai-generate",
      percent: 70,
      message: "AI 正在生成文档骨架...",
      provider,
    });

    const generateLogicalTurnId = desktopBridgeEnabled
      ? (await resolveLogicalTurn({
          owner: { kind: "project_ai_run", projectAiRunId: projectAiRunId! },
          phase: "Context",
          role: "context_generate",
          round: 0,
          ordinal: 0,
          request: { prompt: generatePrompt, sandboxMode: "read-only" },
        })).logicalTurnId
      : null;
    const generateResult = await engine.run(desktopBridgeEnabled ? {
      logicalTurnId: generateLogicalTurnId!,
    } as never : {
      changeId: `${projectId}-context-generate`,
      repoPath: project.repoPath,
      phase: "plan",
      prompt: generatePrompt,
      sandboxMode: "read-only",
      timeoutMs,
    });
    assertProviderRunSucceeded("generation", generateResult);

    const aiOutput = generateResult.summary || "";

    writeProgress(shipDir, {
      stage: "ai-generate",
      percent: 85,
      message: "AI 文档骨架生成完成",
      provider,
    });

    log.info({ projectId }, "Stage 3 (AI generate) complete");

    // ═══════════════════════════════════════════
    // Stage 4: Merge AI Skeleton + Static Data
    // ═══════════════════════════════════════════
    writeProgress(shipDir, {
      stage: "merge",
      percent: 90,
      message: "正在合并静态数据和 AI 文档...",
      provider,
    });

    const docs: Array<{ tag: string; filename: string }> = [
      { tag: "architecture", filename: "architecture.md" },
      { tag: "coding-rules", filename: "coding-rules.md" },
      { tag: "tech-stack", filename: "tech-stack.md" },
      { tag: "file-guide", filename: "file-guide.md" },
    ];

    let docsWritten = 0;
    for (const { tag, filename } of docs) {
      const content = parseDocBlock(aiOutput, tag);
      if (content) {
        let finalContent = content;

        if (tag === "file-guide") {
          finalContent = mergeFileGuideWithStatic(content, analysisResult);
        }

        fs.writeFileSync(path.join(shipDir, filename), finalContent, "utf-8");
        docsWritten++;
      }
    }

    if (docsWritten === 0) {
      log.warn({ projectId }, "AI output did not contain any doc blocks, saving raw output");
      fs.writeFileSync(path.join(shipDir, "architecture.md"), aiOutput, "utf-8");
    }

    writeProgress(shipDir, {
      stage: "merge",
      percent: 100,
      message: `完成！生成了 ${docsWritten} 份文档`,
      provider,
    });

    db.update(projects)
      .set({ contextStatus: "ready", updatedAt: nowISO() })
      .where(eq(projects.id, projectId))
      .run();
    if (projectRunFence) await markProjectAiRunSucceeded(projectRunFence);

    log.info({ projectId, docsWritten }, "Context initialization completed (4-stage)");
  } catch (err) {
    if (projectRunFence) {
      await markProjectAiRunFailed(projectRunFence).catch(() => {});
    }
    log.error({ projectId, err }, "Context initialization failed");
    writeProgress(shipDir, {
      stage: "merge",
      percent: 0,
      message: `生成失败: ${err instanceof Error ? err.message : "未知错误"}`,
      provider,
    });
    db.update(projects)
      .set({ contextStatus: "failed", updatedAt: nowISO() })
      .where(eq(projects.id, projectId))
      .run();
  }
}

function mergeFileGuideWithStatic(aiContent: string, analysis: AnalysisResult): string {
  const staticExports = new Map<string, string[]>();
  for (const file of analysis.coreFiles) {
    const sigs = file.exports
      .filter(e => e.signature)
      .map(e => `- \`${e.signature}\``);
    if (sigs.length > 0) {
      staticExports.set(file.filePath, sigs);
    }
  }

  let result = aiContent;

  for (const [filePath, sigs] of staticExports) {
    if (!result.includes(filePath)) {
      result += `\n\n## ${filePath}\n\n**Exports (from static analysis):**\n${sigs.join("\n")}`;
    }
  }

  return result;
}

export { parseDocBlock, parseFileSelectionJson };
