import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  codexFollowerStartAttempts,
  codexLogicalTurns,
  codexThreadBindings,
} from "../db/schema";
import type { CodexAppServerShellControl } from "./codex-app-server-shell-control";
import type {
  CodexFollowerStartAttempt,
  CodexFollowerStartAttemptPort,
  CodexFollowerStartFence,
  CodexLogicalTurnPort,
} from "./codex-desktop-bridge-types";
import {
  assertCodexMutationFence,
  type CodexFenceTransaction,
} from "./codex-durable-execution-fence";

export class CodexFollowerStartAttemptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexFollowerStartAttemptError";
  }
}

type AttemptRow = typeof codexFollowerStartAttempts.$inferSelect;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function ownerColumns(fence: CodexFollowerStartFence): {
  pipelineJobId: string | null;
  projectAiRunId: string | null;
} {
  return fence.owner.kind === "pipeline_job"
    ? { pipelineJobId: fence.owner.pipelineJobId, projectAiRunId: null }
    : { pipelineJobId: null, projectAiRunId: fence.owner.projectAiRunId };
}

function sameOwner(row: AttemptRow, fence: CodexFollowerStartFence): boolean {
  return row.logicalTurnId === fence.logicalTurnId
    && row.workerId === fence.workerId
    && row.leaseToken === fence.leaseToken
    && row.ownerAttempt === fence.ownerAttempt
    && row.ownerEpoch === fence.ownerEpoch
    && row.dispatchSurface === fence.dispatchSurface
    && (
      fence.owner.kind === "pipeline_job"
        ? row.pipelineJobId === fence.owner.pipelineJobId
          && row.projectAiRunId === null
        : row.projectAiRunId === fence.owner.projectAiRunId
          && row.pipelineJobId === null
    );
}

function attemptPredicate(
  row: AttemptRow,
  fence: CodexFollowerStartFence,
) {
  return and(
    eq(codexFollowerStartAttempts.attemptId, row.attemptId),
    eq(codexFollowerStartAttempts.logicalTurnId, fence.logicalTurnId),
    eq(codexFollowerStartAttempts.workerId, fence.workerId),
    eq(codexFollowerStartAttempts.leaseToken, fence.leaseToken),
    eq(codexFollowerStartAttempts.ownerAttempt, fence.ownerAttempt),
    eq(codexFollowerStartAttempts.ownerEpoch, fence.ownerEpoch),
  );
}

