import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

import {
  commitsWholeTree, isPhase, requiresHumanEdit, upstreamOf, type Phase,
} from "../domain/phase";
import type { CodexTransport } from "../codex/transport";
import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";
import {
  childThreadsOf, readThreadTranscript, readThreadUserMessages,
} from "../codex/subagent";
import {
  archiveFinished, type ArchiveOps,
} from "../codex/archive";
import {
  type AppServerHistory,
  threadTurnEnded as appServerThreadTurnEnded,
} from "../codex/app-server-history";
import { RoundTurnRunner } from "../work/round-turn-runner";
import { createTrustOps, type TrustOps } from "../codex/trust";
import { editGateClosed, isEditGateGap } from "../domain/edit-gate";
import { createRepoOps, looksLikeSha, type RepoOps } from "../work/repo";
import { JobStore } from "../work/job-store";
import { AsideStore } from "../store/aside-store";
import { BindingStore, type BoundThread } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ParallelStore } from "../store/parallel-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { WorklistStore } from "../store/worklist-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { RoundNoteStore } from "../store/round-note-store";
import { RUBRIC_ROLES, type RubricRole } from "../domain/rubric";
import { parseRubricEdit, UnreadableEditError } from "../domain/rubric-edit";
import { LEASE_TTL_MS, TurnLoop, recoverStuckTurns } from "../work/turn-loop";
import { decideGate, type DecideOutcome } from "../app/decide-gate";
import { rubricFor, saveRubric } from "../app/edit-rubric";
import {
  createChange, createProject, deleteChange, deleteProject, type BusyCheck,
} from "../app/workspace";
import { recordBrief, type BriefOutcome } from "../app/record-brief";
import { confirmBrief, draftBrief, STAGEPASS_SAID } from "../app/converge-brief";
import { waive, type WaiveOutcome } from "../app/waive";
import { panelView, progressView } from "./panel-view";
import {
  prepareBoundThread, reconcileMissingBindings, type BindingRecoveryReport,
} from "./session-recovery";
import { serveCodexStreamApi } from "./codex-stream-api";
import { STREAM_ASIDE, type StreamSessions } from "./stream-session";

/**
 * StagePass Web workbench backed exclusively by one supervised Codex App Server.
 *
 * The browser receives normalized snapshots and typed events, never terminal
 * bytes or JSON-RPC envelopes. Human decisions still pass through the existing
 * StagePass domain use cases; rendering a Codex thread cannot advance a gate.
 *
 * There is at most one live App Server turn per (Change, phase). This preserves
 * deterministic turn ownership while still allowing independent phase seats to
 * be open concurrently (PRD §6.5 rule 5).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 旁路会话的座位名（DESIGN-phase-not-the-only-axis §3.3）。
 *
 * 一个 Change 的注册表座位从「十一个阶段」变成「十一个阶段 + 这一个」：旁路会话
 * 不属于任何阶段、不产出、不推闸门，**也不占任何阶段的座**（`cannotAskNow` 和
 * 派发的守卫都按阶段问，永远问不到它）——「问个名词」和「跑一轮对抗」从此不抢
 * 同一把椅子。
 *
 * 它是字符串 `"aside"` 而不是一个 Phase：把它塞进 PHASES 会让每一张按阶段铺开的
 * 表（模板、rubric、闸门）都得回答「aside 那一格填什么」，而答案全是「不适用」。
 */
export const ASIDE = "aside" as const;
type Seat = Phase | typeof ASIDE;

/**
 * 把 StagePass 的插件挂给一次 Codex 启动。
 *
 * **每次启动都带，从不写进人的全局配置** —— 那样一个跑砸的实验会留在他机器上。
 *
 * 抽出来是因为这串东西现在有四个落点（问人问题、录需求、录需求的第二段、跑一轮），
 * 而**同一条规则的四份拷贝必然漂移**：漂移的那一天，某一条路上的模型会理直气壮地
 * 说「没有这个工具」，而那是最难查的一种毛病 —— 提示词里明明写着叫它调。
 *
 * ## `changeId` 也在这里
 *
 * 插件那三个工具**一个入参都不收**（2026-08-02 起），所以「问的是哪个 Change 的事」
 * 只能由启动它的这一侧说。这不是把手抄换个地方 —— 它从头到尾没经过模型的嘴，
 * 而那正是判据。见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
 */
/**
 * 这个阶段的账本上还有没有没了结的活儿。
 *
 * `sessions.has()` 问的是「注册表里还有没有这个阶段的 App Server 会话」，那是**当下这一刻**的
 * 事实；而这里问的是「有没有事情还没了结」，只有账本知道。
 *
 * 2026-08-03 真机撞出来的：一轮跑完、会话结束、注册表里没了，**而库里那个 job 还是
 * `running`**（没人收尾）—— 于是下一次派发畅通无阻，同一个 (Change, 阶段) 上起了
 * 第二条裁判线程。实测两条互相打断，一条烧掉近 300 万 input token，人在终端里连字
 * 都打不进去，而 §6.5 规则 5 的全部意义就是不许出现这个。
 *
 * **排着队的也算忙** —— 派了还没跑起来，和正在跑一样不能再派一次。
 */
const phaseBusy = (
  database: Database.Database,
  changeId: string,
  /** 只问这个阶段（批 3：并行座位互不打断）。不给 = 任何阶段的活儿都算。 */
  phase?: Phase,
): { reason: "phase_already_running"; busy: string; jobId: string } | null => {
  const job = new JobStore(database).busyFor(changeId, phase);
  return job === null
    ? null
    // `reason` 是**界面在精确匹配的那个字符串**（`panel.js`），不许改。要说得更细
    // 就往旁边加字段 —— 「在等什么」是人要看的，而把它编进 reason 会当场弄坏界面。
    : { reason: "phase_already_running", busy: job.status, jobId: job.id };
};

/**
 * 问人之前：账本闲着**而且**没有活进程。
 *
 * 比派发那条严一格，因为问人是**往一个已经存在的会话里打字**。而 2026-08-03 实测：
 * 往正在跑 turn 的会话里塞新提示词，Codex 当成打断（`turn_aborted: interrupted`），
 * 人面前那个选择器当场被取消，`stagepass_ask` 在 1~4 秒内返回空的 `cancel` ——
 * 人还没看清它就没了。连着六次都是这么废的。
 *
 * 派发那条**不加**这一格：一轮结算完会话仍可恢复，但没有活跃 turn 边界可交错，
 * 它可以被关闭后接着派（2026-08-02 收窄，理由见 `runPhase`）。
 */
const cannotAskNow = (
  database: Database.Database,
  sessions: PanelSessions,
  changeId: string,
  phase: Phase,
): { reason: "phase_already_running"; busy: string; jobId?: string } | null =>
  phaseBusy(database, changeId, phase)
  ?? (sessions.active(changeId, phase)
    // 同上：`reason` 保持界面认识的那个，细节走 `busy`。
    ? { reason: "phase_already_running" as const, busy: "session" }
    : null);



interface StagePassPluginConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly defaultToolsApprovalMode: string;
}

const stagepassPluginFor = (
  database: { name: string }, changeId: string,
  /**
   * 这个会话是为哪个阶段起的（批 4 · P0 第 1 条）。跑轮的裁判会话必须给 ——
   * worklist 按 (Change, 阶段) 取，并行的两条轨才各答各的。旁路/问人会话不给
   * （它们不答 worklist），插件退回按 Change 取。
   */
  phase?: Phase,
): StagePassPluginConfig => ({
  command: "npx",
  args: ["tsx", join(HERE, "..", "plugin", "server.ts")],
  env: {
    STAGEPASS_DB: resolve(database.name),
    STAGEPASS_CHANGE: changeId,
    ...(phase === undefined ? {} : { STAGEPASS_PHASE: phase }),
  },
  defaultToolsApprovalMode: "auto",
});


const pluginAppServerConfigFor = (
  database: { name: string }, changeId: string, phase?: Phase,
): Readonly<Record<string, unknown>> => {
  const plugin = stagepassPluginFor(database, changeId, phase);
  return {
    "mcp_servers.stagepass.command": plugin.command,
    "mcp_servers.stagepass.args": plugin.args,
    "mcp_servers.stagepass.env": plugin.env,
    "mcp_servers.stagepass.default_tools_approval_mode":
      plugin.defaultToolsApprovalMode,
  };
};

/**
 * 一份产出最大读多大，超过就只报大小、不读。
 *
 * 弹窗里要看的是一份文档。比这还大的东西**不是拿来在弹窗里读的**，而无条件读进内存
 * 会让一个模型写歪的文件把面板拖死。
 */
const ARTIFACT_MAX_BYTES = 2_000_000;


export interface PanelOptions {
  readonly database: Database.Database;
  /** Every Codex turn in this worktree crosses this structured seam. */
  readonly appServerTransport: (input: {
    readonly cwd: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly timeoutMs?: number;
  }) => CodexTransport;
  readonly streams: StreamSessions;
  readonly history: AppServerHistory;
  /**
   * brief 的草稿和工作稿放哪（批 2「模型起草，人改」—— 人要在编辑器里打开这个
   * 目录里的文件）。默认 ~/.stagepass/briefs。可注入是为了测试不摸真目录。
   */
  readonly briefsDir?: string;
  /**
   * git。同理，而且这一格更要紧：真的那一套会在项目仓库里 `add -A` + `commit`，
   * 测试里没换掉就等于每跑一次测试就提交一次工作区。
   */
  readonly repo?: RepoOps;
  /** Codex 的目录信任。同一个路子 —— 真的那一套会去读用户的 `~/.codex/config.toml`。 */
  readonly trust?: TrustOps;
  /**
   * 图谱那三条路（`/api/graph` `/api/file` `/api/graph-excludes`）的处理器
   * （spec 2026-08-12）。处理了返回 true，不是它的路返回 false。
   *
   * **不在这里 import `web/graph-api.ts`，故意的**：本模块的依赖闭包有一条
   * 只许缩的棘轮（architecture.test.ts 的 CLOSURE_RATCHET），把图谱一族 import
   * 进来它当场红 —— 而它红得对。接线在入口（scripts/panel.ts），archive / trust /
   * repo 全是这个形状。不注入 = 面板没有图谱（404），不是半个图谱。
   */
  readonly graph?: (
    url: URL, request: IncomingMessage, response: ServerResponse,
  ) => Promise<boolean>;
  /**
   * 一轮最多等多久。默认 180 分钟。
   *
   * 不只是给测试用的旋钮：一轮对抗真的会停在审批上等人（PRD §6.6），而
   * 「窗口还开着、什么也没发生」和成功长得一模一样 —— 总得有个东西替它说话。
   *
   * **30 分钟的旧默认 2026-08-12 被真机杀掉**：Arch 按新模板（九节 + 图纸）
   * 一轮真跑了 3.5 小时 —— turn 在 12:49 被判死，Codex 却继续跑到
   * 15:56 出了结果，人对着一条已判死的轮裁决，账落了、轮早没了。用户拍：
   * 全部统一 180。
   */
  readonly turnTimeoutMs?: number;
  /**
   * 问人一道题之后等多久放弃。默认 15 分钟。
   *
   * **可注入是为了测试跑得完。** 写死之前，一条没按预期形状作答的测试会真的坐在
   * 那里等满 15 分钟（被测试框架 300 秒截断）—— 2026-08-03 裁决改成两趟时，四条
   * 测试同时掉进这条路，一次 `pnpm check` 从 35 秒涨到 20 分钟以上。
   *
   * 病不在那几条测试写错了，在于**它们写错的代价是 20 分钟**。
   */
  readonly askTimeoutMs?: number;
  /**
   * 多久扫一次过期的活。默认 30 秒。
   *
   * 可注入是为了测试跑得完 —— 和 `askTimeoutMs` 同一个理由（写错的代价应该是
   * 1 秒，不是 30）。
   */
  readonly recoverEveryMs?: number;
  /**
   * 跑几轮之后开始把收敛数据摊给人看。默认 5。
   *
   * **不是硬上限**（用户 2026-08-03）：「再来一轮」仍然提供，只是从这一轮起，
   * 裁决那张表的题面会告诉他一共提过几条、现在还开着几条。阻断归人管。
   */
  readonly roundBudget?: number;
}

