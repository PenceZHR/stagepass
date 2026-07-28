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

const PLUGIN_NAME = "stagepass-card";
const TOOL_NAME = "show_stagepass_card";

async function main(): Promise<void> {
  const root = process.cwd();
  const runId = randomUUID();
  const projectId = `plugin-card-probe-${runId}`;
  const databasePath = path.join(
    root,
    ".stagepass",
    "verification",
    `codex-desktop-plugin-card-${runId}.sqlite`,
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
    const provisionDeadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const shell = await bridge.ensurePersistentShell({
      projectPath: root,
      scope: {
        kind: "project_context",
        scopeId: projectId,
        projectId,
      },
      title: `[PLUGIN CARD ${runId}] StagePass Desktop`,
      provisionFence: {
        ownerId: `plugin-card-provision-${runId}`,
        leaseToken: randomUUID(),
        leaseExpiresAt: provisionDeadlineAt,
        deadlineAt: provisionDeadlineAt,
        ownerAttempt: 1,
        ownerEpoch: 1,
      },
    });
    const turnDeadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const run = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `plugin-card-present-${runId}`,
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
          `Use the ${PLUGIN_NAME} plugin.`,
          `Call ${TOOL_NAME} exactly once with ${JSON.stringify({
            project: "stagepass",
            taskName: shell.title,
            threadId: shell.threadId,
            state: "plugin prompt probe",
            prompt:
              "STAGEPASS_CARD_TURN_OK：这条消息来自 StagePass Card 插件。请只回复“卡片 turn 已运行”。",
          })}.`,
          "Do not simulate or describe a hypothetical tool call.",
          "After the call, state separately whether the Codex Desktop host actually rendered the interactive card.",
        ].join(" "),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: turnDeadlineAt,
      leaseExpiresAt: turnDeadlineAt,
    });
    const started = await bridge.startTurn({
      logicalTurnId: run.logicalTurnId,
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
    if (!terminal) {
      throw new Error("plugin card probe terminal turn was not observed");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          project: "stagepass",
          plugin: PLUGIN_NAME,
          tool: TOOL_NAME,
          taskName: shell.title,
          threadId: shell.threadId,
          turnId: started.turnId,
          turnStatus: terminal.status,
          toolCalls: terminal.items.flatMap((item) =>
            item.kind === "tool_call"
              ? [
                  {
                    name: item.semantic.name,
                    status: item.semantic.status,
                    result: item.semantic.result ?? null,
                  },
                ]
              : [],
          ),
          output: terminal.terminal?.output ?? null,
          databasePath,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    journal.close();
  }
}

void main();
