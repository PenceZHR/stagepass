import type { pipelineJobs, runs } from "../db/schema";
import type { ProviderRunProcess } from "./provider-run-lifecycle-service";
import type { ProcessIdentity } from "./process-identity-service";

/**
 * Pure predicates for stale-provider-run recovery: ownership/identity/fence and
 * freshness comparisons. No database, filesystem, or process access — every
 * function is a deterministic function of its arguments. Extracted from the
 * recovery orchestrator to isolate the decision inputs from the transactional
 * executors.
 */

export function inArrayValue<T>(value: T, allowed: readonly T[]): boolean {
  return allowed.includes(value);
}

export function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isCanonicalUtcIsoTimestamp(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function processIdentityForProvider(process: ProviderRunProcess): ProcessIdentity | null {
  if (
    process.pid === null
    || process.processNonce === null
    || process.processStartTime === null
    || process.processPgid === null
    || process.processCwd === null
    || process.processCommandJson === null
  ) return null;
  let command: unknown;
  try {
    command = JSON.parse(process.processCommandJson);
  } catch {
    return null;
  }
  if (!Array.isArray(command) || !command.every((item) => typeof item === "string")) return null;
  return {
    pid: process.pid,
    ppid: process.processPpid ?? process.ppid,
    pgid: process.processPgid,
    nonce: process.processNonce,
    processStartTime: process.processStartTime,
    cwd: process.processCwd,
    command,
  };
}

export function sameFence(
  left: Pick<typeof runs.$inferSelect, "leaseToken" | "attemptNo">,
  right: Pick<typeof pipelineJobs.$inferSelect, "leaseToken" | "attemptNo">,
): boolean {
  return left.leaseToken === right.leaseToken && left.attemptNo === right.attemptNo;
}

const canonicalOwnershipPhases: Readonly<Record<string, string>> = {
  intake: "intake",
  prd: "intake",
  prdbriefing: "intake",
  prdbriefingquestions: "intake",
  prdbriefingdraft: "intake",
  prdbriefingfinalreview: "intake",
  spec: "spec",
  speccritic: "spec",
  specbattle: "spec",
  techspec: "tech_spec",
  generatetechspec: "tech_spec",
  plan: "generate_plan",
  generateplan: "generate_plan",
  testplan: "test_plan",
  generatetestplan: "test_plan",
  build: "implement",
  implement: "implement",
  fix: "fix_findings",
  fixfindings: "fix_findings",
  review: "review",
  check: "local_check",
  qa: "local_check",
  localcheck: "local_check",
  merge: "release",
  release: "release",
  retro: "retro",
};

export function canonicalOwnershipPhase(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return canonicalOwnershipPhases[normalized] ?? normalized;
}

export function providerOwnershipMatchesRun(
  provider: ProviderRunProcess,
  run: typeof runs.$inferSelect,
): boolean {
  return provider.runId === run.id
    && provider.changeId === run.changeId
    && canonicalOwnershipPhase(provider.phase) === canonicalOwnershipPhase(run.phase)
    && provider.jobId === run.jobId
    && provider.leaseToken === run.leaseToken
    && provider.attemptNo === run.attemptNo;
}

export function processIdentitiesMatch(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid
    && left.ppid === right.ppid
    && left.pgid === right.pgid
    && left.nonce === right.nonce
    && left.processStartTime === right.processStartTime
    && left.cwd === right.cwd
    && JSON.stringify(left.command) === JSON.stringify(right.command);
}

export function providerFreshnessMatches(
  expected: ProviderRunProcess,
  current: ProviderRunProcess | null,
): boolean {
  return current !== null
    && current.changeId === expected.changeId
    && canonicalOwnershipPhase(current.phase) === canonicalOwnershipPhase(expected.phase)
    && current.status === expected.status
    && current.lastHeartbeatAt === expected.lastHeartbeatAt
    && current.leaseToken === expected.leaseToken
    && current.attemptNo === expected.attemptNo
    && current.jobId === expected.jobId
    && current.workerId === expected.workerId
    && current.startedAt === expected.startedAt
    && current.endedAt === expected.endedAt;
}

export function jobFreshnessMatches(
  expected: typeof pipelineJobs.$inferSelect | null,
  current: typeof pipelineJobs.$inferSelect | null,
): boolean {
  if (expected === null || current === null) return expected === current;
  return current.status === expected.status
    && current.heartbeatAt === expected.heartbeatAt
    && current.leaseExpiresAt === expected.leaseExpiresAt
    && current.leaseToken === expected.leaseToken
    && current.attemptNo === expected.attemptNo
    && current.leasedBy === expected.leasedBy
    && current.workerNonce === expected.workerNonce
    && current.startedAt === expected.startedAt
    && current.endedAt === expected.endedAt;
}

export function strongIdentityMatchesAfterReparent(
  expected: ProcessIdentity,
  observed: ProcessIdentity,
): boolean {
  return observed.pid === expected.pid
    && observed.pgid === expected.pgid
    && observed.processStartTime === expected.processStartTime
    && observed.cwd === expected.cwd
    && JSON.stringify(observed.command) === JSON.stringify(expected.command);
}

export function hasValidExternalRef(provider: ProviderRunProcess): boolean {
  return typeof provider.externalRef === "string"
    && provider.externalRef.trim().length > 0
    && provider.externalRef.length <= 512;
}

/**
 * Age of the provider's last heartbeat at `observedAt`, or null when neither
 * the heartbeat nor the start timestamp parses. `heartbeatIsStale` is defined
 * in terms of this so a recorded age and a staleness verdict can never
 * disagree about the same row.
 */
export function providerHeartbeatAgeMs(
  provider: ProviderRunProcess,
  observedAt: Date,
): number | null {
  const heartbeatMs = Date.parse(provider.lastHeartbeatAt ?? provider.startedAt);
  return Number.isFinite(heartbeatMs) ? observedAt.getTime() - heartbeatMs : null;
}

export function heartbeatIsStale(provider: ProviderRunProcess, observedAt: Date, staleMs: number): boolean {
  const ageMs = providerHeartbeatAgeMs(provider, observedAt);
  return ageMs === null || ageMs >= staleMs;
}

/**
 * Age of the job's heartbeat at `observedAt`, independent of job status, or
 * null when there is no job row or no parseable timestamp. Paired with
 * `jobHeartbeatIsFresh` the same way the provider helpers are paired.
 */
export function jobHeartbeatAgeMs(
  job: typeof pipelineJobs.$inferSelect | null,
  observedAt: Date,
): number | null {
  if (!job) return null;
  const heartbeatMs = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.createdAt);
  return Number.isFinite(heartbeatMs) ? observedAt.getTime() - heartbeatMs : null;
}

export function jobHeartbeatIsFresh(
  job: typeof pipelineJobs.$inferSelect | null,
  observedAt: Date,
  staleMs: number,
): boolean {
  if (!job || !inArrayValue(job.status, ["leased", "running"])) return false;
  const ageMs = jobHeartbeatAgeMs(job, observedAt);
  return ageMs !== null && ageMs < staleMs;
}