class ProjectPathMissingError extends Error {
  constructor(readonly changeId: string) {
    super(`change ${changeId} has no project path; nothing knows where to run Codex`);
    this.name = "ProjectPathMissingError";
  }
}

class SessionResumeRefusedError extends Error {
  constructor(readonly threadId: string, reason: string) {
    super(`refusing to resume thread ${threadId}: ${reason}`);
    this.name = "SessionResumeRefusedError";
  }
}

/** StagePass-facing facade over structured App Server sessions and history. */
export class PanelSessions {
  readonly archive: ArchiveOps;
  readonly repo: RepoOps;
  readonly trust: TrustOps;

  constructor(private readonly options: PanelOptions) {
    this.archive = options.history;
    this.repo = options.repo ?? createRepoOps();
    this.trust = options.trust ?? createTrustOps();
  }

  async reconcileBindings(): Promise<BindingRecoveryReport> {
    return reconcileMissingBindings(
      new BindingStore(this.options.database),
      this.archive,
    );
  }

  workspaceFor(changeId: string): string | null {
    try {
      const projectId = new ChangeStore(this.options.database).read(changeId).projectId;
      if (projectId === null) return null;
      return new ProjectStore(this.options.database).read(projectId).path;
    } catch {
      return null;
    }
  }

  has(changeId: string, phase: Seat): boolean {
    return this.options.streams.has(changeId, phase);
  }

  active(changeId: string, phase: Seat): boolean {
    return this.options.streams.active(changeId, phase);
  }

  async openForChat(
    changeId: string,
    phase: Seat,
    config: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.prepareBinding(changeId, phase);
    await this.options.streams.open(changeId, phase, { config });
  }

  async startTurn(
    changeId: string,
    phase: Seat,
    prompt: string,
    config: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    await this.openForChat(changeId, phase, config);
    return this.options.streams.startTurn(changeId, phase, prompt);
  }

  async type(changeId: string, phase: Seat, line: string): Promise<boolean> {
    if (line.includes("\n")) throw new Error("prompt_must_be_one_line");
    if (!this.has(changeId, phase) || this.active(changeId, phase)) return false;
    try {
      await this.options.streams.startTurn(changeId, phase, line);
      return true;
    } catch {
      return false;
    }
  }

  async recordCount(changeId: string, phase: Seat): Promise<number | null> {
    const threadId = this.boundThreadId(changeId, phase);
    if (threadId === null) return null;
    try {
      return (await this.options.history.readThread(threadId))?.turnCount ?? null;
    } catch {
      return null;
    }
  }

  async turnEnded(
    changeId: string,
    phase: Seat,
    fromIndex: number,
    prompt: string,
  ): Promise<boolean> {
    const threadId = this.boundThreadId(changeId, phase);
    return threadId === null
      ? false
      : this.threadTurnEnded(threadId, fromIndex, prompt);
  }

  async threadTurnEnded(
    threadId: string,
    fromIndex: number,
    prompt: string,
  ): Promise<boolean> {
    try {
      const history = await this.options.history.readThread(threadId);
      return history !== null && appServerThreadTurnEnded(history, fromIndex, prompt);
    } catch {
      return false;
    }
  }

  quietForMs(changeId: string, phase: Seat): number | null {
    return this.options.streams.quietForMs(changeId, phase);
  }

  close(changeId: string, phase: Seat): void {
    this.options.streams.close(changeId, phase);
  }

  async interrupt(changeId: string, phase: Seat): Promise<boolean> {
    if (!this.has(changeId, phase)) return false;
    const snapshot = this.options.streams.snapshot(changeId, phase);
    if (snapshot.activeTurnId === null) return false;
    await this.options.streams.interrupt(changeId, phase, snapshot.activeTurnId);
    return true;
  }

  forget(changeId: string): void {
    this.options.streams.forget(changeId);
  }

  closeAll(): void {
    this.options.streams.closeAll();
  }

  private boundThreadId(changeId: string, phase: Seat): string | null {
    const bindings = new BindingStore(this.options.database);
    const bound = phase === ASIDE
      ? bindings.findAside(changeId)
      : bindings.find(changeId, phase);
    return bound?.status === "bound" ? bound.threadId : null;
  }

  private detachBinding(binding: BoundThread): void {
    const bindings = new BindingStore(this.options.database);
    if (binding.kind === "round") bindings.detach(binding.changeId, binding.phase);
    else bindings.detachAside(binding.changeId);
  }

  private async prepareBinding(changeId: string, phase: Seat): Promise<void> {
    const threadId = this.boundThreadId(changeId, phase);
    if (threadId === null) return;
    const binding: BoundThread = phase === ASIDE
      ? { changeId, kind: "aside", phase: null, threadId }
      : { changeId, kind: "round", phase, threadId };
    const prepared = await prepareBoundThread({
      binding,
      archive: this.archive,
      detach: (found) => { this.detachBinding(found); },
    });
    if (prepared.kind === "fresh") {
      console.log(
        `[panel] ${changeId}/${phase} 的线程 ${threadId} 已不存在 —— fresh`,
      );
      return;
    }
    if (prepared.kind === "refused") {
      throw new SessionResumeRefusedError(threadId, prepared.reason);
    }
  }
}

const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: join(HERE, "panel.html"), type: "text/html; charset=utf-8" },
  "/panel.js": { file: join(HERE, "panel.js"), type: "text/javascript; charset=utf-8" },
  "/codex-stream.js": {
    file: join(HERE, "codex-stream.js"), type: "text/javascript; charset=utf-8",
  },
  // The cloud-sea ground is a real generated raster, not CSS pretending to be
  // one -- that was decided in the 2026-07-24 visual direction, not styled.
  "/assets/abstract-cloud-sea.png": {
    file: join(HERE, "assets", "abstract-cloud-sea.png"),
    type: "image/png",
  },
  // 图谱的前端和 three.js 本体。从 node_modules 直接喂，
  // 零 CDN、零构建步骤 —— 面板是 localhost，600KB 不过网络。
  "/graph-view.js": {
    file: join(HERE, "graph-view.js"), type: "text/javascript; charset=utf-8",
  },
  "/graph-scene.js": {
    file: join(HERE, "graph-scene.js"), type: "text/javascript; charset=utf-8",
  },
  "/three.module.js": {
    file: join(HERE, "..", "..", "node_modules", "three", "build", "three.module.js"),
    type: "text/javascript; charset=utf-8",
  },
  // r180 起 three 拆成两半：module 那份 `export * from "./three.core.js"`。
  // 浏览器按相对路径来要它，所以它也得在菜单上 —— 少这条整个 3D 静默不加载。
  "/three.core.js": {
    file: join(HERE, "..", "..", "node_modules", "three", "build", "three.core.js"),
    type: "text/javascript; charset=utf-8",
  },
  "/CSS2DRenderer.js": {
    file: join(
      HERE, "..", "..", "node_modules", "three",
      "examples", "jsm", "renderers", "CSS2DRenderer.js",
    ),
    type: "text/javascript; charset=utf-8",
  },
  "/OrbitControls.js": {
    file: join(
      HERE, "..", "..", "node_modules", "three",
      "examples", "jsm", "controls", "OrbitControls.js",
    ),
    type: "text/javascript; charset=utf-8",
  },
};

/**
 * 派一轮对抗，跑到它结算。
 *
 * ## 为什么它是一个函数，而不只是 `/api/run` 里的一段
 *
 * 「答完直接续跑」要用同一段（用户 2026-07-30：把 selector 里选 reject → 回面板按
 * 「跑这个阶段」这两步合成一步）。抄一份到 `/api/ask` 里就是两份实现 —— 而这两份
 * 只要有一处的前置检查漏掉，人就会得到一个被打成 blocked 的 Change 而不是一句
 * 「还没录需求」。E3 说的就是这件事。
 *
 * ## 「跑这个阶段」跑的是一轮对抗，不是一次 turn
 *
 * 单次 turn 是让一个模型自己写、自己说没问题，闸门读它的自述 —— 这个产品存在的理由
 * 就是不许那样。所以这里直接换掉 runner，而不是在界面上多一个按钮：两个「跑」、
 * 没人说得清哪个是真的，那是老树的病。
 *
 * 裁判仍然跑在这个阶段自己的 App Server thread 里（`launch` 那一行），所以你在面板上看得见它，
 * 也看得见它什么时候停下来问你。
 */
