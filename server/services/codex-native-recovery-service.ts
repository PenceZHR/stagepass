export type CodexNativeAttemptState =
  | "prepared"
  | "no_client_found"
  | "dispatching"
  | "ambiguous"
  | "succeeded"
  | "quarantined";

export interface CodexNativeRecoveryCandidate {
  attemptId: string;
  logicalTurnId: string;
  threadId: string;
  canonicalThreadId: string | null;
  state: CodexNativeAttemptState;
  owner:
    | { kind: "pipeline_job"; id: string }
    | { kind: "project_ai_run"; id: string };
  workerId: string;
  leaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  deadlineAt: string;
  correlationMarker: string;
  normalizedPromptHash: string;
  preStartSemanticHash: string;
  dispatchOrdinal: number;
  turnId: string | null;
}

export interface CodexNativeRecoveryOwnerLease {
  workerId: string;
  leaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  leaseExpiresAt: string;
}

export type CodexNativeRecoveryAction =
  | "handoff_same_attempt"
  | "adopted_turn"
  | "turn_not_yet_visible"
  | "resumed_snapshot_poll"
  | "settled_terminal"
  | "quarantined"
  | "already_quarantined"
  | "left_owned_by_live_worker"
  | "lost_race";

export interface CodexNativeRecoveryResult {
  attemptId: string;
  logicalTurnId: string;
  action: CodexNativeRecoveryAction;
  turnId?: string;
  reason?: string;
}

export interface CodexNativeRecoveryDependencies {
  listCandidates(): Promise<string[]>;
  /**
   * Must join the logical turn to its authoritative binding. Recovery calls
   * this again immediately before every operation that can reach Codex.
   */
  readCandidate(attemptId: string): Promise<CodexNativeRecoveryCandidate | null>;
  /**
   * Acquires/renews the owner named by the logical row (never an owner supplied
   * by an execution row). A null result means another live worker owns it.
   */
  acquireOwnerLease(
    candidate: CodexNativeRecoveryCandidate,
  ): Promise<CodexNativeRecoveryOwnerLease | null>;
  /**
   * The durable CAS must preserve logical/attempt/marker/baseline/ordinal,
   * prove the old fence expired, and increment ownerEpoch.
   */
  claimSafeAttempt(input: {
    candidate: CodexNativeRecoveryCandidate;
    lease: CodexNativeRecoveryOwnerLease;
  }): Promise<boolean>;
  /**
   * Safe states may dispatch only through this callback. Implementations reuse
   * the same attempt; they must not prepare a new logical turn.
   */
  dispatchSafeAttempt(
    candidate: CodexNativeRecoveryCandidate,
  ): Promise<{ action: "succeeded"; turnId: string } | { action: "no_client_found" }>;
  /**
   * Dispatching/ambiguous recovery is app-server read-only. It must never call
   * follower start.
   */
  reconcileAmbiguous(
    candidate: CodexNativeRecoveryCandidate,
  ): Promise<
    | { action: "adopted"; turnId: string }
    | { action: "not_visible" }
    | { action: "ambiguous"; reason: string }
  >;
  resumeSucceededTurn(
    candidate: CodexNativeRecoveryCandidate,
  ): Promise<
    | { action: "not_visible" }
    | { action: "running" }
    | { action: "terminal" }
  >;
  quarantine(input: {
    candidate: CodexNativeRecoveryCandidate;
    reason: string;
  }): Promise<void>;
  emitDiagnostic(input: {
    attemptId: string;
    logicalTurnId: string;
    code: string;
  }): Promise<void> | void;
  now?: () => Date;
}

function expired(iso: string, now: Date): boolean {
  const value = Date.parse(iso);
  return !Number.isFinite(value) || value <= now.getTime();
}

/**
 * Recovery coordinator for Codex-native work.
 *
 * This deliberately owns no Desktop transport. Its small port boundary makes
 * the two allowed external paths explicit: safe-state dispatch and read-only
 * reconciliation/snapshot polling.
 */
