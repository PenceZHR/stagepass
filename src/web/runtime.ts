import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { AppServerHistory } from "../codex/app-server-history";
import { AppServerClient } from "../codex/app-server-client";
import { AppServerSessionHost } from "../codex/app-server-transport";
import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/phase-instructions";
import { childThreadsOf, readThreadTranscript, readThreadUserMessages } from "../codex/subagent";
import type { Phase } from "../domain/phase";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ParallelStore } from "../store/parallel-store";
import { RoundNoteStore } from "../store/round-note-store";
import { RubricStore } from "../store/rubric-store";
import { HandoffStore } from "../store/handoff-store";
import { WorklistStore } from "../store/worklist-store";
import type { CodexTransport } from "../codex/transport";
import { createProcessOps, type ProcessOps } from "../system/process";
import { createSlotFiles } from "../system/slot-files";
import { JobStore } from "../work/job-store";
import type { RepoOps } from "../work/repo";
import { RoundTurnRunner } from "../work/round-turn-runner";
import { TurnLoop } from "../work/turn-loop";
import { nudgeAfterRound } from "./nudge";
import { ASIDE, PluginSeats, workspaceOf } from "./seats";

/**
 * 插件这一侧的执行通道 —— 一轮真的怎么跑起来。
 *
 * ## 和旧面板的差别只有一处，但那一处是全部
 *
 * 旧的一轮跑在**人开的那个 Terminal 窗口**里：StagePass 往窗口里打字，再轮询历史等
 * 它出现。插件里没有窗口可打字，所以现在直接开一条 Codex 会话
 * （`thread/start` + `turn/start`，见 `seats.ts`）。**人仍然看得见它** —— 那条线程
 * 带 `threadSource:"user"`，落在 Codex App 的项目分类里，点开就是。
 *
 * ## 进程是懒起的
 *
 * `codex app-server daemon` 只在**第一次真要跑一轮**时才拉起来。只看不跑的会话
 * 一个子进程都不起 —— 「打开面板看一眼」不该在机器上留下任何东西。
 *
 * ## 审批现在归 StagePass，这是一个还没定的问题
 *
 * StagePass 起的 turn，它自己就是订阅者，所以审批 / elicitation 会打回**这条控制
 * 连接**，而不是打给在 App 里看着的人。这里把它们交给 `AppServerSessionHost` 按
 * threadId 路由到对应会话（会话会把它们记进 `interactions`），**但目前没有任何界面
 * 在答它们** —— 于是一个要审批的 turn 会停在那里，`quietForMs` 会显示它很久没动静。
 *
 * 两条出路：给 StagePass 起的 turn 设一个不问的 `approvalPolicy`，或者把待答的
 * interaction 画到面板上让人答。**这是产品决定，没到该由这一层替谁做主的时候** ——
 * 所以这里保持和旧面板一样的 `on-request`，不偷偷改安全姿态。
 */

export interface RuntimeOptions {
  readonly database: Database.Database;
  readonly repo: RepoOps;
  /** 一轮的硬顶。默认三小时 —— 实测一轮 60~343 分钟。 */
  readonly turnTimeoutMs?: number;
  /** 一个阶段最多几轮。跑满之后摊开收敛数据，**不拦人**。 */
  readonly roundBudget?: number;
  readonly model?: string;
  readonly effort?: string;
  /** 外部进程的出口。一轮跑完发系统通知要它；不给就是真的那个。 */
  readonly process?: ProcessOps;
}

const DEFAULT_TURN_TIMEOUT_MS = 180 * 60_000;
const DEFAULT_ROUND_BUDGET = 5;
/**
 * 一次租多久。跑得再久也靠**续租**，不靠一次批满 —— 批满等于「进程死了也要等这么久
 * 才有人敢碰这条活儿」。
 */
const LEASE_TTL_MS = 60_000;

