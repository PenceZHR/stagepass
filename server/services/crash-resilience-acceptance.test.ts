import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { defaultDatabasePath, resolveDatabasePath } from "../db/config";
import { parseCrashAcceptanceArgs } from "../../scripts/acceptance-crash-resilience";
import { resolveAcceptanceInjection } from "./acceptance-injection-service";
import {
  CRASH_ACCEPTANCE_CASES,
  ACCEPTANCE_OUTER_TIMEOUT_MS,
  ACCEPTANCE_PROVIDER_TIMEOUT_MS,
  ResourceRegistry,
  runCrashAcceptance,
  runHungProviderTimeoutProbe,
  terminateValidatedProcess,
} from "./crash-resilience-harness";

describe("crash resilience acceptance harness", { concurrency: false }, () => {
  it("keeps provider execution timeout below the outer acceptance budget", () => {
    assert.equal(ACCEPTANCE_OUTER_TIMEOUT_MS, 120_000);
    assert.equal(ACCEPTANCE_PROVIDER_TIMEOUT_MS, 60_000);
    assert.ok(ACCEPTANCE_PROVIDER_TIMEOUT_MS <= ACCEPTANCE_OUTER_TIMEOUT_MS / 2);
  });

  it("times out a stuck transport, persists terminal state, and cleans its process/root", { timeout: 15_000 }, async () => {
    const result = await runHungProviderTimeoutProbe(200);
    assert.equal(result.processExited, true);
    assert.equal(result.rootRemoved, true);
    assert.ok(["failed", "stopped"].includes(result.providerStatus));
    assert.equal(result.jobStatus, "failed");
  });
  it("resolves STAGEPASS_DB_PATH and never aliases the production default", () => {
    const isolated = resolveDatabasePath({ STAGEPASS_DB_PATH: "./tmp/acceptance.db" } as NodeJS.ProcessEnv);
    assert.equal(isolated, path.resolve("./tmp/acceptance.db"));
    assert.notEqual(isolated, defaultDatabasePath());

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-injection-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-injection-outside-"));
    const executable = path.join(outside, "transport");
    const escapedLink = path.join(root, "transport-link");
    try {
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      fs.symlinkSync(executable, escapedLink);
      assert.throws(() => resolveAcceptanceInjection({
        STAGEPASS_ACCEPTANCE_MODE: "1",
        STAGEPASS_ACCEPTANCE_ROOT: root,
        STAGEPASS_CLAUDE_TRANSPORT_BIN: escapedLink,
      } as NodeJS.ProcessEnv), /claude_transport_invalid/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("imports the harness without touching ship.db or its WAL sidecars", () => {
    const files = [defaultDatabasePath(), `${defaultDatabasePath()}-wal`, `${defaultDatabasePath()}-shm`];
    const snapshot = (file: string) => fs.existsSync(file) ? {
      exists: true,
      hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      mtimeMs: fs.statSync(file).mtimeMs,
    } : { exists: false, hash: null, mtimeMs: null };
    const before = files.map(snapshot);
    execFileSync(process.execPath, ["--import", "tsx", "-e", "import('./server/services/crash-resilience-harness.ts')"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    assert.deepEqual(files.map(snapshot), before);
  });

  it("fails closed unless kill-provider identifies change and run explicitly", () => {
    assert.throws(
      () => parseCrashAcceptanceArgs(["--case", "kill-provider", "--execute"]),
      /requires --change <id> and --run <id>/,
    );
    assert.deepEqual(
      parseCrashAcceptanceArgs(["--case", "kill-provider", "--change", "CHG-X", "--run", "RUN-X"]),
      { caseName: "kill-provider", changeId: "CHG-X", runId: "RUN-X", execute: false },
    );
    assert.throws(
      () => parseCrashAcceptanceArgs(["--case", "restart-recovery"]),
      /requires --execute/,
    );
  });

  it("kill-provider dry-run uses the shared selector and signals neither provider", { timeout: 120_000 }, async () => {
    const result = await runCrashAcceptance({
      caseName: "kill-provider",
      changeId: "CHG-PROVIDER-DRY",
      runId: "RUN-PROVIDER-DRY",
      execute: false,
    });
    assert.ok(result.assertions.includes("shared selector validated target/non-target; dry-run emitted no signal"));
    assert.ok(result.evidence.some((entry) => entry.kind === "http"));
    assert.ok(result.evidence.some((entry) => entry.kind === "processes"));
  });

  it("cleans replacement resources after supervisor stop fails", { timeout: 60_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-stop-failure-"));
    const registry = new ResourceRegistry(root, 2_000);
    for (let index = 0; index < 100; index += 1) {
      let deadline: NodeJS.Timeout | null = null;
      try {
        const result = await Promise.race([
          registry.runProbe(["--child", "immediate-probe"], {}, 1_000),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("immediate_probe_hung")), 2_000);
          }),
        ]);
        assert.equal(result.stdout, "immediate-probe-ok\n");
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    }
    const immediateProbes = registry.processes.filter((record) => record.identity.command.join(" ").includes("immediate-probe"));
    assert.equal(immediateProbes.length, 100);
    for (const probe of immediateProbes) {
      assert.throws(() => process.kill(probe.identity.pid, 0), /ESRCH|kill/);
    }
    const processRecord = await registry.spawn("identity-holder", {});
    await assert.rejects(
      () => registry.runProbe(["--child", "hung-probe"], {}, 50),
      /probe_timeout/,
    );
    const hungProbe = registry.processes.find((record) => record.identity.command.join(" ").includes("hung-probe"));
    assert.ok(hungProbe);
    assert.throws(() => process.kill(hungProbe.identity.pid, 0), /ESRCH|kill/);
    await assert.rejects(
      () => registry.runProbe(["--child", "overflow-probe"], {}, 2_000),
      /probe_output_limit/,
    );
    const overflowProbe = registry.processes.find((record) => record.identity.command.join(" ").includes("overflow-probe"));
    assert.ok(overflowProbe);
    assert.throws(() => process.kill(overflowProbe.identity.pid, 0), /ESRCH|kill/);
    registry.addSupervisor({
      start: async () => {},
      stop: async () => { throw new Error("injected_supervisor_stop_failure"); },
    });
    await assert.rejects(() => registry.cleanup(), AggregateError);
    assert.equal(fs.existsSync(root), false);
    assert.throws(() => process.kill(processRecord.identity.pid, 0), /ESRCH|kill/);
  });

  it("retains the temp root when an identity mismatch prevents safe cleanup", { timeout: 15_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-unsafe-cleanup-"));
    const registry = new ResourceRegistry(root, 200);
    const processRecord = await registry.spawn("identity-holder", {});
    const original = { ...processRecord.identity };
    processRecord.identity.nonce = "mismatched-cleanup-nonce";
    try {
      await assert.rejects(() => registry.cleanup(), AggregateError);
      assert.equal(fs.existsSync(root), true);
      assert.doesNotThrow(() => process.kill(original.pid, 0));
    } finally {
      await terminateValidatedProcess({ ...processRecord, identity: original }, 1_000);
      assert.throws(() => process.kill(original.pid, 0), /ESRCH|kill/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const caseName of CRASH_ACCEPTANCE_CASES) {
    it(`${caseName}: proves isolated real-process failure and joined observability`, { timeout: 120_000 }, async () => {
      const changeId = caseName === "kill-provider" ? "CHG-PROVIDER-EXPLICIT" : undefined;
      const runId = caseName === "kill-provider" ? "RUN-PROVIDER-EXPLICIT" : undefined;
      const result = await runCrashAcceptance({
        caseName,
        changeId,
        runId,
        execute: caseName === "kill-provider",
      });
      assert.equal(result.passed, true);
      assert.notEqual(path.resolve(result.dbPath), path.resolve("server/db/ship.db"));
      assert.equal(fs.existsSync(path.dirname(result.dbPath)), false, "fixture root must be removed");
      assert.ok(result.identities.length >= 2);
      assert.ok(result.assertions.includes("GET detail=200"));
      assert.ok(result.assertions.includes("SSE initial event observed"));
      assert.ok(result.assertions.includes("action contract observed"));
      assert.ok(result.evidence.some((entry) => entry.kind === "http"));
      assert.ok(result.evidence.some((entry) => entry.kind === "logs"));
    });
  }
});