export class CodexNativeRecoveryService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: CodexNativeRecoveryDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async recoverAll(): Promise<CodexNativeRecoveryResult[]> {
    const ids = await this.dependencies.listCandidates();
    const results: CodexNativeRecoveryResult[] = [];
    for (const attemptId of ids) {
      results.push(await this.recoverAttempt(attemptId));
    }
    return results;
  }

  async recoverAttempt(attemptId: string): Promise<CodexNativeRecoveryResult> {
    let candidate = await this.dependencies.readCandidate(attemptId);
    if (!candidate) {
      return {
        attemptId,
        logicalTurnId: "unknown",
        action: "lost_race",
        reason: "attempt_missing",
      };
    }

    const base = {
      attemptId: candidate.attemptId,
      logicalTurnId: candidate.logicalTurnId,
    };
    if (
      !candidate.canonicalThreadId
      || candidate.threadId !== candidate.canonicalThreadId
    ) {
      await this.quarantineNoncanonical(candidate);
      return {
        ...base,
        action: "quarantined",
        reason: "noncanonical_thread_override",
      };
    }
    if (candidate.state === "quarantined") {
      return { ...base, action: "already_quarantined" };
    }

    const lease = await this.dependencies.acquireOwnerLease(candidate);
    if (!lease) {
      return { ...base, action: "left_owned_by_live_worker" };
    }

    // Re-read after the owner lease CAS. This prevents a stale binding or
    // logical-owner snapshot from authorizing any Codex call.
    candidate = await this.dependencies.readCandidate(attemptId);
    if (!candidate) return { ...base, action: "lost_race" };
    if (
      !candidate.canonicalThreadId
      || candidate.threadId !== candidate.canonicalThreadId
    ) {
      await this.quarantineNoncanonical(candidate);
      return {
        ...base,
        action: "quarantined",
        reason: "noncanonical_thread_override",
      };
    }

    if (candidate.state === "prepared" || candidate.state === "no_client_found") {
      if (expired(candidate.deadlineAt, this.now())) {
        await this.dependencies.quarantine({
          candidate,
          reason: "safe_attempt_deadline_expired",
        });
        return {
          ...base,
          action: "quarantined",
          reason: "safe_attempt_deadline_expired",
        };
      }
      const claimed = await this.dependencies.claimSafeAttempt({
        candidate,
        lease,
      });
      if (!claimed) return { ...base, action: "lost_race" };
      const current = await this.requireCanonicalBeforeExternal(attemptId);
      if (!current) {
        return {
          ...base,
          action: "quarantined",
          reason: "noncanonical_thread_override",
        };
      }
      const dispatched = await this.dependencies.dispatchSafeAttempt(current);
      return dispatched.action === "succeeded"
        ? {
            ...base,
            action: "handoff_same_attempt",
            turnId: dispatched.turnId,
          }
        : {
            ...base,
            action: "handoff_same_attempt",
            reason: "no_client_found",
          };
    }

    if (candidate.state === "dispatching" || candidate.state === "ambiguous") {
      const current = await this.requireCanonicalBeforeExternal(attemptId);
      if (!current) {
        return {
          ...base,
          action: "quarantined",
          reason: "noncanonical_thread_override",
        };
      }
      const reconciled = await this.dependencies.reconcileAmbiguous(current);
      if (reconciled.action === "adopted") {
        return {
          ...base,
          action: "adopted_turn",
          turnId: reconciled.turnId,
        };
      }
      if (reconciled.action === "not_visible") {
        if (!expired(current.deadlineAt, this.now())) {
          return { ...base, action: "turn_not_yet_visible" };
        }
        await this.dependencies.quarantine({
          candidate: current,
          reason: "ambiguous_visibility_deadline_expired",
        });
        return {
          ...base,
          action: "quarantined",
          reason: "ambiguous_visibility_deadline_expired",
        };
      }
      await this.dependencies.quarantine({
        candidate: current,
        reason: reconciled.reason,
      });
      return {
        ...base,
        action: "quarantined",
        reason: reconciled.reason,
      };
    }

    const current = await this.requireCanonicalBeforeExternal(attemptId);
    if (!current) {
      return {
        ...base,
        action: "quarantined",
        reason: "noncanonical_thread_override",
      };
    }
    const resumed = await this.dependencies.resumeSucceededTurn(current);
    if (resumed.action === "not_visible") {
      return { ...base, action: "turn_not_yet_visible" };
    }
    return {
      ...base,
      action: resumed.action === "terminal"
        ? "settled_terminal"
        : "resumed_snapshot_poll",
      ...(current.turnId ? { turnId: current.turnId } : {}),
    };
  }

  private async requireCanonicalBeforeExternal(
    attemptId: string,
  ): Promise<CodexNativeRecoveryCandidate | null> {
    const current = await this.dependencies.readCandidate(attemptId);
    if (
      current
      && current.canonicalThreadId
      && current.threadId === current.canonicalThreadId
    ) return current;
    if (current) await this.quarantineNoncanonical(current);
    return null;
  }

  private async quarantineNoncanonical(
    candidate: CodexNativeRecoveryCandidate,
  ): Promise<void> {
    await this.dependencies.quarantine({
      candidate,
      reason: "noncanonical_thread_override",
    });
    await this.dependencies.emitDiagnostic({
      attemptId: candidate.attemptId,
      logicalTurnId: candidate.logicalTurnId,
      code: "noncanonical_thread_override",
    });
  }
}

export interface CodexNativeRecoverySummary {
  recovered: CodexNativeRecoveryResult[];
  failed: Array<{ attemptId: string; error: string }>;
  deferred: CodexNativeRecoveryResult[];
  truncated: false;
}

export async function runCodexNativeRecovery(
  service: Pick<CodexNativeRecoveryService, "recoverAll">,
): Promise<CodexNativeRecoverySummary> {
  const recovered: CodexNativeRecoveryResult[] = [];
  const deferred: CodexNativeRecoveryResult[] = [];
  const failed: Array<{ attemptId: string; error: string }> = [];
  try {
    for (const result of await service.recoverAll()) {
      if (
        result.action === "turn_not_yet_visible"
        || result.action === "left_owned_by_live_worker"
        || result.action === "lost_race"
      ) deferred.push(result);
      else recovered.push(result);
    }
  } catch (error) {
    failed.push({
      attemptId: "recovery_scan",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { recovered, failed, deferred, truncated: false };
}
