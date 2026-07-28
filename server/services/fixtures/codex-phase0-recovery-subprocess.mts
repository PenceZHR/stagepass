import fs from "node:fs/promises";

import type { CodexAppServerShellControl } from "../codex-app-server-shell-control";
import {
  createCodexDesktopBridge,
} from "../codex-desktop-bridge";
import {
  REQUIRED_APP_SERVER_SHELL_CAPABILITIES,
  REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
  type CodexDesktopTurnRequest,
  type CodexFollowerStartFence,
  type CodexTurnSnapshot,
} from "../codex-desktop-bridge-types";
import type {
  CodexDesktopFollowerTransport,
} from "../codex-desktop-ipc-transport";
import {
  createCodexPhase0SqliteJournal,
  type CodexPhase0JournalFailpoint,
} from "../codex-phase0-sqlite-journal";

type Scenario =
  | "after_prepare"
  | "after_no_client_found"
  | "after_dispatch_cas_before_send"
  | "unknown_response"
  | "success_before_cas";

interface FixtureConfig {
  action: "crash" | "recover";
  scenario: Scenario;
  databasePath: string;
  statePath: string;
  candidatePath: string;
  dispatchLogPath: string;
  candidateCount: 0 | 1 | 2;
}

interface FixtureState {
  logicalTurnId: string;
  attemptId: string;
  fence: CodexFollowerStartFence;
}

const configPath = process.argv[2];
if (!configPath) throw new Error("fixture config path is required");
const config = JSON.parse(
  await fs.readFile(configPath, "utf8"),
) as FixtureConfig;

