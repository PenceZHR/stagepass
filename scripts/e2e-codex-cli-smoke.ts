#!/usr/bin/env tsx
/**
 * E2E smoke: drive a REAL `codex` process through CodexCliEngine end-to-end.
 * Verifies the bare-spawn engine against the installed codex CLI (0.144+):
 * real pid capture, JSONL parsing, structured result. read-only sandbox +
 * trivial prompt to keep it cheap and side-effect free.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CodexCliEngine } from "../server/services/codex-cli-engine";
import type { AiRunInput, AiRunLifecycleSink } from "../server/services/ai-engine-types";

async function main() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-"));
  const events: string[] = [];
  const lifecycle: AiRunLifecycleSink = {
    onProcessStarted(e) {
      events.push(`started(pid=${e.pid})`);
      console.log(`[lifecycle] onProcessStarted  pid=${e.pid}  ppid=${e.ppid}  externalRef=${e.externalRef}`);
      console.log(`[lifecycle] identity: pid=${e.identity?.pid} cmd=${JSON.stringify(e.identity?.command)}`);
    },
    onHeartbeat() {},
    onTerminal(e) {
      events.push(`terminal:${e.status}`);
      console.log(`[lifecycle] onTerminal  status=${e.status}`);
    },
  };

  const input: AiRunInput = {
    changeId: "E2E-SMOKE",
    repoPath,
    phase: "refine", // no multi-agent files for this phase
    prompt: "Reply with exactly the word OK and nothing else.",
    sandboxMode: "read-only",
    timeoutMs: 150_000,
    lifecycle,
  };

  console.log(`Spawning real codex via CodexCliEngine (read-only, cwd=${repoPath})...`);
  const engine = new CodexCliEngine();
  const started = Date.now();
  const result = await engine.run(input);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\n=== RESULT ===");
  console.log("success:            ", result.success);
  console.log("threadId:           ", result.threadId);
  console.log("summary:            ", JSON.stringify(result.summary).slice(0, 200));
  console.log("items:              ", result.items.length, "→", result.items.map((i) => i.type).join(", "));
  console.log("changedFiles:       ", result.changedFiles);
  console.log("providerErrorCode:  ", result.providerErrorCode ?? "(none)");
  console.log("lifecycle events:   ", events.join(" → "));
  console.log(`elapsed:            ${elapsed}s`);

  fs.rmSync(repoPath, { recursive: true, force: true });

  const gotPid = events.some((e) => e.startsWith("started(pid=") && !e.includes("pid=null"));
  const ok = result.success && gotPid && events.includes("terminal:completed");
  console.log(`\nE2E ${ok ? "PASS ✓" : "FAIL ✗"} (real pid captured: ${gotPid})`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E threw:", e);
  process.exit(1);
});