async function runRound(input: {
  changeId: string;
  phase: Phase;
  sessions: PanelSessions;
  options: PanelOptions;
}): Promise<{
  ran: boolean; phase: Phase; reason?: string;
  /**
   * 排出去的那一轮的 id。**只在 `ran` 为真时有** —— 拒绝的时候没有轮可指认。
   *
   * 这里原来是 `outcome`（整轮的结果），而派发 2026-08-05 改成不等它跑完了
   * （BACKLOG §3.4）。**不留 `outcome` 这个字段**：留着就是留一个有时有值、
   * 有时没有的东西，比没有更难对付；轮的结局走库和那条独立的进度轮询。
   */
  jobId?: string;
  /** 树脏时是哪几个文件。人得知道从哪下手。 */
  dirty?: readonly string[];
  /** 没被信任的那个目录。人要拿它去手动答一次 Codex 的信任提问。 */
  workspace?: string;
  /** 上游产物缺了哪几份。人得知道是哪个阶段的哪一份，才有地方下手。 */
  missing?: readonly { phase: Phase; id: string }[];
}> {
  const { changeId, phase, sessions, options } = input;
  const database = options.database;

  /*
   * §6.5 规则 5：一个阶段线程同一时刻只许有一个活进程。
   *
   * **判据是「这个阶段有没有活儿没了结」，不是「窗口开没开」，也不是「进程活着吗」。**
   *
   * 两次收窄。2026-08-02 从「窗口开着就拒」收到「有 turn 在飞才拒」—— 一轮结算完
   * 会话保持可恢复，闲置时没有任何 turn 边界可交错，而原来那条会让人
   * 每次派发前都得手动去关。
   *
   * 2026-08-03 又反过来补了另一半：**只看进程会漏**。一轮跑完、会话结束、注册表里
   * 没了，而库里那个 job 还是 `running`（没人收尾）—— 于是下一次派发畅通无阻，
   * 同一个 (Change, 阶段) 上起了第二条裁判线程。实测两条互相打断，一条烧掉近
   * 300 万 input token，人在终端里连字都打不进去。
   *
   * 所以两个都查（`phaseBusy`）：账本说有活儿，或者注册表里还有个活进程。
   * 都不忙时，把那个闲窗口关掉再派 —— `close` 会主动通知正在看的人，不留死画面。
   */
  const busy = phaseBusy(database, changeId, phase);
  if (busy) {
    return { ran: false, phase, ...busy };
  }
  if (sessions.has(changeId, phase)) {
    sessions.close(changeId, phase);
  }
  /*
   * **这一轮跑在哪个座位上**（批 3）：主线，或者一个开着的并行座位。
   * 都不是就拒 —— 一个既不在主线上、也没开座位的阶段没有「跑它」这回事。
   */
  const mainPhase = new ChangeStore(database).read(changeId).state.phase;
  const seat = phase === mainPhase
    ? null
    : new ParallelStore(database).find(changeId, phase);
  if (phase !== mainPhase && seat === null) {
    return { ran: false, phase, reason: "phase_not_active" };
  }
  /*
   * **只有 `pending` 和 `running` 能派。这份名单和 `TurnLoop.queueTurn` 是同一份。**
   *
   * `queueTurn` 收 `pending`（自己补一个 `start`）和 `running`（人刚 `retry` 过，
   * 状态已经在那儿了）；别的状态它直接抛。而抛出来的后果 2026-07-30 实测过：
   * 一个 `blocked` 的阶段上按「跑这个阶段」，回来的是 **HTTP 500、空 body**，
   * 界面显示「没跑起来：undefined」，而下一步那行偏偏正在让人按它 —— 老树那种病。
   *
   * 所以这里先拦住，**并且说出是哪一种**。两条出口分别是：
   *   blocked  -> retry，而 retry 是人的裁决，走「请 Codex 问我」
   *   settled  -> 先裁决（批准 / 再来一轮）
   *
   * **第一版我写成了「只有 pending」，那是错的** —— 那会把 retry 之后那一步堵死：
   * `retry` 把 Change 推到 `running`，而那时正需要派一轮。名单要跟着 `queueTurn` 走。
   */
  /*
   * **blocked 的座位从这个按钮出去**（批 4 · 审计 P0 第 3 条）。
   *
   * 主线的 blocked 走裁决（retry 是人的决定，经「请 Codex 问我」）；座位没有
   * 裁决面 —— 它的终点只有被收编。撤回前 `ParallelStore.retry` 全树没有调用者，
   * 座位一 blocked 就永远趴着。人按「跑这个阶段」就是那个决定：先 retry 推回
   * running，再照常派 —— 阻断归人管，这一下正是人在管。
   */
  if (seat !== null && seat.status === "blocked") {
    new ParallelStore(database).apply(changeId, phase, "retry");
  }
  /*
   * **settled 的座位从这个按钮再来一轮**（2026-08-13 用户拍：并行轨必须能
   * 独立重来）。座位没有裁决面，主线的 reject 够不着它 —— 在这之前一个
   * settled 的座位是冻的：按「跑」被拒，提示去裁决，而裁决面根本不存在，
   * 死路。和上面 blocked → retry 同一个形状：人按这个按钮，就是「这轨
   * 再来一轮」的决定本身。
   */
  if (seat !== null && seat.status === "settled") {
    new ParallelStore(database).apply(changeId, phase, "start");
  }
  // 并行座位看座位自己的状态，主线看主线的 —— 同一份名单，两个座。
  const status = seat === null
    ? new ChangeStore(database).read(changeId).state.status
    : seat.status === "blocked" || seat.status === "settled"
      ? "running" : seat.status;
  if (status !== "pending" && status !== "running") {
    return { ran: false, phase, reason: `phase_cannot_queue:${status}` };
  }
  /*
   * **拒绝派发时，状态要跟着派发结果走。**
   *
   * 下面 brief / path / trust / dirty / upstream 五条预检，拒的时候分两种：
   *
   * - `pending` 的拒绝不动状态 —— 它没说过自己在跑，没有谎要圆。下面那两段
   *   「前置条件不满足不该把 Change 打成 blocked」说的就是这条路，仍然成立。
   * - `running` 的拒绝必须当场回滚。retry 那条路先推状态、这里才预检
   *   （`questions.apply` 把 blocked 推到 running）——拒了不回滚，就留下
   *   「界面说在跑、库里什么都没有」，而 running 只允许 settle / fail，
   *   人一个按钮都没有。2026-08-05 真机：Build/running 永久卡死，唯一出口是改库。
   *
   * `queueTurn` 写明的不变量 **a running Change always has work behind it** 在
   * 拒绝的那一刻已经破了；fail 把它修回 blocked，人清完路障还能 retry。
   * 拒绝的理由本身跟着 HTTP 响应回去（`runRefusal` 那套人话），这里只管状态不说谎。
   */
  const refuse = <T extends {
    readonly ran: false; readonly reason: string;
  }>(refusal: T): T => {
    /*
     * **拒绝也要进账本**（交接 §5.5.4 / §5.5.5）。不记的话，库里最近的 error
     * 还是上一轮的旧话（实测：retry 被干净树拒掉，屏幕上挂着的还是 30 分钟前的
     * 超时）—— 界面读「最近一条」，那一条必须是这一次的真话。
     */
    new JobStore(database).recordRefusal({
      id: `JOB-${changeId}-${phase}-${Date.now()}-refused`,
      changeId, phase, reason: refusalError(refusal), at: Date.now(),
    });
    if (status === "running") {
      // 回滚落在拒绝的那个座位上：并行座位收座位，主线收主线（批 3）。
      if (seat === null) new ChangeStore(database).apply(changeId, "fail");
      else new ParallelStore(database).apply(changeId, phase, "fail");
    }
    return refusal;
  };
  // 五条预检（brief / path / trust / dirty / upstream）—— 判据全在
  // `dispatchPrecheck` 里，这里只管把拒绝按 `refuse` 的规矩落账、回滚状态。
  const refused = dispatchPrecheck(database, sessions, changeId, phase);
  if (refused !== null) return refuse(refused);
  const workspace = sessions.workspaceFor(changeId);
  if (workspace === null) throw new ProjectPathMissingError(changeId);

  const loop = new TurnLoop({
    database,
    runner: new RoundTurnRunner({
      transport: options.appServerTransport({
        cwd: workspace,
        config: pluginAppServerConfigFor(database, changeId, phase),
        ...(options.turnTimeoutMs === undefined
          ? {} : { timeoutMs: options.turnTimeoutMs }),
      }),
      gaps: new GapStore(database),
      rubrics: new RubricStore(database),
      changes: new ChangeStore(database),
      bindings: new BindingStore(database),
      evidence: new EvidenceStore(database),
      notes: new RoundNoteStore(database),
      repo: sessions.repo,
      workspaceFor: (each) => sessions.workspaceFor(each),
      childThreads: (parentThreadId) => childThreadsOf({
        history: options.history,
        parentThreadId,
      }),
      /*
       * **写临时目录，不写工作区。** 写进工作区会把干净树弄脏，而干净树是派轮的
       * 前置条件（上面那个 `workspace_dirty`）—— 那会变成「派轮这件事本身让下一次
       * 派不了轮」。子 Agent 的沙箱把 `/private/tmp` 列在可写根里（实测见过）。
       */
      writeRoundFile: (name, content) => {
        const directory = mkdtempSync(join(tmpdir(), "stagepass-round-"));
        const path = join(directory, name);
        writeFileSync(path, content, "utf-8");
        return path;
      },
      /*
       * 读回反方写的那份判定。**不在就是 `null`，绝不抛** —— 「它没写」是这一轮的
       * 一个正常结局（反方可能压根没照做），不是 StagePass 出了故障。
       */
      readRoundFile: (path) => {
        try { return readFileSync(path, "utf-8"); } catch { return null; }
      },
      worklist: new WorklistStore(database),
      readThread: (threadId) => readThreadTranscript({
        history: options.history,
        threadId,
      }),
      // 并行座位的轮次从活儿数（批 3）：座位的 start 不进账本。
      parallelRound: (each, seatPhase) =>
        new JobStore(database).countFor(each, seatPhase),
      // 案 B 的挡门取数口（批 4）：Build 整树提交前看对轨（Test）在不在跑。
      seatStatus: (each, seatPhase) =>
        new ParallelStore(database).find(each, seatPhase)?.status ?? null,
      taskFor: (each) => MINIMAL_PHASE_INSTRUCTIONS[each as Phase],
    }),
  });
  const at = Date.now();
  const jobId = `JOB-${changeId}-${phase}-${at}`;
  /*
   * **硬顶有两份（App Server turn 和 job 截止），它们必须是同一个数；租约不再是第三份。**
   *
   *   App Server  等 `turn/completed`（`AppServerCodexTransport.timeoutMs`） = turnMs
   *   job 截止    到点把 job 判 `deadline_reached`（`domain/lease.ts`）      = turnMs
   *   租约        短租 + 跑轮期间心跳续（`LEASE_TTL_MS`，turn-loop.ts）
   *
   * 2026-08-04 实测（当时三个都要同数）：执行器跟着 `--turn-timeout` 走、
   * 后两个写死 30 分钟时，`--turn-timeout 180` **一点用都没有** —— 21:25 起跑的
   * 那一轮 21:55 整死于 `deadline_reached`。更坏的是同一堵墙两个名字：三个都是
   * 30 分钟时执行器先喊 `codex_unavailable`，把执行器推上去之后轮到
   * job 截止喊 `deadline_reached`（我当天先后诊断错了两次）。所以**硬顶那两份
   * 必须同数**这半句今天仍然成立。
   *
   * 租约那份原来也要同数，因为当时没有心跳 —— 租约短于轮长，收尸人会在一条
   * **还在跑**的轮身上收尸（第三张脸：库里说死了，屏幕上 Codex 还在动）。
   * 代价是**检测死亡的延迟 = 单轮时限**：出厂 30 → 180 分钟之后，面板中途死掉，
   * 界面要说满 3 小时的「在跑」。2026-08-13 起心跳接上了（`TurnLoop.startHeartbeat`），
   * 租约只回答「工人还活着吗」：活着每拍续，死了最多 `LEASE_TTL_MS` + 一趟收尸
   * 就被发现。第三张脸由「续到硬顶就停手」挡住，有测试钉。
   */
  const turnMs = options.turnTimeoutMs ?? 180 * 60_000;
  loop.queueTurn({ changeId, jobId, deadlineAt: at + turnMs, maxAttempts: 1, phase });

  /*
   * **排完队就返回，不把一轮的时长压在一个 HTTP 请求上**（BACKLOG §3.4）。
   *
   * 原来这里 `await loop.runOnce`，而实测一轮 60~343 分钟。三个后果：浏览器和
   * 代理会先超时（那时人看到「网络错误」，而轮跑得好好的）；一个挂几十分钟的
   * HTTP 请求本身就不该有；**以及它逼着所有人绕过去** —— 2026-08-04 那一夜每一轮
   * 都是 fire-and-forget 发的，测试里也到处是 `void open(...).catch(() => {})`。
   *
   * **进度不靠这个响应**：`panel.js` 有一条独立的只读轮询，`panel.status` 一变成
   * `running` 它自己就开始转。这个响应要说的只有「派出去了没有」，外加一个 jobId
   * 让人和测试指认得了这一轮。
   */
  void runToCompletion({ loop, database, changeId, phase, jobId, at });
  return { ran: true, phase, jobId };
}