export function createCodexFollowerStartAttemptPort(
  logicalTurns: Pick<CodexLogicalTurnPort, "readForStart">,
  shellControl: Pick<CodexAppServerShellControl, "readThreadWithTurns">,
): CodexFollowerStartAttemptPort {
  async function inspectRow(row: AttemptRow | undefined): Promise<CodexFollowerStartAttempt | null> {
    if (!row) return null;
    const logical = await logicalTurns.readForStart(row.logicalTurnId);
    const request = {
      ...logical.request,
      prompt: `${logical.request.prompt}\n\n${row.correlationMarker}`,
    };
    const fence: CodexFollowerStartFence = {
      ...logical.fence,
      workerId: row.workerId,
      leaseToken: row.leaseToken,
      ownerAttempt: row.ownerAttempt,
      ownerEpoch: row.ownerEpoch,
      deadlineAt: row.budgetDeadline,
      leaseExpiresAt: row.budgetDeadline,
    };
    return {
      attemptId: row.attemptId,
      logicalTurnId: row.logicalTurnId,
      request,
      fence,
      originalDeadlineAt: row.budgetDeadline,
      correlationMarker: row.correlationMarker,
      normalizedPromptHash: row.normalizedPromptHash,
      preStartTurnIds: JSON.parse(row.preStartTurnIdsJson) as string[],
      preStartSemanticHash: row.preStartSemanticHash,
      state: row.state,
      dispatchOrdinal: row.dispatchOrdinal,
      ...(row.followerTurnId ? { turnId: row.followerTurnId } : {}),
      ...(row.lastErrorCode === "desktop_follower_start_ambiguous"
        ? { code: "desktop_follower_start_ambiguous" as const }
        : {}),
      ...(row.lastResult && [
        "timeout",
        "disconnect",
        "unknown_response",
        "visibility_timeout",
        "multiple_candidates",
      ].includes(row.lastResult)
        ? { ambiguousReason: row.lastResult as CodexFollowerStartAttempt["ambiguousReason"] }
        : {}),
      ...(row.recoveryLeaseToken
        ? {
            recoveryFence: {
              ownerFence: fence,
              recoveryLeaseToken: row.recoveryLeaseToken,
              recoveryEpoch: row.recoveryEpoch,
            },
          }
        : {}),
    };
  }

  async function rowByAttempt(attemptId: string) {
    return db.select().from(codexFollowerStartAttempts)
      .where(eq(codexFollowerStartAttempts.attemptId, attemptId)).get();
  }

  function requireMutationRow(
    tx: CodexFenceTransaction,
    attemptId: string,
    fence: CodexFollowerStartFence,
  ): AttemptRow {
    const row = tx.select().from(codexFollowerStartAttempts)
      .where(eq(codexFollowerStartAttempts.attemptId, attemptId)).get();
    if (!row || !sameOwner(row, fence)) {
      throw new CodexFollowerStartAttemptError(
        "stale_start_attempt_fence",
        "Follower start attempt fence is stale",
      );
    }
    assertCodexMutationFence(tx, {
      logicalTurnId: row.logicalTurnId,
      owner: fence,
      attemptId: row.attemptId,
    });
    return row;
  }

  return {
    async inspect(attemptId) {
      return inspectRow(await rowByAttempt(attemptId));
    },
    async inspectByLogicalTurn(logicalTurnId) {
      return inspectRow(db.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.logicalTurnId, logicalTurnId)).get());
    },
    async prepare({ attemptId, logicalTurnId }) {
      const logical = await logicalTurns.readForStart(logicalTurnId);
      const observed = await shellControl.readThreadWithTurns({
        threadId: logical.request.threadId,
        includeTurns: true,
        deadlineAt: logical.fence.deadlineAt,
      });
      const preStartTurnIds = observed.turns.map((turn) => turn.turnId);
      const preStartSemanticHash = digest(observed.turns);
      const correlationMarker =
        `[stagepass-run:${logical.runCorrelationId}:attempt:${attemptId}]`;
      const requestWithMarker = {
        ...logical.request,
        prompt: `${logical.request.prompt}\n\n${correlationMarker}`,
      };
      const normalizedPromptHash = createHash("sha256")
        .update(requestWithMarker.prompt)
        .digest("hex");
      const timestamp = new Date().toISOString();
      db.transaction((tx) => {
        assertCodexMutationFence(tx, {
          logicalTurnId,
          owner: logical.fence,
          attemptId,
        });
        const existing = tx.select().from(codexFollowerStartAttempts)
          .where(eq(codexFollowerStartAttempts.logicalTurnId, logicalTurnId)).get();
        if (existing) {
          throw new CodexFollowerStartAttemptError(
            "logical_turn_attempt_exists",
            "Logical turn already owns its durable follower attempt",
          );
        }
        tx.insert(codexFollowerStartAttempts).values({
          attemptId,
          logicalTurnId,
          runCorrelationId: logical.runCorrelationId,
          ...ownerColumns(logical.fence),
          workerId: logical.fence.workerId,
          leaseToken: logical.fence.leaseToken,
          ownerAttempt: logical.fence.ownerAttempt,
          ownerEpoch: logical.fence.ownerEpoch,
          threadId: logical.request.threadId,
          purpose: logical.fence.purpose,
          dispatchSurface: logical.fence.dispatchSurface,
          normalizedPromptHash,
          correlationMarker,
          cwd: logical.request.cwd,
          model: logical.request.model ?? null,
          reasoningEffort: logical.request.reasoningEffort ?? null,
          sandboxMode: logical.request.sandboxMode,
          approvalPolicy: logical.request.approvalPolicy,
          preStartTurnIdsJson: JSON.stringify(preStartTurnIds),
          preStartSemanticHash,
          state: "prepared",
          dispatchOrdinal: 0,
          dispatchCount: 0,
          budgetDeadline: logical.fence.deadlineAt,
          followerTurnId: null,
          recoveryOwnerId: null,
          recoveryLeaseToken: null,
          recoveryEpoch: 0,
          lastResult: null,
          lastErrorCode: null,
          preparedAt: timestamp,
          dispatchedAt: null,
          completedAt: null,
        }).run();
      });
      return {
        attemptId,
        state: "prepared",
        fence: logical.fence,
        request: logical.request,
        correlationMarker,
        normalizedPromptHash,
        requestWithMarker,
        preStartTurnIds,
        preStartSemanticHash,
      };
    },
    async claimDispatch({ attemptId, fence }) {
      return db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence);
        if (!["prepared", "no_client_found"].includes(row.state)) {
          throw new CodexFollowerStartAttemptError(
            "start_attempt_not_dispatchable",
            "Follower attempt is not safely dispatchable",
          );
        }
        const dispatchOrdinal = row.dispatchOrdinal + 1;
        const timestamp = new Date().toISOString();
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "dispatching",
          dispatchOrdinal,
          dispatchCount: row.dispatchCount + 1,
          dispatchedAt: timestamp,
          lastResult: null,
          lastErrorCode: null,
        }).where(and(
          attemptPredicate(row, fence),
          eq(codexFollowerStartAttempts.state, row.state),
          eq(codexFollowerStartAttempts.dispatchOrdinal, row.dispatchOrdinal),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower dispatch claim lost",
          );
        }
        return dispatchOrdinal;
      });
    },
    async claimSafeAttemptForWorker(input) {
      db.transaction((tx) => {
        const row = tx.select().from(codexFollowerStartAttempts)
          .where(eq(codexFollowerStartAttempts.attemptId, input.attemptId)).get();
        if (!row || !sameOwner(row, input.expectedOldFence)) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Safe follower attempt old fence is stale",
          );
        }
        assertCodexMutationFence(tx, {
          logicalTurnId: row.logicalTurnId,
          owner: input.newFence,
          attemptId: row.attemptId,
        });
        if (row.state !== input.expectedState) {
          throw new CodexFollowerStartAttemptError(
            "start_attempt_not_safe",
            "Only explicit safe states can move to a new worker fence",
          );
        }
        const updated = tx.update(codexFollowerStartAttempts).set({
          ...ownerColumns(input.newFence),
          workerId: input.newFence.workerId,
          leaseToken: input.newFence.leaseToken,
          ownerAttempt: input.newFence.ownerAttempt,
          ownerEpoch: input.newFence.ownerEpoch,
        }).where(and(
          attemptPredicate(row, input.expectedOldFence),
          eq(codexFollowerStartAttempts.state, input.expectedState),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Safe follower attempt takeover lost",
          );
        }
      });
    },
    async recordNoClientFound({ attemptId, dispatchOrdinal, fence }) {
      db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence);
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "no_client_found",
          lastResult: "no-client-found",
        }).where(and(
          attemptPredicate(row, fence),
          eq(codexFollowerStartAttempts.state, "dispatching"),
          eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "No-client result was fenced",
          );
        }
      });
    },
    async recordSuccess({ attemptId, dispatchOrdinal, turnId, fence }) {
      const timestamp = new Date().toISOString();
      db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence);
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "succeeded",
          followerTurnId: turnId,
          lastResult: "started",
          completedAt: timestamp,
        }).where(and(
          attemptPredicate(row, fence),
          eq(codexFollowerStartAttempts.state, "dispatching"),
          eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower success CAS was fenced",
          );
        }
        const logical = tx.select().from(codexLogicalTurns)
          .where(eq(codexLogicalTurns.logicalTurnId, row.logicalTurnId)).get()!;
        const bindingUpdate = tx.update(codexThreadBindings).set({
          followerStartProvedAt: timestamp,
          lastTurnId: turnId,
          updatedAt: timestamp,
        }).where(and(
          eq(codexThreadBindings.bindingId, logical.bindingId),
          eq(codexThreadBindings.threadId, row.threadId),
        )).run();
        if (bindingUpdate.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower success binding update was fenced",
          );
        }
      });
    },
    async recordAmbiguous({ attemptId, dispatchOrdinal, reason, fence }) {
      db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence);
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "ambiguous",
          lastResult: reason,
          lastErrorCode: "desktop_follower_start_ambiguous",
        }).where(and(
          attemptPredicate(row, fence),
          eq(codexFollowerStartAttempts.state, "dispatching"),
          eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Ambiguous follower result was fenced",
          );
        }
      });
    },
    async claimReconciliation({ attemptId, ownerFence }) {
      return db.transaction((tx) => {
        const row = tx.select().from(codexFollowerStartAttempts)
          .where(eq(codexFollowerStartAttempts.attemptId, attemptId)).get();
        if (!row || row.logicalTurnId !== ownerFence.logicalTurnId) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower reconciliation logical identity changed",
          );
        }
        assertCodexMutationFence(tx, {
          logicalTurnId: row.logicalTurnId,
          owner: ownerFence,
          attemptId: row.attemptId,
        });
        if (!["dispatching", "ambiguous"].includes(row.state)) {
          throw new CodexFollowerStartAttemptError(
            "start_attempt_not_ambiguous",
            "Only a dispatched/ambiguous attempt can reconcile",
          );
        }
        const recoveryLeaseToken = crypto.randomUUID();
        const updated = tx.update(codexFollowerStartAttempts).set({
          ...ownerColumns(ownerFence),
          workerId: ownerFence.workerId,
          leaseToken: ownerFence.leaseToken,
          ownerAttempt: ownerFence.ownerAttempt,
          ownerEpoch: ownerFence.ownerEpoch,
          state: "ambiguous",
          recoveryOwnerId: ownerFence.workerId,
          recoveryLeaseToken,
          recoveryEpoch: row.recoveryEpoch + 1,
        }).where(and(
          eq(codexFollowerStartAttempts.attemptId, row.attemptId),
          eq(codexFollowerStartAttempts.logicalTurnId, row.logicalTurnId),
          eq(codexFollowerStartAttempts.recoveryEpoch, row.recoveryEpoch),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower reconciliation claim lost",
          );
        }
        return {
          ownerFence,
          recoveryLeaseToken,
          recoveryEpoch: row.recoveryEpoch + 1,
        };
      });
    },
    async adoptSuccess({ attemptId, dispatchOrdinal, turnId, fence }) {
      const timestamp = new Date().toISOString();
      db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence.ownerFence);
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "succeeded",
          followerTurnId: turnId,
          lastResult: "adopted",
          completedAt: timestamp,
        }).where(and(
          attemptPredicate(row, fence.ownerFence),
          eq(codexFollowerStartAttempts.state, "ambiguous"),
          eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
          eq(codexFollowerStartAttempts.recoveryOwnerId, fence.ownerFence.workerId),
          eq(codexFollowerStartAttempts.recoveryLeaseToken, fence.recoveryLeaseToken),
          eq(codexFollowerStartAttempts.recoveryEpoch, fence.recoveryEpoch),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower adoption was fenced",
          );
        }
        const logical = tx.select().from(codexLogicalTurns)
          .where(eq(codexLogicalTurns.logicalTurnId, row.logicalTurnId)).get()!;
        const bindingUpdate = tx.update(codexThreadBindings).set({
          followerStartProvedAt: timestamp,
          lastTurnId: turnId,
          updatedAt: timestamp,
        }).where(and(
          eq(codexThreadBindings.bindingId, logical.bindingId),
          eq(codexThreadBindings.threadId, row.threadId),
        )).run();
        if (bindingUpdate.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower adoption binding update was fenced",
          );
        }
      });
    },
    async quarantine({ attemptId, dispatchOrdinal, fence }) {
      db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence.ownerFence);
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "quarantined",
          lastResult: "multiple_candidates",
          lastErrorCode: "desktop_follower_start_ambiguous",
          completedAt: new Date().toISOString(),
        }).where(and(
          attemptPredicate(row, fence.ownerFence),
          eq(codexFollowerStartAttempts.state, "ambiguous"),
          eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
          eq(codexFollowerStartAttempts.recoveryOwnerId, fence.ownerFence.workerId),
          eq(codexFollowerStartAttempts.recoveryLeaseToken, fence.recoveryLeaseToken),
          eq(codexFollowerStartAttempts.recoveryEpoch, fence.recoveryEpoch),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower quarantine was fenced",
          );
        }
      });
    },
    async expireVisibility({ attemptId, dispatchOrdinal, fence }) {
      db.transaction((tx) => {
        const row = requireMutationRow(tx, attemptId, fence.ownerFence);
        const updated = tx.update(codexFollowerStartAttempts).set({
          state: "quarantined",
          lastResult: "visibility_timeout",
          lastErrorCode: "desktop_follower_start_ambiguous",
          completedAt: new Date().toISOString(),
        }).where(and(
          attemptPredicate(row, fence.ownerFence),
          eq(codexFollowerStartAttempts.state, "ambiguous"),
          eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
          eq(codexFollowerStartAttempts.recoveryOwnerId, fence.ownerFence.workerId),
          eq(codexFollowerStartAttempts.recoveryLeaseToken, fence.recoveryLeaseToken),
          eq(codexFollowerStartAttempts.recoveryEpoch, fence.recoveryEpoch),
        )).run();
        if (updated.changes !== 1) {
          throw new CodexFollowerStartAttemptError(
            "stale_start_attempt_fence",
            "Follower visibility expiry was fenced",
          );
        }
      });
    },
  };
}
