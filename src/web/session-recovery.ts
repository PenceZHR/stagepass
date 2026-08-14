import {
  ensureResumable, type ArchiveOps,
} from "../codex/archive";
import {
  BindingStore, type BoundThread,
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

type RecoveryBindings = Pick<
  BindingStore,
  "listBound" | "detach" | "detachAside"
>;

function detachBinding(bindings: RecoveryBindings, binding: BoundThread): void {
  if (binding.kind === "round") {
    bindings.detach(binding.changeId, binding.phase);
  } else {
    bindings.detachAside(binding.changeId);
  }
}

/**
 * 服务启动时只收拾已经确定不存在的线程。
 *
 * archived 留给真正打开它的那一刻解开；unavailable 只报告，绝不拿环境故障当丢失。
 */
export function reconcileMissingBindings(
  bindings: RecoveryBindings,
  archive: ArchiveOps,
): BindingRecoveryReport {
  const detached: BoundThread[] = [];
  const unavailable: { binding: BoundThread; reason: string }[] = [];

  for (const binding of bindings.listBound()) {
    const availability = archive.availability(binding.threadId);
    if (availability.kind === "missing") {
      detachBinding(bindings, binding);
      detached.push(binding);
    } else if (availability.kind === "unavailable") {
      unavailable.push({ binding, reason: availability.reason });
    }
  }

  return { detached, unavailable };
}

/**
 * PTY 创建前的最后一道守卫。返回 fresh 时，真正的新 id 仍由现有 onThread 回调绑定。
 */
export function prepareBoundThread(input: {
  readonly binding: BoundThread;
  readonly archive: ArchiveOps;
  readonly detach: (binding: BoundThread) => void;
}): PreparedThread {
  const { binding, archive, detach } = input;
  const availability = archive.availability(binding.threadId);

  if (availability.kind === "open") {
    return { kind: "resume", threadId: binding.threadId };
  }
  if (availability.kind === "missing") {
    detach(binding);
    return { kind: "fresh", replacedThreadId: binding.threadId };
  }
  if (availability.kind === "unavailable") {
    return { kind: "refused", reason: availability.reason };
  }

  const outcome = ensureResumable(binding.threadId, archive);
  if (outcome === "already_open" || outcome === "unarchived") {
    return { kind: "resume", threadId: binding.threadId };
  }
  if (outcome === "missing") {
    detach(binding);
    return { kind: "fresh", replacedThreadId: binding.threadId };
  }
  if (outcome === "unavailable") {
    const after = archive.availability(binding.threadId);
    return {
      kind: "refused",
      reason: after.kind === "unavailable"
        ? after.reason
        : "thread availability became unavailable after unarchive",
    };
  }
  return {
    kind: "refused",
    reason: "thread is still archived after unarchive",
  };
}
