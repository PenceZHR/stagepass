import { eq } from "drizzle-orm";
import { db } from "../db";
import { changes } from "../db/schema";
import { createChildLogger } from "../logger";
import type { ChangeStatus, RunPhase } from "../types";
import {
  generatePlan,
  approvePlan,
  runImplement,
  runCheck,
  runFix,
  runReview,
} from "./pipeline-service";
import { getStageAuthority } from "./stage-authority-service";
import { transitionChangeStatus } from "./change-status-service";
import { stopActiveRunsAndSetStatus } from "./pipeline-run-ledger-service";
import type { JobExecutionContext } from "./job-execution-context";

const log = createChildLogger("graph-runner");

function getChange(changeId: string) {
  return db.select().from(changes).where(eq(changes.id, changeId)).get();
}

function phaseFromStatus(status: string): RunPhase {
  const map: Record<string, RunPhase> = {
    REFINING: "refine",
    DRAFT: "refine",
    PLANNING: "generate_plan",
    PLAN_READY: "generate_plan",
    PLAN_APPROVED: "generate_plan",
    IMPLEMENTING: "implement",
    IMPLEMENTED: "implement",
    CHECKING: "local_check",
    CHECK_FAILED: "local_check",
    SCOPE_FAILED: "local_check",
    LOCAL_READY: "local_check",
    FIXING: "fix_findings",
    BLOCKED: "local_check",
  };
  return map[status] ?? "local_check";
}

function setStatus(changeId: string, status: ChangeStatus, blockedPhase?: RunPhase | null) {
  transitionChangeStatus({
    changeId,
    to: status,
    blockedPhase,
    message: `GraphRunner status -> ${status}`,
    rawJson: { source: "graph_runner" },
  });
}

export class GraphRunner {
  async generatePlan(changeId: string, context: JobExecutionContext) {
    return generatePlan(changeId, context);
  }

  async approvePlan(changeId: string) {
    return approvePlan(changeId, { source: "route_preflight" });
  }

  async implement(changeId: string, context: JobExecutionContext) {
    return runImplement(changeId, context);
  }

  async runLocalCheck(changeId: string, context: JobExecutionContext) {
    return runCheck(changeId, context, { entrypoint: "graph_runner", actor: "system" });
  }

  async review(changeId: string, context: JobExecutionContext) {
    return runReview(changeId, context);
  }

  async fixFindings(changeId: string, context: JobExecutionContext) {
    return runFix(changeId, context);
  }

  async stopCurrentRun(changeId: string) {
    const change = getChange(changeId);
    if (!change) throw new Error(`Change not found: ${changeId}`);

    const rollbackMap: Record<string, ChangeStatus> = {
      IMPLEMENTING: "PLAN_APPROVED",
      FIXING: "CHECK_FAILED",
      CHECKING: "PLAN_APPROVED",
    };

    const target = rollbackMap[change.status as string];
    if (!target) {
      throw new Error(
        `Cannot stop: change is in ${change.status}, not a running state`
      );
    }

    // Mark active runs as stopped and roll the status back in one transaction --
    // otherwise a crash in between leaves every run `stopped` (terminal) with
    // the status still at the running phase, invisible to recovery.
    stopActiveRunsAndSetStatus({
      changeId,
      status: target,
      message: `GraphRunner status -> ${target}`,
      rawJson: { source: "graph_runner" },
    });
    log.info({ changeId, from: change.status, to: target }, "Run stopped");
  }

  async blockChange(changeId: string, reason: string, phase?: RunPhase) {
    const change = getChange(changeId);
    if (!change) throw new Error(`Change not found: ${changeId}`);

    if (change.status === "BLOCKED") {
      throw new Error("Change is already blocked");
    }

    // Stop any running runs and set BLOCKED in one transaction (see stopCurrentRun).
    stopActiveRunsAndSetStatus({
      changeId,
      status: "BLOCKED",
      blockedPhase: phase ?? phaseFromStatus(change.status),
      message: "GraphRunner status -> BLOCKED",
      rawJson: { source: "graph_runner" },
    });
    log.info({ changeId, reason }, "Change blocked");
  }

  async markLocalReady(changeId: string) {
    const change = getChange(changeId);
    if (!change) throw new Error(`Change not found: ${changeId}`);

    if (change.status !== "CHECKING") {
      throw new Error(
        `Cannot mark LOCAL_READY from ${change.status}. Must be CHECKING.`
      );
    }

    const qaGate = getStageAuthority(changeId, "QA").latestGate;
    if (!qaGate || (qaGate.status !== "passed" && qaGate.status !== "passed_with_warnings")) {
      throw new Error(`Cannot mark LOCAL_READY before QA gate passes: ${qaGate?.status ?? "missing"}`);
    }

    setStatus(changeId, "LOCAL_READY");
    log.info({ changeId }, "Marked LOCAL_READY");
  }
}

let instance: GraphRunner | null = null;

export function getGraphRunner(): GraphRunner {
  if (!instance) {
    instance = new GraphRunner();
  }
  return instance;
}
