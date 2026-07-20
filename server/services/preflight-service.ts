import { spawn } from "node:child_process";

import {
  actionContractRepository,
  createActionContractRepository,
  type ActionContractRepositoryDb,
} from "../repositories/action-contract-repository";
import {
  getActions,
  persistActionContract,
  type PipelineActionContract,
} from "./action-contract-service";
import { findPipelineJobByIdempotency } from "./job-dispatch-service";

const GIT_COMMAND_TIMEOUT_MS = 1_000;
const GIT_OUTPUT_CAP_BYTES = 64 * 1024;

export interface AssertActionAllowedInput {
  changeId: string;
  actionId: string;
  expectedGateVersion: string;
  expectedSourceDbHash: string;
  idempotencyKey?: string;
  expectedHeadSha?: string;
}

export interface PreflightErrorEnvelope {
  status: 409;
  error: "action_not_allowed";
  reasonCode: string | null;
  action: PipelineActionContract;
  actions: PipelineActionContract[];
}

let headProbeForTest: ((repoPath: string) => string | null) | null = null;
let preflightRepositoryDbForTest: ActionContractRepositoryDb | null = null;

export function setPreflightServiceDbForTest(nextDb: ActionContractRepositoryDb): () => void {
  const previous = preflightRepositoryDbForTest;
  preflightRepositoryDbForTest = nextDb;
  return () => {
    preflightRepositoryDbForTest = previous;
  };
}

export function setPreflightHeadProbeForTest(
  probe: (repoPath: string) => string | null,
): () => void {
  const previous = headProbeForTest;
  headProbeForTest = probe;
  return () => {
    headProbeForTest = previous;
  };
}

export class PreflightValidationError extends Error {
  public readonly status = 422;

  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PreflightValidationError";
  }
}

export class PreflightBlockedError extends Error {
  public readonly status = 409;

  constructor(public readonly envelope: PreflightErrorEnvelope) {
    super(envelope.action.reason ?? envelope.reasonCode ?? "action_not_allowed");
    this.name = "PreflightBlockedError";
  }
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PreflightValidationError("invalid_preflight_input", `${field} is required`);
  }
  return value;
}

async function currentGitHead(repoPath: string): Promise<string | null> {
  if (headProbeForTest) return headProbeForTest(repoPath);
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    child.stdin.end();
    let settled = false;
    let output = Buffer.alloc(0);
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const collect = (chunk: Buffer) => {
      if (settled) return;
      if (output.length + chunk.length > GIT_OUTPUT_CAP_BYTES) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      output = Buffer.concat([output, chunk]);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length > GIT_OUTPUT_CAP_BYTES) child.kill("SIGKILL");
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      const value = output.toString("utf8").trim();
      finish(code === 0 && /^[0-9a-f]{40}$/i.test(value) ? value : null);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, GIT_COMMAND_TIMEOUT_MS);
    timer.unref();
  });
}

function withAction(actions: PipelineActionContract[], action: PipelineActionContract) {
  return actions.map((candidate) => (candidate.actionId === action.actionId ? action : candidate));
}

export function actionNotAllowedEnvelope(
  changeId: string,
  actionId: string,
  override?: Pick<PipelineActionContract, "enabled" | "reasonCode" | "reason">,
): PreflightErrorEnvelope {
  const actions = getActions(changeId);
  const action = actions.find((candidate) => candidate.actionId === actionId);
  if (!action) {
    throw new PreflightValidationError("unknown_action", `Unknown action: ${actionId}`);
  }
  const nextAction = override ? { ...action, ...override } : action;
  persistActionContract(changeId, nextAction);
  return {
    status: 409,
    error: "action_not_allowed",
    reasonCode: nextAction.reasonCode,
    action: nextAction,
    actions: override ? withAction(actions, nextAction) : actions,
  };
}

