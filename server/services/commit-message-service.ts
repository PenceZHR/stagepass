import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { createChildLogger } from "../logger";
import { getDiffSummary, getWorkingTreeStatus } from "./git-service";

const log = createChildLogger("commit-message");
const CLI_DISCOVERY_TIMEOUT_MS = 30_000;
const AI_COMMAND_TIMEOUT_MS = 300_000;

function getClaudeBin(): string {
  try {
    return execSync("which claude", {
      encoding: "utf-8",
      timeout: CLI_DISCOVERY_TIMEOUT_MS,
    }).trim();
  } catch {
    return "claude";
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

  try {
    const result = spawnSync(getClaudeBin(), [
      "--print",
      "--max-turns", "1",
      "--no-input",
      prompt,
    ], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: AI_COMMAND_TIMEOUT_MS,
    });

    const output = (result.stdout || "").trim();
    if (output && result.status === 0) {
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
  }

  const totalFiles = status.staged.length + status.unstaged.length;
  return `chore: update ${totalFiles} files`;
}