/** 取题面的下场。`handed: false` 时 `reason` 和派轮那条同一套词。 */
export type HandoffOutcome =
  | {
      readonly handed: true;
      readonly phase: Phase;
      readonly round: number;
      readonly envelope: string;
      readonly scriptPath: string;
    }
  | {
      readonly handed: false;
      readonly phase: Phase;
      readonly reason: string;
      readonly busy?: string;
    };

/** 结算的下场。`found` 是认回了几条线程 —— >1 时取的是最新那条，说出来。 */
export type SettleOutcome =
  | {
      readonly settled: true;
      readonly phase: Phase;
      readonly round: number;
      readonly threadId: string;
      readonly jobId: string;
      readonly found: number;
      readonly outcome: unknown;
    }
  | {
      readonly settled: false;
      readonly phase: Phase;
      readonly reason: string;
      readonly found?: number;
    };

export type RunOutcome =
  | { readonly ran: true; readonly phase: Phase; readonly jobId: string }
  | { readonly ran: false; readonly phase: Phase; readonly reason: string; readonly busy?: string };

export class PluginRuntime {
  private client: AppServerClient | null = null;
  private seats: PluginSeats | null = null;
  private history: AppServerHistory | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  /** 起过就复用。**第一次真要跑一轮时才起** —— 看一眼不该起子进程。 */
  private async ready(): Promise<{ seats: PluginSeats; history: AppServerHistory }> {
    if (this.seats !== null && this.history !== null) {
      return { seats: this.seats, history: this.history };
    }
    /*
     * **自己的 app-server 子进程，不是那个常驻 daemon。**
     *
     * daemon（`codex app-server daemon start`）是 Codex 给 SSH / 远程控制用的常驻服务。
     * StagePass 用不到它：2026-08-18 实测，占用问题的成因是**订阅**不是 daemon
     * （见 `docs/DESIGN-thread-ownership-2026-08-18.md` §11），退订之后线程就归人了。
     *
     * 那 daemon 就只剩坏处：它是全机器共享的（别人的会话也在里面）、它把线程一直
     * loaded 着、而且连它要走 WebSocket —— `ws` 是 CJS，打进 ESM 会让插件产物起不来
     * （2026-08-18 那个 `Dynamic require of "events"`）。子进程这条路一样都没有。
     *
     * 代价说清楚：**turn 跑在这个子进程里，插件退出它就没了。** daemon 那种「关掉
     * 会话轮还活着」的 durability 就此失去 —— 而收这一轮的记账本来也要插件活着。
     */
    const client = AppServerClient.spawn({
      command: "codex",
      args: ["app-server"],
      cwd: process.cwd(),
      onNotification: () => {},
      /*
       * 审批 / elicitation 交给 host 按 threadId 路由。**绝不在这里代答** ——
       * 代答等于替人做了他本该看见的决定，那正是这套东西存在的反面。
       *
       * 注意：派完一轮我们就退订了（`seats.ts`），所以正常情况下审批根本不会走到
       * 这里 —— 它归那条线程此刻的订阅者，也就是在 App 里看着的人。
       */
      onServerRequest: (request) => host.handleServerRequest(request),
      onStderr: () => {},
    });
    await client.initialize();
    const host = new AppServerSessionHost(client);
    this.client = client;
    this.history = new AppServerHistory(client);
    this.seats = new PluginSeats({
      database: this.options.database,
      host,
      history: this.history,
      turnTimeoutMs: this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      effort: this.options.effort ?? "xhigh",
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    });
    return { seats: this.seats, history: this.history };
  }

  /** 收掉那个 app-server 子进程。插件退出前叫一次，别留一个孤儿进程。 */
  close(): void {
    void this.client?.close();
    this.client = null;
    this.seats = null;
    this.history = null;
  }

