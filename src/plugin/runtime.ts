import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { AppServerHistory } from "../codex/app-server-history";
import { startManagedAppServer, type ManagedAppServer } from "../codex/app-server-daemon";
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
import { WorklistStore } from "../store/worklist-store";
import { createSlotFiles } from "../system/slot-files";
import { JobStore } from "../work/job-store";
import type { RepoOps } from "../work/repo";
import { RoundTurnRunner } from "../work/round-turn-runner";
import { TurnLoop } from "../work/turn-loop";
import { ASIDE, PluginSeats } from "./seats";

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
}

const DEFAULT_TURN_TIMEOUT_MS = 180 * 60_000;
const DEFAULT_ROUND_BUDGET = 5;
/**
 * 一次租多久。跑得再久也靠**续租**，不靠一次批满 —— 批满等于「进程死了也要等这么久
 * 才有人敢碰这条活儿」。
 */
const LEASE_TTL_MS = 60_000;

export type RunOutcome =
  | { readonly ran: true; readonly phase: Phase; readonly jobId: string }
  | { readonly ran: false; readonly phase: Phase; readonly reason: string; readonly busy?: string };

export class PluginRuntime {
  private managed: ManagedAppServer | null = null;
  private seats: PluginSeats | null = null;
  private history: AppServerHistory | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  /** 起过就复用。**第一次真要跑一轮时才起** —— 看一眼不该起子进程。 */
  private async ready(): Promise<{ seats: PluginSeats; history: AppServerHistory }> {
    if (this.seats !== null && this.history !== null) {
      return { seats: this.seats, history: this.history };
    }
    const managed = await startManagedAppServer({
      command: "codex",
      cwd: process.cwd(),
      onNotification: () => {},
      /*
       * 审批 / elicitation 交给 host 按 threadId 路由。**绝不在这里代答** ——
       * 代答等于替人做了他本该看见的决定，那正是这套东西存在的反面。
       */
      onServerRequest: (request) => host.handleServerRequest(request),
      onStderr: () => {},
    });
    const host = new AppServerSessionHost(managed.client);
    this.managed = managed;
    this.history = new AppServerHistory(managed.client);
    this.seats = new PluginSeats({
      database: this.options.database,
      host,
      turnTimeoutMs: this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      effort: this.options.effort ?? "xhigh",
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    });
    return { seats: this.seats, history: this.history };
  }

  /** 关掉那条控制连接。插件进程退出前叫一次，别把 daemon 的连接晾着。 */
  close(): void {
    this.managed?.close?.();
    this.managed = null;
    this.seats = null;
    this.history = null;
  }

  /**
   * 派一轮。
   *
   * 判据顺序照搬旧面板，一条不改：**先看这个阶段有没有活儿没了结**（同一阶段线程
   * 同时只许一轮 —— 违反过一次，两条裁判线程互相打断，烧掉近 300 万 input token），
   * 再看这一轮跑在主线还是并行座位上，最后看状态能不能排队。
   */
  async runRound(changeId: string, phase: Phase): Promise<RunOutcome> {
    const database = this.options.database;
    if (phase === "Done") return { ran: false, phase, reason: "phase_not_active" };

    const busy = new JobStore(database).busyFor(changeId, phase);
    if (busy !== null) {
      return { ran: false, phase, reason: "phase_already_running", busy: busy.status };
    }

    const mainPhase = new ChangeStore(database).read(changeId).state.phase;
    const seat = phase === mainPhase ? null : new ParallelStore(database).find(changeId, phase);
    if (phase !== mainPhase && seat === null) {
      return { ran: false, phase, reason: "phase_not_active" };
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
      return { ran: false, phase, reason: `phase_cannot_queue:${status}` };
    }

    const { seats, history } = await this.ready();
    if (seats.workspaceFor(changeId) === null) {
      return { ran: false, phase, reason: "project_has_no_path" };
    }

    const loop = new TurnLoop({
      database,
      runner: new RoundTurnRunner({
        transport: seats.transportFor(changeId, phase),
        gaps: new GapStore(database),
        rubrics: new RubricStore(database),
        changes: new ChangeStore(database),
        bindings: new BindingStore(database),
        evidence: new EvidenceStore(database),
        notes: new RoundNoteStore(database),
        worklist: new WorklistStore(database),
        repo: this.options.repo,
        workspaceFor: (each) => seats.workspaceFor(each),
        taskFor: (each) => MINIMAL_PHASE_INSTRUCTIONS[each as Phase],
        childThreads: (parentThreadId) => childThreadsOf({ history, parentThreadId }),
        readThread: (threadId) => readThreadTranscript({ history, threadId }),
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
    }).catch(() => { /* 结局落库；这里不吞进沉默，也不抛进一个没人接的 Promise */ });
    return { ran: true, phase, jobId };
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
