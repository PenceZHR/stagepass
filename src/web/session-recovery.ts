import type { ArchiveOps } from "../codex/archive";
import {
  BindingStore,
  type BoundThread,
} from "../store/binding-store";

export interface BindingRecoveryReport {
  readonly detached: readonly BoundThread[];
  readonly unavailable: readonly {
    readonly binding: BoundThread;
    readonly reason: string;
  }[];
}

export type PreparedThread =
  | { readonly kind: "resume"; readonly threadId: string }
  | { readonly kind: "fresh"; readonly replacedThreadId: string }
  | { readonly kind: "refused"; readonly reason: string };

export type InspectedThread =
  | { readonly kind: "open" | "archived" | "missing"; readonly threadId: string }
  | { readonly kind: "unavailable"; readonly reason: string };

type RecoveryBindings = Pick<
  BindingStore,
  "listBound" | "detach" | "detachAside"
>;

function detachBinding(bindings: RecoveryBindings, binding: BoundThread): void {
  if (binding.kind === "round") bindings.detach(binding.changeId, binding.phase);
  else bindings.detachAside(binding.changeId);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only public-protocol classification used by status and recovery. */
export async function inspectBoundThread(
  binding: BoundThread,
  archive: ArchiveOps,
): Promise<InspectedThread> {
  try {
    const kind = await archive.availability(binding.threadId);
    return { kind, threadId: binding.threadId };
  } catch (error) {
    return { kind: "unavailable", reason: detail(error) };
  }
}

/** Startup audit: detach only App Server-confirmed missing threads. */
export async function reconcileMissingBindings(
  bindings: RecoveryBindings,
  archive: ArchiveOps,
): Promise<BindingRecoveryReport> {
  const detached: BoundThread[] = [];
  const unavailable: { binding: BoundThread; reason: string }[] = [];
  for (const binding of bindings.listBound()) {
    const inspected = await inspectBoundThread(binding, archive);
    if (inspected.kind === "missing") {
      detachBinding(bindings, binding);
      detached.push(binding);
    } else if (inspected.kind === "unavailable") {
      unavailable.push({ binding, reason: inspected.reason });
    }
  }
  return { detached, unavailable };
}

/** Final public-protocol guard before resuming a durable binding. */
export async function prepareBoundThread(input: {
  readonly binding: BoundThread;
  readonly archive: ArchiveOps;
  readonly detach: (binding: BoundThread) => void;
}): Promise<PreparedThread> {
  const { binding, archive, detach } = input;
  const inspected = await inspectBoundThread(binding, archive);
  if (inspected.kind === "unavailable") {
    return { kind: "refused", reason: inspected.reason };
  }
  if (inspected.kind === "open") return { kind: "resume", threadId: binding.threadId };
  if (inspected.kind === "missing") {
    detach(binding);
    return { kind: "fresh", replacedThreadId: binding.threadId };
  }

  try {
    await archive.unarchive(binding.threadId);
  } catch {
    return { kind: "refused", reason: "thread is still archived after thread/unarchive" };
  }
  let after;
  try {
    after = await archive.availability(binding.threadId);
  } catch {
    return {
      kind: "refused",
      reason: "codex app-server became unavailable while unarchiving the thread",
    };
  }
  if (after === "open") return { kind: "resume", threadId: binding.threadId };
  if (after === "missing") {
    detach(binding);
    return { kind: "fresh", replacedThreadId: binding.threadId };
  }
  return {
    kind: "refused",
    reason: "thread is still archived after thread/unarchive",
  };
}
