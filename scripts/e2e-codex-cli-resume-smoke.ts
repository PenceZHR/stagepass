#!/usr/bin/env tsx
/**
 * E2E smoke: drive a REAL `thread/start` then `thread/resume` through
 * `codex app-server`. This obtains a real threadId, resumes it, and verifies
 * read-only thread continuity with trivial side-effect-free prompts.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CodexAppServerEngine } from "../server/services/codex-app-server-engine";
import type { AiRunInput } from "../server/services/ai-engine-types";

async function main() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-resume-e2e-"));
  const engine = new CodexAppServerEngine();

  try {
    console.log(`Fresh run (cwd=${repoPath})...`);
    const fresh = await engine.run({
      changeId: "E2E-RESUME-SMOKE",
      repoPath,
      phase: "refine",
      prompt: "Reply with exactly the word OK and nothing else.",
      sandboxMode: "read-only",
      timeoutMs: 150_000,
    } satisfies AiRunInput);

    console.log("fresh.success:", fresh.success, " fresh.threadId:", fresh.threadId, " fresh.providerErrorCode:", fresh.providerErrorCode ?? "(none)");
    if (!fresh.success || !fresh.threadId) {
      throw new Error(`Fresh run did not produce a resumable threadId: ${fresh.summary}`);
    }

    console.log(`\nResume run (threadId=${fresh.threadId})...`);
    const resumed = await engine.run({
      changeId: "E2E-RESUME-SMOKE",
      repoPath,
      phase: "refine",
      prompt: "Reply with exactly the word OK again.",
      sandboxMode: "read-only",
      threadId: fresh.threadId,
      timeoutMs: 150_000,
    } satisfies AiRunInput);

    console.log("\n=== RESUME RESULT ===");
    console.log("success:            ", resumed.success);
    console.log("threadId:           ", resumed.threadId);
    console.log("summary:            ", JSON.stringify(resumed.summary).slice(0, 300));
    console.log("providerErrorCode:  ", resumed.providerErrorCode ?? "(none)");

    const ok = resumed.success && resumed.threadId === fresh.threadId;
    console.log(`\nE2E ${ok ? "PASS ✓" : "FAIL ✗"} (thread preserved: ${resumed.threadId === fresh.threadId})`);
    process.exit(ok ? 0 : 1);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("E2E threw:", e);
  process.exit(1);
});