  /**
   * 这个阶段现在能不能开一轮。**派轮和取题面共用这一份判据。**
   *
   * 顺序照搬旧面板，一条不改：**先看这个阶段有没有活儿没了结**（同一阶段线程
   * 同时只许一轮 —— 违反过一次，两条裁判线程互相打断，烧掉近 300 万 input token），
   * 再看这一轮跑在主线还是并行座位上，最后看状态能不能排队。
   *
   * 抽出来是因为「取题面」得走同一套：那一轮虽然跑在人自己的会话里，对 StagePass
   * 来说仍然是这个阶段的一轮 —— 两套判据就是两种「什么时候允许开一轮」，而它们
   * 分叉的那天，账本上会同时坐着两轮。
   */
  private admit(
    changeId: string, phase: Phase,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly busy?: string } {
    const database = this.options.database;
    if (phase === "Done") return { ok: false, reason: "phase_not_active" };

    const busy = new JobStore(database).busyFor(changeId, phase);
    if (busy !== null) {
      return { ok: false, reason: "phase_already_running", busy: busy.status };
    }

    const mainPhase = new ChangeStore(database).read(changeId).state.phase;
    const seat = phase === mainPhase ? null : new ParallelStore(database).find(changeId, phase);
    if (phase !== mainPhase && seat === null) {
      return { ok: false, reason: "phase_not_active" };
    }
    /*
     * 座位没有裁决面 —— 主线的 blocked 走裁决、settled 走批准，而座位够不着那些。
     * **人按下这个按钮，就是「这一轨再来一轮」的决定本身**，所以这里替他把状态推回去。
     */
    if (seat !== null && seat.status === "blocked") {
      new ParallelStore(database).apply(changeId, phase, "retry");
    }
    if (seat !== null && seat.status === "settled") {
      new ParallelStore(database).apply(changeId, phase, "start");
    }
    const status = seat === null
      ? new ChangeStore(database).read(changeId).state.status
      : seat.status === "blocked" || seat.status === "settled" ? "running" : seat.status;
    if (status !== "pending" && status !== "running") {
      return { ok: false, reason: `phase_cannot_queue:${status}` };
    }
    return { ok: true };
  }

  /**
   * 派一轮。
   */
  async runRound(changeId: string, phase: Phase): Promise<RunOutcome> {
    const database = this.options.database;
    const admitted = this.admit(changeId, phase);
    if (!admitted.ok) {
      return {
        ran: false, phase, reason: admitted.reason,
        ...(admitted.busy === undefined ? {} : { busy: admitted.busy }),
      };
    }
    const mainPhase = new ChangeStore(database).read(changeId).state.phase;
    const seat = phase === mainPhase ? null : new ParallelStore(database).find(changeId, phase);

    const { seats, history } = await this.ready();
    if (seats.workspaceFor(changeId) === null) {
      return { ran: false, phase, reason: "project_has_no_path" };
    }

    const loop = new TurnLoop({
      database,
      runner: this.roundRunner({
        transport: seats.transportFor(changeId, phase),
        workspaceFor: (each) => seats.workspaceFor(each),
        childThreads: (parentThreadId) => childThreadsOf({ history, parentThreadId }),
        readThread: (threadId) => readThreadTranscript({ history, threadId }),
      }),
    });

    const jobId = `JOB-${changeId}-${phase}-${Date.now()}`;
    loop.queueTurn({
      changeId,
      jobId,
      deadlineAt: Date.now() + (this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS),
      maxAttempts: 1,
      phase,
    });
    /*
     * **排完队就回，不等它跑完。** 一轮实测 60~343 分钟，等着回复的那条链路上
     * 每一层都会先超时 —— 那时人看到「网络错误」而轮跑得好好的。进度走独立的轮询。
     */
    void loop.runOnce({
      owner: "plugin", token: jobId, now: Date.now(), ttlMs: LEASE_TTL_MS,
    })
      /*
       * **跑完叫一声人。** 一轮 60~343 分钟，跑完之后闸门停在那里等裁决 —— 而插件
       * 是个 MCP server，它不能把面板推到人眼前。系统通知是唯一能主动出去的一条缝。
       *
       * 该不该响、问主线还是问座位，全在 `nudge.ts` 里（那些能离线证）；这里只是
       * 那一轮真的结束的时刻。
       */
      .then((result) => nudgeAfterRound({
        database, changeId, phase, onSeat: seat !== null, result,
        process: this.options.process ?? createProcessOps(),
      }))
      .catch(() => { /* 结局落库；这里不吞进沉默，也不抛进一个没人接的 Promise */ });
    return { ran: true, phase, jobId };
  }