/**
 * 派发前的五条预检（brief / path / trust / dirty / upstream）。
 * 拒 = 返回那个说得清的拒绝对象；null = 五条都过。**纯判据，不动任何状态** ——
 * 落账和回滚归 `runRound` 里的 `refuse`。从 runRound 抽出来是函数上限
 * （300 行）逼的，判据一个字没变。
 *
 * - **没有录入需求就不跑**：能绕过的录入等于装饰（用户 2026-07-29 的洞）。
 *   RoundTurnRunner 里有同一条（防御在两层），但那层抛出来会被 TurnLoop 记成
 *   「这一轮失败了」—— 而前置条件不满足不是失败。
 * - **项目没写路径也不跑**：同一个形状，`launchInto` 那层抛出来同样会被记错。
 * - **Codex 没信任过这个目录就别派**（2026-07-30 实测：Codex 停在信任提问上，
 *   这一侧等满 30 分钟只拿到「没有新线程」）。只有明确的 `false` 才拦；不替人
 *   答那个提问 —— 信任是人对目录的授权，不是 StagePass 的决定。
 * - **整树提交的阶段要干净树**（`commitsWholeTree`，批 4 起只剩 Build ——
 *   「整树名单 = 干净树名单」那条等式不变，名单缩成一个）：StagePass 提交整树，
 *   分不出哪行是红方写的、哪行是人写了一半的。文件要列出来。Test 窄提交
 *   （逐个点名，卷不走别人的），所以它不查 —— 这正是两轨能并行的机械前提。
 * - **上游产物还在不在**（C1）：判据和 `/api/artifact` 同一个（`locateArtifact`），
 *   名单和任务书同一份（`upstreamOf`）。缺的逐条列出来。
 */
function dispatchPrecheck(
  database: Database.Database,
  sessions: PanelSessions,
  changeId: string,
  phase: Phase,
):
  | { ran: false; phase: Phase; reason: string }
  | { ran: false; phase: Phase; reason: string; workspace: string }
  | { ran: false; phase: Phase; reason: string; dirty: readonly string[] }
  | { ran: false; phase: Phase; reason: string; missing: readonly { phase: Phase; id: string }[] }
  | null {
  if (new ChangeStore(database).read(changeId).brief === null) {
    return { ran: false, phase, reason: "change_has_no_brief" };
  }
  const root = sessions.workspaceFor(changeId);
  if (root === null) {
    return { ran: false, phase, reason: "project_has_no_path" };
  }
  if (sessions.trust.isTrusted(root) === false) {
    return { ran: false, phase, reason: "workspace_not_trusted", workspace: root };
  }
  if (commitsWholeTree(phase)) {
    const dirty = sessions.repo.dirtyPaths(root);
    if (dirty.length > 0) {
      return { ran: false, phase, reason: "workspace_dirty", dirty };
    }
  }
  const missing = upstreamOf(phase, new ChangeStore(database).graphOf(changeId))
    .flatMap((each) =>
      new EvidenceStore(database).read(changeId, each).artifactIds
        .map((id) => ({ phase: each, id })))
    .filter(({ id }) => !locateArtifact({ root, id, repo: sessions.repo }).ok);
  if (missing.length > 0) {
    return { ran: false, phase, reason: "upstream_artifact_missing", missing };
  }
  return null;
}

/**
 * 一次预检拒绝，落进账本的那句话。
 *
 * 细节（哪几个文件、哪个目录、缺哪几份）都要在 —— 「树脏了」这句话本身没法让人
 * 动手，这正是那几个字段被加进返回值的理由，落账时不能又把它们丢掉。
 */
function refusalError(refusal: {
  readonly reason: string;
  readonly dirty?: readonly string[];
  readonly workspace?: string;
  readonly missing?: readonly { phase: Phase; id: string }[];
}): string {
  const detail = refusal.dirty !== undefined && refusal.dirty.length > 0
    ? refusal.dirty.join("、")
    : refusal.workspace !== undefined
      ? refusal.workspace
      : refusal.missing !== undefined && refusal.missing.length > 0
        ? refusal.missing.map((each) => `${each.phase} 的 ${each.id}`).join("、")
        : "";
  return detail === "" ? refusal.reason : `${refusal.reason}：${detail}`;
}

/**
 * 后台把这一轮跑完，然后收尾。
 *
 * **它不许抛。** 移到后台之后没有 HTTP 请求接着了 —— 一个未处理的 rejection 会被
 * Node 直接杀进程，把整个面板带走。所以这里兜住一切，只留一行日志：轮本身的成败
 * `TurnLoop` 已经在库里记全了（job + Change 两边），这里再抛没有第二个人受益。
 */
async function runToCompletion(input: {
  loop: TurnLoop;
  database: Database.Database;
  changeId: string;
  phase: Phase;
  jobId: string;
  at: number;
}): Promise<void> {
  const { loop, database, changeId, phase, jobId } = input;
  try {
    await loop.runOnce({
      owner: "panel", token: jobId, now: input.at, ttlMs: LEASE_TTL_MS,
    });
  } catch (error: unknown) {
    // 库已经关了 = 面板在退场（生产不关库，只有测试的 teardown 会）。这时的
    // 「抛了」全是同一句 not open —— 在全量输出里刷十几行，把真的红淹掉。
    if (!database.open) return;
    console.error(`[panel] ${changeId}/${phase} 这一轮抛了：${String(error)}`);
  }
  /*
   * **轮失败就放开裁判线程，下一轮从干净的线程开。**
   *
   * 2026-08-02 CHG-003 连烧四轮实测出来的机制：一轮被作废，**库里不留痕，但裁判
   * 线程的记忆里全在** —— resume 回去，它接着抄自己上一轮的坏格式（第 3、4 轮），
   * 接着对自己在作废轮里发明的幽灵 gap 表态（第 5 轮 `unknown_gap`）。提示词里的
   * 告诫压不过它自己的历史，这不是提示词能修的。
   *
   * 放开是安全的，因为**线程从来不是真相的载体**：开着的 gap、任务、契约每一轮都
   * 完整写在提示词里（§6.5 —— 线程之间只能靠文档传信息）。被作废的轮丢掉的只有
   * 毒，没有事实。
   *
   * 只在**失败**时放开。成功的轮继续复用线程 —— 那里的历史是真的。
   */
  try {
    const finished = database.prepare(
      "SELECT status FROM jobs WHERE id = ?",
    ).get(jobId) as { status: string } | undefined;
    if (finished?.status === "failed") {
      new BindingStore(database).detach(changeId, phase);
    }
  } catch (error: unknown) {
    if (!database.open) return; // 同上：退场中，没有可收的尾。
    console.error(`[panel] ${changeId}/${phase} 收尾失败：${String(error)}`);
  }
}


/**
 * 一份产物现在还在不在，在哪。
 *
 * ## 为什么抽成一个函数
 *
 * 两处要问同一个问题：`/api/artifact` 读的时候，和**派发前预检**（C1）。判据必须是
 * 同一份 —— 同一条规则两份拷贝必然漂移，漂移那天预检放行的东西读接口打不开，
 * 或者反过来（`stagepass-duplicated-predicates` 那条教训）。
 *
 * ## 判据
 *
 * - 长得像 sha（`looksLikeSha`）→ 是个 commit，问 git（`repo.show`）
 * - 否则是路径 → 按项目目录解，realpath 摊平软链和 `../`，必须落在项目目录内
 *
 * 「一个阶段产出什么形态是那一轮的事实」—— 按形态判，不按阶段猜。
 */
function locateArtifact(input: {
  root: string;
  id: string;
  repo: RepoOps;
}):
  | { readonly ok: true; readonly kind: "commit"; readonly text: string }
  | { readonly ok: true; readonly kind: "file"; readonly real: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: "gone" | "outside_project" | "not_a_file"; readonly kind?: "commit" } {
  if (looksLikeSha(input.id)) {
    const shown = input.repo.show(input.root, input.id);
    return shown === null
      ? { ok: false, reason: "gone", kind: "commit" }
      : { ok: true, kind: "commit", text: shown };
  }

  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(input.root);
    real = realpathSync(isAbsolute(input.id) ? input.id : join(realRoot, input.id));
  } catch {
    return { ok: false, reason: "gone" };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { ok: false, reason: "outside_project" };
  }
  if (!statSync(real).isFile()) {
    return { ok: false, reason: "not_a_file" };
  }
  return { ok: true, kind: "file", real, bytes: statSync(real).size };
}

/** `/api/progress`。从 `handle()` 搬出来 —— 图谱那条路进来时，函数上限棘轮要的债。 */
async function serveProgress(
  url: URL,
  response: ServerResponse,
  database: Database.Database,
  sessions: PanelSessions,
  streams: StreamSessions,
  history: AppServerHistory,
): Promise<void> {
  const view = await progressView({
    database,
    sessions: {
      has: (changeId, phase) => streams.active(changeId, phase),
      quietForMs: (changeId, phase) => sessions.quietForMs(changeId, phase),
    },
    history,
    changeId: url.searchParams.get("change") ?? "",
  });
  if (view === null) { response.writeHead(404).end("no such change"); return; }
  json(response, view);
}

function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => { chunks.push(chunk); });
    request.on("end", () => { resolve(Buffer.concat(chunks)); });
    request.on("error", reject);
  });
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function serveStructuredCodex(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: PanelOptions,
): Promise<boolean> {
  return serveCodexStreamApi(url, request, response, {
    streams: options.streams,
    configFor: (changeId, seat) => pluginAppServerConfigFor(
      options.database,
      changeId,
      seat === STREAM_ASIDE ? undefined : seat,
    ),
  });
}

/**
 * 删掉一个 Change，或者一个项目（连同它底下的全部 Change）。
 *
 * 用户 2026-08-03：「每个 change 每个 project 我需要可以删除，我现在没法删。」
 * 在这之前删除路径压根不存在 —— 真库里那条空的 `CHG-1` 就是这么留下的。
 * 从 `handle()` 里搬出来（函数上限逼的），行为一个字没变。
 */
