import { getAiEngine } from "./ai-engine-adapter";
import type { AiEngineAdapter, AiProvider, AiRunLifecycleSink, AiRunPhase } from "./ai-engine-types";
import type { RunPhase } from "../types";
import {
  finishProviderRun,
  type ProviderRunPhase,
  type ProviderRunTerminalStatus,
} from "./provider-run-lifecycle-service";
import {
  heartbeatProviderLease,
  leaseProviderProcess,
} from "./provider-process-lease-service";
import {
  activeProviderRegistry,
  type ActiveProviderRegistry,
} from "./active-provider-registry";
import type { JobExecutionContext } from "./job-execution-context";
import { assertCompleteExecutionContext } from "./execution-fence-service";
import {
  DEFAULT_AI_PROVIDER_TIMEOUT_MS,
  MAX_NODE_TIMER_DELAY_MS,
  resolveAiProviderTimeoutMs,
} from "./ai-timeout-policy";

export type EngineProvider = AiProvider;
export type EngineFactory = (provider: EngineProvider) => AiEngineAdapter | Promise<AiEngineAdapter>;

export const DEFAULT_DOCUMENT_STAGE_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;
export const DEFAULT_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS = 30 * 1000;
export const MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS = 5 * 60 * 1000;
export { MAX_NODE_TIMER_DELAY_MS };
export const DEFAULT_TEST_PLAN_STAGE_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;
export const DEFAULT_BUILD_STREAM_START_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_REVIEW_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

let pipelineEngineFactory: EngineFactory | null = null;
let documentStageTimeoutMsForTest: number | null = null;
let documentStageTimeoutCleanupGraceMsForTest: number | null = null;
let reviewTimeoutMsForTest: number | null = null;

export function setPipelineEngineFactoryForTest(factory: EngineFactory | null): void {
  pipelineEngineFactory = factory;
}

export function setDocumentStageTimeoutMsForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError("Document stage timeout must be a positive safe integer");
  }
  if (timeoutMs !== null && timeoutMs > MAX_NODE_TIMER_DELAY_MS) {
    throw new RangeError("Document stage timeout exceeds the Node timer maximum");
  }
  documentStageTimeoutMsForTest = timeoutMs;
}

export function setDocumentStageTimeoutCleanupGraceMsForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError("Document stage timeout cleanup grace must be a positive finite number");
  }
  if (timeoutMs !== null && !Number.isSafeInteger(timeoutMs)) {
    throw new RangeError("Document stage timeout cleanup grace must be a positive safe integer");
  }
  documentStageTimeoutCleanupGraceMsForTest = timeoutMs;
}

function strictPositiveSafeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function documentStageTimeoutMs(phase?: RunPhase): number {
  const fallback = phase === "test_plan"
    ? DEFAULT_TEST_PLAN_STAGE_TIMEOUT_MS
    : DEFAULT_DOCUMENT_STAGE_TIMEOUT_MS;
  const configured = documentStageTimeoutMsForTest !== null
    ? documentStageTimeoutMsForTest
    : phase === "test_plan"
      ? resolveAiProviderTimeoutMs("STAGEPASS_TEST_PLAN_TIMEOUT_MS", fallback)
      : resolveAiProviderTimeoutMs("STAGEPASS_DOCUMENT_STAGE_TIMEOUT_MS", fallback);
  const maxProviderTimeout = MAX_NODE_TIMER_DELAY_MS - documentStageTimeoutCleanupGraceMs();
  return configured <= maxProviderTimeout ? configured : fallback;
}

export function documentStageTimeoutCleanupGraceMs(): number {
  if (documentStageTimeoutCleanupGraceMsForTest !== null) {
    return Math.min(
      documentStageTimeoutCleanupGraceMsForTest,
      MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
    );
  }
  const configured = strictPositiveSafeIntegerEnv(
    "STAGEPASS_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS",
    DEFAULT_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
  );
  return Math.min(configured, MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS);
}

export function documentStageWatchdogTimeoutMs(phase?: RunPhase): number {
  return Math.min(
    documentStageTimeoutMs(phase) + documentStageTimeoutCleanupGraceMs(),
    MAX_NODE_TIMER_DELAY_MS,
  );
}

export function setReviewTimeoutMsForTest(timeoutMs: number | null): void {
  reviewTimeoutMsForTest = timeoutMs;
}

interface ProviderLifecycleBaseContext {
  changeId: string;
  runId: string;
  phase: AiRunPhase | RunPhase | ProviderRunPhase;
  provider: AiProvider;
  roundId?: string | null;
  closeBusinessRunOnProviderFailure?: boolean;
}

export interface ProviderLifecycleContext
  extends ProviderLifecycleBaseContext, Omit<JobExecutionContext, "provider"> {}

export function providerRunPhaseFromAiPhase(
  phase: AiRunPhase | RunPhase | ProviderRunPhase,
): ProviderRunPhase {
  switch (phase) {
    case "plan":
      return "generate_plan";
    case "fix":
      return "fix_findings";
    default:
      return phase as ProviderRunPhase;
  }
}

