import crypto from "crypto";
import fs from "fs";

import {
  critiquePath,
  planMarkdownPath,
  planPath,
  readText,
} from "./plan-safe-file-service";
import type { PlanSandboxState } from "./plan-types";

export type SourceHashes = {
  planJson: string;
  planMarkdown: string;
  planCritique: string;
};

const REPORT_META_PREFIX = "<!-- plan-sandbox-source-hashes:";

function sha256File(filePath: string): string {
  if (!fs.existsSync(filePath)) return "missing";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf-8")).digest("hex");
}

export function currentSourceHashes(repoPath: string, changeId: string): SourceHashes {
  return {
    planJson: sha256File(planPath(repoPath, changeId)),
    planMarkdown: sha256File(planMarkdownPath(repoPath, changeId)),
    planCritique: sha256File(critiquePath(repoPath, changeId)),
  };
}

export function readReportSourceHashes(filePath: string): SourceHashes | null {
  const report = readText(filePath);
  if (report === null) return null;

  const firstLine = report.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith(REPORT_META_PREFIX) || !firstLine.endsWith("-->")) {
    return null;
  }

  const json = firstLine.slice(REPORT_META_PREFIX.length, -3).trim();
  try {
    return JSON.parse(json) as SourceHashes;
  } catch {
    return null;
  }
}

export function sameHashes(a: SourceHashes | null, b: SourceHashes): boolean {
  return (
    a !== null &&
    a.planJson === b.planJson &&
    a.planMarkdown === b.planMarkdown &&
    a.planCritique === b.planCritique
  );
}

export function formatReport(
  changeId: string,
  state: PlanSandboxState,
  hashes: SourceHashes
): string {
  const lines: string[] = [
    `${REPORT_META_PREFIX} ${JSON.stringify(hashes)} -->`,
    "# Plan Sandbox Report",
    "",
    `Change: ${changeId}`,
    `Verdict: ${state.gate.canApprove ? "can_approve" : "blocked"}`,
    `Report fresh: ${state.reportFresh ? "yes" : "no"}`,
    "",
    "## Gate",
    "",
    `- Blocking P0: ${state.gate.blockingP0}`,
    `- Blocking P1: ${state.gate.blockingP1}`,
    `- Non-blocking P2: ${state.gate.nonBlockingP2}`,
    `- Missing fields: ${state.gate.missingFields.length ? state.gate.missingFields.join(", ") : "none"}`,
    `- Stale: ${state.gate.stale ? "yes" : "no"}`,
    "",
    "## Risks",
    "",
  ];

  if (state.risks.length === 0) {
    lines.push("- none");
  } else {
    for (const risk of state.risks) {
      const waiver = risk.waiverReason ? ` Waiver: ${risk.waiverReason}` : "";
      lines.push(
        `- [${risk.severity}/${risk.status}] ${risk.id}: ${risk.title} - ${risk.evidence}${waiver}`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}