  /**
   * **取题面**：备一轮，把信封交给人，自己什么都不跑（2026-08-19 定案「甲」）。
   *
   * ## 为什么这条路存在
   *
   * **谁执行 turn，谁就占着那条 Codex 线程。** StagePass 派的那一轮，人在 App 里
   * 打不开（真机反复撞到的 "This is open in another app"）。改成把题面交给他：
   * 那一轮从第一秒起就是他的 —— 看得见、点得开、审批弹给他、进程死了也不关它事。
   *
   * ## 它一个子进程都不起
   *
   * 备一轮只读库、只写几个文件，**一句话都不用跟 Codex 说**。所以这里不叫
   * `ready()` —— 为了「拿一份题面」去拉起一个 app-server 是纯粹的浪费，而且违反
   * 「看状态不该有副作用」那条界面原则的精神。
   *
   * ## 不建 job、不推主线状态
   *
   * StagePass 这时候确实什么都没在跑。建一个 job 会让收尸人在租约过期时把它判失败
   * （而人可能正跑到一半），也会让界面说「这个阶段在跑」——那是假话。
   * 「这个阶段备着一轮」是 `handed_rounds` 自己的事实。
   */
  handOff(changeId: string, phase: Phase): HandoffOutcome {
    const database = this.options.database;
    const admitted = this.admit(changeId, phase);
    if (!admitted.ok) {
      return {
        handed: false, phase, reason: admitted.reason,
        ...(admitted.busy === undefined ? {} : { busy: admitted.busy }),
      };
    }
    if (workspaceOf(database, changeId) === null) {
      return { handed: false, phase, reason: "project_has_no_path" };
    }

    const runner = this.roundRunner({
      /*
       * **备一轮不派 turn**，所以这条通道走到就是错。给一个会喊的替身，而不是
       * 一个能悄悄开会话的真通道 —— 静默地开一条线程正是这条路要躲开的东西。
       */
      transport: {
        runTurn: () => {
          throw new Error("handoff_must_not_dispatch: 取题面这条路不许派 turn");
        },
      },
      workspaceFor: (each) => workspaceOf(database, each),
      childThreads: () => Promise.resolve([]),
      readThread: () => Promise.resolve(""),
    });

    const job = { id: `HANDOFF-${changeId}-${phase}`, changeId, phase };
    const prepared = runner.prepare(job as Parameters<typeof runner.prepare>[0]);
    new HandoffStore(database).prepare({
      changeId, phase, round: prepared.round,
      envelope: prepared.envelope,
      scriptPath: prepared.scriptPath,
      files: {
        worklist: prepared.worklist,
        blueRubric: prepared.blueRubric,
        rubricIds: prepared.rubricIds,
      },
    });
    return {
      handed: true, phase, round: prepared.round,
      envelope: prepared.envelope, scriptPath: prepared.scriptPath,
    };
  }