function handleWorkspaceDelete(
  url: URL,
  response: ServerResponse,
  database: Database.Database,
  sessions: PanelSessions,
): void {
  const isBusy = (id: string): ReturnType<BusyCheck> => phaseBusy(database, id);
  const forget = (id: string): void => { sessions.forget(id); };
  // 删掉的 Change 不该在 Codex 里留活线程 —— 归档的理由在 `app/workspace.ts`。
  const archive = (threadId: string): void => { sessions.archive.archive(threadId); };

  if (url.pathname === "/api/change") {
    const outcome = deleteChange({
      database, changeId: url.searchParams.get("change") ?? "",
      isBusy, forget, archive,
    });
    if (outcome.kind === "no_such_change") {
      response.writeHead(404).end("no such change");
      return;
    }
    json(response, outcome.kind === "busy"
      ? { deleted: false, ...outcome.busy }
      : { deleted: true, changeId: outcome.changeId });
    return;
  }

  const outcome = deleteProject({
    database, projectId: url.searchParams.get("project") ?? "",
    isBusy, forget, archive,
  });
  if (outcome.kind === "no_such_project") {
    response.writeHead(404).end("no_such_project");
    return;
  }
  json(response, outcome.kind === "busy"
    ? { deleted: false, changeId: outcome.changeId, ...outcome.busy }
    : { deleted: true, projectId: outcome.projectId, changes: outcome.changes });
}

/**
 * 裁决那个用例的下场，翻成网页认识的那份 JSON。
 *
 * 三个 `*Body` 是同一个形状：**下场是用例的词汇，`asked / answered` 是界面的**。
 * 一处翻译，用例那边一个 HTTP 概念都没有。
 */
function decideBody(outcome: Exclude<DecideOutcome, { kind: "no_such_change" }>): unknown {
  const phase = outcome.phase;
  switch (outcome.kind) {
    case "busy":
      return { asked: false, phase, ...outcome.busy };
    case "no_decision":
      return { asked: false, reason: "no_decision_available", phase };
    case "unanswered":
      return {
        asked: true, answered: false, phase, questionId: outcome.questionId,
        reason: outcome.reason, threadId: outcome.threadId,
      };
    case "gate_moved":
      return {
        asked: true, answered: true, phase, questionId: outcome.questionId,
        answer: outcome.answer, reason: "gate_moved",
      };
    case "decided":
      return {
        asked: true, answered: true, phase, questionId: outcome.questionId,
        answer: outcome.answer,
        responses: outcome.responses,
        refused: outcome.refused,
        raised: outcome.raised,
        outcome: outcome.outcome,
        continued: outcome.continued,
        state: outcome.state,
      };
  }
}

/**
 * 录需求那个用例的下场，翻成网页认识的那份 JSON。和 `waiveBody` 同一个道理：
 * `asked / answered / recorded` 是**界面的词汇**，用例不该知道它们存在。
 */
function briefBody(outcome: Exclude<BriefOutcome, { kind: "no_such_change" }>): unknown {
  const phase = outcome.phase;
  switch (outcome.kind) {
    case "busy":
      return { asked: false, phase, ...outcome.busy };
    case "proposal_failed":
      return {
        asked: false, reason: outcome.reason, detail: outcome.detail, phase,
      };
    case "not_asked":
      return { asked: false, reason: "session_died_before_asking", phase };
    case "unanswered":
      return {
        asked: true, answered: false, phase, questionId: outcome.questionId,
        reason: outcome.reason, threadId: outcome.threadId,
      };
    case "not_recorded":
      return { asked: true, answered: true, recorded: false, phase };
    case "recorded":
      return { asked: true, answered: true, recorded: true, phase, brief: outcome.brief };
  }
}

/**
 * 接受风险那个用例的下场，翻成网页认识的那份 JSON。
 *
 * **翻译只发生在这里。** 用例返回的是 `WaiveOutcome`（一个说得清的下场），
 * `asked / answered / waived` 这三个布尔是**这一层的词汇** —— 界面读它们，
 * 用例不该知道它们存在（BACKLOG §4.1：换界面不该等于重写用例）。
 *
 * `no_such_change` 不在这里 —— 它是 404，不是一个 200 的 body。
 */
function waiveBody(outcome: Exclude<WaiveOutcome, { kind: "no_such_change" }>): unknown {
  const phase = outcome.phase;
  switch (outcome.kind) {
    case "busy":
      return { asked: false, phase, ...outcome.busy };
    case "nothing_waivable":
      return { asked: false, reason: "nothing_waivable", phase };
    case "unanswered":
      return {
        asked: true, answered: false, phase, questionId: outcome.questionId,
        reason: outcome.reason, threadId: outcome.threadId,
      };
    case "none_accepted":
      return {
        asked: true, answered: true, waived: false, phase,
        questionId: outcome.questionId,
      };
    case "gate_moved":
      return {
        asked: true, answered: true, waived: false, reason: "gate_moved", phase,
        questionId: outcome.questionId,
      };
    case "waived":
      return {
        asked: true, answered: true, waived: true, phase,
        questionId: outcome.questionId, gapIds: outcome.gapIds,
      };
  }
}

/**
 * Route one request.
 *
 * Split out from the server so the routing can be tested without a socket.
 */

/**
 * `/api/rubric` 的 POST 转发体，以及下面那条升级。
 *
 * 抽出来的理由不是审美：`handle()` 背着 §4.1 的棘轮，**只许缩不许涨**
 * （`architecture.test.ts` 的 `FUNCTION_RATCHET`）。这两段本来就是纯转发。
 */
async function serveRubricSave(
  database: Database.Database,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
    const changeId = url.searchParams.get("change") ?? "";
    const phase = url.searchParams.get("phase") ?? "";
    const role = url.searchParams.get("role") ?? "";
    if (!isPhase(phase) || !(RUBRIC_ROLES as readonly string[]).includes(role)) {
      response.writeHead(400).end("bad phase or role");
      return;
    }

    // 解码住在 domain/rubric-edit.ts，不在这里 —— 第五条常驻护栏禁止 src/web/ 把
    // 字节变成字符串。那条规则是面板被接受的前提，不是可以绕的风格问题。
    let edit;
    try {
      edit = parseRubricEdit(await readBody(request));
    } catch (error: unknown) {
      if (!(error instanceof UnreadableEditError)) throw error;
      response.writeHead(400).end(error.code);
      return;
    }

    const outcome = saveRubric({
      database, changeId, phase, role: role as RubricRole, edit,
    });
    if (outcome.kind === "no_such_change") {
      response.writeHead(404).end("no such change, or it belongs to no project");
      return;
    }
    // 三种拒绝，都要说清是哪一种 —— 前端要分别提示。
    json(response, outcome.kind === "saved"
      ? { saved: true, version: outcome.version, retired: outcome.retired }
      : outcome.kind === "reason_required"
        ? { saved: false, reason: "reason_required", retired: outcome.retired }
        : outcome.kind === "untrusted_key"
          ? { saved: false, reason: "untrusted_key", key: outcome.key }
          : { saved: false, reason: outcome.code });
    return;
  }

/**
 * 打开（或接上）这个 Change 的旁路会话 —— 一个不属于任何阶段的 Codex 聊天窗口。
 *
 * ## 为什么它不查 `phaseBusy`
 *
 * 这正是它存在的理由（DESIGN §3.3）：一个阶段正在跑轮的时候，人中途想问个名词，
 * 原来只能等整轮跑完 ——「问个名词」和「跑一轮」抢同一把椅子。旁路会话有自己的
 * 座位（`ASIDE`），不产出、不推闸门，所以什么都不用等。
 *
 * ## 线程怎么被认出来、绑定
 *
 * 聊天没有「turn 跑完」这回事，但线程要能跨窗口续（批 2 的「把闲聊收敛成 brief」
 * 要按它找到那段对话）。所以第一次打开带一句开场提示词，走 transport 的
 * `awaitNewThread`（按提示词认线程，不认「谁先出现」）；`onThread` 一认出来就
 * 绑进 `change_bindings (kind='aside')`，之后每次打开都 resume 同一条。
 * 认线程在后台跑，不挡这个响应 —— 人要的是窗口，不是绑定回执。
 */
async function serveAside(
  database: Database.Database,
  url: URL,
  response: ServerResponse,
  sessions: PanelSessions,
  options: PanelOptions,
  request: IncomingMessage,
): Promise<void> {
  const changeId = url.searchParams.get("change") ?? "";
  /*
   * **写那一趟的理由走同一个入口**（`?visit=<seq>`）—— 它和开旁路是同一种
   * 资源上的两个动作，而 `handle` 是一张路由表：每加一个功能就给它加一个分支，
   * 那张表迟早长成一层（护栏「没有一个函数长成一层」盯的正是它）。
   */
  const visit = url.searchParams.get("visit");
  if (visit !== null) {
    await serveAsideNote(database, changeId, Number(visit), request, response);
    return;
  }
  try {
    new ChangeStore(database).read(changeId);
  } catch {
    response.writeHead(404).end("no such change");
    return;
  }
  /*
   * **进旁路记一趟账**（彗星，2026-08-11）。开着就接上，账也不重记 ——
   * `AsideStore.open` 自己幂等，两边的语义必须一致，否则每点一次侧栏就记一趟空账。
   */
  const root = sessions.workspaceFor(changeId);
  new AsideStore(database).open(
    changeId, root === null ? null : sessions.repo.head(root));
  // 已经开着就原样接上，不起第二个 —— 和 /api/terminal 同一个幂等契约。
  if (sessions.has(changeId, ASIDE)) {
    json(response, { opened: true });
    return;
  }

  const bound = new BindingStore(database).findAside(changeId);
  await sessions.openForChat(
    changeId,
    ASIDE,
    pluginAppServerConfigFor(database, changeId),
  );
  if (bound?.status !== "bound") {
    /*
     * 开场词带 changeId 和时刻：awaitNewThread 按它认线程，两个 Change 同时
     * 开旁路、或同一个 Change 关了重开，都不许认错。
     *
     * **开头那个标记是承重的**（`STAGEPASS_SAID`）：起草前要数「人说过几句」，
     * 而这句话也会成为 App Server thread 的 user message —— 不标记它就会被算成人说的，
     * 那道闸当场失效（2026-08-06 真机上就是这么放过一份空草稿的）。
     */
    await options.streams.startTurn(changeId, ASIDE,
      `${STAGEPASS_SAID} 这是 StagePass 里 ${changeId} 的旁路会话`
      + `（${new Date().toISOString()}）。`
      + "人会在这里问问题、聊这次改动要什么。你不产出任何阶段的东西、不推动任何"
      + "闸门。回答要基于这个仓库的真实代码，不知道就说不知道。收到请简短回应。",
    );
  }
  json(response, { opened: true });
}

