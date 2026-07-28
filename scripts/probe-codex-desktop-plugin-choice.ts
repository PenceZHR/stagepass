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
const TOOL_NAME = "present_stagepass_choices";

async function main(): Promise<void> {
  const root = process.cwd();
  const runId = randomUUID();
  const projectId = `plugin-choice-probe-${runId}`;
  const interactionId = `plugin-choice-${runId}`;
  const databasePath = path.join(
    root,
    ".stagepass",
    "verification",
    `codex-desktop-plugin-choice-${runId}.sqlite`,
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
      title: `[STAGEPASS CHOICE ${runId}]`,
      provisionFence: {
        ownerId: `plugin-choice-provision-${runId}`,
        leaseToken: randomUUID(),
        leaseExpiresAt: provisionDeadlineAt,
        deadlineAt: provisionDeadlineAt,
        ownerAttempt: 1,
        ownerEpoch: 1,
      },
    });
    const turnDeadlineAt =
      new Date(Date.now() + 5 * 60_000).toISOString();
    const run = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `plugin-choice-present-${runId}`,
      projectId,
      scopeKind: "project_context",
      scopeId: projectId,
      phase: "Spec",
      role: "stage",
      round: 0,
      ordinal: 0,
      purpose: "stage_run",
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
            interactionId,
            project: "StagePass",
            stage: "Spec",
            threadId: shell.threadId,
            question: "这次需求确认按哪种范围继续？",
            helperText:
              "请勾选一个选项。提交成功后，卡片必须明确显示已生效。",
            selectionMode: "single",
            options: [
              {
                id: "focused",
                label: "只做当前阶段",
                description: "聚焦当前 Spec 阶段的必需范围。",
              },
              {
                id: "extended",
                label: "同时准备下一阶段",
                description: "在当前范围外补齐下一阶段的输入。",
              },
            ],
          })}.`,
          "Do not simulate the tool call and do not answer the question yourself.",
          "Wait for STAGEPASS_SELECTION_CONFIRMED after the card is shown.",
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
      throw new Error("plugin choice probe terminal turn was not observed");
    }

    process.stdout.write(`${JSON.stringify({
      project: "stagepass",
      plugin: PLUGIN_NAME,
      tool: TOOL_NAME,
      interactionId,
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
