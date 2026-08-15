import { AppServerError } from "./app-server-client";
import {
  asRecord,
  type AppServerNotification,
} from "./app-server-protocol";
import type { AppServerConnection } from "./app-server-session";

const HISTORY_REQUEST_TIMEOUT_MS = 30_000;
const THREAD_LIST_PAGE_SIZE = 100;
const THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export type HistoryTurnStatus =
  | "completed"
  | "failed"
  | "interrupted"
  | "inProgress";

export interface ContextUsage {
  /** Tokens in the latest model request, not cumulative billing usage. */
  readonly used: number;
  readonly window: number;
}

export interface HistoryTurn {
  readonly id: string;
  readonly status: HistoryTurnStatus;
  readonly userMessages: readonly string[];
  readonly agentText: string;
  readonly allText: string;
}

export interface ThreadHistory {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly status: string;
  readonly turns: readonly HistoryTurn[];
  readonly turnCount: number;
  readonly userMessages: readonly string[];
  readonly allText: string;
  readonly lastCompletedText: string | null;
  readonly childThreadIds: readonly string[];
  readonly contextUsage: ContextUsage | null;
}

export type ThreadAvailability = "open" | "archived" | "missing";

export class AppServerHistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AppServerHistoryError";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function records(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function turnStatus(value: unknown): HistoryTurnStatus {
  return value === "completed" || value === "failed" ||
      value === "interrupted" || value === "inProgress"
    ? value
    : "inProgress";
}

function userText(item: Readonly<Record<string, unknown>>): string[] {
  if (item.type !== "userMessage") return [];
  return records(item.content)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .filter((text) => text !== "");
}

function agentText(item: Readonly<Record<string, unknown>>): string | null {
  return item.type === "agentMessage" && typeof item.text === "string" && item.text !== ""
    ? item.text
    : null;
}

function contextUsageOf(value: unknown): ContextUsage | null {
  const usage = asRecord(value);
  const last = asRecord(usage.last);
  const used = last.totalTokens;
  const window = usage.modelContextWindow;
  return typeof used === "number" && Number.isFinite(used) &&
      typeof window === "number" && Number.isFinite(window)
    ? { used, window }
    : null;
}

function normalizeTurn(value: unknown): HistoryTurn {
  const raw = asRecord(value);
  const items = records(raw.items);
  const users: string[] = [];
  const agents: string[] = [];
  const all: string[] = [];
  for (const item of items) {
    const saidByUser = userText(item);
    users.push(...saidByUser);
    all.push(...saidByUser);
    const saidByAgent = agentText(item);
    if (saidByAgent !== null) {
      agents.push(saidByAgent);
      all.push(saidByAgent);
    }
  }
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    status: turnStatus(raw.status),
    userMessages: users,
    agentText: agents.join("\n"),
    allText: all.join("\n"),
  };
}

function childThreadIds(turns: readonly unknown[]): string[] {
  const found = new Set<string>();
  for (const turn of turns) {
    for (const item of records(asRecord(turn).items)) {
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
        for (const id of stringArray(item.receiverThreadIds)) found.add(id);
      }
      if (item.type === "subAgentActivity" && item.kind === "started" &&
          typeof item.agentThreadId === "string") {
        found.add(item.agentThreadId);
      }
    }
  }
  return [...found];
}

function explicitMissing(error: unknown, threadId: string): boolean {
  if (!(error instanceof AppServerError)) return false;
  if (error.code !== "app_server_request_failed" || error.rpcCode !== -32600) {
    return false;
  }
  return error.message === `thread not loaded: ${threadId}`;
}

/**
 * Public App Server history boundary. No Codex files, sqlite state, or rollout
 * paths cross this module; persistence remains owned by Codex.
 */
export class AppServerHistory {
  private readonly tokenUsage = new Map<string, ContextUsage>();
  private readonly unsubscribeNotifications: () => void;

