import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import {
  parseTurnResult,
  RESULT_CONTRACT,
  TurnResultUnparsableError,
  type TurnRequest,
} from "../domain/turn";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { TurnStore } from "../store/turn-store";
import type { Job } from "../work/job-store";
import type { TurnOutcome, TurnRunner } from "../work/turn-loop";
import type { CodexTransport } from "./transport";

/**
 * L1's `TurnRunner`, backed by Codex.
 *
 * L1 proved the loop around this with a scripted runner. This is the same seam
 * filled in: bind the Change to its thread, write the turn down, send it, read
 * the answer through StagePass's contract. Nothing about the loop changes.
 *
 * ## Order is the durability guarantee
 *
 *   allocate -> markDispatched -> send -> markCompleted -> parse
 *
 * The record exists before anything leaves the process, so a crash mid-flight
 * leaves a `dispatched` row that recovery can see rather than no evidence that
 * work ever happened. Parsing comes last so a malformed answer is a failed turn
 * whose response is still on disk to look at.
 */

export type PhaseInstructions = Readonly<Record<Phase, string>>;

/**
 * What each phase asks for, before the adversarial rounds exist.
 *
 * Minimal on purpose and honest about it: L4 replaces this map with the
 * red/blue/judge instructions. It is not a placeholder in the sense that
 * matters -- every entry is a real instruction that produces a real result --
 * it is simply the shortest correct version.
 */
export const MINIMAL_PHASE_INSTRUCTIONS: PhaseInstructions = {
  PRD: "Write the product requirement for this change: who it is for, what outcome it must produce, and what is out of scope.",
  Spec: "Turn the approved PRD into a product specification. Name every behaviour a user can observe, and every case the PRD leaves undecided.",
  TechSpec: "Turn the approved specification into a technical design: system behaviour, constraints, blast radius, and the main risks.",
  Plan: "Break the approved design into executable steps, each with its expected blast radius and how it will be verified.",
  TestPlan: "State what must be verified before this change can ship, and how -- automated where possible, manual where not.",
  Build: "Implement the approved plan. Change nothing outside the files the plan allows.",
  Review: "Review the adopted code independently. Report every defect you find, by severity.",
  Fix: "Fix the blocking problems that were reported. Change nothing beyond what they require.",
  QA: "Run the approved test plan against the current code and report what actually happened.",
  Merge: "Summarise requirements, design, implementation, review and test facts, and state whether anything still blocks delivery.",
  Retro: "Record what worked, what went wrong, and what should carry into the next change.",
  Done: "Write the delivery note: what was built, how to use it, what changed, and what is knowingly still open.",
};

export interface CodexTurnRunnerOptions {
  readonly database: Database.Database;
  readonly transport: CodexTransport;
  readonly instructions?: PhaseInstructions;
  readonly now?: () => Date;
  /** Turn id for a job. Injected so tests are deterministic. */
  readonly turnId?: (job: Job) => string;
}

export class CodexTurnRunner implements TurnRunner {
  private readonly bindings: BindingStore;
  private readonly turns: TurnStore;
  private readonly changes: ChangeStore;
  private readonly instructions: PhaseInstructions;
  private readonly turnId: (job: Job) => string;

  constructor(private readonly options: CodexTurnRunnerOptions) {
    const now = options.now ?? (() => new Date());
    this.bindings = new BindingStore(options.database, now);
    this.turns = new TurnStore(options.database, now);
    this.changes = new ChangeStore(options.database, { now });
    this.instructions = options.instructions ?? MINIMAL_PHASE_INSTRUCTIONS;
    this.turnId = options.turnId
      ?? ((job) => `TURN-${job.id}-${job.attempt}`);
  }

  async run(job: Job): Promise<TurnOutcome> {
    const phase = this.changes.read(job.changeId).state.phase;
    const request: TurnRequest = {
      changeId: job.changeId,
      phase,
      prompt: this.promptFor(phase),
    };
    // Written down before anything leaves this process.
    const turn = this.turns.allocate({
      id: this.turnId(job),
      jobId: job.id,
      request,
    });

    // Null on a Change's first turn: the thread does not exist until the turn
    // that creates it comes back.
    const existing = this.bindings.find(job.changeId, phase);
    const threadId = existing?.status === "bound" ? existing.threadId : null;
    this.turns.markDispatched(turn.id, threadId);

    let delivery: { threadId: string; text: string };
    try {
      delivery = await this.options.transport.runTurn({
        threadId,
        prompt: request.prompt,
      });
    } catch (error) {
      throw this.failTurn(turn.id, "turn_dispatch_failed", error);
    }
    this.turns.markCompleted(turn.id, delivery.text, delivery.threadId);
    // Bound after the fact, from the thread the turn actually ran on. Binding
    // a guess beforehand would leave a Change pointing at a thread that was
    // never created when the turn failed.
    try {
      this.bindings.bind(job.changeId, phase, delivery.threadId);
    } catch {
      // NOT marked failed: the turn completed and its answer is on disk. Only
      // the job fails, which is what L1 records. Calling markFailed here would
      // throw on its own precondition and bury the real cause.
      throw new Error("thread_binding_conflict");
    }

    try {
      const result = parseTurnResult(delivery.text);
      return {
        artifactIds: result.artifactIds,
        blockers: result.blockers,
      };
    } catch (error) {
      // The turn completed -- the response is on disk -- but it said nothing
      // this system can act on. That is a failure with a name, not an empty
      // result that would settle the phase with no artifacts and no reason.
      if (error instanceof TurnResultUnparsableError) throw new Error(error.code);
      throw error;
    }
  }

  private promptFor(phase: Phase): string {
    // The contract travels with every turn. A turn dispatched without it is a
    // turn whose answer cannot be read, and the failure surfaces far from here.
    return `${this.instructions[phase]}\n\n${RESULT_CONTRACT}`;
  }

  private failTurn(turnId: string, code: string, cause: unknown): Error {
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.turns.markFailed(turnId, `${code}: ${detail}`);
    return new Error(code);
  }
}
