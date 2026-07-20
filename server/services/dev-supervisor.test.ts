import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  appendSupervisorEvent,
  computeBackoffMs,
  createDefaultChildFactory,
  createDefaultWorkerChildFactory,
  createSupervisor,
  ensureLogDir,
  isCrashLoop,
  type ChildFactory,
  type DevSupervisorOptions,
  type SupervisorDecisionEvent,
} from "../../scripts/dev-supervisor.ts";
import {
  readSupervisorHealth,
  readWorkerHeartbeat,
} from "./supervisor-health-service.ts";
import {
  createPlatformProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
} from "./process-identity-service.ts";

class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignal: NodeJS.Signals | null = null;
  private autoExitOnKill: boolean;

  constructor(pid: number, options: { autoExitOnKill?: boolean } = {}) {
    super();
    this.pid = pid;
    this.autoExitOnKill = options.autoExitOnKill ?? true;
    fakeChildrenByPid.set(pid, this);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignal = signal ?? "SIGTERM";
    if (this.autoExitOnKill) {
      queueMicrotask(() => {
        this.emit("exit", null, this.killedSignal);
      });
    }
    return true;
  }
}

class StubbornFakeChild extends FakeChild {
  signals: NodeJS.Signals[] = [];

  override kill(signal?: NodeJS.Signals): boolean {
    const sentSignal = signal ?? "SIGTERM";
    this.signals.push(sentSignal);
    this.killedSignal = sentSignal;
    if (sentSignal === "SIGKILL") {
      queueMicrotask(() => this.emit("exit", null, sentSignal));
    }
    return true;
  }
}

const fakeChildrenByPid = new Map<number, FakeChild>();

function fakeProcessStartTime(pid: number): string {
  return new Date(Date.UTC(2026, 0, 1) + pid * 1000).toISOString();
}

function createTestSupervisor(options: DevSupervisorOptions) {
  const fakeProbe: ProcessIdentityProbe = {
    capture: async (pid, expected) => ({
      pid,
      ppid: expected?.ppid ?? process.pid,
      pgid: pid,
      nonce: `fake-identity-${pid}`,
      processStartTime: fakeProcessStartTime(pid),
      cwd: expected?.cwd ?? options.cwd ?? process.cwd(),
      command: ["fake-child", String(pid)],
    }),
    validate: async (expected) => ({ ok: true, observed: expected }),
  };
  return createSupervisor({
    ...options,
    processIdentityProbe: fakeProbe,
    processGroupSignaler: options.processGroupSignaler ?? ((pgid, signal) => {
      fakeChildrenByPid.get(pgid)?.kill(signal);
    }),
  });
}