/**
 * 批 2 的两步：起草（POST /api/brief-draft）和定稿（POST /api/brief-confirm）。
 *
 * 用例在 `app/converge-brief.ts`（含那条机械判据）；这里只提供它不认识的三样：
 * 在旁路线程上跑一个 turn、和 briefs 目录的读写。
 */
function briefFiles(options: PanelOptions): {
  write: (name: string, content: string) => string;
  read: (name: string) => string | null;
} {
  const directory = options.briefsDir
    ?? join(homedir(), ".stagepass", "briefs");
  return {
    write: (name, content) => {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, name);
      writeFileSync(path, content, "utf-8");
      return path;
    },
    read: (name) => {
      try {
        return readFileSync(join(directory, name), "utf-8");
      } catch {
        return null;
      }
    },
  };
}

async function serveBriefDraft(
  database: Database.Database,
  url: URL,
  response: ServerResponse,
  sessions: PanelSessions,
  options: PanelOptions,
): Promise<void> {
  const changeId = url.searchParams.get("change") ?? "";
  const outcome = await draftBrief({
    database, changeId,
    saidIn: (threadId) => readThreadUserMessages({
      history: options.history,
      threadId,
    }),
    runTurn: async (threadId, prompt) => {
      const workspace = sessions.workspaceFor(changeId);
      if (workspace === null) throw new ProjectPathMissingError(changeId);
      const transport = options.appServerTransport({
        cwd: workspace,
        ...(options.turnTimeoutMs === undefined
          ? {} : { timeoutMs: options.turnTimeoutMs }),
        config: pluginAppServerConfigFor(database, changeId),
      });
      return (await transport.runTurn({ threadId, prompt })).text;
    },
    writeBriefFile: briefFiles(options).write,
  });
  json(response, outcome);
}

function serveBriefConfirm(
  database: Database.Database,
  url: URL,
  response: ServerResponse,
  options: PanelOptions,
): void {
  json(response, confirmBrief({
    database,
    changeId: url.searchParams.get("change") ?? "",
    readBriefFile: briefFiles(options).read,
  }));
}

/**
 * 结束一个阶段的终端 —— 以及，有一轮在飞时，**把那一轮当场收掉**。
 *
 * ## 光杀进程不算出口（交接 §5.5.2）
 *
 * 「这个 (Change, 阶段) 上有没有活儿」有两个来源：注册表里的进程，和账本里
 * queued / running 的 job。原来这条路只问注册表 —— 杀掉进程，账本上那一轮照旧
 * 挂着，Change 停在 `running` 等满 30 分钟超时，这段时间里人一个能按的都没有；
 * 面板重启过的话连进程都不在注册表里，出口整个被藏。
 *
 * 所以两个都收：进程照旧 kill，账本上的活儿记成 `aborted_by_human`、Change 收回
 * `blocked`（可以 retry）。迟到的工人失败由 `TurnLoop.runOnce` 的「谁先收尾谁
 * 说了算」兜住，不会把账翻回去。
 *
 * ## 这仍然不是网页上的裁决入口
 *
 * 中止一轮和结束一个进程同一类：不推动闸门、不对任何产物下判断，只陈述
 * 「人把这一轮停了」—— 和收尸人对过期租约做的是同一件事，只是由人当场触发。
 */
async function serveClose(
  database: Database.Database,
  url: URL,
  response: ServerResponse,
  sessions: PanelSessions,
): Promise<void> {
  const changeId = url.searchParams.get("change") ?? "";
  const phase = url.searchParams.get("phase") ?? "";
  // 旁路会话也从这儿关：只有进程可收，没有账 —— 它不产出、不占座、没有 job。
  if (phase === ASIDE) {
    const had = sessions.has(changeId, ASIDE);
    await sessions.interrupt(changeId, ASIDE);
    sessions.close(changeId, ASIDE);
    /*
     * **出旁路结账**：记下当时的 HEAD。前后不同 = 这一趟动过手，`needsNote`
     * 为真，界面据此向人要一句「这次旁路做了什么」—— 那句话是下游唯一能知道
     * 「环外发生过什么」的地方。只聊过的那种一个字都不问。
     */
    const root = sessions.workspaceFor(changeId);
    const settled = new AsideStore(database).close(
      changeId, root === null ? null : sessions.repo.head(root));
    json(response, {
      closed: had, phase,
      ...(settled === null ? {} : {
        visit: settled.visit.seq, needsNote: settled.needsNote,
      }),
    });
    return;
  }
  if (!isPhase(phase)) { response.writeHead(400).end("no such phase"); return; }
  const was = sessions.has(changeId, phase);
  await sessions.interrupt(changeId, phase);
  sessions.close(changeId, phase);

  // 只收「这个阶段」的账（批 3 起 busy 按阶段问）——
  // 人关一个历史阶段的闲终端，不该顺手把正在跑的那一轮打掉。
  const busy = phaseBusy(database, changeId, phase);
  let aborted: string | null = null;
  if (busy !== null) {
    let state: { phase: Phase; status: string } | null = null;
    try {
      const read = new ChangeStore(database).read(changeId).state;
      state = { phase: read.phase, status: read.status };
    } catch { /* Change 已经没了 —— 没有账可收 */ }
    const seat = state !== null && state.phase !== phase
      ? new ParallelStore(database).find(changeId, phase)
      : null;
    if (state !== null && (state.phase === phase || seat !== null)) {
      new JobStore(database).abort(busy.jobId, "aborted_by_human");
      // 中止落在这一轮的座位上：主线收主线，并行座位收座位（批 3）。
      if (state.phase === phase) {
        if (state.status === "running") {
          new ChangeStore(database).apply(changeId, "fail");
        }
      } else if (seat?.status === "running") {
        new ParallelStore(database).apply(changeId, phase, "fail");
      }
      aborted = busy.jobId;
    }
  }
  json(response, {
    closed: was, phase, ...(aborted === null ? {} : { aborted }),
  });
}

/**
 * 并行座位一览（GET /api/parallel，批 4 重开）—— **只读**。
 *
 * ## 手动开座的入口没有回来
 *
 * 批 3 的 POST 入口 2026-08-07 撤回（审计 12 个问题、6 个 P0）。批 4 把那六条
 * 逐个还了，但**开座从此是结构的事，不是按钮的事**：钻石的分叉在
 * `ChangeStore.apply` 里 —— 批准落到 BuildPlan / Build 时自动给孪生阶段
 * （TestPlan / Test）开座（`parallelTwinOf`）。人不需要、也不再能手动开一个
 * 图上没有的并行 —— 那正是孤儿座位（P0 第 2/6 条）当初进来的门。
 *
 * 这条路由留着给界面读「现在有哪些座位、各自什么状态」——
 * 看状态不该有副作用（用户的界面原则），所以它一个字都不写。
 */
function serveParallel(
  database: Database.Database,
  url: URL,
  response: ServerResponse,
): void {
  const changeId = url.searchParams.get("change") ?? "";
  json(response, { seats: new ParallelStore(database).list(changeId) });
}

/**
 * 旁路那一趟的理由（彗星，2026-08-11）。
 *
 * **只在动过手时界面才会来调它** —— 判据是 `AsideStore.close` 返回的
 * `needsNote`（前后两个 HEAD 不同），不在这儿重算一份。只聊过的那种一个字
 * 都不问，那正是让轻的用法保持轻。
 */
async function serveAsideNote(
  database: Database.Database,
  changeId: string,
  seq: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!Number.isInteger(seq) || seq < 1) {
    response.writeHead(400).end("bad visit");
    return;
  }
  // 原样递字节 —— 解码在 AsideStore 那一层（web/ 只转发，不解释）。
  const wrote = new AsideStore(database).note(changeId, seq, await readBody(request));
  if (!wrote) {
    response.writeHead(400).end("empty note or no such visit");
    return;
  }
  json(response, { noted: true });
}

/**
 * 编辑过门的**关门检测**（批 6，机制见 `domain/edit-gate.ts`）。
 *
 * 判据是机械的：这个阶段的产出文件（路径形态的那些）在工作树里有未提交的改动。
 * StagePass 自己轮末就把产物目录窄提交掉了（`producedBy`），所以 settle 之后
 * 树上这份文件的任何脏改动都只能出自人的手。
 *
 * 挂在 `/api/ask` 的进门处而不是读面板那条路上：检测到编辑要**写库**（关那条
 * gap），而「看状态不该有副作用」—— 按下「请 Codex 问我」是一个动作，动作里
 * 顺手把已经成立的事实落库，不违反那条原则。
 *
 * 人自己把编辑 commit 掉了的情形这里看不见 —— 那时门还开着，他在裁决表上驳回
 * 或 waive 这一条（说明原因）就是出口，gap 的标题写着这句话。
 */
function settleEditGateIfEdited(
  database: Database.Database,
  sessions: PanelSessions,
  changeId: string,
): void {
  let phase: Phase;
  try {
    phase = new ChangeStore(database).read(changeId).state.phase;
  } catch {
    return;   // 没有这个 Change —— decideGate 会用 404 说这件事
  }
  if (!requiresHumanEdit(phase)) return;
  const gaps = new GapStore(database);
  if (!gaps.all(changeId, phase).some(
    (gap) => isEditGateGap(gap) && gap.status === "open")) return;
  const root = sessions.workspaceFor(changeId);
  if (root === null) return;
  const artifacts = new EvidenceStore(database).read(changeId, phase).artifactIds
    .filter((id) => !looksLikeSha(id));
  const dirty = new Set(sessions.repo.dirtyPaths(root));
  const edited = artifacts.filter((path) => dirty.has(path));
  if (edited.length === 0) return;
  gaps.replace(changeId, phase, editGateClosed(
    gaps.all(changeId, phase), edited.join(", ")));
}

/**
 * 主屏那一份（GET /api/panel）：环、工作区两栏，外加**现在派得出去吗**。
 *
 * ## 为什么路障要在这一屏上
 *
 * 2026-08-07 真机：闸门只放行 `retry`，人走「请 Codex 问我」在选择器里选了它，
 * 题成功落地 —— 然后干净树预检 36 毫秒把这一轮拒掉，Change 回到 blocked，而
 * `rerun` 那条路派发前先关掉了那个阶段的终端。人眼前只剩一个死终端，屏幕上事先
 * 一个字都没说「这个阶段现在根本派不出去」。
 *
 * **闸门放行的动作，预检必拒**，两处判据从不对话 —— 那正是「亮着的按钮，按下去
 * 什么都没有」，这个产品存在的理由就是不许出现它。
 *
 * 判据不另算一份：调的就是派发那条路自己用的 `dispatchPrecheck`。它是纯读的
 * （状态和落账都归 `runRound` 的 `refuse`），所以这一屏仍然一个字都不写（M5）。
 */
