import type {
  AppServerHistory,
  ThreadAvailability,
} from "./app-server-history";

/** The public App Server operations StagePass needs for lifecycle policy. */
export type ArchiveOps = Pick<
  AppServerHistory,
  "availability" | "archive" | "unarchive"
>;

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