  /**
   * **结算**：认回人自己跑的那条线程，把这一轮收进账本。
   *
   * ## 认线程不让人手抄 id
   *
   * 判据是 (工作目录, 题面路径)：题面路径在他原样粘贴的那段信封里，而 `thread/list`
   * 每条的 `preview` 就是第一条用户消息（2026-08-19 实测：**没有 `title` 这个字段**，
   * 而 `preview` 不截断）。题面路径每轮一个随机临时目录，所以这个键是精确的。
   *
   * ## 还在跑就不收
   *
   * 半截的 transcript 收进去，红蓝两方说的话会缺一截，而账本上看不出缺过 ——
   * 那正是这套东西最不能出的一种错。照实说「还在跑」，让人跑完再点。
   */
  async settleHandoff(changeId: string, phase: Phase): Promise<SettleOutcome> {
    const database = this.options.database;
    const handoffs = new HandoffStore(database);
    const stored = handoffs.waiting(changeId, phase);
    if (stored === null) {
      return { settled: false, phase, reason: "no_round_waiting" };
    }
    const cwd = workspaceOf(database, changeId);
    if (cwd === null) return { settled: false, phase, reason: "project_has_no_path" };

    const { history } = await this.ready();
    const found = await history.findThreads({ cwd, marker: stored.scriptPath });
    if (found.length === 0) {
      return { settled: false, phase, reason: "round_not_found", found: 0 };
    }
    /*
     * 撞上多条 = 他把同一个信封贴进了不止一条线程（第一次跑挂了，再来一次）。
     * **取最新那条**，并且把条数报上去 —— 替他挑而不说，挑错的那次他永远看不见。
     */
    const threadId = found[0]!.id;
    const thread = await history.readThread(threadId);
    if (thread === null) {
      return { settled: false, phase, reason: "thread_unreadable", found: found.length };
    }
    if (thread.turns.some((turn) => turn.status === "inProgress")) {
      return { settled: false, phase, reason: "round_still_running", found: found.length };
    }
    if (thread.lastCompletedText === null) {
      return { settled: false, phase, reason: "judge_said_nothing", found: found.length };
    }

    const runner = this.roundRunner({
      transport: {
        runTurn: () => {
          throw new Error("settle_must_not_dispatch: 结算这条路不许派 turn");
        },
      },
      workspaceFor: (each) => workspaceOf(database, each),
      childThreads: (parentThreadId) => childThreadsOf({ history, parentThreadId }),
      readThread: (each) => readThreadTranscript({ history, threadId: each }),
    });

    /*
     * **走 TurnLoop，不自己记账。**
     *
     * 状态怎么推、产物怎么入档、失败怎么落，全在那一层，而它已经被派轮那条路
     * 用真机验过。这里绕过去自己写一份，就是账本上第二套规则。
     *
     * job 现在才建：这一轮到此刻才真的进账本，而它一建出来就要被跑完 ——
     * 中间没有人的时间，所以租约那条不会误伤。
     */
    const loop = new TurnLoop({
      database,
      runner: {
        run: (job) => runner.settle(job, {
          threadId, text: thread.lastCompletedText!,
        }, stored),
      },
    });
    const jobId = `JOB-${changeId}-${phase}-${Date.now()}`;
    loop.queueTurn({
      changeId, jobId, phase, maxAttempts: 1,
      deadlineAt: Date.now() + (this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS),
    });
    const result = await loop.runOnce({
      owner: "handoff", token: jobId, now: Date.now(), ttlMs: LEASE_TTL_MS,
    });
    handoffs.settled(changeId, phase, stored.round, threadId);

    return {
      settled: true, phase, round: stored.round, threadId, jobId,
      found: found.length,
      outcome: result,
    };
  }

  /**
   * 一轮那台机器 —— **派轮、取题面、结算三处共用同一份接线。**
   *
   * 分出来不是为了少写几行：这里挂着十个 store 和四个外部口子，抄第二份的那一刻，
   * 「人手跑的那一轮」和「StagePass 派的那一轮」就开始记不同的账，而那种差异要到
   * 人裁决时才看得见。
   */
  private roundRunner(seams: {
    readonly transport: CodexTransport;
    readonly workspaceFor: (changeId: string) => string | null;
    readonly childThreads: (parentThreadId: string) => Promise<readonly string[]>;
    readonly readThread: (threadId: string) => Promise<string>;
  }): RoundTurnRunner {
    const database = this.options.database;
    return new RoundTurnRunner({
      transport: seams.transport,
      gaps: new GapStore(database),
      rubrics: new RubricStore(database),
      changes: new ChangeStore(database),
      bindings: new BindingStore(database),
      evidence: new EvidenceStore(database),
      notes: new RoundNoteStore(database),
      worklist: new WorklistStore(database),
      repo: this.options.repo,
      workspaceFor: seams.workspaceFor,
      taskFor: (each) => MINIMAL_PHASE_INSTRUCTIONS[each as Phase],
      childThreads: seams.childThreads,
      readThread: seams.readThread,
      /*
       * **写临时目录，不写工作区。** 写进工作区会把干净树弄脏，而干净树是派轮的
       * 前置条件 —— 那会变成「派轮这件事本身让下一次派不了轮」。
       */
      writeRoundFile: (name, content) => {
        const path = join(mkdtempSync(join(tmpdir(), "stagepass-round-")), name);
        writeFileSync(path, content, "utf-8");
        return path;
      },
      /*
       * 读回反方写的那份判定。**不在就是 `null`，绝不抛** —— 「它没写」是这一轮的
       * 一个正常结局，不是 StagePass 出了故障。
       */
      readRoundFile: (path) => {
        try { return readFileSync(path, "utf-8"); } catch { return null; }
      },
      slotFiles: createSlotFiles(),
      // 并行座位的轮次从活儿数：座位的 start 不进账本。
      parallelRound: (each, seatPhase) => new JobStore(database).countFor(each, seatPhase),
      seatStatus: (each, seatPhase) =>
        new ParallelStore(database).find(each, seatPhase)?.status ?? null,
    });
  }