function servePanel(
  url: URL,
  response: ServerResponse,
  sessions: PanelSessions,
  options: PanelOptions,
): void {
  const database = options.database;
  const changeId = url.searchParams.get("change") ?? "";
  let blocked: unknown = null;
  try {
    const state = new ChangeStore(database).read(changeId).state;
    blocked = dispatchPrecheck(database, sessions, changeId, state.phase);
  } catch {
    blocked = null;   // 没有这个 Change —— 那一屏本来就空着
  }
  json(response, {
    ...panelView({
      database,
      sessions: {
        has: (each, phase) => options.streams.active(each, phase),
        quietForMs: (each, phase) => sessions.quietForMs(each, phase),
      },
      changeId,
      askedProject: url.searchParams.get("project"),
      workspace: basename(sessions.workspaceFor(changeId) ?? process.cwd()),
    }) as object,
    /** 现在派这个阶段会被哪一条预检拒。null = 五条都过。 */
    blocked,
  });
}

/**
 * 一份产出的正文（GET /api/artifact）—— 从 `handle()` 抽出来还棘轮的债
 * （§4.1：加一条路由必须先还等量的债）。语义一个字没变，注释跟着正文走。
 *
 * ## 为什么这一条最要紧
 *
 * 在它之前弹窗只显示 artifactIds 里的**文件名**。用户 2026-07-30 的原话：
 * 「他们把 PRD 和建议一起带回给我 —— 现在只有建议，我拿不到那份 PRD。」
 * 五步场景的第 ④ 步就断在这儿：红蓝对抗跑完了，蓝方挑的毛病看得见，**被挑的那
 * 份东西看不见** —— 那份建议是悬着的，人没法判断该不该接受。
 *
 * ## 这不违反 §9.3
 *
 * 那条护栏管的是**Codex 会话流**：不许从渲染文本反推业务决定。这里读的是模型
 * **明确登记的项目产物**；会话历史和子 Agent 关系则统一由 App Server 公共方法读取。
 * 区别是判据性的：会话流是「界面」，产物是「文档」。
 *
 * ## 只读，而且只读这个阶段自己报出来的那些
 *
 * 路径必须出现在这个 (Change, 阶段) 的 `artifactIds` 里，而且落在项目目录内 ——
 * 两道都不省。`artifactIds` 是模型写的，一个想歪的模型可以往里放
 * `~/.ssh/id_rsa`；「只读库里列着的」挡不住那个，「必须在项目目录内」才挡得住。
 *
 * 读接口不写任何东西（M5）。
 */
function serveArtifact(
  database: Database.Database,
  url: URL,
  response: ServerResponse,
  sessions: PanelSessions,
): void {
  const changeId = url.searchParams.get("change") ?? "";
  const phaseName = url.searchParams.get("phase") ?? "";
  const wanted = url.searchParams.get("id") ?? "";
  if (!isPhase(phaseName)) { response.writeHead(404).end("no_such_phase"); return; }

  const listed = new EvidenceStore(database).read(changeId, phaseName).artifactIds;
  if (!listed.includes(wanted)) {
    // 不是这个阶段报出来的东西。**不猜、不去别处找。**
    json(response, { path: wanted, readable: false, reason: "not_produced_here" });
    return;
  }
  const root = sessions.workspaceFor(changeId);
  if (root === null) {
    json(response, { path: wanted, readable: false, reason: "project_has_no_path" });
    return;
  }

  /*
   * 产出是一个 commit（Build 走这条，见 `work/repo.ts`）。
   *
   * 判据是**这一格长得像不像 sha**，而不是「这是不是 Build 阶段」：一个阶段产出
   * 什么形态是那一轮的事实，不该由读的人按阶段去猜 —— 猜错的那一天，Build 的
   * commit 会被当成路径去磁盘上找，回来一句「这份产出不见了」。
   *
   * 「必须在 artifactIds 里」的闸照旧管着这一条：一个不是这个阶段报出来的 sha，
   * 走不到这里。
   */
  // 判据在 `locateArtifact` 里，和派发前预检（C1）**同一份** —— 别在这儿另算。
  const located = locateArtifact({ root, id: wanted, repo: sessions.repo });
  if (!located.ok) {
    // 「文件被移走了」要说出来 —— 一个空白的正文框和「这份产出不见了」是
    // 两件完全不同的事（M7）。
    json(response, {
      path: wanted, readable: false, reason: located.reason,
      ...(located.kind === undefined ? {} : { kind: located.kind }),
    });
    return;
  }
  if (located.kind === "commit") {
    json(response, {
      path: wanted, readable: true, kind: "commit",
      bytes: located.text.length, text: located.text,
    });
    return;
  }
  if (located.bytes > ARTIFACT_MAX_BYTES) {
    json(response, {
      path: wanted, readable: false, reason: "too_big", bytes: located.bytes,
    });
    return;
  }
  json(response, {
    path: wanted,
    readable: true,
    bytes: located.bytes,
    text: readFileSync(located.real, "utf-8"),
  });
}