function readSupervisorEvents(logDir: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(logDir, "dev-supervisor.log"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function awaitDecisionLatch<T>(
  promise: Promise<T>,
  decisions: SupervisorDecisionEvent[],
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out: ${JSON.stringify(decisions)}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function killOwnedProcessGroup(child: ChildProcess | null): void {
  const pid = child?.pid;
  if (!pid || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The supervisor may already have reaped the test-owned process group.
  }
}

async function assertRealWorkerFatalExit(
  tempDir: string,
  kind: "uncaughtException" | "unhandledRejection",
  fatalIoFault?: "heartbeat" | "log",
): Promise<void> {
  const repoRoot = process.cwd();
  const tempDbDir = path.join(tempDir, "server", "db");
  const heartbeatFile = fatalIoFault === "log"
    ? path.join(tempDir, "state", "worker-heartbeat.json")
    : path.join(tempDir, "logs", "worker-heartbeat.json");
  const providerShutdownMarker = path.join(tempDir, "provider-shutdown.txt");
  fs.mkdirSync(tempDbDir, { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "server", "db", "migrations"),
    path.join(tempDbDir, "migrations"),
    "dir",
  );
  const trigger = kind === "uncaughtException"
    ? "setImmediate(() => { throw new Error('fatal worker test') })"
    : "setImmediate(() => { void Promise.reject(new Error('fatal worker test')) })";
  const bootstrap = [
    `void import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "server", "services", "active-provider-registry.ts")).href)}).then((module) => { module.activeProviderRegistry.handleSignal = async (signal) => { require('node:fs').appendFileSync(${JSON.stringify(providerShutdownMarker)}, signal + '\\n'); return 0 }; return import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts", "pipeline-worker.ts")).href)}) }).then((worker) => worker.runPipelineWorker())`,
    `process.on('message', (message) => { if (message === 'trigger-fatal') setTimeout(() => { ${trigger} }, 20) })`,
  ].join(";");
  const child = spawn(process.execPath, [
    "--import",
    path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    "--eval",
    bootstrap,
  ], {
    cwd: tempDir,
    detached: true,
    env: {
      ...process.env,
      PIPELINE_WORKER_HEARTBEAT_FILE: heartbeatFile,
      PIPELINE_WORKER_PROCESS_HEARTBEAT_MS: "30",
      PIPELINE_WORKER_ID: `fatal-worker-${kind}`,
      PIPELINE_WORKER_INSTANCE_NONCE: `fatal-instance-${kind}`,
      PIPELINE_WORKER_STDOUT_ONLY: fatalIoFault === "log" ? "0" : "1",
      STAGEPASS_DB_BOOTSTRAPPED: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let exitTimeout: NodeJS.Timeout | null = null;

  try {
    await waitUntil(() => readWorkerHeartbeat(heartbeatFile) !== null, 4_000);
    if (fatalIoFault === "heartbeat") {
      fs.rmSync(heartbeatFile);
      fs.mkdirSync(heartbeatFile);
    } else if (fatalIoFault === "log") {
      const workerLog = path.join(tempDir, "logs", "pipeline-worker.log");
      await waitUntil(() => fs.existsSync(workerLog), 4_000);
      fs.rmSync(workerLog);
      fs.mkdirSync(workerLog);
    }
    child.send("trigger-fatal", () => child.disconnect());
    const result = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        exitTimeout = setTimeout(() => reject(new Error(`${kind} worker did not exit`)), 3_000);
      }),
    ]);
    if (exitTimeout) clearTimeout(exitTimeout);

    assert.equal(result.signal, null);
    assert.equal(result.code, 1);
    if (fatalIoFault === "heartbeat") {
      fs.rmSync(heartbeatFile, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.existsSync(heartbeatFile), false);
    } else {
      const finalHeartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf-8"));
      assert.equal(finalHeartbeat.health, "fatal");
      assert.equal(finalHeartbeat.fatalKind, kind);
      const finalContents = fs.readFileSync(heartbeatFile, "utf-8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.readFileSync(heartbeatFile, "utf-8"), finalContents);
    }
    if (fatalIoFault) {
      assert.deepEqual(
        fs.readFileSync(providerShutdownMarker, "utf-8").trim().split("\n"),
        ["SIGTERM"],
      );
    }
  } finally {
    if (exitTimeout) clearTimeout(exitTimeout);
    killOwnedProcessGroup(child);
  }
}

describe("dev supervisor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-supervisor-"));
    fakeChildrenByPid.clear();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the log directory when it is missing", () => {
    const logDir = path.join(tempDir, "logs");

    ensureLogDir(logDir);

    assert.equal(fs.statSync(logDir).isDirectory(), true);
  });

  it("appends supervisor events as JSONL with event fields", () => {
    const logFile = path.join(tempDir, "logs", "dev-supervisor.log");

    appendSupervisorEvent(logFile, "dev_server_exit", {
      pid: 4242,
      exitCode: 1,
      signal: null,
      restartCount: 3,
      backoffMs: 2000,
      startedAt: "2026-07-10T03:00:00.000Z",
      endedAt: "2026-07-10T03:00:05.000Z",
    });

    const [line] = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    const event = JSON.parse(line);
    assert.equal(event.event, "dev_server_exit");
    assert.equal(event.pid, 4242);
    assert.equal(event.exitCode, 1);
    assert.equal(event.signal, null);
    assert.equal(event.restartCount, 3);
    assert.equal(event.backoffMs, 2000);
    assert.equal(event.startedAt, "2026-07-10T03:00:00.000Z");
    assert.equal(event.endedAt, "2026-07-10T03:00:05.000Z");
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("computes capped restart backoff values", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 99].map((restartCount) => computeBackoffMs(restartCount)),
      [500, 1000, 2000, 5000, 10000, 10000, 10000],
    );
  });

  it("detects five abnormal exits inside ten minutes and ignores older exits", () => {
    const now = Date.parse("2026-07-10T04:10:00.000Z");
    const recentCrashes = [
      now - 9 * 60_000,
      now - 7 * 60_000,
      now - 5 * 60_000,
      now - 3 * 60_000,
      now - 1 * 60_000,
    ];

    assert.equal(isCrashLoop(recentCrashes, now), true);
    assert.equal(isCrashLoop([now - 11 * 60_000, ...recentCrashes.slice(1)], now), false);
  });

  it("launches Next directly as a detached Node process without an npm wrapper", async () => {
    const child = createDefaultChildFactory(process.cwd())() as ChildProcess;
    try {
      assert.equal(child.spawnfile, process.execPath);
      assert.equal(child.spawnargs.some((part) => /(^|\/)npm(?:$|\s)/.test(part)), false);
      assert.equal(child.spawnargs.some((part) => part.includes("next/dist/bin/next")), true);
      const identity = await createPlatformProcessIdentityProbe().capture(child.pid!, {
        ppid: process.pid,
        cwd: process.cwd(),
      });
      assert.equal(identity.pgid, child.pid);
      assert.equal(identity.command.join(" ").includes("next/dist/bin/next"), true);
    } finally {
      killOwnedProcessGroup(child);
      await waitUntil(() => !isProcessAlive(child.pid!));
    }
  });

  it("launches the default worker directly with supervisor-owned identity and pgid", async () => {
    const repoRoot = process.cwd();
    const heartbeatFile = path.join(tempDir, "logs", "worker-heartbeat.json");
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tempDir, "node_modules"), "dir");
    fs.symlinkSync(path.join(repoRoot, "scripts"), path.join(tempDir, "scripts"), "dir");
    const tempDbDir = path.join(tempDir, "server", "db");
    fs.mkdirSync(tempDbDir, { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "server", "db", "migrations"),
      path.join(tempDbDir, "migrations"),
      "dir",
    );
    const instance = {
      workerId: "factory-worker-owned-by-supervisor",
      instanceNonce: "factory-instance-owned-by-supervisor",
    };
    const child = createDefaultWorkerChildFactory(tempDir, heartbeatFile)(instance) as ChildProcess;

    try {
      await waitUntil(() => readWorkerHeartbeat(heartbeatFile) !== null, 4_000);
      const heartbeat = readWorkerHeartbeat(heartbeatFile);
      const identity = await createPlatformProcessIdentityProbe().capture(child.pid!, {
        ppid: process.pid,
        pgid: child.pid,
        cwd: fs.realpathSync(tempDir),
      });

      assert.equal(child.spawnfile, process.execPath);
      assert.equal(child.spawnargs.some((part) => /(^|\/)npm(?:$|\s)/.test(part)), false);
      assert.equal(child.spawnargs.some((part) => part.includes("tsx/dist/cli")), false);
      assert.equal(child.spawnargs.includes("--import"), true);
      assert.equal(identity.pgid, child.pid);
      assert.equal(heartbeat?.pid, child.pid);
      assert.equal(heartbeat?.workerId, instance.workerId);
      assert.equal(heartbeat?.instanceNonce, instance.instanceNonce);
      assert.equal(heartbeat?.workerNonce, instance.instanceNonce);
    } finally {
      killOwnedProcessGroup(child);
      await waitUntil(() => !isProcessAlive(child.pid!));
    }
  });

  it("supervised worker logs once through stdout without raw nonce values", async () => {
    const repoRoot = process.cwd();
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tempDir, "node_modules"), "dir");
    fs.symlinkSync(path.join(repoRoot, "scripts"), path.join(tempDir, "scripts"), "dir");
    const tempDbDir = path.join(tempDir, "server", "db");
    fs.mkdirSync(tempDbDir, { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "server", "db", "migrations"),
      path.join(tempDbDir, "migrations"),
      "dir",
    );
    const rawInstanceNonce = "raw-supervised-instance-secret";
    const next = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: tempDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logDir = path.join(tempDir, "logs");
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => next,
      workerIdentityFactory: () => ({
        workerId: "supervised-worker-log-test",
        instanceNonce: rawInstanceNonce,
      }),
      superviseWorker: true,
      healthCheck: async () => true,
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
      terminationGraceMs: 2_000,
    });

    try {
      await supervisor.start();
      const workerLog = path.join(logDir, "pipeline-worker.log");
      await waitUntil(
        () => fs.existsSync(workerLog) && fs.readFileSync(workerLog, "utf-8").includes("pipeline_worker_started"),
        4_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const contents = fs.readFileSync(workerLog, "utf-8");
      const starts = contents
        .trim()
        .split("\n")
        .filter((line) => line.includes('"event":"pipeline_worker_started"'));

      assert.equal(starts.length, 1);
      assert.doesNotMatch(contents, new RegExp(rawInstanceNonce));
    } finally {
      await supervisor.stop("SIGTERM");
      killOwnedProcessGroup(next);
    }
  });

  it("never logs raw lease tokens or instance nonce fields", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "pipeline-worker.ts"),
      "utf-8",
    );

    const logCalls = [...source.matchAll(/\blog\([\s\S]*?\);/g)].map(([call]) => call);
    for (const call of logCalls) {
      assert.doesNotMatch(call, /\bleaseToken\s*:/);
      assert.doesNotMatch(call, /\bworkerNonce\s*[,}]/);
      assert.doesNotMatch(call, /\binstanceNonce\s*[,}]/);
    }
  });

  it("plans a restart after an abnormal child exit without starting Next directly", async () => {
    const children: FakeChild[] = [];
    const delays: number[] = [];
    const childFactory: ChildFactory = () => {
      const child = new FakeChild(9000 + children.length);
      children.push(child);
      return child;
    };

    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir: path.join(tempDir, "logs"),
      healthFilePath: path.join(tempDir, "logs", "supervisor-health.json"),
      childFactory,
      healthCheck: async () => true,
      sleep: async (ms) => {
        delays.push(ms);
      },
      now: () => new Date("2026-07-10T05:00:00.000Z"),
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
    });

    await supervisor.start();
    children[0].emit("exit", 1, null);
    await supervisor.waitForIdle();

    assert.equal(children.length, 2);
    assert.deepEqual(delays, [500]);
    const log = fs.readFileSync(path.join(tempDir, "logs", "dev-supervisor.log"), "utf-8");
    assert.match(log, /"event":"dev_server_restarting"/);
    await supervisor.stop("SIGTERM");
  });

  it("ignores stale health check results from a child that has already been replaced", async () => {
    const logDir = path.join(tempDir, "logs");
    const firstHealth = deferred<boolean>();
    const children: FakeChild[] = [];
    const childFactory: ChildFactory = () => {
      const child = new FakeChild(9100 + children.length, { autoExitOnKill: false });
      children.push(child);
      return child;
    };
    let healthChecks = 0;
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      healthFilePath: path.join(logDir, "supervisor-health.json"),
      childFactory,
      healthCheck: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          return firstHealth.promise;
        }
        return true;
      },
      sleep: async () => {},
      now: () => new Date(children.length <= 1 ? "2026-07-10T06:00:00.000Z" : "2026-07-10T06:00:10.000Z"),
      healthPollIntervalMs: 1,
      healthTimeoutMs: 0,
    });

    const firstStart = supervisor.start();
    await new Promise((resolve) => setImmediate(resolve));
    children[0].emit("exit", 1, null);
    await supervisor.waitForIdle();
    assert.equal(children.length, 2);

    firstHealth.resolve(false);
    await firstStart;
    const secondKilledSignal = children[1].killedSignal;
    const portNotListeningEvents = readSupervisorEvents(logDir).filter(
      (event) => event.event === "dev_server_port_not_listening",
    );

    children[1].emit("exit", 0, null);
    await supervisor.waitForIdle();

    assert.equal(secondKilledSignal, null);
    assert.deepEqual(portNotListeningEvents, []);
  });

  it("stops restarting after five abnormal exits and marks health as crashLoop", async () => {
    const logDir = path.join(tempDir, "logs");
    const healthFilePath = path.join(logDir, "supervisor-health.json");
    const children: FakeChild[] = [];
    const childFactory: ChildFactory = () => {
      const child = new FakeChild(9200 + children.length);
      children.push(child);
      return child;
    };
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      healthFilePath,
      childFactory,
      healthCheck: async () => true,
      sleep: async () => {},
      now: () => new Date("2026-07-10T07:00:00.000Z"),
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
    });

    await supervisor.start();
    for (let index = 0; index < 5; index += 1) {
      children[index].emit("exit", 1, null);
      await supervisor.waitForIdle();
    }

    const events = readSupervisorEvents(logDir);
    assert.equal(children.length, 5);
    assert.equal(
      events.filter((event) => event.event === "supervisor_child_crash_loop").length,
      1,
    );
    assert.equal(readSupervisorHealth(healthFilePath)?.next.crashLoop, true);
  });

  it("kills the current launched child when health checks never pass and then restarts", async () => {
    const logDir = path.join(tempDir, "logs");
    const children: FakeChild[] = [];
    const childFactory: ChildFactory = () => {
      const child = new FakeChild(9300 + children.length);
      children.push(child);
      return child;
    };
    let healthChecks = 0;
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      healthFilePath: path.join(logDir, "supervisor-health.json"),
      childFactory,
      healthCheck: async () => {
        healthChecks += 1;
        return healthChecks > 1;
      },
      sleep: async (ms) => {
        if (ms === 5) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        }
      },
      now: () => new Date("2026-07-10T08:00:00.000Z"),
      healthPollIntervalMs: 5,
      healthTimeoutMs: 1,
    });

    await supervisor.start();
    await supervisor.waitForIdle();

    assert.equal(children[0].killedSignal, "SIGTERM");
    assert.equal(children.length, 2);
    assert.equal(children[1].killedSignal, null);
    const events = readSupervisorEvents(logDir);
    assert.equal(
      events.filter((event) => event.event === "dev_server_port_not_listening").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.event === "dev_server_restarting").length,
      1,
    );
    await supervisor.stop("SIGTERM");
  });

  it("enters unmanaged fatal state when health-check termination fails", async () => {
    const logDir = path.join(tempDir, "health-termination-failure");
    const child = new FakeChild(9350, { autoExitOnKill: false });
    let signalCalls = 0;
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => child,
      healthCheck: async () => false,
      sleep: async () => {},
      healthTimeoutMs: 0,
      healthPollIntervalMs: 1,
      processGroupSignaler: () => {
        signalCalls += 1;
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
    } as DevSupervisorOptions);

    await assert.rejects(supervisor.start(), /manual process cleanup required/i);
    assert.equal(signalCalls, 1);
    assert.equal(child.killedSignal, null);
    assert.equal(
      readSupervisorHealth(path.join(logDir, "supervisor-health.json"))?.next.error?.code,
      "supervisor_unmanaged_process",
    );
    await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
  });

  it("writes child stdout and stderr to dev-server.log", async () => {
    const logDir = path.join(tempDir, "logs");
    const child = new FakeChild(9400);
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      healthFilePath: path.join(logDir, "supervisor-health.json"),
      childFactory: () => child,
      healthCheck: async () => true,
      sleep: async () => {},
      now: () => new Date("2026-07-10T09:00:00.000Z"),
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
    });

    await supervisor.start();
    child.stdout.write("stdout line\n");
    child.stderr.write("stderr line\n");
    await supervisor.stop("SIGTERM");

    const serverLog = fs.readFileSync(path.join(logDir, "dev-server.log"), "utf-8");
    assert.match(serverLog, /stdout line/);
    assert.match(serverLog, /stderr line/);
  });

  it("restarts worker crashes without marking Next crash loop", async () => {
    const logDir = path.join(tempDir, "logs");
    const nextChildren: FakeChild[] = [];
    const workerChildren: FakeChild[] = [];
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      healthFilePath: path.join(logDir, "supervisor-health.json"),
      childFactory: () => {
        const child = new FakeChild(9500 + nextChildren.length);
        nextChildren.push(child);
        return child;
      },
      workerChildFactory: () => {
        const child = new FakeChild(9600 + workerChildren.length);
        workerChildren.push(child);
        return child;
      },
      superviseWorker: true,
      healthCheck: async () => true,
      sleep: async () => {},
      now: () => new Date("2026-07-10T09:30:00.000Z"),
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
    });

    await supervisor.start();
    workerChildren[0].emit("exit", 1, null);
    await supervisor.waitForIdle();

    const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
    assert.equal(nextChildren.length, 1);
    assert.equal(workerChildren.length, 2);
    assert.equal(health?.next.crashLoop, false);
    assert.equal(health?.worker.restartCount, 1);
    const events = readSupervisorEvents(logDir);
    assert.equal(events.some((event) => event.event === "pipeline_worker_restarting"), true);
    await supervisor.stop("SIGTERM");
  });

  it("restarts worker normal exits while the supervisor is still running", async () => {
    const logDir = path.join(tempDir, "logs");
    const nextChildren: FakeChild[] = [];
    const workerChildren: FakeChild[] = [];
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      healthFilePath: path.join(logDir, "supervisor-health.json"),
      childFactory: () => {
        const child = new FakeChild(9700 + nextChildren.length);
        nextChildren.push(child);
        return child;
      },
      workerChildFactory: () => {
        const child = new FakeChild(9800 + workerChildren.length);
        workerChildren.push(child);
        return child;
      },
      superviseWorker: true,
      healthCheck: async () => true,
      sleep: async () => {},
      now: () => new Date("2026-07-10T09:45:00.000Z"),
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
    });

    await supervisor.start();
    workerChildren[0].emit("exit", 0, null);
    await supervisor.waitForIdle();

    const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
    assert.equal(nextChildren.length, 1);
    assert.equal(workerChildren.length, 2);
    assert.equal(health?.worker.restartCount, 1);
    const events = readSupervisorEvents(logDir);
    assert.equal(events.some((event) => event.event === "pipeline_worker_restarting"), true);
    await supervisor.stop("SIGTERM");
  });

  it("rejects worker heartbeats with the wrong owner or invalid observed time", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const expectedWorker = {
      workerId: "worker-owned-by-supervisor",
      instanceNonce: "instance-owned-by-supervisor",
    };
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: () => new FakeChild(9850),
      workerChildFactory: () => new FakeChild(9851),
      workerIdentityFactory: () => expectedWorker,
      superviseWorker: true,
      healthCheck: async () => true,
      now: () => new Date("2026-07-10T09:30:05.000Z"),
      workerStaleAfterMs: 60_000,
      workerMonitorIntervalMs: 60_000,
    } as DevSupervisorOptions);
    const invalidHeartbeats = [
      {
        label: "workerId",
        workerId: "wrong-worker",
        instanceNonce: expectedWorker.instanceNonce,
        observedAt: "2026-07-10T09:30:01.000Z",
      },
      {
        label: "instanceNonce",
        workerId: expectedWorker.workerId,
        instanceNonce: "wrong-instance",
        observedAt: "2026-07-10T09:30:01.000Z",
      },
      {
        label: "observedAt_before_start",
        workerId: expectedWorker.workerId,
        instanceNonce: expectedWorker.instanceNonce,
        observedAt: "2026-07-10T09:29:59.000Z",
      },
      {
        label: "observedAt_future",
        workerId: expectedWorker.workerId,
        instanceNonce: expectedWorker.instanceNonce,
        observedAt: "2026-07-10T09:30:06.000Z",
      },
    ];

    try {
      await supervisor.start();
      for (const heartbeat of invalidHeartbeats) {
        fs.writeFileSync(heartbeatFile, JSON.stringify({
          pid: 9851,
          workerId: heartbeat.workerId,
          workerNonce: heartbeat.instanceNonce,
          instanceNonce: heartbeat.instanceNonce,
          observedAt: heartbeat.observedAt,
          health: "healthy",
          fatalKind: null,
          currentJob: null,
          lastJobAt: null,
        }), "utf-8");

        await supervisor.checkWorkerHealth();

        const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
        assert.equal(health?.worker.lastHealthAt, null, heartbeat.label);
        assert.equal(health?.worker.record?.lastHeartbeatAt, null, heartbeat.label);
        assert.equal(health?.worker.error?.code, "worker_heartbeat_mismatch", heartbeat.label);
      }
    } finally {
      await supervisor.stop("SIGTERM");
    }
  });

  it("awaits stale worker exit and revalidates before escalating SIGTERM to SIGKILL", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const stubbornWorker = new StubbornFakeChild(9871, { autoExitOnKill: false });
    const replacementWorker = new FakeChild(9872);
    const workerChildren = [stubbornWorker, replacementWorker];
    let workerLaunches = 0;
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: () => new FakeChild(9870),
      workerIdentityFactory: () => ({
        workerId: `controlled-worker-${workerLaunches + 1}`,
        instanceNonce: `controlled-instance-${workerLaunches + 1}`,
      }),
      workerChildFactory: () => workerChildren[workerLaunches++],
      superviseWorker: true,
      healthCheck: async () => true,
      sleep: async () => {},
      workerStaleAfterMs: 1,
      workerMonitorIntervalMs: 60_000,
      terminationGraceMs: 1,
    } as DevSupervisorOptions);

    try {
      await supervisor.start();
      const workerStartedAt = readSupervisorHealth(
        path.join(logDir, "supervisor-health.json"),
      )?.worker.record?.startedAt;
      fs.writeFileSync(heartbeatFile, JSON.stringify({
        pid: stubbornWorker.pid,
        workerId: "controlled-worker-1",
        workerNonce: "controlled-instance-1",
        instanceNonce: "controlled-instance-1",
        observedAt: workerStartedAt,
        health: "healthy",
        fatalKind: null,
        currentJob: null,
        lastJobAt: null,
      }), "utf-8");
      await new Promise((resolve) => setTimeout(resolve, 5));

      await supervisor.checkWorkerHealth();
      await supervisor.waitForIdle();

      assert.deepEqual(stubbornWorker.signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(workerLaunches, 2);
      assert.equal(
        readSupervisorHealth(path.join(logDir, "supervisor-health.json"))
          ?.worker.record?.identity.pid,
        replacementWorker.pid,
      );
      assert.equal(
        readSupervisorEvents(logDir).some(
          (event) => event.event === "controlled_termination_escalated",
        ),
        true,
      );
    } finally {
      if (workerLaunches === 1) {
        const stopping = supervisor.stop("SIGTERM");
        queueMicrotask(() => stubbornWorker.emit("exit", null, "SIGKILL"));
        await stopping;
      } else {
        await supervisor.stop("SIGTERM");
      }
    }
  });

  it("does not escalate when identity mismatches after SIGTERM grace expires", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const worker = new StubbornFakeChild(9881, { autoExitOnKill: false });
    let validateCalls = 0;
    const probe: ProcessIdentityProbe = {
      capture: async (pid, expected) => ({
        pid,
        ppid: expected?.ppid ?? process.pid,
        pgid: pid,
        nonce: `controlled-mismatch-${pid}`,
        processStartTime: fakeProcessStartTime(pid),
        cwd: expected?.cwd ?? fs.realpathSync(tempDir),
        command: ["test-child", String(pid)],
      }),
      validate: async (expected) => {
        if (expected.pid !== worker.pid) return { ok: true, observed: expected };
        validateCalls += 1;
        return validateCalls < 3
          ? { ok: true, observed: expected }
          : { ok: false, reason: "command_mismatch" };
      },
    };
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: () => new FakeChild(9880),
      workerIdentityFactory: () => ({
        workerId: "controlled-mismatch-worker",
        instanceNonce: "controlled-mismatch-instance",
      }),
      workerChildFactory: () => worker,
      superviseWorker: true,
      healthCheck: async () => true,
      processIdentityProbe: probe,
      processGroupSignaler: (pgid, signal) => fakeChildrenByPid.get(pgid)?.kill(signal),
      workerStaleAfterMs: 1,
      workerMonitorIntervalMs: 60_000,
      terminationGraceMs: 1,
    });

    try {
      await supervisor.start();
      const startedAt = readSupervisorHealth(
        path.join(logDir, "supervisor-health.json"),
      )?.worker.record?.startedAt;
      fs.writeFileSync(heartbeatFile, JSON.stringify({
        pid: worker.pid,
        workerId: "controlled-mismatch-worker",
        workerNonce: "controlled-mismatch-instance",
        instanceNonce: "controlled-mismatch-instance",
        observedAt: startedAt,
        health: "healthy",
        fatalKind: null,
        currentJob: null,
        lastJobAt: null,
      }), "utf-8");
      await new Promise((resolve) => setTimeout(resolve, 5));

      await supervisor.checkWorkerHealth();

      assert.deepEqual(worker.signals, ["SIGTERM"]);
      assert.equal(validateCalls, 3);
      assert.equal(
        readSupervisorHealth(path.join(logDir, "supervisor-health.json"))?.worker.error?.code,
        "supervisor_unmanaged_process",
      );
    } finally {
      await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
    }
  });

  it("reconciles ESRCH signal delivery through worker exit and restart", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const firstWorker = new FakeChild(9883, { autoExitOnKill: false });
    const replacementWorker = new FakeChild(9884);
    const workers = [firstWorker, replacementWorker];
    let workerLaunches = 0;
    let clockMs = Date.parse("2026-07-10T10:00:00.000Z");
    const delivered: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: () => new FakeChild(9882),
      workerIdentityFactory: () => ({
        workerId: `esrch-worker-${workerLaunches + 1}`,
        instanceNonce: `esrch-instance-${workerLaunches + 1}`,
      }),
      workerChildFactory: () => workers[workerLaunches++],
      superviseWorker: true,
      healthCheck: async () => true,
      sleep: async () => {},
      processGroupSignaler: (pgid, signal) => {
        delivered.push({ pgid, signal });
        if (pgid === firstWorker.pid) {
          queueMicrotask(() => firstWorker.emit("exit", null, signal));
          const error = new Error("process group already exited") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        fakeChildrenByPid.get(pgid)?.kill(signal);
      },
      workerStaleAfterMs: 1,
      workerMonitorIntervalMs: 60_000,
      terminationGraceMs: 10,
      now: () => new Date(clockMs),
    } as DevSupervisorOptions);

    try {
      await supervisor.start();
      const startedAt = readSupervisorHealth(
        path.join(logDir, "supervisor-health.json"),
      )?.worker.record?.startedAt;
      fs.writeFileSync(heartbeatFile, JSON.stringify({
        pid: firstWorker.pid,
        workerId: "esrch-worker-1",
        workerNonce: "esrch-instance-1",
        instanceNonce: "esrch-instance-1",
        observedAt: startedAt,
        health: "healthy",
        fatalKind: null,
        currentJob: null,
        lastJobAt: null,
      }), "utf-8");
      clockMs += 5_000;

      await supervisor.checkWorkerHealth();
      await supervisor.waitForIdle();

      assert.deepEqual(delivered, [{ pgid: firstWorker.pid, signal: "SIGTERM" }]);
      assert.equal(workerLaunches, 2);
      assert.equal(
        readSupervisorHealth(path.join(logDir, "supervisor-health.json"))
          ?.worker.record?.identity.pid,
        replacementWorker.pid,
      );
      assert.equal(replacementWorker.killedSignal, null);
    } finally {
      await supervisor.stop("SIGTERM");
    }
  });

  it("records EPERM signal delivery and fails closed without escalation", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const worker = new StubbornFakeChild(9886, { autoExitOnKill: false });
    let signalCalls = 0;
    let clockMs = Date.parse("2026-07-10T10:10:00.000Z");
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: () => new FakeChild(9885),
      workerIdentityFactory: () => ({
        workerId: "eperm-worker",
        instanceNonce: "eperm-instance",
      }),
      workerChildFactory: () => worker,
      superviseWorker: true,
      healthCheck: async () => true,
      processGroupSignaler: () => {
        signalCalls += 1;
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
      workerStaleAfterMs: 1,
      workerMonitorIntervalMs: 60_000,
      terminationGraceMs: 1,
      now: () => new Date(clockMs),
    } as DevSupervisorOptions);

    try {
      await supervisor.start();
      const startedAt = readSupervisorHealth(
        path.join(logDir, "supervisor-health.json"),
      )?.worker.record?.startedAt;
      fs.writeFileSync(heartbeatFile, JSON.stringify({
        pid: worker.pid,
        workerId: "eperm-worker",
        workerNonce: "eperm-instance",
        instanceNonce: "eperm-instance",
        observedAt: startedAt,
        health: "healthy",
        fatalKind: null,
        currentJob: null,
        lastJobAt: null,
      }), "utf-8");
      clockMs += 5_000;

      await supervisor.checkWorkerHealth();

      assert.equal(signalCalls, 1);
      assert.deepEqual(worker.signals, []);
      assert.equal(
        readSupervisorHealth(path.join(logDir, "supervisor-health.json"))?.worker.error?.code,
        "supervisor_unmanaged_process",
      );
    } finally {
      await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
    }
  });

  it("catches monitor scheduler rejection and keeps concurrent ticks mutually exclusive", async () => {
    const logDir = path.join(tempDir, "logs");
    const worker = new FakeChild(9888);
    let scheduledTick: (() => Promise<void>) | null = null;
    let validateCalls = 0;
    let rejectValidation!: (error: Error) => void;
    let monitorSettled = false;
    const validationPending = new Promise<never>((_resolve, reject) => {
      rejectValidation = reject;
    });
    const probe: ProcessIdentityProbe = {
      capture: async (pid, expected) => ({
        pid,
        ppid: expected?.ppid ?? process.pid,
        pgid: pid,
        nonce: `monitor-${pid}`,
        processStartTime: fakeProcessStartTime(pid),
        cwd: expected?.cwd ?? fs.realpathSync(tempDir),
        command: ["test-child", String(pid)],
      }),
      validate: async (expected) => {
        if (expected.pid !== worker.pid || monitorSettled) {
          return { ok: true, observed: expected };
        }
        validateCalls += 1;
        return validationPending;
      },
    };
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => new FakeChild(9887),
      workerChildFactory: () => worker,
      superviseWorker: true,
      healthCheck: async () => true,
      processIdentityProbe: probe,
      processGroupSignaler: (pgid, signal) => fakeChildrenByPid.get(pgid)?.kill(signal),
      workerMonitorScheduler: (tick) => {
        scheduledTick = tick;
        return () => {};
      },
    });

    try {
      await supervisor.start();
      const firstTick = scheduledTick!();
      const overlappingTick = scheduledTick!();
      assert.equal(validateCalls, 1);
      monitorSettled = true;
      rejectValidation(new Error("monitor probe failed"));

      await Promise.all([firstTick, overlappingTick]);

      assert.equal(validateCalls, 1);
      assert.equal(
        readSupervisorHealth(path.join(logDir, "supervisor-health.json"))?.worker.error?.code,
        "worker_monitor_failed",
      );
    } finally {
      await supervisor.stop("SIGTERM");
    }
  });

  it("forwards SIGINT and SIGHUP before escalating only to SIGKILL", async () => {
    for (const requestedSignal of ["SIGINT", "SIGHUP"] as const) {
      const logDir = path.join(tempDir, requestedSignal);
      const next = new StubbornFakeChild(requestedSignal === "SIGINT" ? 9892 : 9894);
      const worker = new StubbornFakeChild(requestedSignal === "SIGINT" ? 9893 : 9895);
      const supervisor = createTestSupervisor({
        cwd: tempDir,
        logDir,
        childFactory: () => next,
        workerChildFactory: () => worker,
        superviseWorker: true,
        healthCheck: async () => true,
        terminationGraceMs: 1,
      } as DevSupervisorOptions);

      await supervisor.start();
      await supervisor.stop(requestedSignal);

      assert.deepEqual(next.signals, [requestedSignal, "SIGKILL"]);
      assert.deepEqual(worker.signals, [requestedSignal, "SIGKILL"]);
    }
  });

  it("shares one in-flight termination across stale monitor and concurrent stop signals", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const next = new StubbornFakeChild(9896);
    const worker = new StubbornFakeChild(9897);
    let clockMs = Date.parse("2026-07-10T10:20:00.000Z");
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: () => next,
      workerIdentityFactory: () => ({
        workerId: "shared-termination-worker",
        instanceNonce: "shared-termination-instance",
      }),
      workerChildFactory: () => worker,
      superviseWorker: true,
      healthCheck: async () => true,
      now: () => new Date(clockMs),
      workerStaleAfterMs: 1,
      workerMonitorIntervalMs: 60_000,
      terminationGraceMs: 20,
    } as DevSupervisorOptions);

    await supervisor.start();
    const startedAt = readSupervisorHealth(
      path.join(logDir, "supervisor-health.json"),
    )?.worker.record?.startedAt;
    fs.writeFileSync(heartbeatFile, JSON.stringify({
      pid: worker.pid,
      workerId: "shared-termination-worker",
      workerNonce: "shared-termination-instance",
      instanceNonce: "shared-termination-instance",
      observedAt: startedAt,
      health: "healthy",
      fatalKind: null,
      currentJob: null,
      lastJobAt: null,
    }), "utf-8");
    clockMs += 5_000;

    const staleTermination = supervisor.checkWorkerHealth();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(worker.signals, ["SIGTERM"]);

    await Promise.all([
      staleTermination,
      supervisor.stop("SIGINT"),
      supervisor.stop("SIGHUP"),
    ]);

    assert.deepEqual(worker.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(next.signals, ["SIGINT", "SIGKILL"]);
  });

  it("waits for child log streams to flush before stop resolves", async () => {
    let flushed = false;
    const delayedLog = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        setTimeout(() => {
          flushed = true;
          callback();
        }, 25);
      },
    });
    const next = new FakeChild(9898);
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir: path.join(tempDir, "flush-logs"),
      childFactory: () => next,
      healthCheck: async () => true,
      logStreamFactory: () => delayedLog,
    } as DevSupervisorOptions);

    await supervisor.start();
    next.stdout.write("last child line\n");
    await supervisor.stop("SIGTERM");

    assert.equal(flushed, true);
  });

  it("fails shutdown when a child log stream cannot flush", async () => {
    const flushError = new Error("child log flush failed");
    const failingLog = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback(flushError);
      },
    });
    const logDir = path.join(tempDir, "failed-flush");
    const next = new FakeChild(9908);
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => next,
      healthCheck: async () => true,
      logStreamFactory: () => failingLog,
    } as DevSupervisorOptions);

    await supervisor.start();
    await assert.rejects(supervisor.stop("SIGTERM"), /child log flush failed/);

    assert.equal(
      readSupervisorHealth(path.join(logDir, "supervisor-health.json"))?.next.error?.code,
      "supervisor_log_flush_failed",
    );
    assert.equal(
      readSupervisorEvents(logDir).some((event) => event.event === "supervisor_log_flush_failed"),
      true,
    );
  });

  it("uses exitCode instead of forcing process exit before shutdown flushes", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "dev-supervisor.ts"),
      "utf-8",
    );

    assert.doesNotMatch(source, /process\.exit\s*\(/);
    assert.match(source, /process\.exitCode\s*=/);
  });

  it("does not launch a worker after stop completes during the Next health wait", async () => {
    const healthEntered = deferred<void>();
    const releaseHealth = deferred<boolean>();
    const next = new FakeChild(9899);
    const workers: FakeChild[] = [];
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir: path.join(tempDir, "start-stop-race"),
      childFactory: () => next,
      workerChildFactory: () => {
        const worker = new FakeChild(9909 + workers.length);
        workers.push(worker);
        return worker;
      },
      superviseWorker: true,
      healthCheck: async () => {
        healthEntered.resolve(undefined);
        return releaseHealth.promise;
      },
      healthTimeoutMs: 5_000,
      healthPollIntervalMs: 1,
    } as DevSupervisorOptions);

    const starting = supervisor.start();
    await healthEntered.promise;
    await supervisor.stop("SIGTERM");
    releaseHealth.resolve(true);
    await starting;

    assert.equal(workers.length, 0);
  });

  it("fails stop closed when it arrives before Next identity capture completes", async () => {
    const captureEntered = deferred<void>();
    const releaseCapture = deferred<void>();
    const next = new FakeChild(9910, { autoExitOnKill: false });
    let signalCalls = 0;
    let workerLaunches = 0;
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir: path.join(tempDir, "capture-stop-race"),
      childFactory: () => next,
      workerChildFactory: () => {
        workerLaunches += 1;
        return new FakeChild(9911);
      },
      superviseWorker: true,
      healthCheck: async () => true,
      processIdentityProbe: {
        capture: async (pid, expected) => {
          captureEntered.resolve(undefined);
          await releaseCapture.promise;
          return {
            pid,
            ppid: expected?.ppid ?? process.pid,
            pgid: pid,
            nonce: `capture-race-${pid}`,
            processStartTime: fakeProcessStartTime(pid),
            cwd: expected?.cwd ?? fs.realpathSync(tempDir),
            command: ["test-child", String(pid)],
          };
        },
        validate: async (expected) => ({ ok: true, observed: expected }),
      },
      processGroupSignaler: () => {
        signalCalls += 1;
      },
    });

    const starting = supervisor.start();
    await captureEntered.promise;
    const stopping = supervisor.stop("SIGTERM");
    releaseCapture.resolve(undefined);

    await assert.rejects(stopping, /manual process cleanup required/i);
    await assert.rejects(starting, /manual process cleanup required/i);
    assert.equal(signalCalls, 0);
    assert.equal(next.killedSignal, null);
    assert.equal(workerLaunches, 0);
  });

  it("graceful shutdown waits for child exits and disposes the worker monitor", async () => {
    const logDir = path.join(tempDir, "logs");
    const next = new FakeChild(9890);
    const worker = new FakeChild(9891);
    let monitorScheduled = false;
    let monitorDisposed = false;
    const supervisor = createTestSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => next,
      workerChildFactory: () => worker,
      superviseWorker: true,
      healthCheck: async () => true,
      workerMonitorScheduler: () => {
        monitorScheduled = true;
        return () => {
          monitorDisposed = true;
        };
      },
    } as DevSupervisorOptions);

    await supervisor.start();
    assert.equal(monitorScheduled, true);

    await supervisor.stop("SIGTERM");

    assert.equal(next.killedSignal, "SIGTERM");
    assert.equal(worker.killedSignal, "SIGTERM");
    assert.equal(monitorDisposed, true);
  });

  it("restarts after expected capture failure only with constrained quarantine identity", async () => {
    const logDir = path.join(tempDir, "logs");
    const children: FakeChild[] = [];
    let captureCalls = 0;
    let quarantineExpected: Partial<ProcessIdentity> | undefined;
    const probe: ProcessIdentityProbe = {
      capture: async (pid, expected) => {
        captureCalls += 1;
        if (captureCalls === 1) throw new Error("expected cwd mismatch");
        if (captureCalls === 2) {
          quarantineExpected = expected;
        }
        return {
          pid,
          ppid: process.pid,
          pgid: pid,
          nonce: `quarantine-${pid}`,
          processStartTime: fakeProcessStartTime(pid),
          cwd: fs.realpathSync(tempDir),
          command: ["test-child", String(pid)],
        };
      },
      validate: async (expected) => ({ ok: true, observed: expected }),
    };
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => {
        const child = new FakeChild(9900 + children.length);
        children.push(child);
        return child;
      },
      processIdentityProbe: probe,
      processGroupSignaler: (pgid, signal) => fakeChildrenByPid.get(pgid)?.kill(signal),
      healthCheck: async () => true,
      sleep: async () => {},
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
    });

    try {
      await supervisor.start();
      await new Promise((resolve) => setImmediate(resolve));
      await supervisor.waitForIdle();

      assert.equal(children[0].killedSignal, "SIGTERM");
      assert.equal(children.length, 2);
      assert.equal(captureCalls, 3);
      assert.deepEqual(quarantineExpected, {
        ppid: process.pid,
        pgid: 9900,
        cwd: fs.realpathSync(tempDir),
      });
      const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
      assert.equal(health?.next.record?.identity.pid, 9901);
      assert.equal("pid" in JSON.parse(fs.readFileSync(path.join(logDir, "supervisor-health.json"), "utf-8")).next, false);
    } finally {
      await supervisor.stop("SIGTERM");
    }
  });

  it("does not signal when quarantine capture also fails", async () => {
    const logDir = path.join(tempDir, "logs");
    const child = new FakeChild(9920, { autoExitOnKill: false });
    let captureCalls = 0;
    let childLaunches = 0;
    let quarantineExpected: Partial<ProcessIdentity> | undefined;
    let signalCalls = 0;
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => {
        childLaunches += 1;
        return child;
      },
      processIdentityProbe: {
        capture: async (pid, expected) => {
          captureCalls += 1;
          if (captureCalls === 2) {
            quarantineExpected = expected;
          }
          throw new Error(captureCalls === 1 ? "expected capture failed" : "quarantine capture failed");
        },
        validate: async (expected) => ({ ok: true, observed: expected }),
      },
      processGroupSignaler: () => {
        signalCalls += 1;
      },
      healthCheck: async () => true,
    });

    await assert.rejects(
      supervisor.start(),
      (error: unknown) => Boolean(
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "supervisor_unmanaged_process"
      ),
    );

    const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
    const events = readSupervisorEvents(logDir);
    assert.equal(captureCalls, 2);
    assert.equal(childLaunches, 1);
    assert.deepEqual(quarantineExpected, {
      ppid: process.pid,
      pgid: 9920,
      cwd: fs.realpathSync(tempDir),
    });
    assert.equal(signalCalls, 0);
    assert.equal(child.killedSignal, null);
    assert.equal(health?.next.record, null);
    assert.equal(health?.next.error?.code, "supervisor_unmanaged_process");
    assert.equal(events.some((event) => event.event === "dev_server_started"), false);
    assert.equal(events.some((event) => event.event === "dev_server_restarting"), false);
    await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
    assert.equal(signalCalls, 0);
  });

  it("does not signal when quarantine identity validation mismatches", async () => {
    const logDir = path.join(tempDir, "logs");
    const child = new FakeChild(9930, { autoExitOnKill: false });
    let captureCalls = 0;
    let validateCalls = 0;
    let signalCalls = 0;
    let quarantineExpected: Partial<ProcessIdentity> | undefined;
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => child,
      processIdentityProbe: {
        capture: async (pid, expected) => {
          captureCalls += 1;
          if (captureCalls === 1) throw new Error("expected capture failed");
          quarantineExpected = expected;
          return {
            pid,
            ppid: process.pid,
            pgid: pid,
            nonce: `quarantine-${pid}`,
            processStartTime: fakeProcessStartTime(pid),
            cwd: fs.realpathSync(tempDir),
            command: ["test-child", String(pid)],
          };
        },
        validate: async () => {
          validateCalls += 1;
          return { ok: false, reason: "command_mismatch" };
        },
      },
      processGroupSignaler: () => {
        signalCalls += 1;
      },
      healthCheck: async () => true,
    });

    await assert.rejects(
      supervisor.start(),
      (error: unknown) => Boolean(
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "supervisor_unmanaged_process"
      ),
    );

    const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
    assert.equal(captureCalls, 2);
    assert.equal(validateCalls, 1);
    assert.deepEqual(quarantineExpected, {
      ppid: process.pid,
      pgid: 9930,
      cwd: fs.realpathSync(tempDir),
    });
    assert.equal(signalCalls, 0);
    assert.equal(child.killedSignal, null);
    assert.equal(health?.next.record, null);
    assert.equal(health?.next.error?.code, "supervisor_unmanaged_process");
    await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
    assert.equal(signalCalls, 0);
  });

  it("treats a captured child outside its own process group as unmanaged", async () => {
    const logDir = path.join(tempDir, "unsafe-pgid");
    const child = new FakeChild(9940, { autoExitOnKill: false });
    let signalCalls = 0;
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => child,
      processIdentityProbe: {
        capture: async (pid) => ({
          pid,
          ppid: process.pid,
          pgid: pid + 1,
          nonce: `unsafe-group-${pid}`,
          processStartTime: fakeProcessStartTime(pid),
          cwd: fs.realpathSync(tempDir),
          command: ["test-child", String(pid)],
        }),
        validate: async (expected) => ({ ok: true, observed: expected }),
      },
      processGroupSignaler: () => {
        signalCalls += 1;
      },
      healthCheck: async () => true,
    });

    await assert.rejects(supervisor.start(), /manual process cleanup required/i);
    assert.equal(signalCalls, 0);
    assert.equal(child.killedSignal, null);
    assert.equal(
      readSupervisorHealth(path.join(logDir, "supervisor-health.json"))?.next.error?.code,
      "supervisor_unmanaged_process",
    );
    await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
  });

  it("captures a real detached child identity and stops its complete process group", async () => {
    const logDir = path.join(tempDir, "logs");
    const portFile = path.join(tempDir, "next-port.txt");
    let launched: ChildProcess | null = null;
    let grandchildPid: number | null = null;
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => {
        launched = spawn(process.execPath, [
          "-e",
          [
            "const { spawn } = require('node:child_process')",
            "const fs = require('node:fs')",
            "const http = require('node:http')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            `http.createServer((_request, response) => response.end('ok')).listen(0, '127.0.0.1', function () { fs.writeFileSync(${JSON.stringify(portFile)}, String(this.address().port)); process.stdout.write(String(child.pid) + '\\n') })`,
          ].join(";"),
        ], {
          cwd: tempDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        launched.stdout?.once("data", (chunk) => {
          grandchildPid = Number(String(chunk).trim());
        });
        return launched;
      },
      healthCheck: async () => {
        if (!fs.existsSync(portFile)) return false;
        const response = await fetch(`http://127.0.0.1:${fs.readFileSync(portFile, "utf-8")}`);
        return response.ok;
      },
      healthPollIntervalMs: 10,
      healthTimeoutMs: 2_000,
    });

    try {
      await supervisor.start();
      await waitUntil(() => grandchildPid !== null);
      const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
      const record = health?.next.record;
      assert.equal(record?.identity.pid, launched?.pid);
      assert.equal(record?.identity.pgid, launched?.pid);
      assert.equal(record?.identity.cwd, fs.realpathSync(tempDir));
      assert.equal(record?.role, "next");
      assert.equal(health?.next.portListening, true);

      await supervisor.stop("SIGTERM");
      await waitUntil(() => !isProcessAlive(launched!.pid!) && !isProcessAlive(grandchildPid!));
    } finally {
      await supervisor.stop("SIGTERM");
      killOwnedProcessGroup(launched);
    }
  });

  it("refuses to signal a real process when complete identity validation mismatches", async () => {
    const logDir = path.join(tempDir, "logs");
    let launched: ChildProcess | null = null;
    const platformProbe = createPlatformProcessIdentityProbe();
    let rejectValidation = false;
    const mismatchProbe: ProcessIdentityProbe = {
      capture: (pid, expected) => platformProbe.capture(pid, expected),
      validate: (expected) => rejectValidation
        ? Promise.resolve({ ok: false, reason: "command_mismatch" })
        : platformProbe.validate(expected),
    };
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      childFactory: () => {
        launched = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          cwd: tempDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return launched;
      },
      healthCheck: async () => true,
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
      processIdentityProbe: mismatchProbe,
    } as Parameters<typeof createSupervisor>[0]);

    try {
      await supervisor.start();
      rejectValidation = true;
      await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);

      assert.equal(isProcessAlive(launched!.pid!), true);
      const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
      assert.equal(health?.next.error?.code, "supervisor_unmanaged_process");
      assert.equal(
        readSupervisorEvents(logDir).some(
          (event) => event.error === "process_identity_mismatch",
        ),
        true,
      );
    } finally {
      await assert.rejects(supervisor.stop("SIGTERM"), /manual process cleanup required/i);
      killOwnedProcessGroup(launched);
    }
  });

  it("restarts an identity-valid worker with a stale heartbeat using a new process and nonce", async () => {
    const logDir = path.join(tempDir, "logs");
    const heartbeatFile = path.join(logDir, "worker-heartbeat.json");
    const launched: ChildProcess[] = [];
    const workerChildren: ChildProcess[] = [];
    const decisions: SupervisorDecisionEvent[] = [];
    const firstHeartbeatReady = deferred<void>();
    const firstHeartbeatWriterStopped = deferred<void>();
    const firstSigtermSeen = deferred<void>();
    const firstWorkerExited = deferred<void>();
    const secondHeartbeatReady = deferred<void>();
    let workerLaunches = 0;
    let supervisorNowMs: number | null = null;
    const spawnSleeper = (): ChildProcess => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: tempDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      launched.push(child);
      return child;
    };
    const supervisor = createSupervisor({
      cwd: tempDir,
      logDir,
      workerHeartbeatFilePath: heartbeatFile,
      childFactory: spawnSleeper,
      workerIdentityFactory: () => {
        workerLaunches += 1;
        return {
          workerId: `worker-${workerLaunches}`,
          instanceNonce: `worker-nonce-${workerLaunches}`,
        };
      },
      workerChildFactory: (identity) => {
        const isFirstWorker = workerLaunches === 1;
        const script = [
          "const fs = require('node:fs')",
          `fs.mkdirSync(${JSON.stringify(logDir)}, { recursive: true })`,
          ...(isFirstWorker
            ? [
              `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(path.join(tempDir, "first-worker-sigterm.txt"))}, 'seen'); process.stdout.write('sigterm-seen\\n') })`,
              "process.on('message', (message) => { if (message === 'stop-heartbeat') { clearInterval(heartbeatTimer); process.stdout.write('heartbeat-writer-stopped\\n') } })",
            ]
            : []),
          `const heartbeatFile = ${JSON.stringify(heartbeatFile)}`,
          `const heartbeat = { pid: process.pid, workerId: '${identity.workerId}', workerNonce: '${identity.instanceNonce}', instanceNonce: '${identity.instanceNonce}', observedAt: '', health: 'healthy', fatalKind: null, currentJob: null, lastJobAt: null }`,
          "let announced = false",
          "const writeHeartbeat = () => { heartbeat.observedAt = new Date().toISOString(); const temporary = heartbeatFile + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(heartbeat)); fs.renameSync(temporary, heartbeatFile); if (!announced) { announced = true; process.stdout.write('heartbeat-ready\\n') } }",
          "writeHeartbeat()",
          "const heartbeatTimer = setInterval(writeHeartbeat, 20)",
          "setInterval(() => {}, 1000)",
        ].join(";");
        const child = spawn(process.execPath, ["-e", script], {
          cwd: tempDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        launched.push(child);
        workerChildren.push(child);
        child.stdout?.on("data", (chunk) => {
          const output = String(chunk);
          if (output.includes("heartbeat-ready")) {
            if (isFirstWorker) firstHeartbeatReady.resolve(undefined);
            else secondHeartbeatReady.resolve(undefined);
          }
          if (output.includes("heartbeat-writer-stopped")) {
            firstHeartbeatWriterStopped.resolve(undefined);
          }
          if (output.includes("sigterm-seen")) firstSigtermSeen.resolve(undefined);
        });
        if (isFirstWorker) {
          child.once("exit", () => firstWorkerExited.resolve(undefined));
        }
        return child;
      },
      superviseWorker: true,
      healthCheck: async () => true,
      sleep: async () => {},
      healthPollIntervalMs: 1,
      healthTimeoutMs: 1,
      workerStaleAfterMs: 80,
      workerMonitorIntervalMs: 60_000,
      terminationGraceMs: 80,
      decisionCollector: (decision) => decisions.push(decision),
      now: () => new Date(supervisorNowMs ?? Date.now()),
    });

    try {
      await supervisor.start();
      await firstHeartbeatReady.promise;
      workerChildren[0].send?.("stop-heartbeat");
      await awaitDecisionLatch(
        firstHeartbeatWriterStopped.promise,
        decisions,
        "first heartbeat writer stop",
      );
      const firstHeartbeat = readWorkerHeartbeat(heartbeatFile);
      const oldIdentity = readSupervisorHealth(
        path.join(logDir, "supervisor-health.json"),
      )?.worker.record?.identity;
      supervisorNowMs = Date.parse(firstHeartbeat!.observedAt) + 81;
      const nextStartTimeBoundary = Date.parse(oldIdentity!.processStartTime) + 1_020;
      if (Date.now() < nextStartTimeBoundary) {
        await new Promise((resolve) => setTimeout(resolve, nextStartTimeBoundary - Date.now()));
      }
      await supervisor.checkWorkerHealth();
      await awaitDecisionLatch(firstSigtermSeen.promise, decisions, "first SIGTERM");
      await firstWorkerExited.promise;
      await secondHeartbeatReady.promise;
      await supervisor.waitForIdle();
      supervisorNowMs = null;
      await supervisor.checkWorkerHealth();

      const health = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
      assert.equal(workerChildren.length, 2);
      assert.equal(health?.worker.restartCount, 1);
      assert.equal(health?.worker.record?.identity.pid, workerChildren[1].pid);
      assert.equal(health?.worker.heartbeat?.workerNonce, "worker-nonce-2");
      assert.equal(health?.worker.heartbeat?.instanceNonce, "worker-nonce-2");
      assert.equal(oldIdentity?.pid, workerChildren[0].pid);
      assert.notEqual(workerChildren[0].pid, workerChildren[1].pid);
      assert.notEqual(oldIdentity?.nonce, health?.worker.record?.identity.nonce);
      assert.notEqual(
        oldIdentity?.processStartTime,
        health?.worker.record?.identity.processStartTime,
      );
      assert.equal(fs.existsSync(path.join(tempDir, "first-worker-sigterm.txt")), true);
      assert.equal(isProcessAlive(workerChildren[0].pid!), false);
      assert.equal(
        readSupervisorEvents(logDir).some((event) => event.event === "pipeline_worker_stale"),
        true,
      );
      assert.equal(
        readSupervisorEvents(logDir).some(
          (event) => event.event === "controlled_termination_escalated"
            && event.pid === workerChildren[0].pid,
        ),
        true,
      );
    } finally {
      await supervisor.stop("SIGTERM");
      for (const child of launched) killOwnedProcessGroup(child);
    }
  });

  it("the real pipeline worker atomically publishes immediate and periodic process heartbeats", async () => {
    const repoRoot = process.cwd();
    const tempDbDir = path.join(tempDir, "server", "db");
    const heartbeatFile = path.join(tempDir, "logs", "worker-heartbeat.json");
    fs.mkdirSync(tempDbDir, { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "server", "db", "migrations"),
      path.join(tempDbDir, "migrations"),
      "dir",
    );
    const worker = spawn(process.execPath, [
      "--import",
      path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      path.join(repoRoot, "scripts", "pipeline-worker.ts"),
    ], {
      cwd: tempDir,
      detached: true,
      env: {
        ...process.env,
        PIPELINE_WORKER_HEARTBEAT_FILE: heartbeatFile,
        PIPELINE_WORKER_PROCESS_HEARTBEAT_MS: "30",
        PIPELINE_WORKER_ID: "pipeline-worker-real-test",
        PIPELINE_WORKER_INSTANCE_NONCE: "pipeline-worker-instance-real-test",
        STAGEPASS_DB_BOOTSTRAPPED: "1",
      },
      stdio: "ignore",
    });

    try {
      await waitUntil(() => readWorkerHeartbeat(heartbeatFile) !== null, 4_000);
      const first = readWorkerHeartbeat(heartbeatFile);
      assert.equal(first?.pid, worker.pid);
      assert.match(first?.workerId ?? "", /^pipeline-worker-/);
      assert.ok((first?.workerNonce.length ?? 0) >= 16);
      assert.equal(first?.currentJob, null);
      assert.equal(first?.lastJobAt, null);

      await waitUntil(
        () => readWorkerHeartbeat(heartbeatFile)?.observedAt !== first?.observedAt,
        2_000,
      );
      assert.deepEqual(
        fs.readdirSync(path.dirname(heartbeatFile)).filter((name) => name.includes(".tmp")),
        [],
      );
    } finally {
      killOwnedProcessGroup(worker);
      await waitUntil(() => !isProcessAlive(worker.pid!));
    }
  });

  it("exits nonzero and stops healthy heartbeat after uncaughtException", async () => {
    await assertRealWorkerFatalExit(tempDir, "uncaughtException");
  });

  it("exits nonzero and stops healthy heartbeat after unhandledRejection", async () => {
    await assertRealWorkerFatalExit(tempDir, "unhandledRejection");
  });

  it("still shuts down the active provider when the fatal heartbeat write throws", async () => {
    await assertRealWorkerFatalExit(tempDir, "uncaughtException", "heartbeat");
  });

  it("still shuts down the active provider when the fatal log append throws", async () => {
    await assertRealWorkerFatalExit(tempDir, "unhandledRejection", "log");
  });
});