  /**
   * 在这个阶段的座位上问模型一句，回它说的话。录需求靠它去提问题。
   *
   * 和 `runRound` 的区别：那条是**排一轮活儿**（进账本、有 job、有租约），这条只是
   * 借这条线程说句话。所以它不碰账本 —— 「模型在读仓库」不是这个阶段的一轮。
   */
  async askInPhase(changeId: string, phase: Phase, prompt: string): Promise<string> {
    const { seats } = await this.ready();
    // `threadId` 由座位自己从绑定表认（见 `seats.seatOn`），这里给 null 不是「开新线程」。
    return (await seats.transportFor(changeId, phase).runTurn({ threadId: null, prompt })).text;
  }

  /** 旁路线程上说一句。没有那条线程就当场开一条 —— 人按「旁路窗口」就是这个意思。 */
  async talkAside(changeId: string, prompt: string): Promise<string> {
    const { seats } = await this.ready();
    return (await seats.asideTransport(changeId).runTurn({ threadId: null, prompt })).text;
  }

  /**
   * 这条线程上人说过哪些话。**`null` = 读不出来**，和「读到了，一句都没有」是两件事
   * —— 起草那道闸靠这个区分（`app/converge-brief.ts` 里那段注释说的就是它）。
   */
  async saidIn(threadId: string): Promise<readonly string[] | null> {
    const { history } = await this.ready();
    return readThreadUserMessages({ history, threadId });
  }

  /**
   * 放掉一个座位的会话。**没起过连接就什么都不用做** —— 那时也没有会话可放。
   *
   * 这里不 `await ready()`：为了放掉一个不存在的会话去起一个 daemon 是纯粹的荒谬。
   */
  releaseSeat(changeId: string, seat: Phase | typeof ASIDE): void {
    this.seats?.release(changeId, seat);
  }

  /**
   * 归档要用的那一小片历史接口。**没起过 app-server 就是 null** —— 那时也没有
   * 线程可归档，返回 null 比按需起一个子进程诚实（归档不该顺手拉起一个 daemon）。
   */
  archiveOps(): AppServerHistory | null {
    return this.history;
  }

  /**
   * 进度那一屏要问的两样。同上：**没起过就是 null，这里绝不去起。**
   *
   * 而「没有连接」在进度上不是「不知道」：daemon 是这个进程的孩子，它不在，
   * StagePass 派出去的那一轮就真的没了 —— `api.ts` 据此报 `processGone`，
   * 那一格正是为这种死法存在的。
   */
  liveProgress(): { seats: PluginSeats; history: AppServerHistory } | null {
    return this.seats === null || this.history === null
      ? null
      : { seats: this.seats, history: this.history };
  }

  /** 一个阶段最多跑几轮。裁决那条路要用它摊开收敛数据。 */
  get roundBudget(): number {
    return this.options.roundBudget ?? DEFAULT_ROUND_BUDGET;
  }
}
