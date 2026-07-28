import { CodexAppServerClient } from "../server/services/codex-app-server-client.ts";

async function main(): Promise<void> {
  const threadId = process.argv[2];
  if (!threadId) throw new Error("thread id is required");

  const client = CodexAppServerClient.spawn({
    bin: "/Applications/ChatGPT.app/Contents/Resources/codex",
    cwd: process.cwd(),
    onNotification: () => {},
    onServerRequest: async () => ({ decision: "decline" }),
  });

  try {
    await client.initialize();
    const response = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    }, 15_000) as {
      thread?: {
        turns?: Array<{
          items?: Array<Record<string, unknown>>;
        }>;
      };
    };
    const cards = (response.thread?.turns ?? []).flatMap((turn) =>
      (turn.items ?? []).flatMap((item) =>
        item.type === "mcpToolCall"
          ? [{
              server: item.server,
              tool: item.tool,
              status: item.status,
              mcpAppResourceUri: item.mcpAppResourceUri ?? null,
              pluginId: item.pluginId ?? null,
              appContext: item.appContext ?? null,
            }]
          : []),
    );
    process.stdout.write(`${JSON.stringify({ threadId, cards }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

void main();