export async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: PanelSessions,
  options: PanelOptions,
): Promise<void> {
  const database = options.database;
  const url = new URL(request.url ?? "/", "http://panel.invalid");
  const asset = ASSETS[url.pathname];
  if (asset && request.method === "GET") {
    response.writeHead(200, {
      "content-type": asset.type,
      // Read from disk every time and never cached. This panel is edited while
      // it is open; a cached page silently shows the previous build, which
      // reads exactly like "the change did not work".
      "cache-control": "no-store, must-revalidate",
    });
    response.end(readFileSync(asset.file));
    return;
  }
  if (await serveStructuredCodex(url, request, response, options)) return;

  if (url.pathname === "/api/panel" && request.method === "GET") {
    servePanel(url, response, sessions, options);
    return;
  }

  if (url.pathname === "/api/progress" && request.method === "GET") {
    await serveProgress(
      url,
      response,
      database,
      sessions,
      options.streams,
      options.history,
    );
    return;
  }

  if (url.pathname === "/api/artifact" && request.method === "GET") {
    serveArtifact(database, url, response, sessions);
    return;
  }

  // 项目图谱（spec 2026-08-12）。注入的 —— 理由见 PanelOptions.graph。
  if (options.graph !== undefined && await options.graph(url, request, response)) return;

  /*
   * 新建 Project / Change。
   *
   * **这不是「业务决策入口」，所以它可以在网页上。** PRD §1.1 那条线是「Web 可以
   * 改标准，永远不可以对这一次的产物下判断」—— 新建两者都不是：它不推动任何闸门，
   * 也不对任何产物下任何判断，和「选中一个 Change」是同一类动作。
   *
   * 参数走 query 而不是 body：只有一个名字，用不着一套解析；而 `src/web/` 里不许
   * 出现 TextDecoder / JSON.parse（第五条常驻护栏），能不引进来就不引。
   */
  if (url.pathname === "/api/project" && request.method === "POST") {
    const outcome = createProject({
      database,
      name: url.searchParams.get("name") ?? "",
      path: url.searchParams.get("path") ?? "",
    });
    if (outcome.kind !== "created") { response.writeHead(400).end(outcome.kind); return; }
    json(response, {
      created: true, id: outcome.id, name: outcome.name, path: outcome.path,
    });
    return;
  }

  if (request.method === "DELETE"
    && (url.pathname === "/api/change" || url.pathname === "/api/project")) {
    handleWorkspaceDelete(url, response, database, sessions);
    return;
  }

  if (url.pathname === "/api/change" && request.method === "POST") {
    const outcome = createChange({
      database,
      projectId: url.searchParams.get("project") ?? "",
      title: url.searchParams.get("title") ?? "",
    });
    if (outcome.kind === "title_required") {
      response.writeHead(400).end("title_required"); return;
    }
    if (outcome.kind === "no_such_project") {
      response.writeHead(404).end("no_such_project"); return;
    }
    json(response, { created: true, id: outcome.id, phase: outcome.phase });
    return;
  }

  /*
   * Rubric：**网页上唯一可以改的东西**（PRD §1.1）。
   *
   * 这里没有、也不许有对「这一次的产物」的裁决。改 rubric 改的是**标准** ——
   * 「这条我们本来就不该要求」；而 approve 说的是「这份产物够好了」。前者不需要
   * 人说谎就能撤销一个阻断项，后者必须在人被正面问到时回答。
   *
   * 落到能查的判据上：这两个端点只碰 rubric 表和它派生的 standard gap，
   * **碰不到 changes、commands、questions 一个字节**。
   */
  if (url.pathname === "/api/rubric" && request.method === "GET") {
    const phase = url.searchParams.get("phase") ?? "";
    if (!isPhase(phase)) { response.writeHead(400).end("bad phase"); return; }

    const outcome = rubricFor({
      database, changeId: url.searchParams.get("change") ?? "", phase,
    });
    if (outcome.kind === "no_such_change") {
      response.writeHead(404).end("no such change, or it belongs to no project");
      return;
    }
    json(response, { roles: outcome.roles });
    return;
  }

  if (url.pathname === "/api/rubric" && request.method === "POST") {
    await serveRubricSave(database, url, request, response);
    return;
  }

  /*
   * Put the gate decision to the human.
   *
   * The panel does NOT decide anything, and there is deliberately no endpoint
   * that approves or rejects. What this does is compose the question, register
   * the StagePass plugin for one invocation, and dispatch a turn that asks the
   * plugin to put it to the person -- so the selector is drawn by Codex, in
   * Codex, exactly as it was before the panel existed. The panel supplies the
   * window (PRD §1: the web surface carries no decision entrance, §5.2b: the
   * only answer path is the elicitation selector).
   *
   * The answer is applied through the fence stored with the question, so a
   * decision made against evidence that has since moved is refused rather than
   * applied to evidence the human never saw.
   */
  if (url.pathname === "/api/ask" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    settleEditGateIfEdited(database, sessions, changeId);
    const { outcome, closeSession } = await decideGate({
      database, sessions, changeId,
      cannotAskNow: (phase) => cannotAskNow(database, sessions, changeId, phase),
      launch: ({ phase, prompt }) => sessions.startTurn(
        changeId,
        phase,
        prompt,
        pluginAppServerConfigFor(database, changeId),
      ).then(() => {}),
      rerun: async (phase) => {
        // 那个阶段的终端这时还活着（题就是送进去的），所以先关掉它 —— 不然
        // `runRound` 会撞上 §6.5 规则 5 直接拒。
        sessions.close(changeId, phase);
        return runRound({ changeId, phase, sessions, options });
      },
      /*
       * 用户 2026-07-30 拍板的那一半：「Archive 只能我在 stage 跑完了之后，才能
       * 自动地 archive。」归档从此标记的是「这个阶段结束了」，而不是「Codex 那边
       * 有人清了一下」。
       */
      onApproved: async ({ phase, threadId }) => {
        const done = await archiveFinished(threadId, sessions.archive);
        console.log(`[panel] ${changeId}/${phase} 已批准，线程 ${threadId} —— ${done}`);
      },
      roundBudget: options.roundBudget ?? 5,
      timeoutMs: options.askTimeoutMs ?? 15 * 60_000,
    });
    if (outcome.kind === "no_such_change") {
      response.writeHead(404).end("no such change");
      return;
    }
    if (closeSession) sessions.close(changeId, outcome.phase);
    json(response, decideBody(outcome));
    return;
  }

  // Dispatch the Change's current phase as a real turn: the prompt is built
  // from the phase, the turn is recorded before it leaves, the thread is bound
  // to (Change, phase) afterwards, evidence lands and the gate reads it. All of
  // that is the machinery L1/L2 already proved -- the panel only supplies the
  // window it runs in.
  /*
   * 接受一条已知风险。
   *
   * **这仍然不是「网页上的裁决入口」。** 网页做的是组题、把题送进那个阶段的终端；
   * 选哪一条、写什么理由，发生在 Codex 自己画的选择器里 —— 和 approve / reject
   * 走的是同一条路，同一条规矩（PRD §1、§5.2b）。
   *
   * 这里唯一的额外判断是**候选名单**：只有 open 的 P1 finding 可以被接受。
   * P0 不许豁免；一条 `standard` 的出口是撤下那条标准，不是接受风险 —— 两句话
   * 不是一回事，让 waive 能关掉它就是让人用前者去说后者（domain/gap.ts）。
   */
  /*
   * 录入需求：模型读仓库提问题 -> 人在选择器里答 -> 答出来的那段成为需求。
   *
   * **这是「引导用户表达需求」那条职责**（需求文档 §2.1 第一条）。在这之前它整个
   * 是空的：红方收到一句写死的通用指令，「this change」是哪个 change 从来没被告知。
   *
   * 分工（用户 2026-07-29 拍板）：**问什么由模型定**（它先读仓库，问题才贴这个
   * 项目）；**信封和校验归 StagePass**（id 由这里分配，条数上下限、每题至少几个
   * 选项都在这里卡）。判据始终是「结构由谁决定」。
   *
   * 这仍然不是网页上的裁决入口：网页组题、把题送进终端，人在 Codex 自己的选择器里
   * 答 —— 和 approve / reject / waive 同一条路。
   */
  if (url.pathname === "/api/brief" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    const { outcome, closeSession } = await recordBrief({
      database, sessions, changeId,
      cannotAskNow: (phase) => cannotAskNow(database, sessions, changeId, phase),
      /*
       * **插件在这里就得注册上**，虽然提问题这一步用不到它：第二段提示词是打进
       * **同一个会话**的（见 `PanelSessions.type`），而 MCP 工具是启动时注册的。
       * 这时候不注册，后面打字让它调 `stagepass_ask` 只会得到「没有这个工具」。
       */
      propose: async (prompt) => {
        const phase = new ChangeStore(database).read(changeId).state.phase;
        const workspace = sessions.workspaceFor(changeId);
        if (workspace === null) throw new ProjectPathMissingError(changeId);
        await sessions.openForChat(
          changeId,
          phase,
          pluginAppServerConfigFor(database, changeId),
        );
        const bound = new BindingStore(database).find(changeId, phase);
        if (bound?.status !== "bound") throw new Error("App Server thread was not bound");
        const transport = options.appServerTransport({
          cwd: workspace,
          ...(options.turnTimeoutMs === undefined ? {} : { timeoutMs: options.turnTimeoutMs }),
          config: pluginAppServerConfigFor(database, changeId),
        });
        return (await transport.runTurn({ threadId: bound.threadId, prompt })).text;
      },
      timeoutMs: options.askTimeoutMs ?? 15 * 60_000,
    });
    if (outcome.kind === "no_such_change") {
      response.writeHead(404).end("no such change");
      return;
    }
    if (closeSession) sessions.close(changeId, outcome.phase);
    json(response, briefBody(outcome));
    return;
  }

  if (url.pathname === "/api/waive" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    const { outcome, closeSession } = await waive({
      database, sessions, changeId,
      cannotAskNow: (phase) => cannotAskNow(database, sessions, changeId, phase),
      launch: ({ phase, prompt }) => sessions.startTurn(
        changeId,
        phase,
        prompt,
        pluginAppServerConfigFor(database, changeId),
      ).then(() => {}),
      timeoutMs: options.askTimeoutMs ?? 15 * 60_000,
    });
    if (outcome.kind === "no_such_change") {
      response.writeHead(404).end("no such change");
      return;
    }
    if (closeSession) sessions.close(changeId, outcome.phase);
    json(response, waiveBody(outcome));
    return;
  }

  if (url.pathname === "/api/run" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    /*
     * `&phase=` 指定跑哪个座位（批 3）。不给 = 主线当前阶段（老语义）。
     * 给了一个既不在主线、也没开座位的阶段，`runRound` 会拒（phase_not_active）。
     */
    const asked = url.searchParams.get("phase");
    let phase: Phase;
    try {
      const main = new ChangeStore(database).read(changeId).state.phase;
      if (asked !== null && !isPhase(asked)) {
        response.writeHead(400).end("no such phase");
        return;
      }
      phase = asked === null ? main : asked;
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    json(response, await runRound({ changeId, phase, sessions, options }));
    return;
  }

  if (url.pathname === "/api/parallel" && request.method === "GET") {
    return serveParallel(database, url, response);
  }

  /*
   * **明确打开一个可交互 Codex 会话。** 和「只读历史」分开。
   *
   * 只读 snapshot 绝不起 turn，所以要有一个显式动作创建或恢复会话。人按下去
   * 就知道自己在打开一个 Codex —— 这正是
   * 用户 2026-08-03 那句话要的：「我点进入终端只是想看看状态……而不是点了就报废。」
   *
   * 带插件：这条路上起的 Codex 人是要跟它说话的，手上没有 StagePass 的工具就
   * 只能得到「没有这个工具」。
   */
  if (url.pathname === "/api/terminal" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    const phase = url.searchParams.get("phase") ?? "";
    if (!isPhase(phase) || phase === "Done") {
      response.writeHead(400).end("no such phase");
      return;
    }
    // 账本闲着才许起：一个阶段同时只许一个进程（PRD §6.5 规则 5），而正在跑的
    // 那一轮拥有这个座位。批 3 起按阶段问 —— 并行座位的轮不挡别的阶段开终端。
    const busy = phaseBusy(database, changeId, phase);
    if (busy) { json(response, { opened: false, ...busy }); return; }
    try {
      await sessions.openForChat(
        changeId,
        phase,
        pluginAppServerConfigFor(database, changeId),
      );
    } catch (error: unknown) {
      response.writeHead(409).end(
        error instanceof Error ? error.message : "could not open Codex");
      return;
    }
    json(response, { opened: true, phase });
    return;
  }

  if (url.pathname === "/api/aside" && request.method === "POST") {
    await serveAside(database, url, response, sessions, options, request);
    return;
  }

  if (url.pathname === "/api/brief-draft" && request.method === "POST") {
    await serveBriefDraft(database, url, response, sessions, options);
    return;
  }

  if (url.pathname === "/api/brief-confirm" && request.method === "POST") {
    serveBriefConfirm(database, url, response, options);
    return;
  }

  if (url.pathname === "/api/close" && request.method === "POST") {
    await serveClose(database, url, response, sessions);
    return;
  }


  response.writeHead(404).end("not found");
}

export function createPanelServer(options: PanelOptions): {
  server: Server;
  sessions: PanelSessions;
} {
  const sessions = new PanelSessions(options);
  const server = createServer((request, response) => {
    void handle(request, response, sessions, options).catch((error: unknown) => {
      /*
       * **失败必须说真话**（PRD §7 M7）。
       *
       * 这里原来是 `catch(() => { 500; end(); })` —— 一个空 body 的 500，服务端一句
       * 都不记。2026-07-30 撞上了它的代价：用户点「请 Codex 问我」报错，而我这一侧
       * 能看到的只有「题落库了、没有活进程」，**真实原因被这一行吃掉了**。
       * 那正是 M7 记着的老树病：「把真实原因吞在 `record_failed` 里，一个 bug 要查一天」。
       *
       * 现在两处都说：写进面板的 stdout（跑面板的人看得见），也回给浏览器（人当场
       * 看得见）。这是一个本机单用户的工具，藏错误没有换来任何东西。
       */
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      /*
       * 唯一不说的：库已经关了。那是退场（生产不关库，测试的 teardown 关）——
       * 这时飞着的每个请求都摔在同一句 not open 上，只会把全量输出里真的红
       * 淹掉。浏览器那份照回：万一真有人看着，它仍然是实话。
       */
      if (options.database.open) {
        console.error(`[panel] ${request.method ?? "?"} ${request.url ?? "?"} —— ${detail}`);
        if (error instanceof Error && error.stack !== undefined) {
          console.error(error.stack);
        }
      }
      if (response.headersSent) { response.end(); return; }
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ failed: true, error: detail }));
    });
  });
  /*
   * **收尸人要一直在，不能只在启动时来一趟。**
   *
   * `recoverStuckTurns` 原来只有一个调用者：面板启动那一次。而租约存在的全部意义
   * 就是「发现有人死了」—— 一个只在启动时跑的收尸人不算收尸人。
   *
   * 2026-08-03 实测撞到：一轮死掉，Change 卡在 `running`，按钮全灰。人做了最自然
   * 的那件事（重启面板），**什么都没有发生** —— 因为租约还有四分钟才到期。屏幕上
   * 没有任何东西说「再等四分钟」，所以它和「坏了」完全同形。
   *
   * 现在每 `recoverEveryMs` 扫一次，到期的自己就被收掉，人不必重启、也不必知道
   * 租约这个概念。**扫到东西要说出来** —— 静默恢复和什么都没发生在屏幕上一模一样，
   * 而它刚刚把一个 Change 从「在跑」改成了「上一轮失败了」。
   */
  const everyMs = options.recoverEveryMs ?? 30_000;
  const reaper = setInterval(() => {
    let swept;
    try {
      swept = recoverStuckTurns(options.database, Date.now());
    } catch (error: unknown) {
      // 收尸失败不该把面板带走 —— 说出来，下一次再扫。
      console.error(`[panel] 收拾过期的活失败了：${String(error)}`);
      return;
    }
    for (const each of swept.failed) {
      console.log(`[panel] 租约到期，判为失败（可以 retry）：${each.id} —— ${each.reason}`);
    }
    for (const each of swept.resumed) {
      console.log(`[panel] 租约到期，重新排队：${each}`);
    }
    for (const each of swept.stranded) {
      // running 而身后没有任何未完成的 job —— 不变量破了，收回 blocked（可以 retry）。
      console.log(`[panel] running 却没有任何活儿，收回 blocked（可以 retry）：${each}`);
    }
    for (const each of swept.clamped) {
      // 多半是升级前批的整轮长租约。重计时之后，死进程最多 TTL + 一趟收尸就被发现。
      console.log(`[panel] 租约比现行 TTL 长，按 ${LEASE_TTL_MS / 60_000} 分钟重新计时：${each}`);
    }
  }, everyMs);
  // Node 不该为了这个定时器活着。
  reaper.unref();

  server.on("close", () => { clearInterval(reaper); sessions.closeAll(); });
  return { server, sessions };
}