function blocked(
  changeId: string,
  actionId: string,
  override?: Pick<PipelineActionContract, "enabled" | "reasonCode" | "reason">,
): never {
  throw new PreflightBlockedError(actionNotAllowedEnvelope(changeId, actionId, override));
}

function getRepoPath(changeId: string): string | null {
  if (preflightRepositoryDbForTest) {
    return createActionContractRepository(preflightRepositoryDbForTest).getRepoPathForChange(changeId);
  }
  return actionContractRepository.getRepoPathForChange(changeId);
}

export function assertActionAllowed(input: AssertActionAllowedInput): PipelineActionContract {
  const changeId = assertNonEmptyString(input.changeId, "changeId");
  const actionId = assertNonEmptyString(input.actionId, "actionId");
  const expectedGateVersion = assertNonEmptyString(
    input.expectedGateVersion,
    "expectedGateVersion",
  );
  const expectedSourceDbHash = assertNonEmptyString(
    input.expectedSourceDbHash,
    "expectedSourceDbHash",
  );
  if (input.expectedHeadSha !== undefined) {
    assertNonEmptyString(input.expectedHeadSha, "expectedHeadSha");
  }

  const actions = getActions(changeId);
  const action = actions.find((candidate) => candidate.actionId === actionId);
  if (!action) {
    throw new PreflightValidationError("unknown_action", `Unknown action: ${actionId}`);
  }
  if (action.requiresIdempotencyKey && !input.idempotencyKey?.trim()) {
    throw new PreflightValidationError(
      "missing_idempotency_key",
      `Idempotency key is required for ${actionId}`,
    );
  }

  const replay = input.idempotencyKey?.trim()
    ? findPipelineJobByIdempotency(changeId, input.idempotencyKey.trim())
    : null;
  if (replay) {
    if (replay.actionId !== actionId) {
      throw new PreflightValidationError(
        "idempotency_conflict",
        `Idempotency key is already bound to ${replay.actionId}`,
      );
    }
    return action;
  }

  if (!action.enabled) {
    blocked(changeId, action.actionId);
  }
  if (action.gateVersion !== expectedGateVersion) {
    blocked(changeId, action.actionId, {
      enabled: false,
      reasonCode: "gate_version_drift",
      reason: "Gate version drifted since the action contract was issued",
    });
  }
  if (action.sourceDbHash !== expectedSourceDbHash) {
    blocked(changeId, action.actionId, {
      enabled: false,
      reasonCode: "source_db_hash_drift",
      reason: "Source DB hash drifted since the action contract was issued",
    });
  }
  if (input.expectedHeadSha) {
    if (!headProbeForTest) {
      throw new PreflightValidationError(
        "async_git_probe_required",
        "Git HEAD validation requires assertActionAllowedAsync",
      );
    }
    const repoPath = getRepoPath(changeId);
    const head = repoPath ? headProbeForTest(repoPath) : null;
    if (!head || head !== input.expectedHeadSha) {
      blocked(changeId, action.actionId, {
        enabled: false,
        reasonCode: head ? "git_head_drift" : "git_head_unavailable",
        reason: head ? "Git HEAD drifted since the action contract was issued" : "Git HEAD could not be verified",
      });
    }
  }

  return action;
}

export async function assertActionAllowedAsync(
  input: AssertActionAllowedInput,
): Promise<PipelineActionContract> {
  const expectedHeadSha = input.expectedHeadSha;
  const action = assertActionAllowed({ ...input, expectedHeadSha: undefined });
  if (!expectedHeadSha) return action;

  assertNonEmptyString(expectedHeadSha, "expectedHeadSha");
  const repoPath = getRepoPath(input.changeId);
  const head = repoPath ? await currentGitHead(repoPath) : null;
  if (!head || head !== expectedHeadSha) {
    blocked(input.changeId, action.actionId, {
      enabled: false,
      reasonCode: head ? "git_head_drift" : "git_head_unavailable",
      reason: head ? "Git HEAD drifted since the action contract was issued" : "Git HEAD could not be verified",
    });
  }
  return action;
}