function dateFromIso(value: string): Date {
  return new Date(value);
}

function terminalStatusFromLifecycle(
  status: "completed" | "failed" | "stopped",
): ProviderRunTerminalStatus {
  return status;
}

type LifecyclePersistenceStatus = "idle" | "in_flight" | "completed";

interface LifecyclePersistenceState {
  status: LifecyclePersistenceStatus;
  inFlight: Promise<void> | null;
}

function createLifecyclePersistenceState(): LifecyclePersistenceState {
  return { status: "idle", inFlight: null };
}

function runLifecyclePersistence(
  state: LifecyclePersistenceState,
  operation: () => void | Promise<void>,
): Promise<void> {
  if (state.status === "completed") return Promise.resolve();
  if (state.status === "in_flight") return state.inFlight!;

  const inFlight = Promise.resolve().then(operation);
  state.status = "in_flight";
  state.inFlight = inFlight;
  void inFlight.then(
    () => {
      if (state.inFlight !== inFlight) return;
      state.status = "completed";
      state.inFlight = null;
    },
    () => {
      if (state.inFlight !== inFlight) return;
      state.status = "idle";
      state.inFlight = null;
    },
  );
  return inFlight;
}

export function createProviderLifecycleSink(
  input: ProviderLifecycleContext,
  registry: ActiveProviderRegistry = activeProviderRegistry,
): AiRunLifecycleSink {
  assertCompleteExecutionContext(input);
  const phase = providerRunPhaseFromAiPhase(input.phase);
  const executionContext: JobExecutionContext = {
    jobId: input.jobId,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    attemptNo: input.attemptNo,
  };
  const registrationId = [
    input.runId,
    phase,
    input.provider,
    executionContext.leaseToken,
    executionContext.attemptNo,
  ].join(":");
  const started = createLifecyclePersistenceState();
  const terminal = createLifecyclePersistenceState();
  const assertLifecycleProvider = (eventProvider: AiProvider): void => {
    if (eventProvider !== input.provider) {
      throw new Error(
        `provider_lifecycle_mismatch: expected ${input.provider}, received ${eventProvider}`,
      );
    }
  };

  const onTerminal: AiRunLifecycleSink["onTerminal"] = (event) => {
    assertLifecycleProvider(event.provider);
    if (started.status !== "completed") return Promise.resolve();
    return runLifecyclePersistence(terminal, () => {
      const finishInput = {
        runId: input.runId,
        phase,
        status: terminalStatusFromLifecycle(event.status),
        pid: event.pid,
        exitCode: event.exitCode,
        signal: event.signal,
        summary: event.summary,
        endedAt: dateFromIso(event.endedAt),
        closeBusinessRun: input.closeBusinessRunOnProviderFailure,
        executionContext,
      };
      finishProviderRun(finishInput);
      registry.unregister(registrationId);
    });
  };

  return {
    onProcessStarted(event) {
      assertLifecycleProvider(event.provider);
      return runLifecyclePersistence(started, async () => {
        const leaseInput = {
          ...executionContext,
          changeId: input.changeId,
          runId: input.runId,
          phase,
          provider: event.provider,
          pid: event.pid,
          ppid: event.ppid,
          externalRef: event.externalRef ?? null,
          identity: event.identity ?? null,
          leasedAt: dateFromIso(event.startedAt),
        };
        await leaseProviderProcess(leaseInput);

        if (event.identity && event.pid !== null) {
          registry.register({
            registrationId,
            ownerPid: event.ppid,
            identity: event.identity,
            onStopped(signal) {
              return onTerminal({
                provider: event.provider,
                pid: event.pid,
                signal,
                status: "stopped",
                summary: `Provider stopped after parent received ${signal}`,
                endedAt: new Date().toISOString(),
              });
            },
          });
        }
      });
    },
    onHeartbeat(event) {
      assertLifecycleProvider(event.provider);
      if (started.status !== "completed" || terminal.status !== "idle") return;
      const heartbeatInput = {
        ...executionContext,
        runId: input.runId,
        observedAt: dateFromIso(event.observedAt),
      };
      heartbeatProviderLease(heartbeatInput);
    },
    onTerminal,
  };
}

export async function getPipelineEngine(provider: EngineProvider): Promise<AiEngineAdapter> {
  if (pipelineEngineFactory) {
    return pipelineEngineFactory(provider);
  }

  return getAiEngine(provider);
}

export function buildStreamStartTimeoutMs(): number {
  const raw = process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS;
  if (!raw) return DEFAULT_BUILD_STREAM_START_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BUILD_STREAM_START_TIMEOUT_MS;
}

export function resolveReviewTimeoutMs(): number {
  if (reviewTimeoutMsForTest !== null) return reviewTimeoutMsForTest;
  return resolveAiProviderTimeoutMs("STAGEPASS_REVIEW_TIMEOUT_MS", DEFAULT_REVIEW_TIMEOUT_MS);
}
