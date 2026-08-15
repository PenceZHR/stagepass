import type {
  AppServerHistory,
  ThreadAvailability,
} from "./app-server-history";

/** The public App Server operations StagePass needs for lifecycle policy. */
export type ArchiveOps = Pick<
  AppServerHistory,
  "availability" | "archive" | "unarchive"
>;

export type ResumableOutcome =
  | "already_open"
  | "unarchived"
  | "still_archived"
  | "missing"
  /** App Server was unavailable; this must never detach a durable binding. */
  | "unavailable";

async function availability(
  threadId: string,
  ops: ArchiveOps,
): Promise<ThreadAvailability | "unavailable"> {
  try {
    return await ops.availability(threadId);
  } catch {
    return "unavailable";
  }
}

/** Make a bound thread resumable without reading Codex-owned files or sqlite. */
export async function ensureResumable(
  threadId: string,
  ops: ArchiveOps,
): Promise<ResumableOutcome> {
  const before = await availability(threadId, ops);
  if (before === "missing" || before === "unavailable") return before;
  if (before === "open") return "already_open";
  try {
    await ops.unarchive(threadId);
  } catch {
    return "still_archived";
  }
  const after = await availability(threadId, ops);
  if (after === "open") return "unarchived";
  if (after === "missing" || after === "unavailable") return after;
  return "still_archived";
}

export type ArchiveOutcome =
  | "archived"
  | "already_archived"
  | "still_open"
  | "unknown";

/** Archive only after the human-approved StagePass phase transition. */
export async function archiveFinished(
  threadId: string,
  ops: ArchiveOps,
): Promise<ArchiveOutcome> {
  const before = await availability(threadId, ops);
  if (before === "missing" || before === "unavailable") return "unknown";
  if (before === "archived") return "already_archived";
  try {
    await ops.archive(threadId);
  } catch {
    return "still_open";
  }
  const after = await availability(threadId, ops);
  if (after === "archived") return "archived";
  if (after === "open") return "still_open";
  return "unknown";
}
