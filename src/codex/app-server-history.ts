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

class AppServerHistoryError extends Error {
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

/**
 * 一条**还没收到过第一条用户消息**的线程。
 *
 * 2026-08-17 真机：裁决选了「再来一轮」，续跑那一刀新建了线程，紧接着就去问它
 * 「有没有在跑的 turn」，app-server 回 `not materialized yet`，整个 job 当场 failed。
 *
 * 而这条线程**可证明**有零轮 turn —— 它连第一条消息都还没收到。那是答案，不是错误。
 * 只认这一句话，别的协议错误照抛（吞掉所有失败就是把「读不出来」变成「没有」，
 * 那正是这个项目从头到尾在防的那一类）。
 */
function notYetMaterialized(error: unknown, threadId: string): boolean {
  if (!(error instanceof AppServerError)) return false;
  if (error.code !== "app_server_request_failed" || error.rpcCode !== -32600) return false;
  return error.message.startsWith(`thread ${threadId} is not materialized yet`);
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

  async readThreadStatus(threadId: string): Promise<string | null> {
    let result: unknown;
    try {
      result = await this.connection.request("thread/read", {
        threadId,
        includeTurns: false,
      }, this.requestTimeoutMs);
    } catch (error) {
      if (explicitMissing(error, threadId)) return null;
      throw error;
    }
    const raw = asRecord(asRecord(result).thread);
    if (raw.id !== threadId) {
      throw new AppServerHistoryError(
        "app_server_protocol_error",
        "codex app-server thread/read returned a different thread",
      );
    }
    const status = asRecord(raw.status).type;
    return typeof status === "string" ? status : "notLoaded";
  }

  async readRecentTurns(threadId: string, limit = 20): Promise<readonly HistoryTurn[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppServerHistoryError(
        "invalid_recent_turn_limit",
        "recent turn limit must be an integer from 1 to 100",
      );
    }
    let result: unknown;
    try {
      result = await this.connection.request("thread/turns/list", {
        threadId,
        limit,
        sortDirection: "desc",
        itemsView: "full",
      }, this.requestTimeoutMs);
    } catch (error) {
      if (explicitMissing(error, threadId)) return [];
      if (notYetMaterialized(error, threadId)) return [];
      throw error;
    }
    return records(asRecord(result).data).map(normalizeTurn);
  }

  /*
   * 从控制连接直接发 turn/start —— 不 thread/start、不 thread/resume，所以这条连接
   * 永远不会成为订阅者：`turn/*` 通知和审批 / elicitation 全部留给官方 TUI。
   *
   * 2026-08-17 真机：非订阅连接发的两轮都正常跑完、TUI 把它们画了出来，而这条连接
   * 一条 `turn/*`、一条反向请求都没收到。所以**完成判定只能轮询**
   * `thread/turns/list`，别在这里等一个不会来的 `turn/completed`。
   *
   * 不重复传 cwd / approvalPolicy / effort / model：它们是「本轮及以后」的覆盖，
   * 建线程时已经定过了。
   */
  async startTurnDetached(threadId: string, prompt: string): Promise<string> {
    const result = asRecord(await this.connection.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    }, this.requestTimeoutMs));
    const turnId = asRecord(result.turn).id;
    if (typeof turnId !== "string" || turnId === "") {
      throw new AppServerHistoryError(
        "app_server_protocol_error",
        "codex app-server turn/start response has no turn id",
      );
    }
    return turnId;
  }

  /*
   * 「thread/list 里没有」不等于「这条线程没了」。
   *
   * 2026-08-17 真机：面板刚建出来的线程零轮次，还没落 rollout，`thread/list`
   * 查不到它 —— 于是判 missing → detach → 重建一条，下一次照样零轮次，churn
   * 就这么转起来。而同一时刻 `thread/loaded/list`（daemon 内存里加载着的会话）
   * 一直有它。所以先问 loaded，问不到再翻 list。
   *
   * 归档的线程不会留在 loaded 里（同日实测：archive 之后 loaded 由 true 变 false），
   * 所以 loaded 命中直接判 open 不会盖住 archived 那条路。
   */
  async availability(threadId: string): Promise<ThreadAvailability> {
    if (await this.loadedIncludes(threadId)) return "open";
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

  /** Stop this control connection from receiving this thread's reverse requests. */
  async unsubscribeThread(threadId: string): Promise<void> {
    await this.connection.request(
      "thread/unsubscribe",
      { threadId },
      this.requestTimeoutMs,
    );
  }

  /** Interrupt by protocol identity without subscribing as an interaction owner. */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.connection.request(
      "turn/interrupt",
      { threadId, turnId },
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

  /** daemon 内存里加载着的线程 id。零轮次线程只在这份名单里。 */
  private async loadedIncludes(threadId: string): Promise<boolean> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const result = asRecord(await this.connection.request("thread/loaded/list", {
        cursor,
        limit: THREAD_LIST_PAGE_SIZE,
      }, this.requestTimeoutMs));
      const page = Array.isArray(result.data) ? result.data : [];
      if (page.some((id) => id === threadId)) return true;
      const next = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (next === null || seenCursors.has(next)) return false;
      seenCursors.add(next);
      cursor = next;
    } while (true);
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