  constructor(
    private readonly connection: AppServerConnection,
    private readonly requestTimeoutMs = HISTORY_REQUEST_TIMEOUT_MS,
  ) {
    this.unsubscribeNotifications = connection.subscribeNotifications((message) => {
      this.accept(message);
    });
  }

  dispose(): void {
    this.unsubscribeNotifications();
  }

  async readThread(threadId: string): Promise<ThreadHistory | null> {
    let result: unknown;
    try {
      result = await this.connection.request("thread/read", {
        threadId,
        includeTurns: true,
      }, this.requestTimeoutMs);
    } catch (error) {
      if (explicitMissing(error, threadId)) return null;
      throw error;
    }
    const response = asRecord(result);
    const raw = asRecord(response.thread);
    const id = typeof raw.id === "string" ? raw.id : "";
    if (id === "") {
      throw new AppServerHistoryError(
        "app_server_protocol_error",
        "codex app-server thread/read response has no thread id",
      );
    }
    if (id !== threadId) {
      throw new AppServerHistoryError(
        "app_server_protocol_error",
        "codex app-server thread/read returned a different thread",
      );
    }
    const rawTurns = Array.isArray(raw.turns) ? raw.turns : [];
    const turns = rawTurns.map(normalizeTurn);
    let lastCompletedText: string | null = null;
    for (const turn of turns) {
      if (turn.status === "completed") lastCompletedText = turn.agentText;
    }
    const rawStatus = asRecord(raw.status).type;
    const inlineUsage = contextUsageOf(raw.tokenUsage) ?? contextUsageOf(response.tokenUsage);
    if (inlineUsage !== null) this.tokenUsage.set(threadId, inlineUsage);
    return {
      id,
      parentThreadId: typeof raw.parentThreadId === "string"
        ? raw.parentThreadId
        : null,
      status: typeof rawStatus === "string" ? rawStatus : "notLoaded",
      turns,
      turnCount: turns.length,
      userMessages: turns.flatMap((turn) => turn.userMessages),
      allText: turns.map((turn) => turn.allText).filter(Boolean).join("\n"),
      lastCompletedText,
      childThreadIds: childThreadIds(rawTurns),
      contextUsage: this.tokenUsage.get(threadId) ?? null,
    };
  }

  async availability(threadId: string): Promise<ThreadAvailability> {
    if (await this.listIncludes(threadId, false)) return "open";
    if (await this.listIncludes(threadId, true)) return "archived";
    return "missing";
  }

  async archive(threadId: string): Promise<void> {
    await this.connection.request(
      "thread/archive",
      { threadId },
      this.requestTimeoutMs,
    );
  }

  async unarchive(threadId: string): Promise<void> {
    await this.connection.request(
      "thread/unarchive",
      { threadId },
      this.requestTimeoutMs,
    );
  }

  private accept(message: AppServerNotification): void {
    if (message.method !== "thread/tokenUsage/updated") return;
    const threadId = message.params.threadId;
    const usage = contextUsageOf(message.params.tokenUsage);
    if (typeof threadId === "string" && usage !== null) {
      this.tokenUsage.set(threadId, usage);
    }
  }

  private async listIncludes(threadId: string, archived: boolean): Promise<boolean> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const result = asRecord(await this.connection.request("thread/list", {
        archived,
        cursor,
        limit: THREAD_LIST_PAGE_SIZE,
        sourceKinds: [...THREAD_SOURCE_KINDS],
      }, this.requestTimeoutMs));
      if (records(result.data).some((thread) => thread.id === threadId)) return true;
      const next = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (next === null || seenCursors.has(next)) return false;
      seenCursors.add(next);
      cursor = next;
    } while (true);
  }
}

export function threadTurnEnded(
  history: ThreadHistory,
  fromTurn: number,
  prompt: string,
): boolean {
  return history.turns.slice(Math.max(0, fromTurn)).some((turn) =>
    turn.status !== "inProgress" && turn.userMessages.includes(prompt)
  );
}