async function readCandidates(): Promise<CodexTurnSnapshot[]> {
  try {
    return JSON.parse(
      await fs.readFile(config.candidatePath, "utf8"),
    ) as CodexTurnSnapshot[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeCandidates(request: CodexDesktopTurnRequest): Promise<void> {
  const turns = Array.from({ length: config.candidateCount }, (_, index) => ({
    threadId: request.threadId,
    turnId: `TURN-CANDIDATE-${index + 1}`,
    status: "completed" as const,
    items: [
      {
        id: `USER-${index + 1}`,
        kind: "user_message" as const,
        semantic: { text: request.prompt },
      },
      {
        id: `AGENT-${index + 1}`,
        kind: "agent_message" as const,
        semantic: { text: "done" },
      },
    ],
    terminal: { output: "done" },
    metadata: {
      startedAt: "2026-07-23T12:00:00.000Z",
      completedAt: "2026-07-23T12:00:01.000Z",
      durationMs: 1_000,
      observedAt: "2026-07-23T12:00:02.000Z",
    },
  }));
  await fs.writeFile(config.candidatePath, JSON.stringify(turns));
}

const shellControl: CodexAppServerShellControl = {
  async probe() {
    return {
      version: "subprocess-fixture",
      protocolFingerprint: "subprocess-fixture",
      capabilities: ["model/list", "thread/list"],
      protocolCapabilities: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
    };
  },
  async startPersistentThread() {
    throw new Error("shell provision is outside this fixture");
  },
  async startPersistentThreadAndName() {
    throw new Error("shell provision is outside this fixture");
  },
  async setThreadName() {
    throw new Error("shell naming is outside this fixture");
  },
  async findPersistentShell() {
    return [];
  },
  async listPersistentShells() {
    return [];
  },
  // This fixture never delegates, so no sub-agent thread can exist for it to
  // find. Empty is the truth here rather than a stub.
  async listSubAgentThreads() {
    return [];
  },
  async readPersistentShell() {
    return null;
  },
  async readThreadWithTurns(input) {
    return {
      shell: {
        threadId: input.threadId,
        title: "[PHASE0] recovery",
        cwd: "/phase0",
        ephemeral: false,
      },
      turns: await readCandidates(),
    };
  },
  async listModels() {
    return [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }];
  },
};

const follower: CodexDesktopFollowerTransport = {
  async probe() {
    return {
      clientVersion: "subprocess-fixture",
      protocolFingerprint: "subprocess-fixture",
      capabilities: ["desktop-initialized"],
      protocolCapabilities: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
    };
  },
  async openThreadDeepLink() {},
  async startFollowerTurn(request) {
    await fs.appendFile(config.dispatchLogPath, `${config.action}\n`);
    if (config.scenario === "after_no_client_found" && config.action === "crash") {
      return { status: "no-client-found" as const };
    }
    if (
      config.scenario === "unknown_response"
      || config.scenario === "success_before_cas"
      || config.action === "recover"
    ) {
      await writeCandidates(request);
    }
    if (config.scenario === "unknown_response" && config.action === "crash") {
      throw new Error("unknown follower response");
    }
    return { status: "started" as const, turnId: "TURN-CANDIDATE-1" };
  },
  async interruptTurn() {},
};

const journal = createCodexPhase0SqliteJournal({
  databasePath: config.databasePath,
  async readBaseline() {
    const turns = await readCandidates();
    return {
      turnIds: turns.map(({ turnId }) => turnId),
      semanticHash: JSON.stringify(turns),
    };
  },
});

const followerCheckpoint =
  config.scenario === "after_dispatch_cas_before_send"
  || config.scenario === "unknown_response"
  ? config.scenario
  : undefined;
const bridge = createCodexDesktopBridge({
  shellControl,
  follower,
  logicalTurnPort: journal.logicalTurnPort,
  startAttemptPort: journal.startAttemptPort,
  shellProvisionPort: journal.shellProvisionPort,
  readinessDeadlineMs: 100,
  sleep: async () => {},
  ...(followerCheckpoint && config.action === "crash"
    ? {
      followerStartFailpoint(checkpoint) {
        if (checkpoint !== followerCheckpoint) return;
        const error = new Error(`fixture crash: ${checkpoint}`);
        Object.assign(error, { phase0CrashCheckpoint: checkpoint });
        throw error;
      },
    }
    : {}),
});

try {
  if (config.action === "crash") {
    const seeded = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `OWNER-${config.scenario}`,
      projectId: "PROJECT-1",
      scopeKind: "project_context",
      scopeId: "PROJECT-1",
      phase: "Context",
      role: "context_select",
      round: 0,
      ordinal: 0,
      binding: {
        threadId: "THREAD-1",
        cwd: "/phase0",
        title: "[PHASE0] recovery",
      },
      request: {
        cwd: "/phase0",
        prompt: `recover ${config.scenario}`,
        model: "gpt-test",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 2_500).toISOString(),
    });
    const journalFailpoint: CodexPhase0JournalFailpoint | undefined =
      config.scenario === "after_prepare"
        ? "after_prepare"
        : config.scenario === "after_no_client_found"
          ? "after_no_client_found"
          : config.scenario === "success_before_cas"
            ? "before_success_cas"
            : undefined;
    journal.setFailpoint(journalFailpoint);
    await bridge.startTurn({ logicalTurnId: seeded.logicalTurnId })
      .catch(() => undefined);
    const attempt = await journal.inspectAttemptByLogicalTurn(
      seeded.logicalTurnId,
    );
    if (!attempt) throw new Error("crash checkpoint did not persist an attempt");
    const state: FixtureState = {
      logicalTurnId: seeded.logicalTurnId,
      attemptId: attempt.attemptId,
      fence: seeded.fence,
    };
    await fs.writeFile(config.statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({
      phase: "crash",
      attemptState: attempt.state,
      dispatchOrdinal: attempt.dispatchOrdinal,
    }));
  } else {
    const state = JSON.parse(
      await fs.readFile(config.statePath, "utf8"),
    ) as FixtureState;
    const recovered = await bridge.recoverTurn({
      logicalTurnId: state.logicalTurnId,
    });
    const attempt = await journal.inspectAttempt(state.attemptId);
    process.stdout.write(JSON.stringify({
      phase: "recover",
      recovered,
      attemptState: attempt?.state,
      dispatchOrdinal: attempt?.dispatchOrdinal,
    }));
  }
} finally {
  journal.close();
}
