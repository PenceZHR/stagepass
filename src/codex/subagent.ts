import type {
  AppServerHistory,
  ContextUsage,
  ThreadHistory,
} from "./app-server-history";

type HistoryReader = Pick<AppServerHistory, "readThread">;

export class SubAgentNotFoundError extends Error {
  constructor(readonly threadId: string) {
    super(`no App Server thread ${threadId}`);
    this.name = "SubAgentNotFoundError";
  }
}

export class SubAgentUnfinishedError extends Error {
  constructor(readonly threadId: string) {
    super(`thread ${threadId} has not completed a turn`);
    this.name = "SubAgentUnfinishedError";
  }
}

async function required(
  history: HistoryReader,
  threadId: string,
): Promise<ThreadHistory> {
  const found = await history.readThread(threadId);
  if (found === null) throw new SubAgentNotFoundError(threadId);
  return found;
}

/** Last complete model answer from a child thread. */
export async function readThreadTranscript(input: {
  readonly history: HistoryReader;
  readonly threadId: string;
}): Promise<string> {
  const found = await required(input.history, input.threadId);
  if (found.lastCompletedText === null) {
    throw new SubAgentUnfinishedError(input.threadId);
  }
  return found.lastCompletedText;
}

/** All user and agent prose that the child thread received or produced. */
export async function readThreadWholeText(input: {
  readonly history: HistoryReader;
  readonly threadId: string;
}): Promise<string> {
  return (await required(input.history, input.threadId)).allText;
}

/** User inputs in order; null means history was not safely readable. */
export async function readThreadUserMessages(input: {
  readonly history: HistoryReader;
  readonly threadId: string;
}): Promise<readonly string[] | null> {
  try {
    return (await required(input.history, input.threadId)).userMessages;
  } catch {
    return null;
  }
}

/** Spawn lineage in the exact order exposed by the parent App Server history. */
export async function childThreadsOf(input: {
  readonly history: HistoryReader;
  readonly parentThreadId: string;
}): Promise<readonly string[]> {
  return (await required(input.history, input.parentThreadId)).childThreadIds;
}

/** Latest request context usage cached from the official token usage event. */
export async function threadContextUsage(input: {
  readonly history: HistoryReader;
  readonly threadId: string;
}): Promise<ContextUsage | null> {
  try {
    return (await required(input.history, input.threadId)).contextUsage;
  } catch (error) {
    if (error instanceof SubAgentNotFoundError) return null;
    throw error;
  }
}
