import fs from "fs";
import path from "path";

export interface RetroBacklogAppendResult {
  backlogPath: string;
  appended: number;
}

function isDebtHeading(line: string): boolean {
  return /^#{1,6}\s+.*(债务|backlog)/i.test(line);
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

function normalizeDebtLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const bullet = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
  return bullet ? bullet[1].trim() : trimmed;
}

export function extractRetroDebtItems(retroContent: string): string[] {
  const lines = retroContent.split(/\r?\n/);
  const items: string[] = [];
  let inDebtSection = false;

  for (const line of lines) {
    if (isDebtHeading(line)) {
      inDebtSection = true;
      continue;
    }

    if (inDebtSection && isHeading(line)) {
      break;
    }

    if (!inDebtSection) continue;

    const item = normalizeDebtLine(line);
    if (item) items.push(item);
  }

  return items;
}

export function appendRetroDebtsToBacklog(
  repoPath: string,
  changeId: string
): RetroBacklogAppendResult {
  const retroPath = path.join(repoPath, ".ship", "changes", changeId, "retro.md");
  const backlogPath = path.join(repoPath, ".ship", "baseline", "backlog.md");
  const retroContent = fs.readFileSync(retroPath, "utf-8");
  const items = extractRetroDebtItems(retroContent);

  if (items.length === 0) {
    return { backlogPath, appended: 0 };
  }

  fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
  const prefix = fs.existsSync(backlogPath) ? "\n\n" : "# Backlog\n";
  const entry = [
    `${prefix}## Retro ${changeId} - ${new Date().toISOString()}`,
    ...items.map((item) => `- ${item}`),
    "",
  ].join("\n");

  fs.appendFileSync(backlogPath, entry);

  return { backlogPath, appended: items.length };
}
