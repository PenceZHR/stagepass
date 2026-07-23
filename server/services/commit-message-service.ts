import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { createChildLogger } from "../logger";
import { getDiffSummary, getWorkingTreeStatus } from "./git-service";

const log = createChildLogger("commit-message");
const CLI_DISCOVERY_TIMEOUT_MS = 30_000;
const AI_COMMAND_TIMEOUT_MS = 300_000;

function getCodexBin(): string {
  const fromEnv = process.env.STAGEPASS_CODEX_BIN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("which codex", {
      encoding: "utf-8",
      timeout: CLI_DISCOVERY_TIMEOUT_MS,
    }).trim();
  } catch {
    return "codex";
  }
}

function loadTemplate(): string {
  const templatePath = path.join(/* turbopackIgnore: true */ process.cwd(), "server", "templates", "prompts", "commit-message.md");
  return fs.readFileSync(templatePath, "utf-8");
}

export async function suggestCommitMessage(
  repoPath: string,
  context?: { changeId?: string; changeTitle?: string }
): Promise<string> {
  const status = getWorkingTreeStatus(repoPath);
  if (status.clean) {
    return "chore: no changes";
  }

  let diff: string;
  try {
    diff = getDiffSummary(repoPath, 20000);
  } catch {
    const totalFiles = status.staged.length + status.unstaged.length;
    return `chore: update ${totalFiles} files`;
  }

  const contextStr = context?.changeId
    ? `Change: ${context.changeId} — ${context.changeTitle || ""}`
    : "General commit (no specific change)";

  const prompt = loadTemplate()
    .replace("{context}", contextStr)
    .replace("{diff}", diff);

  const outFile = path.join(os.tmpdir(), `stagepass-commit-msg-${process.pid}-${Date.now()}.txt`);
  try {
    const result = spawnSync(getCodexBin(), [
      "exec",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--cd", repoPath,
      "--output-last-message", outFile,
      "-",
    ], {
      cwd: repoPath,
      input: prompt,
      encoding: "utf-8",
      stdio: ["pipe", "ignore", "pipe"],
      timeout: AI_COMMAND_TIMEOUT_MS,
    });

    if (result.status === 0 && fs.existsSync(outFile)) {
      const output = fs.readFileSync(outFile, "utf-8").trim();
      const cleaned = output
        .replace(/^```[\s\S]*?\n/, "")
        .replace(/\n```$/, "")
        .trim();
      if (cleaned.length > 0 && cleaned.length < 500) {
        return cleaned;
      }
    }
  } catch (err) {
    log.warn({ err }, "AI commit message generation failed, using fallback");
  } finally {
    fs.rmSync(outFile, { force: true });
  }

  const totalFiles = status.staged.length + status.unstaged.length;
  return `chore: update ${totalFiles} files`;
}
