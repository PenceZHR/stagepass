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
  /*
   * Arch **是这次改动的完整技术架构**（2026-08-08 TechSpec 并进来，见
   * domain/phase.ts 的 RETIRED_PHASES）。十节见 ARCH_SECTIONS。
   *
   * 这段话里的 "down to file paths and function names" 是承重的：老的那一版说的是
   * "which modules it touches"，而**问到哪一层就只会答到哪一层** —— 真机产出因此
   * 停在模块层，人看完说「太宽泛」。
   */
  Arch: "Design the complete technical architecture for this change, down to file paths"
    + " and function names: which modules and files it touches or adds (with paths), what"
    + " each file exports (by name) and who calls it, how data is stored and how state"
    + " moves, the signature of every cross-module function, which dependency edges are"
    + " new (as file-imports-file, each with why it cannot be avoided), what each module"
    + " does and does not expose, at least one considered-but-rejected alternative plus"
    + " the price of the one you chose, the single riskiest part, and how each decision"
    + " traces back to the approved Spec."
    + " Leave only step ordering and code-writing to the downstream phases -- function"
    + " names, signatures and data structures belong in this document.",
  // 退休了（并进 Arch）。留一句话是因为 PhaseInstructions 要每个阶段都有；
  // 没有 Change 会再走到它。
  TechSpec: "This phase has been merged into Arch and is no longer used.",
  Plan: "Break the approved design into executable steps, each with its expected blast radius and how it will be verified.",
  /*
   * §8.7·1（用户 2026-08-06 拍）：TestPlan 交方案**和测试代码**，自己不跑 ——
   * 「肯定是 build 做完了跑 test」。执行在 Build 的蓝方，时点在红方写完之后，
   * 所以「怎么跑」那一节必须细到不在场的人照着能跑。
   */
  TestPlan: "State what must be verified before this change can ship, and deliver both"
    + " the test plan and the test code -- automated where possible, manual where not."
    + " Do NOT run the tests: they are executed after Build, by someone else, following"
    + " your own how-to-run instructions.",
  // 「跑一遍并交出证据」是被 rubric 判的（domain/rubric-defaults.ts 的 Build 那几条），
  // 所以它必须**被要求**。判它的蓝方跑不了东西 —— 不写在这里，就是在罚模型没做一件
  // 没人让它做的事，而那正是「模型答不出它没被问过的题」。
  //
  // 2026-08-04 同一条规矩又用了一次：Build 的 rubric 加了四条编码规范（风格一致、
  // 命名对齐上游、一处定义、不明显的决定写为什么），**所以这四件事也必须在这里被
  // 要求**。只加判据不加要求，就是回到上面那句话要防的事。
  /*
   * ## 2026-08-06 拍的 Build 分工：红方**看不到测试**
   *
   * 测试是 TestPlan 交的，跑它们的是这一轮的蓝方（红方写完之后）—— 红方拿到的
   * 反馈是「哪条失败、输出是什么」，对着一个不可见的判据做 TDD。所以这里明令
   * 不读、不改、不跑测试代码；「自己跑一遍」保留，但跑的是改动本身（编译、
   * 启动、手动走一遍改的路径），不是测试套件。
   */
  Build: "Implement the approved plan. Change nothing outside the files the plan allows."
    + " Do NOT read, modify, delete or run any test code: the tests were delivered by"
    + " TestPlan and are executed by someone else after you finish -- you will be told"
    + " which cases failed and what they printed."
    + " Match the surrounding code and its direct callers: naming, error handling and file"
    + " placement follow what is already there -- do not start a second style in the same repo."
    + " Use the words the approved Spec and TechSpec already use; do not invent a second name"
    + " for a concept they have named. Keep one definition per rule -- where the logic already"
    + " exists, call it instead of copying it. Wherever a decision is not obvious, leave the"
    + " reason in the code."
    + " Run what you changed (build it, start it, walk the changed path) and report the"
    + " exact command and its output -- unreported means unverified.",
  // Review 的产出是一份**报告**，而它必须写清审的是哪个 commit —— 审 A 不等于审 B，
  // 而下一轮、下一个阶段都要知道这份意见是对着哪一版说的。
  // 缺陷本身另有去处：Review 里红方报的 blockers 会进 gaps（domain/phase.ts 的
  // `redReviewsOthers`），所以这里要它「报出来」而不是「写进正文」。
  Review: "Review the code produced by Build, independently. Write a review report"
    + " naming the commit you reviewed, and report every defect you find as a blocker,"
    + " by severity -- each one naming the file and position.",
  Fix: "Fix the blocking problems that were reported. Change nothing beyond what they require.",
  // QA 的产出是一份**报告**，而它必须写清测的是哪个 commit —— 和 Review 同一个理由。
  // 失败的用例另有去处：QA 里红方报的 blockers 会进 gaps（`redReviewsOthers`）。
  // 反方在这一阶段可以自己跑，所以「我跑了」这句话是**会被复核的**。
  QA: "Run the approved test plan against the code produced by Build. Write a QA report"
    + " naming the commit you tested and the exact commands you ran, and report every"
    + " failure as a blocker -- each one with the case it came from and the actual output.",
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
