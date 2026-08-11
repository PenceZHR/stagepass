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
  // 退休了（环 v3 改名成 BuildPlan）。同上，留一句话给类型，没有 Change 会走到。
  Plan: "This phase has been renamed to BuildPlan and is no longer used.",
  BuildPlan: "Break the approved design into executable steps, each with its expected blast radius and how it will be verified.",
  /*
   * 环 v3（2026-08-09）：TestPlan 收窄成**纯方案**，测试代码归 Test 阶段。
   * 两轨互盲 —— 它只从 Arch 推导，看不到 BuildPlan/Build；跑测试的是 QA。
   */
  TestPlan: "State what must be verified before this change can ship, as a test plan:"
    + " map every acceptance criterion to concrete cases (each with an id, its inputs,"
    + " expected output, and the file it will land in). Do NOT write or run test code:"
    + " the Test phase writes it from this plan, and QA executes it.",
  // 「跑一遍并交出证据」是被 rubric 判的（domain/rubric-defaults.ts 的 Build 那几条），
  // 所以它必须**被要求**。判它的蓝方跑不了东西 —— 不写在这里，就是在罚模型没做一件
  // 没人让它做的事，而那正是「模型答不出它没被问过的题」。
  //
  // 2026-08-04 同一条规矩又用了一次：Build 的 rubric 加了四条编码规范（风格一致、
  // 命名对齐上游、一处定义、不明显的决定写为什么），**所以这四件事也必须在这里被
  // 要求**。只加判据不加要求，就是回到上面那句话要防的事。
  /*
   * ## 环 v3（2026-08-09）：两轨互盲，Build 对测试**全盲**
   *
   * 2026-08-06 那版还许诺「你会被告知哪条失败」（蓝方跑测试）—— v3 里跑测试整个
   * 挪到 QA，Build 侧从写到判都看不见测试：看得见就会向测试过拟合，QA 的绿就从
   * 证据退化成靶子。所以明令不读、不写、不跑任何测试代码；「自己跑一遍」保留，
   * 但跑的是改动本身（编译、启动、手动走一遍改的路径），不是测试套件。
   */
  Build: "Implement the approved plan. Change nothing outside the files the plan allows."
    + " Do NOT read, write, modify, delete or run any test code: tests are written on a"
    + " separate track you cannot see, and are executed against your code later, at QA."
    + " Match the surrounding code and its direct callers: naming, error handling and file"
    + " placement follow what is already there -- do not start a second style in the same repo."
    + " Use the words the approved Spec and Arch already use; do not invent a second name"
    + " for a concept they have named. Keep one definition per rule -- where the logic already"
    + " exists, call it instead of copying it. Wherever a decision is not obvious, leave the"
    + " reason in the code."
    + " Run what you changed (build it, start it, walk the changed path) and report the"
    + " exact command and its output -- unreported means unverified.",
  /*
   * Test = 测试轨的施工阶段（环 v3）。镜像互盲：只从 TestPlan 推导，不许读实现 ——
   * 测试读了实现就继承实现的盲区，QA 对撞出的一致就没有信息量了。
   * 「证明测试自己站得住」不等于跑实现：语法、依赖、fixture 齐不齐，干跑就知道。
   */
  Test: "Write the test code that the approved test plan specifies, case by case, each"
    + " landing in the file the plan names. Do NOT read the implementation being tested:"
    + " it is built on a separate track you cannot see, and your tests meet it later, at QA."
    + " Assert the expected outputs the plan wrote down, not whatever the code happens to do."
    + " Verify your test code stands on its own (syntax, dependencies, fixtures) without"
    + " running it against the implementation, and report exactly what you checked.",
  // 退休了（环 v3 收编进 QA）。留一句话给类型，没有 Change 会走到。
  Review: "This phase has been absorbed into QA and is no longer used.",
  // 退休了（环 v3：修复 = 打回重开的阶段自己的下一轮）。同上。
  Fix: "This phase has been retired; fixes are new rounds of the reopened phase.",
  /*
   * QA = 两轨对撞点（环 v3）：读（收编旧 Review 的静态审查）+ 跑（执行 Test 轨
   * 的测试）。变异那一攻批 5 进来。失败的用例进 blockers（`redReviewsOthers`）。
   * 反方在这一阶段可以自己跑，所以「我跑了」这句话是**会被复核的**。
   */
  QA: "This is where the two blind tracks collide. First review the code produced by"
    + " Build against its upstream documents, naming the commit you reviewed, and report"
    + " every defect you find as a blocker naming the file and position. Then run the"
    + " tests produced by Test against that code, following the test plan's how-to-run,"
    + " and report every failure as a blocker -- each one with the case it came from and"
    + " the actual output. Then attack the tests themselves, both directions, with"
    + " evidence: temporarily revert Build's change and the must-pass cases MUST go red"
    + " (restore afterwards); apply a behaviour-preserving mutation and the cases MUST"
    + " stay green. When code and tests disagree, say which side you believe is"
    + " wrong and why -- the human decides where it gets sent back.",
  // 退休了（环 v3：合并是 git 动作、复盘不承重、Done 是状态）。各留一句给类型。
  Merge: "This phase has been retired; merging is a git action guarded by the QA stamp.",
  Retro: "This phase has been retired; the ledger and rubric amendments are the retro.",
  Done: "This phase has been retired; QA approval closes the change.",
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
