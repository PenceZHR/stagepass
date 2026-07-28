import { randomUUID } from "node:crypto";
import path from "node:path";

import { createCodexAppServerShellControl } from "../server/services/codex-app-server-shell-control.ts";
import {
  codexTurnSetSemanticHash,
  createCodexDesktopBridge,
} from "../server/services/codex-desktop-bridge.ts";
import { createCodexPhase0SqliteJournal } from "../server/services/codex-phase0-sqlite-journal.ts";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
} from "../server/services/codex-desktop-ipc-discovery.ts";
import { createObservedCodexDesktopFollowerTransport } from "../server/services/codex-desktop-ipc-transport.ts";

const REGISTRATION_NAME =
  "stagepass-phase0-ff851360-1832-4800-808b-6318262e5ee3";

async function main(): Promise<void> {
  const root = process.cwd();
  const runId = randomUUID();
  const projectId = `mcp-prompt-probe-${runId}`;
  const interactionId = randomUUID();
  const databasePath = path.join(
    root,
    ".stagepass",
    "verification",
    `codex-desktop-bridge-phase0-${runId}.sqlite`,
  );
  const endpoint = await discoverCodexDesktopIpcEndpoint(
    defaultCodexDesktopDiscoveryDependencies(),
  );
  const shellControl = createCodexAppServerShellControl({
    appServerBinary: endpoint.appServerBinary,
  });
  const follower = createObservedCodexDesktopFollowerTransport(endpoint);
  const journal = createCodexPhase0SqliteJournal({
    databasePath,
    async readBaseline(request) {
      const snapshot = await shellControl.readThreadWithTurns({
        threadId: request.threadId,
        includeTurns: true,
      });
      return {
        turnIds: snapshot.turns.map(({ turnId }) => turnId),
        semanticHash: codexTurnSetSemanticHash(snapshot.turns),
      };
    },
  });
  try {
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      logicalTurnPort: journal.logicalTurnPort,
      startAttemptPort: journal.startAttemptPort,
      shellProvisionPort: journal.shellProvisionPort,
      readRpcDeadlineMs: 15_000,
      readOutageBudgetMs: 60_000,
    });
    const provisionDeadlineAt =
      new Date(Date.now() + 10 * 60_000).toISOString();
    const shell = await bridge.ensurePersistentShell({
      projectPath: root,
      scope: {
        kind: "project_context",
        scopeId: projectId,
        projectId,
      },
      title: `[MCP PROMPT PROBE ${runId}] Stagepass Desktop`,
      provisionFence: {
        ownerId: `mcp-prompt-provision-${runId}`,
        leaseToken: randomUUID(),
        leaseExpiresAt: provisionDeadlineAt,
        deadlineAt: provisionDeadlineAt,
        ownerAttempt: 1,
        ownerEpoch: 1,
      },
    });
    const turnDeadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const wakeup = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `mcp-prompt-wakeup-${runId}`,
      projectId,
      scopeKind: "project_context",
      scopeId: projectId,
      phase: "InteractionWakeup",
      role: "interaction_wakeup",
      round: 0,
      ordinal: 0,
      purpose: "interaction_wakeup",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: "Stagepass MCP prompt probe wakeup",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: turnDeadlineAt,
      leaseExpiresAt: turnDeadlineAt,
    });
    await journal.createInteractionWakeup({
      interactionId,
      logicalTurnId: wakeup.logicalTurnId,
      cardVersion: 1,
    });
    const present = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `mcp-prompt-present-${runId}`,
      projectId,
      scopeKind: "project_context",
      scopeId: projectId,
      phase: "Interaction",
      role: "interaction_present",
      round: 0,
      ordinal: 0,
      purpose: "interaction_present",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: [
          `Call ${REGISTRATION_NAME}/present_phase0_card exactly once.`,
          `Use exactly ${JSON.stringify({
            threadId: shell.threadId,
            verificationJournalPath: databasePath,
            verificationRunId: runId,
            interactionId,
            cardVersion: 1,
          })}.`,
          "Do not simulate the tool call.",
          "Then report whether the MCP card was actually presented.",
        ].join(" "),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: turnDeadlineAt,
      leaseExpiresAt: turnDeadlineAt,
    });
    const started = await bridge.startTurn({
      logicalTurnId: present.logicalTurnId,
    });
    let terminal;
    for await (const observation of bridge.pollTurn({
      threadId: shell.threadId,
      turnId: started.turnId,
      deadlineAt: turnDeadlineAt,
    })) {
      if (observation.kind === "observation") {
        terminal = observation.snapshot;
      }
    }
    if (!terminal) throw new Error("prompt probe terminal turn was not observed");
    process.stdout.write(`${JSON.stringify({
      project: "stagepass",
      taskName: shell.title,
      threadId: shell.threadId,
      turnId: started.turnId,
      turnStatus: terminal.status,
      toolCalls: terminal.items.flatMap((item) =>
        item.kind === "tool_call"
          ? [{
              name: item.semantic.name,
              status: item.semantic.status,
              result: item.semantic.result ?? null,
            }]
          : []),
      output: terminal.terminal?.output ?? null,
      databasePath,
    }, null, 2)}\n`);
  } finally {
    journal.close();
  }
}

void main();
