import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

import { PHASES, isPhase, producesCommit, type Phase } from "../domain/phase";
import { codexArgv } from "../codex/invocation";
import { CodexTuiTransport } from "../codex/tui-transport";
import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";
import {
  childThreadsOf, createSubAgentLookup, readThreadTranscript, readThreadWholeText,
} from "../codex/subagent";
import {
  archiveFinished, createArchiveOps, ensureResumable, type ArchiveOps,
} from "../codex/archive";
import { RoundTurnRunner } from "../work/round-turn-runner";
import { assessorOf } from "../work/rubric-round";
import { createTrustOps, type TrustOps } from "../codex/trust";
import { createRepoOps, looksLikeSha, type RepoOps } from "../work/repo";
import { JobStore } from "../work/job-store";
import {
  gateDecisionQuestion, waiveQuestion, waiveFrom, waiveFollowUpQuestion,
  clarificationQuestion,
  responseFollowUpQuestion,
  type ClarificationItem, type Answer,
  responsesFrom, runsAgainHere, DECISION_FIELD,
} from "../domain/question";
import {
  briefContract, readBriefProposal, briefFrom, followUpFields, BriefProposalVoidError,
} from "../domain/brief";
import { GateMovedError, GateRefusedError } from "../domain/gate";
import type { Gap } from "../domain/gap";
import type { ChangeState } from "../domain/change-state";
import { BindingStore } from "../store/binding-store";
import { ChangeStore, type LedgerEntry } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { WorklistStore } from "../store/worklist-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore, ReasonRequiredError } from "../store/rubric-store";
import { RoundNoteStore } from "../store/round-note-store";
import { summariseConvergence, summariseRoundNotes } from "../domain/round";
import {
  RUBRIC_ROLES, UntrustedKeyError, InvalidCriterionError, summariseAssessments,
  type RubricRole,
} from "../domain/rubric";
import { parseRubricEdit, UnreadableEditError } from "../domain/rubric-edit";
import { retireStandards } from "../domain/rubric-gaps";
import { QuestionStore } from "../store/question-store";
import { TurnLoop, recoverStuckTurns } from "../work/turn-loop";
import { startPtySession, type PtySession, type PtySessionOptions } from "./pty-session";

/**
 * The terminal panel: StagePass Web hosting the windows Codex draws in.
 *
 * ## Host, not entrance
 *
 * This serves a page with one terminal per phase and moves bytes both ways. It
 * routes no decision. Approvals still happen inside the elicitation selector
 * Codex draws, which now appears in a browser pty instead of a Terminal.app
 * window -- the glass changed owner, not the decision. There is no endpoint here
 * that can move a gate, and there must never be one (PRD §1, §10).
 *
 * ## Bytes go through untouched
 *
 * Nothing in this file reads pty output. It arrives as `Uint8Array` from
 * `pty-session.ts` and is written straight to the response. The reason that
 * matters, and why it is a type rather than a promise, is in that module.
 *
 * ## One live process per phase thread
 *
 * The registry refuses to start a second session for a (Change, phase) that
 * already has a live one. Two `codex resume` processes appending to one rollout
 * interleave their turn boundaries, and then "which turn was mine" -- the thing
 * §6.4 pit 2 depends on -- has no answer. A panel makes several terminals being
 * open at once the normal case, so it is the panel that has to guarantee this
 * (PRD §6.5 rule 5).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

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
 * `sessions.has()` 问的是「注册表里还有没有这个阶段的 pty」，那是**当下这一刻**的
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
): { reason: "phase_already_running"; busy: string; jobId: string } | null => {
  const job = new JobStore(database).busyFor(changeId);
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
 * 派发那条**不加**这一格：一轮结算完 TUI 不退出，留下的闲窗口里没有任何 turn 边界
 * 可交错，它该被关掉接着派（2026-08-02 收窄，理由见 `runPhase`）。
 */
const cannotAskNow = (
  database: Database.Database,
  sessions: PanelSessions,
  changeId: string,
  phase: Phase,
): { reason: "phase_already_running"; busy: string; jobId?: string } | null =>
  phaseBusy(database, changeId)
  ?? (sessions.has(changeId, phase)
    // 同上：`reason` 保持界面认识的那个，细节走 `busy`。
    ? { reason: "phase_already_running" as const, busy: "terminal" }
    : null);

/**
 * 打进 composer 那一行，叫模型去调 `stagepass_ask`。
 *
 * 抽出来是因为它现在有四个落点（问裁决、问裁决的第二趟、录需求两趟）。同一句话的
 * 四份拷贝必然漂移，而漂移的那一天某条路上的模型会说「没有这个工具」。
 *
 * **必须是一行** —— composer 里一个换行就是提交（`PanelSessions.type`）。
 */
const ASK_TOOL_LINE =
  "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数** ——"
  + "问哪一个由 StagePass 决定。不要替我做决定、不要猜我想选什么，调用完就停下。";

const pluginConfigFor = (
  database: { name: string }, changeId: string,
): string[] => [
  `mcp_servers.stagepass.command="npx"`,
  `mcp_servers.stagepass.args=["tsx","${join(HERE, "..", "plugin", "server.ts")}"]`,
  `mcp_servers.stagepass.env={STAGEPASS_DB="${resolve(database.name)}",`
  + `STAGEPASS_CHANGE="${changeId}"}`,
  /*
   * **许可门的根治**（BACKLOG §2.1，2026-08-05 挖出来的）。
   *
   * `-a on-request` 下，Codex 对每个**会话**第一次调某 MCP 服务器的工具都弹许可框，
   * 而每一轮对抗都是新会话 —— 没人按就静默烧满 turn 超时。2026-08-04 一夜实测
   * 撞了七次，其中至少 65 分钟纯花在等人按（TestPlan r3 那两段静默）。
   *
   * 解药是**按服务器**的配置键：`default_tools_approval_mode`，枚举
   * `auto / prompt / writes / approve`（0.146.0 实测，`codex mcp list` 挖的）。
   * `auto` = 这个服务器的工具不再弹框。
   *
   * 为什么敢开：stagepass 这个服务器是**我们自己的插件**，工具只有问人/报判定
   * 那几个 —— 给自己的工具自动放行，不涉及任何第三方。作用面也刚好：走 `-c` 只
   * 影响 StagePass 起的会话，用户自己的 `~/.codex/config.toml` 一个字不动；
   * 弹框全发生在裁判会话上，而 `-c` 恰好够得着它（子 Agent 不继承 `-c`，
   * 但 stagepass_* 从来不是子 Agent 在调）。
   *
   * 真机确认待第一轮：判据是 rollout 里第一次 `stagepass_next` 调用**紧跟着**
   * `custom_tool_call_output`，中间没有等人的空白。
   */
  `mcp_servers.stagepass.default_tools_approval_mode="auto"`,
];

/**
 * The phases that can hold a thread: eleven of the twelve.
 *
 * `Done` is excluded because it is terminal -- nothing is dispatched there, so
 * a terminal for it would be a tab that can never show anything. Eleven is a
 * fixed number, which is what lets the panel be enumerated rather than being a
 * list that grows (PRD §6.5 rule 1). Do not introduce a third count.
 */
const THREADED_PHASES: readonly Phase[] =
  PHASES.filter((phase) => phase !== "Done");

/**
 * 一份产出最大读多大，超过就只报大小、不读。
 *
 * 弹窗里要看的是一份文档。比这还大的东西**不是拿来在弹窗里读的**，而无条件读进内存
 * 会让一个模型写歪的文件把面板拖死。
 */
const ARTIFACT_MAX_BYTES = 2_000_000;

/** Passed, failed, or neither yet. */
type PhaseMark = "approved" | "problem" | null;

/**
 * Whether a phase has passed or failed, for the colour on its node.
 *
 * ## Green is read from the ledger, never from the evidence
 *
 * A phase is approved because a PERSON approved it, and `change_events` is the
 * only place that is recorded. The tempting alternative -- green when the round
 * reported no blockers -- puts the model's own opinion of its work on the
 * screen as a pass, which is the exact substitution StagePass exists to
 * prevent (PRD §1). Decided with the user on 2026-07-29.
 *
 * ## Amber outranks green
 *
 * A gap opened on a phase that was already approved makes the green a false
 * statement, so the open gap wins. Approval is not a permanent property of a
 * phase; it is what was true the last time somebody looked.
 *
 * ## Neither is `null`, not a third word
 *
 * Where the Change is sitting is already carried by `current`, and whether a
 * phase has a thread by `threadId`. A mark that repeated either would be a
 * second name for a concept that already has one.
 */
function markOf(
  phase: Phase,
  ledger: readonly LedgerEntry[],
  state: ChangeState | null,
  gaps: readonly Gap[],
): PhaseMark {
  if (gaps.some((gap) => gap.status === "open")) return "problem";
  if (state?.phase === phase && state.status === "blocked") return "problem";

  // The last thing that happened TO this phase wins. `start` / `settle` /
  // `fail` / `retry` never leave the phase they act on, so they fall through
  // every branch and leave the verdict alone -- only a departure or an arrival
  // changes it.
  let verdict: PhaseMark = null;
  for (const entry of ledger) {
    if (entry.from?.phase === phase && entry.action === "approve") verdict = "approved";
    else if (entry.from?.phase === phase && entry.action === "reject") verdict = "problem";
    // Arriving from somewhere else makes whatever was decided here stale. Fix
    // is the phase this matters for: it is the only one the line re-enters, and
    // a green Fix while the work is back inside it would be last visit's news.
    else if (entry.to.phase === phase && entry.from?.phase !== phase) verdict = null;
  }
  return verdict;
}

export interface PanelOptions {
  readonly database: Database.Database;
  readonly session: PtySessionOptions;
  /** Injected so the routing half is provable without spawning Codex. */
  readonly start?: typeof startPtySession;
  /** 同理：归档那一层也要能在不碰 Codex 的情况下证明。 */
  readonly archive?: ArchiveOps;
  /**
   * git。同理，而且这一格更要紧：真的那一套会在项目仓库里 `add -A` + `commit`，
   * 测试里没换掉就等于每跑一次测试就提交一次工作区。
   */
  readonly repo?: RepoOps;
  /** Codex 的目录信任。同一个路子 —— 真的那一套会去读用户的 `~/.codex/config.toml`。 */
  readonly trust?: TrustOps;
  /**
   * 一轮最多等多久。默认 30 分钟。
   *
   * 不只是给测试用的旋钮：一轮对抗真的会停在审批上等人（PRD §6.6），而
   * 「窗口还开着、什么也没发生」和成功长得一模一样 —— 总得有个东西替它说话。
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

/**
 * How much output a session remembers so a new viewer sees a screen.
 *
 * A pty forwards what happens next, not what already happened, so attaching to
 * a session that has been running shows an empty terminal until Codex prints
 * again -- which, at an idle composer, is never. Replaying the bytes is the fix
 * and it stays inside the rule: they are stored and re-sent as bytes, never
 * read. Whole chunks are dropped from the front rather than slicing, because a
 * slice can land inside an escape sequence or a multi-byte character.
 */
const SCROLLBACK_BYTES = 512 * 1024;

/**
 * 下一个 `PRJ-007` / `CHG-042`。
 *
 * 顺号而不是 uuid，因为这两个 id **人要念**：它们印在界面上、在交接文档里被引用、
 * 在终端标题里出现。`CHG-3f2a9c81-…` 没人记得住上一句说的是哪一个。
 *
 * 取「已有的最大号 + 1」，不是「个数 + 1」—— 后者在删过东西之后会撞号。
 */
function mintId(prefix: string, existing: readonly string[]): string {
  const used = existing
    .map((id) => /^[A-Z]+-(\d+)$/.exec(id)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map((digits) => Number(digits));
  const next = (used.length === 0 ? 0 : Math.max(...used)) + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

interface LiveSession {
  readonly session: PtySession;
  readonly listeners: Set<(bytes: Uint8Array) => void>;
  /**
   * 进程结束时要通知的人。
   *
   * **少了它，一个死掉的终端和一个在思考的终端在浏览器里完全一样**：响应一直开着，
   * fetch 的 reader 永远等不到 done，xterm 停在最后一帧、光标还在，人于是一直等、
   * 一直打字，什么都不发生。用户 2026-07-30 报的「shut down / can't type anything」
   * 就是这个 —— 而当时**没有任何一层察觉到进程已经没了**。
   *
   * `request.on("close")` 管的是反方向（人走开），它救不了这一边。
   */
  readonly enders: Set<() => void>;
  readonly scrollback: Uint8Array[];
  /**
   * 这个 Change 已经被删掉了，死了也别留尸体。
   *
   * `close()` 只 `kill()`，而 `onExit` 是**异步**来的 —— 于是「删 Change」和
   * 「存尸体」的顺序是删在前、存在后，光在 `forget()` 里删一遍 `corpses` 拦不住。
   * 由这条会话自己带着这个标记，就没有顺序问题了。
   */
  forgotten: boolean;
}

/**
 * 这个 Change 所属的项目没写路径，所以不知道该在哪跑 Codex。
 *
 * 是个具名错误，而不是回落到某个默认目录：回落会让「跑在正确的仓库」和「跑在恰好
 * 启动时那个仓库」看起来一模一样，而那正是这条要挡的洞。
 */
export class ProjectPathMissingError extends Error {
  constructor(readonly changeId: string) {
    super(`change ${changeId} has no project path; nothing knows where to run Codex`);
    this.name = "ProjectPathMissingError";
  }
}

export class PanelSessions {
  private readonly live = new Map<string, LiveSession>();
  /**
   * 死掉的会话留下的最后一屏，按 (Change, 阶段) 各留一具。
   *
   * ## 为什么要留尸体
   *
   * 一个刚起来就死的进程，它临死前那句话就是死因（最常见：`session … is archived`）。
   * 而 onExit 把会话删掉时 scrollback 跟着没了，`/pty/…` 又是「打开就起一个新的」——
   * **回不去看尸体**。2026-07-30 查归档那次，这句话是在仓库外用 node-pty 探针重放
   * 同一条 argv 才拿到的；死因不该那么贵。
   *
   * 下一个会话起来时，这段字节先进它的 scrollback（也就是先回放给每个来看的人），
   * 新 TUI 一重画自然把它盖掉。**字节仍然是字节**：存的是原样的 Uint8Array，回放
   * 也是原样写出去，不解析（§9.3）。上限继承 SCROLLBACK_BYTES，代价只有一点内存。
   */
  private readonly corpses = new Map<string, Uint8Array[]>();
  /** 归档那一层。测试注入假的，生产用真的 —— 和 `start` 同一个路子。 */
  readonly archive: ArchiveOps;
  /** git 那一层。同一个路子，理由见 `PanelOptions.repo`。 */
  readonly repo: RepoOps;
  /** 目录信任那一层。同上。 */
  readonly trust: TrustOps;

  constructor(private readonly options: PanelOptions) {
    this.archive = options.archive ?? createArchiveOps();
    this.repo = options.repo ?? createRepoOps();
    this.trust = options.trust ?? createTrustOps();
  }


  private static key(changeId: string, phase: Phase): string {
    return `${changeId}${phase}`;
  }

  /**
   * 这个 Change 该在哪个目录里跑，拿不到就是 null。
   *
   * Change -> Project -> path。三处任意一处缺失都返回 null，**不猜**。
   */
  workspaceFor(changeId: string): string | null {
    try {
      const projectId = new ChangeStore(this.options.database).read(changeId).projectId;
      if (projectId === null) return null;
      return new ProjectStore(this.options.database).read(projectId).path;
    } catch {
      return null; // 没有这个 Change，或者没有那个 Project
    }
  }

  has(changeId: string, phase: Phase): boolean {
    const found = this.live.get(PanelSessions.key(changeId, phase));
    return found !== undefined && found.session.alive;
  }

  /**
   * 这个阶段最后一屏，**进程已经没了的时候**。没有尸体就是空数组。
   *
   * 「死了」和「从没跑过」在屏幕上必须分得开：前者要让人看见它是怎么死的
   * （`corpses` 存在的全部理由），后者该说「还没有进程」而不是给一片空白。
   */
  lastScreen(changeId: string, phase: Phase): readonly Uint8Array[] {
    return this.corpses.get(PanelSessions.key(changeId, phase)) ?? [];
  }

  /**
   * 主线那条会话**如果它已经在跑**。没有就是 `undefined` —— 绝不起一个。
   *
   * `open()` 见没有就起一个，那对「往里写点东西」这种用途是错的：它会凭空造出
   * 一个进程来接收那几个字节（而且是浏览用的那种，手上没有插件）。
   * 「已经在跑就给我，没有就是没有」—— 补按键、查状态都该用这一条。
   */
  current(changeId: string, phase: Phase): LiveSession | undefined {
    const found = this.live.get(PanelSessions.key(changeId, phase));
    return found !== undefined && found.session.alive ? found : undefined;
  }

  /**
   * **明确地**在这个阶段的线程里开一个 Codex 聊天窗口。
   *
   * ## 为什么这件事必须有自己的名字
   *
   * 这个方法原来叫 `open`，而「看一眼这个阶段的终端」走的也是它 —— 于是**只想看**
   * 的人会凭空起一个进程。用户 2026-08-03 连着栽了两次，原话：
   *
   * > 「我点进入终端只是想看看状态或者适时介入，而不是点了就报废。」
   *
   * 起来之后 `has()` 变真，这个阶段的每一个动作都被闸门拒掉（`cannotAskNow`），
   * 而当时界面上要先找到「结束这个终端」才出得来。**看和起是两件事，名字要分开。**
   *
   * ## 必须带插件
   *
   * 原来这条路拼 argv 时漏了 `config`，起出来的 Codex 手上没有 StagePass 的工具 ——
   * 人在里面让它调 `stagepass_ask` 只会得到「没有这个工具」。和 `0c83eca` 修的
   * 是同一个病（那次修的是跑一轮那条路），浏览这条路当时没一起修。
   *
   * 已经活着就原样返回，不起第二个（`launchInto` 的契约）。
   */
  openForChat(
    changeId: string, phase: Phase, config: readonly string[],
  ): LiveSession {
    const bound = new BindingStore(this.options.database).find(changeId, phase);
    // 没有 prompt：Codex 停在 composer，不派任何 turn。跑一个阶段走的是
    // `launchInto`，那条路上的 argv 由 transport 提供，带着提示词。
    return this.launchInto(changeId, phase, codexArgv({
      threadId: bound?.status === "bound" ? bound.threadId : null,
      sandbox: this.options.session.sandbox,
      approval: this.options.session.approval,
      model: this.options.session.model,
      reasoningEffort: this.options.session.reasoningEffort,
      config: [...config],
    }));
  }

  /**
   * The session for a phase, started with this exact invocation if it is not
   * already running.
   *
   * An already-live session is returned untouched -- the argv is ignored rather
   * than applied. That is the guarantee from the top of this file: a second
   * `codex resume` on the same rollout interleaves turn boundaries.
   */
  launchInto(changeId: string, phase: Phase, argv: string[]): LiveSession {
    const key = PanelSessions.key(changeId, phase);
    const existing = this.live.get(key);
    if (existing && existing.session.alive) return existing;

    /*
     * **Codex 跑在这个 Change 所属项目的目录里，不是服务启动时那个 cwd。**
     *
     * 用户 2026-07-30 发现的洞：在这之前 cwd 是 `options.session.cwd` 一个定死的值，
     * 于是无论你选了哪个项目，Codex 都跑在同一个仓库里 —— 新建一个项目，它却在改
     * stagepass 本身，用的还是 workspace-write，而且没有任何提示。
     *
     * 拿不到路径就**不起进程**，不回落到那个 cwd：回落正是那个洞的形状 —— 它让
     * 「跑在正确的仓库」和「跑在恰好启动时那个仓库」看起来一模一样。
     */
    const cwd = this.workspaceFor(changeId);
    if (cwd === null) throw new ProjectPathMissingError(changeId);

    /*
     * **resume 之前先把线程弄成 resume 得动的。**
     *
     * 一条被归档的会话，`codex resume` 一起来就退，而这一侧只看得见「进程没了」——
     * 2026-07-30 用户就撞在这上面。归档是外面的动作（不是 StagePass、也不是进程退出），
     * 所以这里每次 resume 都先确认一遍。**只在真的被归档时才动手**：`codex unarchive`
     * 对一条没被归档的会话会报错。
     *
     * 查不到状态就照旧往下走 —— 退回加这一层之前的行为，不因为读不到别人的库就不干活。
     */
    if (argv[0] === "resume" && argv[1] !== undefined) {
      const outcome = ensureResumable(argv[1], this.archive);
      if (outcome !== "already_open" && outcome !== "unknown") {
        console.log(`[panel] ${changeId}/${phase} 的线程 ${argv[1]} —— ${outcome}`);
      }
    }

    const start = this.options.start ?? startPtySession;
    const session = start({
      changeId, phase, argv,
      options: { ...this.options.session, cwd },
    });

    // 上一具尸体的最后一屏先垫进去 —— 每个来看这个新会话的人都会先看到它，
    // 然后才是新进程的输出。见 `corpses` 那段注释。
    const corpse = this.corpses.get(key) ?? [];
    const entry: LiveSession = {
      session, listeners: new Set(), enders: new Set(), scrollback: [...corpse],
      forgotten: false,
    };
    const bornAt = Date.now();
    let buffered = corpse.reduce((total, chunk) => total + chunk.byteLength, 0);
    session.onBytes((bytes) => {
      entry.scrollback.push(bytes);
      buffered += bytes.byteLength;
      while (buffered > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
        buffered -= entry.scrollback.shift()!.byteLength;
      }
      for (const listener of entry.listeners) listener(bytes);
    });
    session.onExit((exitCode) => {
      /*
       * **死因先说出来。**
       *
       * 2026-08-03 查那一屏 `Error: Operation not permitted (os error 1)` 花掉的
       * 大半时间，都耗在「哪个进程、什么参数、死在哪一步」上 —— 而这一层手里全有，
       * 只是原来一个字都不写。`corpses` 那段注释说的「死因不该那么贵」，指的是
       * 人回去看得见；这一行是另一半：**事后查得出来**。
       *
       * 只写退出码和参数，不碰 pty 的字节（§9.3）。
       */
      console.log(
        `[panel] ${changeId}/${phase} 的进程结束了，exitCode=${exitCode}`
        + ` cwd=${cwd} argv=${JSON.stringify(argv)}`,
      );
      /*
       * **刚起来就死的，把它吐出来的头几百字节一并写进日志**（BACKLOG §2.2，
       * 用户 2026-08-05 裁的：存原始字节 + exitCode、不解析、不分支、只给人看 ——
       * 不算「解释 pty 字节」，§9.3 红线不动）。
       *
       * 账单是 2026-08-04 那次「查了一小时没查出根因」：codex 临死那句话只进了
       * 浏览器，事后去 /pty 捞尸体只剩一行没有上下文。这几百字节就是死因本身
       * （实测最常见：`session … is archived`、`Operation not permitted`）。
       *
       * 阈值取 5 秒而不是笔记里随口写的 1 秒：EPERM 那类「一起来就死」不一定压着
       * 1 秒线，而一个 5 秒内就退的 codex 无论如何都不是正常收工。正常会话跑几分钟，
       * 不会误触。
       */
      if (Date.now() - bornAt < 5_000 && exitCode !== 0) {
        const head = Buffer.concat(entry.scrollback).subarray(0, 512);
        console.log(
          `[panel] ${changeId}/${phase} 起来 ${((Date.now() - bornAt) / 1000).toFixed(1)}s`
          + ` 就死了（exitCode=${exitCode}），它吐出来的头 ${head.byteLength} 字节原样如下：`,
        );
        // **字节原样写 stdout，全程不变字符串** —— §9.3 的护栏因此一个豁免都不用开
        // （它盯的是 toString / TextDecoder；这里从 pty 到日志始终是 Uint8Array）。
        process.stdout.write(head);
        process.stdout.write("\n");
      }
      /*
       * **只删自己那一条。**
       *
       * 无条件 `delete(key)` 的后果 2026-07-30 在真 Codex 上撞到了：D 的「答完直接
       * 续跑」是 `close()` 紧接着 `launchInto()`，而 `close()` 只 `kill()`，进程的
       * `onExit` 是**异步**来的。于是顺序变成
       *
       *   close → kill 旧的 → launchInto 存进新的 → 旧的 onExit 到了 → 把**新的**删掉
       *
       * 注册表从此认为这个阶段没有活进程，下一个 `open()` 就又起了一个 —— 实测到
       * 两个 codex 同时挂在同一个 (Change, 阶段) 上，而 §6.5 规则 5 的全部意义就是
       * 不许出现这个。两个 `codex resume` 往同一个 rollout 追加，「哪一轮是我的」
       * 就没有答案了（§6.4 坑 2）。
       *
       * 症状还很难查：新起的那个是**浏览用**的（没有提示词），人进终端看见一个空
       * composer，而正在跑的那一轮在另一个看不见的进程里。
       */
      // 尸体在身份判定**之前**留：无论这条 onExit 是不是当前会话的，死的都是
      // `entry` 自己，它的最后一屏就该由它自己留下。拷贝一份，免得留下的引用
      // 还被后续写入动到。
      // 除非这个 Change 已经被删了 —— 见 `LiveSession.forgotten`。
      if (!entry.forgotten) this.corpses.set(key, [...entry.scrollback]);
      if (this.live.get(key) !== entry) return;
      this.live.delete(key);
      // **告诉正在看的人它没了。** 不通知的话响应一直开着，浏览器停在最后一帧，
      // 死终端和在思考的终端一模一样。见 LiveSession.enders 那段注释。
      for (const end of entry.enders) end();
      entry.enders.clear();
    });
    this.live.set(key, entry);
    return entry;
  }

  /**
   * 往一个**活着的**会话的 composer 里打一段提示词，然后回车。没有活会话返回 false。
   *
   * ## 为什么是打字，而不是再起一个进程
   *
   * 一个阶段的一次交互有时要两个 turn：先让模型读仓库提问题，再让它把问题问给人。
   * 而 `launchInto` 对一个还活着的会话是「原样返回、argv 直接丢掉」—— 那是 §6.5
   * 规则 5 故意的行为。**于是第二段提示词根本送不进去**（2026-07-30 实测：题落库了、
   * 状态 open、没有任何人被问到，人那边就是「点了没反应」）。
   *
   * 先 close 再 launchInto 也不行：**那会掐断浏览器正在读的那条流**，而浏览器不会
   * 自动重连 —— 第二个 turn 跑起来了，却看不见、也答不了。只是把症状换成了更难查的
   * 那一种。这条路我试过，别再试。
   *
   * TUI 跑完一轮不会退出，它就坐在 composer 上等输入。**把提示词打进去正是人会做的
   * 事**，而且浏览器全程不断线：人看得见提示词出现，也看得见选择器画出来。
   *
   * 不违反 §9.3 —— 那条禁的是把 pty **输出**变成 string。按键一直是往里写的
   * （`/pty/.../in` 就是干这个的）。
   *
   * **必须是一行。** composer 里一个换行就是提交，多行提示词会被截成半句发出去。
   *
   * ## 文字和回车必须分两次写，中间要等一下
   *
   * 实测（2026-07-30）：把 `文字 + \r` 一次写进去，**文字进了 composer，回车被吃掉**，
   * 那段提示词就一直躺在那儿没发出去 —— 屏幕上看得见 `›` 后面跟着完整的一行，但没有
   * 任何 turn 在跑。人那边的症状还是「点了没反应」。
   *
   * 原因是 TUI 把一次性灌进来的一大串当成**粘贴**，而粘贴模式下回车是插入换行、不是
   * 提交。分两次写、中间隔一下，回车才被当成一次真的按键。
   *
   * 所以这个方法是 async 的。别为了「看起来干净」把它改回同步一次写 —— 那会静默地
   * 什么都不做。
   */
  async type(changeId: string, phase: Phase, line: string): Promise<boolean> {
    if (line.includes("\n")) throw new Error("prompt_must_be_one_line");
    const entry = this.live.get(PanelSessions.key(changeId, phase));
    if (!entry || !entry.session.alive) return false;

    entry.session.write(Buffer.from(line, "utf-8"));
    // 让 TUI 把这一串收完、退出粘贴态，再给它一个独立的回车。
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    if (!entry.session.alive) return false;
    entry.session.write(Buffer.from("\r", "utf-8"));
    return true;
  }

  close(changeId: string, phase: Phase): void {
    const key = PanelSessions.key(changeId, phase);
    const entry = this.live.get(key);
    entry?.session.kill();
    this.live.delete(key);
    /*
     * **主动告诉正在看的人，不等 onExit。**
     *
     * `kill()` 之后 onExit 通常会来，也会顺手做这件事。但「通常」在这里不够：这条
     * 路径是我们自己决定关掉它的，那就该由我们自己负责通知 —— 等一个可能迟到、
     * 也可能因为 pty 实现而不来的回调，换来的就是浏览器对着一帧死画面继续等。
     * 重复调用是无害的：`response.end()` 幂等，enders 随后被清空。
     */
    if (entry) {
      for (const end of entry.enders) end();
      entry.enders.clear();
    }
  }

  /**
   * 这个 Change 没了 —— 把它在这一层留下的一切一起收掉：活会话、补问格、尸体。
   *
   * ## 为什么删 Change 时 `close()` 不够
   *
   * 2026-08-03 用户报的那一屏：新建一个 Change，第一个阶段一打开就是几十行
   * 一模一样的 `Error: Operation not permitted (os error 1)`。那些行不是新的 ——
   * 是历次尝试攒下来的，而**删掉 Change 甩不掉它们**：
   *
   *   建 CHG-001 → 进程死掉 → 尸体存在 key `CHG-001PRD`
   *   删掉 → 再建 → `mintId` 取「已有最大号 + 1」，删光了就又发 CHG-001
   *   新会话起来 → 把那具尸体整个垫进 scrollback → 又死 → 存回去，多一行
   *
   * `corpses` 存在的理由是让人回去看**这个** Change 的死因。一个已经被删掉的
   * Change 没有「回去看」这回事，它的最后一屏只会冒充下一个同名者的 —— 而
   * 同名一定会发生，id 是顺号发的、给人念的，不是 uuid（见 `mintId`）。
   *
   * ## 为什么是枚举阶段，而不是按前缀扫 key
   *
   * key 是 `${changeId}${phase}` 拼出来的，**中间没有分隔符**。拿 `CHG-1` 去前缀
   * 匹配会连 `CHG-10`、`CHG-100` 的尸体一起删掉。阶段是一张定死的表，逐个算出
   * 精确的 key 就没有这个问题。
   */
  forget(changeId: string): void {
    for (const phase of PHASES) {
      const key = PanelSessions.key(changeId, phase);
      // 先立标记再 kill：`onExit` 是异步的，晚于下面那句 `corpses.delete`。
      const entry = this.live.get(key);
      if (entry) entry.forgotten = true;
      this.close(changeId, phase);
      this.corpses.delete(key);
    }
  }

  closeAll(): void {
    for (const entry of this.live.values()) entry.session.kill();
    this.live.clear();
  }
}

const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: join(HERE, "panel.html"), type: "text/html; charset=utf-8" },
  "/panel.js": { file: join(HERE, "panel.js"), type: "text/javascript; charset=utf-8" },
  // The cloud-sea ground is a real generated raster, not CSS pretending to be
  // one -- that was decided in the 2026-07-24 visual direction, not styled.
  "/assets/abstract-cloud-sea.png": {
    file: join(HERE, "assets", "abstract-cloud-sea.png"),
    type: "image/png",
  },
  "/xterm.css": {
    file: join(HERE, "..", "..", "node_modules", "@xterm", "xterm", "css", "xterm.css"),
    type: "text/css; charset=utf-8",
  },
  "/xterm.js": {
    file: join(HERE, "..", "..", "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
    type: "text/javascript; charset=utf-8",
  },
  "/addon-fit.js": {
    file: join(HERE, "..", "..", "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
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
 * 裁判仍然跑在这个阶段自己的 pty 里（`launch` 那一行），所以你在面板上看得见它，
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
   * TUI 不退出，留下的是个闲窗口，里面没有任何 turn 边界可交错，而原来那条会让人
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
  const busy = phaseBusy(database, changeId);
  if (busy) {
    return { ran: false, phase, ...busy };
  }
  if (sessions.has(changeId, phase)) {
    sessions.close(changeId, phase);
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
  const status = new ChangeStore(database).read(changeId).state.status;
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
  const refuse = <T extends { readonly ran: false }>(refusal: T): T => {
    if (status === "running") new ChangeStore(database).apply(changeId, "fail");
    return refusal;
  };
  /*
   * 没有录入需求就不跑。**在排队之前拦住，不是让它跑起来再失败。**
   *
   * RoundTurnRunner 里也有同一条检查（防御在两层），但只靠那一层是不够的：
   * TurnLoop 会把 runner 抛的错当成「这一轮跑失败了」，于是给 Change 应用 fail、
   * 标成 blocked。而「还没录需求」是前置条件不满足，**不是这一轮失败** —— 因为它
   * 把 Change 打成阻塞，就得再去 retry 才能恢复，白折腾一圈。
   */
  if (new ChangeStore(database).read(changeId).brief === null) {
    return refuse({ ran: false, phase, reason: "change_has_no_brief" });
  }
  /*
   * 项目没写路径也不跑。
   *
   * 和上面那条同一个形状、同一个理由：**前置条件不满足不该把 Change 打成 blocked**。
   * `PanelSessions.launchInto` 里也会拒（防御在两层），但那一层抛出来会被 TurnLoop
   * 当成「这一轮跑失败了」。
   */
  if (sessions.workspaceFor(changeId) === null) {
    return refuse({ ran: false, phase, reason: "project_has_no_path" });
  }
  /*
   * **Codex 没信任过这个目录就别派。**
   *
   * 2026-07-30 实测：派下去之后 30 分钟拿到 `no new Codex session appeared`。真实
   * 情况是 Codex 起来了、停在「Do you trust the contents of this directory?」上等人
   * 按，而这一侧看得见的只有「没有新线程」——**界面上它和「在跑」一模一样**，正是
   * 这个产品从头到尾在防的那一类。而且每加一个新项目都会撞一次。
   *
   * **只有明确的 `false` 才拦。** 查不出来（配置读不到、Codex 换了格式）就照旧往下
   * 走 —— 和归档那一层同一条规矩：不因为读不到别人的东西就不干活。
   *
   * **不替人答那个提问。** 答一次就往用户的 `~/.codex/config.toml` 里写一条信任，
   * 而信任是人对一个目录的授权，不是 StagePass 的决定（我 2026-07-30 越过这条线一次，
   * 后来要清理）。所以这里只说清楚，让他自己去答。
   */
  if (sessions.trust.isTrusted(sessions.workspaceFor(changeId)!) === false) {
    return refuse({
      ran: false, phase, reason: "workspace_not_trusted",
      workspace: sessions.workspaceFor(changeId)!,
    });
  }
  /*
   * **Build 要在干净的工作树上跑。**
   *
   * Build 一轮的产出是一个 commit（用户 2026-07-30），而 StagePass 提交的是「工作树里
   * 所有的改动」—— 它分不出哪一行是红方写的、哪一行是人自己写了一半的。树脏就跑，
   * 这一次 commit 会**把人没提交的活儿一起卷进去**，而那是不该替他做的事。
   *
   * 干净之后，「这一轮改了什么」才有唯一定义：commit 边界严格等于轮次边界。
   *
   * **只有产出 commit 的阶段查这个**（Build / Fix，见 `producesCommit`）：别的阶段
   * 产出一份文档、一个路径就说全了，人手里有没有没提交的东西和写文档无关，
   * 拦它只会让人没法干活。
   *
   * 把文件列出来，因为「树脏了」这句话本身没法让人动手 —— 他得知道是哪几个。
   */
  if (producesCommit(phase)) {
    const dirty = sessions.repo.dirtyPaths(sessions.workspaceFor(changeId)!);
    if (dirty.length > 0) {
      return refuse({ ran: false, phase, reason: "workspace_dirty", dirty });
    }
  }
  /*
   * **第五道预检：这个阶段的上游产物还在不在**（交接文档 C1）。
   *
   * 任务书会把上游产物列给红方当输入（`round-turn-runner.ts`）。列一个磁盘上没有的
   * 东西，红方到 rollout 里才发现「输入不见了」—— 实测烧过一整轮几分钟只换来这一句
   * （2026-07-31 Review 那次：红方报了 `RV-index-html`，磁盘上没有，QA 和 Merge 的
   * 四个角色各自又发现了一遍）。下游兜得住，但这几分钟可以省。
   *
   * 判据和 `/api/artifact` **同一个**（`locateArtifact`）：sha 问 git，路径查磁盘。
   * 把缺的逐条列出来 —— 「上游产物不见了」这句话本身没法让人动手。
   */
  const missing = PHASES.slice(0, PHASES.indexOf(phase))
    .flatMap((each) =>
      new EvidenceStore(database).read(changeId, each).artifactIds
        .map((id) => ({ phase: each, id })))
    .filter(({ id }) =>
      !locateArtifact({
        root: sessions.workspaceFor(changeId)!, id, repo: sessions.repo,
      }).ok);
  if (missing.length > 0) {
    return refuse({ ran: false, phase, reason: "upstream_artifact_missing", missing });
  }

  const loop = new TurnLoop({
    database,
    runner: new RoundTurnRunner({
      transport: new CodexTuiTransport({
        ...options.session,
        ...(options.turnTimeoutMs === undefined
          ? {} : { timeoutMs: options.turnTimeoutMs }),
        /*
         * **对抗这条路也要挂上插件。**
         *
         * 面板另外两条路（问人问题、录需求）一直挂着，唯独跑一轮的这条没有 ——
         * 于是裁判那个会话手上没有 StagePass 的工具。而落点二要把 gap 表态和 rubric
         * 判定从「手抄标识符」改成「调工具只交内容」，第一步就是它得有这个工具。
         * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md §四。
         */
        config: pluginConfigFor(database, changeId),
        launch: ({ argv }) => { sessions.launchInto(changeId, phase, argv); },
        /*
         * **提示词进了 composer 却没被提交时，补那一下回车。**
         *
         * 2026-08-03 真机：一条 resume 起来的会话，Codex 还在
         * `Starting MCP server (2/4)`，argv 里的提示词被搁进 composer 没发出去，
         * rollout 一个字节没长。判据和守卫都在 `awaitTurn` 那边 —— 这里只负责
         * 把字节送到这个阶段那个终端。**没有就不送**（`current` 不会起进程）。
         */
        nudge: ({ bytes }) => {
          sessions.current(changeId, phase)?.session.write(bytes);
        },
      }),
      gaps: new GapStore(database),
      rubrics: new RubricStore(database),
      changes: new ChangeStore(database),
      bindings: new BindingStore(database),
      evidence: new EvidenceStore(database),
      notes: new RoundNoteStore(database),
      repo: sessions.repo,
      workspaceFor: (each) => sessions.workspaceFor(each),
      childThreads: (parentThreadId) => childThreadsOf({ parentThreadId }),
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
      readThread: (threadId) => readThreadTranscript({ threadId }),
      // 「它说了什么」和「它收到过什么」是两个 reader，理由见 rubric-round.ts 那边
      // 的 `readThreadWhole`：契约在它被问到的那一段里，不在它说的话里。
      readThreadWhole: (threadId) => readThreadWholeText({ threadId }),
      taskFor: (each) => MINIMAL_PHASE_INSTRUCTIONS[each as Phase],
    }),
  });
  const at = Date.now();
  const jobId = `JOB-${changeId}-${phase}-${at}`;
  /*
   * **一轮有三个截止时间，它们必须是同一个数。**
   *
   *   transport   等 rollout 长出结果（`CodexTuiTransport.timeoutMs`）
   *   job 截止    到点把 job 判 `deadline_reached`（`domain/lease.ts`）
   *   租约 TTL    到点收尸人认为没人在管这条，把它收掉
   *
   * 2026-08-04 实测：前者跟着 `--turn-timeout` 走，后两个写死 30 分钟。于是
   * `--turn-timeout 180` **一点用都没有** —— 21:25 起跑的那一轮 21:55 整死于
   * `deadline_reached`，transport 那边还剩 150 分钟没用上。
   *
   * 更坏的是它换了个名字：三个都是 30 分钟时，transport 先喊，错误是
   * `codex_unavailable ... 1800000ms`；把 transport 推上去之后，轮到 job 截止先喊，
   * 错误变成 `deadline_reached`。**同一堵墙，两个名字**，而看错误信息的人会以为
   * 是两个不同的毛病（我今天就先后诊断错了两次）。
   *
   * 租约也要跟着。它短于另外两个的话，收尸人会在一条**还在跑**的轮身上收尸 ——
   * 那是这个坑的第三个面，而它比前两个更难看出来：库里会说这轮死了，屏幕上
   * Codex 还在动。
   */
  const turnMs = options.turnTimeoutMs ?? 30 * 60_000;
  loop.queueTurn({ changeId, jobId, deadlineAt: at + turnMs, maxAttempts: 1 });

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
  void runToCompletion({ loop, database, changeId, phase, jobId, at, turnMs });
  return { ran: true, phase, jobId };
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
  turnMs: number;
}): Promise<void> {
  const { loop, database, changeId, phase, jobId } = input;
  try {
    await loop.runOnce({
      owner: "panel", token: jobId, now: input.at, ttlMs: input.turnMs,
    });
  } catch (error: unknown) {
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

/**
 * Route one request.
 *
 * Split out from the server so the routing can be tested without a socket.
 */
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

  if (url.pathname === "/api/panel" && request.method === "GET") {
    const changeId = url.searchParams.get("change") ?? "";
    const bindings = new BindingStore(database);
    const gapStore = new GapStore(database);
    const rubricRounds = new RubricStore(database);
    const evidence = new EvidenceStore(database);
    const changeStore = new ChangeStore(database);
    let state: ChangeState | null = null;
    let brief: string | null = null;
    let ledger: readonly LedgerEntry[] = [];
    try {
      const change = changeStore.read(changeId);
      state = change.state;
      brief = change.brief;
      ledger = changeStore.ledger(changeId);
    } catch {
      state = null; // No such Change; the panel shows an empty orbit.
    }
    // The two workspace columns. Selecting a project narrows the Change list
    // and nothing else -- it starts no turn and moves no gate.
    /*
     * **没指定项目时，跟着当前这个 Change 走 —— 不是「全都给你」。**
     *
     * 用户 2026-08-03：「我点了某个 Project 只能显示这个 Project 的 change，不是所有
     * Project 的 changes。」而正常打开面板的地址是 `?change=CHG-002`（启动横幅印的
     * 就是这个，不带 project），于是这里读到 null、下面那句 `list(undefined)` 就把
     * 全库的 change 摊开了 —— 项目多起来之后，那一栏就没法看了。
     *
     * 显式带了 `?project=` 就听它的（点项目那条路会带），一个 Change 都没有的新库
     * 也仍然回退到「全都列」，否则第一次打开是一片空白。
     */
    const asked = url.searchParams.get("project");
    const selectedProject = asked
      ?? (() => {
        try {
          return changeStore.read(changeId).projectId;
        } catch {
          return null;   // 没有这个 Change —— 那就没有「它的项目」可跟
        }
      })();
    const projects = new ProjectStore(database).list().map((project) => ({
      ...project,
      changes: changeStore.list(project.id).length,
    }));
    const changes = changeStore.list(selectedProject ?? undefined).map((change) => ({
      id: change.id,
      title: change.title,
      projectId: change.projectId,
      phase: change.state.phase,
      status: change.state.status,
    }));

    json(response, {
      changeId,
      projects,
      selectedProject,
      changes,
      workspace: basename(options.session.cwd),
      // Which phase the Change is actually at. Clicking a future node opens a
      // terminal to look at; it does NOT let you run that phase out of order,
      // because the phase a turn runs in comes from the state machine.
      currentPhase: state?.phase ?? null,
      status: state?.status ?? null,
      /** 人答出来的需求，null = 还没录。界面靠它决定能不能跑。 */
      brief: brief,
      // Read-only, and it stays that way. The panel shows what the gate says;
      // it never offers a control that changes it (PRD §1).
      //
      // The risks the gate is holding are NOT repeated here: they are the
      // current phase's open gaps, and every phase already carries its own
      // below. One concept, one place to read it from.
      gate: state ? (() => {
        const verdict = new CommandStore(database).gateFor(changeId);
        return { permitted: verdict.permitted, refusals: verdict.refusals };
      })() : null,
      phases: THREADED_PHASES.map((phase) => {
        /*
         * 这个阶段最近一轮的 rubric 判定。
         *
         * 一条 `no` 会派生出 standard gap，那个在 gaps 里看得到；但 `yes` 和
         * `not_assessed` **不会留下任何痕迹** —— 而「这一轮到底判了没有」正是人
         * 最需要看见的：全是 not_assessed 意味着模型压根没照契约作答，而那和
         * 「都通过了」在 gaps 里长得一模一样（两边都没有 standard）。
         */
        const rounds = rubricRounds.latestRound(changeId, phase);
        /*
         * 红方这一阶段产出了什么。
         *
         * 「红蓝双方主张摘要」（设计稿 §4.4）落到新树上就是这两样：**蓝方的主张
         * 是 gaps 里那些 finding**（已经在显示了），**红方的主张是它产出的东西** ——
         * 而后者面板从来没读过。只看得见「有人挑了三条毛病」而看不见「他挑的是
         * 什么东西」，那个列表就悬着。
         */
        const produced = evidence.read(changeId, phase).artifactIds;
        // Every phase's whole gap history, closed and waived included -- the
        // popup has to be able to show "we fixed it, and here is the reason"
        // rather than only what is still blocking.
        const gaps = gapStore.all(changeId, phase);
        return {
          phase,
          // 只报真的绑着的：一条 detached 的绑定仍然留着 threadId，报出去界面会
          // 说「有线程，点开会恢复它的历史」—— 而它恢复不了。
          threadId: (() => {
            const bound = bindings.find(changeId, phase);
            return bound?.status === "bound" ? bound.threadId : null;
          })(),
          live: sessions.has(changeId, phase),
          /**
           * 这个阶段现在还开着哪几个补问格。前端拿它画标签页。
           *
           * 空数组是常态 —— 补问只在这一轮里存在，跑完就收。
           */
          current: state?.phase === phase,
          mark: markOf(phase, ledger, state, gaps),
          gaps,
          /** 最近一轮，按角色分。没跑过就是 null。 */
          assessed: rounds,
          /** 红方产出了什么。空数组 = 这个阶段还没产出任何东西。 */
          produced,
        };
      }),
    });
    return;
  }

  /*
   * 一轮跑到哪了。
   *
   * ## 为什么非要有它
   *
   * 用户 2026-07-30 的原话：「跑一轮的时候界面几分钟不说话，我以为它挂了。」而这不是
   * 舒适度问题 —— 同一天我自己撞上了更糟的那一格：`changes.status = running`，而那个
   * 阶段**一个活进程都没有**。派出去的 Codex 早就没了，面板会一直坐到 30 分钟超时才
   * 报一句「超时」，而真正的原因永远不出现。**「在跑」和「已经死了」在界面上是同一
   * 个样子。**
   *
   * ## 两条硬约束都守住
   *
   * - **不解析 pty 输出**（PRD §9.3）。这里一个字节都不碰 pty。
   * - 进度只来自**库**和**进程状态**，外加 Codex 自己的 `state_5.sqlite`
   *   （`codex/subagent.ts` 早就在读它，读的是「这个线程派生了哪几个子 Agent」，
   *   和读 rollout 同一类动作）。
   *
   * ## 说不出来就说不出来
   *
   * `stage` 要靠裁判的 threadId 去查子 Agent，而 id 要等 transport 认出线程才有 ——
   * 第一轮的开头几十秒它就是 `null`，界面照实说「还看不出走到哪一步」。
   * **不编一个阶段名**：这一屏存在的意义就是不再让人猜，编一个就白做了。
   * （绑定现在是线程一出现就写的 —— `TurnDispatch.onThread`；在那之前仍然是 null。）
   *
   * 只读，不写任何东西（M5）。
   */
  if (url.pathname === "/api/progress" && request.method === "GET") {
    const changeId = url.searchParams.get("change") ?? "";
    let state: ChangeState;
    try {
      state = new ChangeStore(database).read(changeId).state;
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    const phase = state.phase;
    const live = sessions.has(changeId, phase);
    const job = new JobStore(database).latestFor(changeId);

    /*
     * 裁判派生了哪几个子 Agent —— 这是唯一能说出「红方在写 / 蓝方在挑」的信号。
     *
     * 整段包在 try 里：它读的是别人的库，Codex 改了表名这里就该**报不知道**，
     * 而不是把整个进度端点带崩。
     */
    let spawned = 0;
    let stageKnown = false;
    try {
      const bound = new BindingStore(database).find(changeId, phase);
      if (bound?.status === "bound") {
        spawned = createSubAgentLookup().spawnCount(bound.threadId);
        stageKnown = true;
      }
    } catch {
      stageKnown = false; // 查不到就是查不到，不猜
    }

    json(response, {
      phase,
      status: state.status,
      live,
      job: job === null ? null : {
        id: job.id,
        status: job.status,
        startedAt: job.createdAt,
        elapsedMs: Date.now() - Date.parse(job.createdAt),
      },
      /** 这一轮派生了几个子 Agent。原样给出去 —— 界面自己决定怎么说。 */
      spawned,
      /**
       * 走到哪一步。`null` = 说不出来（第一轮，或者查不到子 Agent）。
       *
       * 只报**看得见的东西**：红方出现了、蓝方也出现了。蓝方出现之后是「蓝方还在挑」
       * 还是「裁判在裁」，这一侧分不出来 —— 所以不报第三档。
       */
      stage: !stageKnown
        ? null
        // **数个数，不看 agent_path** —— 那一列只有一个派生入口会设，而它不是每个
        // 会话都有（codex/subagent.ts 开头）。派生了 1 个 = 红方在写，2 个 = 轮到
        // 蓝方了。蓝方之后是「还在挑」还是「裁判在裁」这一侧分不出来，不报第三档。
        : spawned >= 2 ? "blue_attacking"
          : spawned === 1 ? "red_writing" : "judge_starting",
      /**
       * **承重的那一格**：状态说在跑，可是没有活进程 —— 派出去的那个 Codex 已经没了。
       *
       * 今天这一格会静默烧掉 30 分钟。它必须有名字，界面才说得出这句话。
       */
      processGone: state.status === "running" && !live,
    });
    return;
  }

  /*
   * 一份产出的正文。
   *
   * ## 为什么这一条最要紧
   *
   * 在这之前弹窗只显示 artifactIds 里的**文件名**。用户 2026-07-30 的原话：
   * 「他们把 PRD 和建议一起带回给我 —— 现在只有建议，我拿不到那份 PRD。」
   * 五步场景的第 ④ 步就断在这儿：红蓝对抗跑完了，蓝方挑的毛病看得见，**被挑的那
   * 份东西看不见** —— 那份建议是悬着的，人没法判断该不该接受。
   *
   * ## 这不违反 §9.3
   *
   * 那条护栏管的是**pty 的字节**：不许读懂 Codex 画在终端里的东西。这里读的是模型
   * **落在磁盘上的产物**，和 `codex/rollout.ts` 读 rollout、`codex/subagent.ts` 读
   * 子 Agent 的文件同一类动作。区别是判据性的：pty 输出是「界面」，产物是「文档」。
   *
   * ## 只读，而且只读这个阶段自己报出来的那些
   *
   * 路径必须出现在这个 (Change, 阶段) 的 `artifactIds` 里，而且落在项目目录内 ——
   * 两道都不省。`artifactIds` 是模型写的，一个想歪的模型可以往里放
   * `~/.ssh/id_rsa`；「只读库里列着的」挡不住那个，「必须在项目目录内」才挡得住。
   *
   * 读接口不写任何东西（M5）。
   */
  if (url.pathname === "/api/artifact" && request.method === "GET") {
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
     * 上面那道「必须在 artifactIds 里」的闸照旧管着这一条：一个不是这个阶段报出来的
     * sha，走不到这里。
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
    return;
  }

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
    const name = (url.searchParams.get("name") ?? "").trim();
    if (name === "") { response.writeHead(400).end("name_required"); return; }

    /*
     * **路径必填，而且当场校验。**
     *
     * 一个 Project 就是一个仓库（用户 2026-07-30 拍板），Codex 就跑在这个目录里。
     * 建一个没有路径的项目，等于建一个「不知道在哪」的项目 —— 那正是用户撞上的洞。
     *
     * 三条都查，因为错在这里发现比在 pty 里发现便宜得多：必须是绝对路径（相对路径
     * 相对谁？服务端的 cwd 吗 —— 那就又回到那个洞了）、必须存在、必须是目录。
     */
    const rawPath = (url.searchParams.get("path") ?? "").trim();
    if (rawPath === "") { response.writeHead(400).end("path_required"); return; }
    if (!isAbsolute(rawPath)) { response.writeHead(400).end("path_must_be_absolute"); return; }
    let path: string;
    try {
      // realpath：macOS 上 /var 是 /private/var 的软链，而 Codex 按真实路径记目录
      // 信任（今天实测过）。存两个不同的字符串指同一个目录，只会埋下一个坑。
      path = realpathSync(rawPath);
      if (!statSync(path).isDirectory()) {
        response.writeHead(400).end("path_is_not_a_directory");
        return;
      }
    } catch {
      response.writeHead(400).end("path_does_not_exist");
      return;
    }

    const projects = new ProjectStore(database);
    const id = mintId("PRJ", projects.list().map((entry) => entry.id));
    const created = projects.ensure(id, name, path);
    // 新项目一建出来就带上出厂标准 —— 全部不阻断，见 domain/rubric-defaults.ts。
    // 不装的话，这个项目的每个阶段都是空 rubric，人得逐个手写才能开始用。
    new RubricStore(database).installDefaults(created.id);
    json(response, {
      created: true, id: created.id, name: created.name,
      // 把路径回给界面：人得看得见「它建在哪」—— 那正是用户撞上的洞。
      path: created.path,
    });
    return;
  }

  /*
   * 删掉一个 Change，或者一个项目（连同它底下的全部 Change）。
   *
   * 用户 2026-08-03：「每个 change 每个 project 我需要可以删除，我现在没法删。」
   * 在这之前删除路径压根不存在 —— 真库里那条空的 `CHG-1` 就是这么留下的。
   *
   * **有活儿在跑就拒。** 不是出于谨慎：删掉一个正在跑的 Change 会留下一个没人认领
   * 的 codex 进程，而那个进程会继续往一个已经不存在的账本上写。先停会话再删。
   */
  if (url.pathname === "/api/change" && request.method === "DELETE") {
    const changeId = url.searchParams.get("change") ?? "";
    const changes = new ChangeStore(database);
    try {
      // 读它就是在问「有没有这条」—— `forget` 枚举所有阶段，不再需要当前那个。
      changes.read(changeId);
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    const busy = phaseBusy(database, changeId);
    if (busy) { json(response, { deleted: false, ...busy }); return; }

    // `forget` 而不是 `close`：连尸体一起收掉，否则下一个重名的 Change 会继承
    // 这一个的最后一屏。见 `PanelSessions.forget`。
    sessions.forget(changeId);
    changes.delete(changeId);
    json(response, { deleted: true, changeId });
    return;
  }

  if (url.pathname === "/api/project" && request.method === "DELETE") {
    const projectId = url.searchParams.get("project") ?? "";
    const projects = new ProjectStore(database);
    if (projects.list().every((entry) => entry.id !== projectId)) {
      response.writeHead(404).end("no_such_project");
      return;
    }
    const changes = new ChangeStore(database);
    const mine = changes.list(projectId);
    // 一个都不能在跑 —— 理由和上面一样，而且这里一次要停好几个。
    for (const each of mine) {
      const busy = phaseBusy(database, each.id);
      if (busy) { json(response, { deleted: false, changeId: each.id, ...busy }); return; }
    }
    // 同上：删项目就是把它底下每条 Change 都删掉，尸体一样要跟着走。
    for (const each of mine) sessions.forget(each.id);
    projects.delete(projectId, changes);
    json(response, { deleted: true, projectId, changes: mine.length });
    return;
  }

  if (url.pathname === "/api/change" && request.method === "POST") {
    const projectId = url.searchParams.get("project") ?? "";
    const title = (url.searchParams.get("title") ?? "").trim();
    if (title === "") { response.writeHead(400).end("title_required"); return; }

    const projects = new ProjectStore(database);
    if (projects.list().every((entry) => entry.id !== projectId)) {
      response.writeHead(404).end("no_such_project");
      return;
    }
    const changes = new ChangeStore(database);
    const id = mintId("CHG", changes.list().map((entry) => entry.id));
    const created = changes.create(id, { projectId, title });
    // 新的 Change 停在第一个阶段、pending —— 状态机的起点，这里不替它走一步。
    json(response, { created: true, id: created.id, phase: created.state.phase });
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
    const changeId = url.searchParams.get("change") ?? "";
    const phase = url.searchParams.get("phase") ?? "";
    if (!isPhase(phase)) { response.writeHead(400).end("bad phase"); return; }

    let projectId: string | null = null;
    try {
      projectId = new ChangeStore(database).read(changeId).projectId;
    } catch {
      projectId = null;
    }
    if (projectId === null) {
      // **不要把「没有这个 Change」降级成「所有角色都没有 rubric」。** 后者是合法
      // 状态（空 rubric = 这个阶段不做判定），前者是问错了地方 —— 混在一起，界面
      // 会摆出一个空编辑器，人填完按保存才收到 404。POST 那边一直是 404，这里跟上。
      response.writeHead(404).end("no such change, or it belongs to no project");
      return;
    }

    const rubrics = new RubricStore(database);
    json(response, {
      // 每个角色一份。scope 说的是这一份是项目级默认还是这个 Change 自己的 ——
      // 编辑器要显示出来，否则人不知道自己在改的是谁。
      roles: RUBRIC_ROLES.map((role) => {
        const current = rubrics.effective(projectId, changeId, phase, role);
        return {
          role,
          scope: current === null ? null
            : (current.scope.changeId === null ? "project" : "change"),
          version: current?.version ?? 0,
          criteria: current?.criteria ?? [],
          /**
           * 这一份由谁判，null = 不进对抗（人自己看）。
           *
           * **从 domain 读，界面不许自己抄一份。** 少了它，verdict 那一栏会显示
           * 「这个角色当时没有 rubric」—— 标准明明在，只是不再由模型判。
           */
          assessedBy: assessorOf(role),
        };
      }),
    });
    return;
  }

  if (url.pathname === "/api/rubric" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    const phase = url.searchParams.get("phase") ?? "";
    const role = url.searchParams.get("role") ?? "";
    if (!isPhase(phase) || !(RUBRIC_ROLES as readonly string[]).includes(role)) {
      response.writeHead(400).end("bad phase or role");
      return;
    }

    let projectId: string | null = null;
    try {
      projectId = new ChangeStore(database).read(changeId).projectId;
    } catch { /* fall through */ }
    if (projectId === null) {
      response.writeHead(404).end("no such change, or it belongs to no project");
      return;
    }

    // 解码住在 domain/rubric-edit.ts，不在这里 —— 第五条常驻护栏禁止 src/web/ 把
    // 字节变成字符串。那条规则是面板被接受的前提，不是可以绕的风格问题。
    let payload;
    try {
      payload = parseRubricEdit(await readBody(request));
    } catch (error: unknown) {
      if (!(error instanceof UnreadableEditError)) throw error;
      response.writeHead(400).end(error.code);
      return;
    }

    const rubrics = new RubricStore(database);
    const scope = {
      projectId,
      // 改项目级默认，还是只给这个 Change 覆盖 —— 人要显式选，不给默认。
      changeId: payload.scope === "change" ? changeId : null,
      phase,
      role: role as RubricRole,
    };

    try {
      const saved = rubrics.save(scope, payload.drafts, payload.reason);
      // 撤下一条标准，它派生的阻断项跟着退休。理由带进 resolution ——
      // 关掉一个问题必须说明理由，rubric 这条路也不例外。
      if (saved.retired.length > 0) {
        const gaps = new GapStore(database);
        gaps.replace(changeId, phase, retireStandards(
          gaps.all(changeId, phase), scope.role,
          saved.retired.map((entry) => entry.key),
          payload.reason ?? "",
        ));
      }
      json(response, {
        saved: true, version: saved.version,
        retired: saved.retired.map((entry) => entry.key),
      });
    } catch (error: unknown) {
      // 三种拒绝，都要说清是哪一种 —— 前端要分别提示。
      if (error instanceof ReasonRequiredError) {
        json(response, { saved: false, reason: "reason_required", retired: error.retired });
      } else if (error instanceof UntrustedKeyError) {
        json(response, { saved: false, reason: "untrusted_key", key: error.key });
      } else if (error instanceof InvalidCriterionError) {
        json(response, { saved: false, reason: error.code });
      } else throw error;
    }
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
    const changes = new ChangeStore(database);
    let phase: Phase;
    try {
      phase = changes.read(changeId).state.phase;
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    const busy = cannotAskNow(database, sessions, changeId, phase);
    if (busy) {
      json(response, { asked: false, phase, ...busy });
      return;
    }

    const gate = new CommandStore(database).gateFor(changeId);
    const gaps = new GapStore(database);
    const blockers = gaps.blockers(changeId, phase);
    /*
     * 「回应蓝方」和裁决**同一次问出来**。
     *
     * 顺序是 open gap 在库里的顺序（`GapStore.all` 按 `opened_round, id` 排），而
     * `responsesFrom` 靠位置对应回来 —— 所以这个名单必须和读答案时用的是同一个。
     * 名单变了 snapshot 就变了，fence 会在落地之前拒掉，不会把答案套到别的问题上。
     */
    const allGaps = gaps.all(changeId, phase);
    const openGaps = allGaps.filter((gap) => gap.status === "open");
    /*
     * 人提的那条算第几轮发现的。
     *
     * 取现有 gap 里最大的那个轮次 —— 他是**看着这一轮的产出**提出来的，所以和这一轮
     * 报出来的问题记同一个号。一条 gap 都没有时是第 1 轮。
     */
    const raiseRound = Math.max(1, ...allGaps.map((gap) => gap.openedRound));
    /*
     * 这一轮的标准判成什么样，**写进题面**。
     *
     * 用户 2026-07-30：要不要继续对抗由人决定，不做成全自动。那么人就得看得见这一轮
     * 判成什么样 —— 否则「再来一轮还是批准」是在没有信息的情况下按的。
     *
     * 为什么它不能只留在网页的「标准」页签里：**裁决发生在 Codex 画的选择器里**
     * （§5.2b），人按下去的那一刻眼前只有那张表。要他判断的信息不在那张表上，
     * 就等于要他凭记忆判断。
     *
     * 非阻断的 `no` 也照报：它不挡闸门，但它正是「要不要再来一轮」的原料 ——
     * 闸门放不放行和这一轮做得好不好是两个问题。
     */
    const assessed = new RubricStore(database).latestRound(changeId, phase);
    /*
     * 裁判的结论和反方的整体判断，也写进题面（用户 2026-07-31）。
     *
     * 逐条判定说得出「第 3 条没勾上」，说不出「加起来还差在哪」—— 而后者正是他
     * 按按钮之前想知道的。裁判那句是**建议**：闸门仍然由他推（2026-07-30 拍板：
     * 要不要继续对抗由人决定，不做成全自动）。
     *
     * 和 `assessed` 取自同一轮：`latestRound` 和 `latest` 都取最大的那个 round，
     * 各取各的轮次就是把两轮的东西并排摆着当成一轮，那是在骗人。
     */
    const notes = new RoundNoteStore(database).latest(changeId, phase);
    const question = gateDecisionQuestion({
      phase,
      gate,
      summary: (blockers.length === 0
        ? "证据已到齐，没有挡住闸门的问题。"
        : `${blockers.length} 项问题仍然挡着闸门。先逐条说你怎么看，最后再裁决。`)
        + summariseAssessments(assessed?.byRole ?? null)
        + summariseRoundNotes(notes)
        /*
         * 跑满预算之后把收敛数据摊出来。**不拦人** —— 阻断归人管。
         *
         * 轮次和派发那边同一个算法：账本里落进 `running` 的次数。两处各算一套迟早
         * 会说出两个不同的「第几轮」，而人正拿着这个数做决定。
         */
        + summariseConvergence({
          round: new ChangeStore(database).ledger(changeId)
            .filter((entry) => entry.to.phase === phase && entry.to.status === "running")
            .length,
          budget: options.roundBudget ?? 5,
          raised: gaps.all(changeId, phase).length,
          open: blockers.length,
        }),
      openGaps,
    });
    // No question rather than an empty one: putting a decision to someone that
    // they cannot make is worse than not asking (domain/question.ts).
    if (!question) {
      json(response, { asked: false, reason: "no_decision_available", phase });
      return;
    }

    const questionId = `Q-${changeId}-${phase}-${Date.now()}`;
    const questions = new QuestionStore(database);
    questions.ask({
      id: questionId, changeId, phase, kind: "gate_decision",
      question, expectedSnapshot: gate.snapshot,
    });

    const bound = new BindingStore(database).find(changeId, phase);
    sessions.launchInto(changeId, phase, codexArgv({
      threadId: bound?.status === "bound" ? bound.threadId : null,
      sandbox: options.session.sandbox,
      approval: options.session.approval,
      model: options.session.model,
      reasoningEffort: options.session.reasoningEffort,
      // Registered per invocation, never written to the user's global config.
      config: pluginConfigFor(database, changeId),
      prompt: [
        "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数** ——",
        "问哪一个由 StagePass 决定。",
        "它会把 StagePass 的问题交给我来选。",
        "不要替我做决定，不要解释我该选什么，调用完就停下。",
      ].join("\n"),
    }));

    const deadline = Date.now() + (options.askTimeoutMs ?? 15 * 60_000);
    let sessionDied = false;
    while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
      /*
       * **进程没了就别再等了。**
       *
       * 2026-07-30 实测到的那一次：这个阶段绑的裁判线程被 Codex **归档**了，于是
       * `codex resume <id>` 一起来就退（`session … is archived`）。而这里原来只盯
       * 答案，于是它对着一个已经死掉的终端等满 15 分钟，界面上一句话都没有 ——
       * 「在等你选」和「那边早就没了」长得一模一样，正是这个项目从头到尾在防的那种。
       *
       * 判据是**进程状态**，不是 pty 的输出（§9.3）。
       */
      if (!sessions.has(changeId, phase)) { sessionDied = true; break; }
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    }
    const first = questions.readAnswerFor(questionId);
    if (!first) {
      /*
       * **放弃了就把题也收掉。**
       *
       * 这里原来只关会话、不 settle，于是超时会漏下一道永远 `open` 的题 ——
       * 录需求那条路（`/api/brief`）一直是 settle 写在判断之前的，两条路不对称，
       * 而不对称没有任何理由。
       *
       * `ask()` 插新题时会把旧的 `open` 全部 superseded，所以危害有一半被兜住；
       * 但在超时和下一次问之间，`questions.open(changeId)` 会返回一道**没有任何人
       * 在等**的题。人这时候开个终端让模型调 `stagepass_ask`，就会被端出这道死题
       * ——答了还会被 fence 以 `GateMovedError` 拒掉。「看起来在等你」而其实没人在等，
       * 正是这个项目从头到尾在防的形状。
       *
       * 2026-08-03 真机撞到：验 B/C/D 那一轮的裁决表挂了 63 分钟（截止 45 分钟），
       * 会话被收掉了，而那道题还是 `open`。
       */
      questions.settle(questionId);
      json(response, {
        asked: true, answered: false, phase, questionId,
        /**
         * 没答上有两种，而它们要做的事完全不同：一种是人还没去答，另一种是**那边
         * 的进程早就没了**。原来两种回来的都是同一个空结果。
         */
        reason: sessionDied ? "session_died_before_answering" : "no_answer_in_time",
        /** 死了的时候把线程 id 给出去 —— 最常见的原因是它被归档了，而解药要这个 id。 */
        threadId: sessionDied
          ? new BindingStore(database).find(changeId, phase)?.threadId ?? null
          : null,
      });
      // 放弃了就把会话关掉 —— 理由和录需求那条一样：留着它，这个阶段的每个动作
      // 都会被闸门拒掉，而界面上没有杀掉终端的入口。
      sessions.close(changeId, phase);
      return;
    }

    /*
     * **第二趟：只问那几条真的需要理由的。**
     *
     * 第一趟纯选项格（客户端空文本格吃回车，`optional` 也不管用）。2026-08-03 真机上
     * 用户在八个格子里各打了一个「1」纯粹为了过去 —— 和录需求那张表被治好之前一模
     * 一样。哪几条要进第二趟由语义定：同意不用说话；不同意 / 先接受风险要落进
     * `resolution`（一次没有理由的关闭和「这一轮忘了提」在库里长得一模一样）；
     * 「我自己说」是他自己要求的。
     *
     * 一条都不需要就不弹 —— 全点「同意」的人一个字都不用打。
     */
    let answer = first;
    const more = responseFollowUpQuestion(openGaps, first);
    if (more) {
      const moreId = `${questionId}-x`;
      questions.ask({
        id: moreId, changeId, phase, kind: "gate_decision",
        question: more, expectedSnapshot: gate.snapshot,
      });
      if (!await sessions.type(changeId, phase, ASK_TOOL_LINE)) {
        questions.settle(moreId);
        json(response, { asked: true, answered: false, phase, reason: "session_died_before_asking" });
        sessions.close(changeId, phase);
        return;
      }
      const until = Date.now() + (options.askTimeoutMs ?? 15 * 60_000);
      while (Date.now() < until && !questions.readAnswerFor(moreId)) {
        if (!sessions.has(changeId, phase)) break;
        await new Promise((resolve) => { setTimeout(resolve, 1_000); });
      }
      const second = questions.readAnswerFor(moreId);
      questions.settle(moreId);
      if (!second) {
        json(response, { asked: true, answered: false, phase, reason: "no_answer_in_time" });
        sessions.close(changeId, phase);
        return;
      }
      answer = { action: first.action, content: { ...first.content, ...second.content } };
    }

    /*
     * ── 三步，顺序是承重的 ────────────────────────────────
     *
     * 1. **先查 fence。** 问的是「人回答的这段时间里，别人动过这份证据吗」。这一步
     *    必须在自己动手之前，否则查的就只是「我刚写完的东西还在不在」。
     * 2. **落人对每一条问题的表态。** 一次驳回或接受会把一条 blocker 从名单里拿掉，
     *    而闸门算的正是那个名单 —— 先裁决就是拿着旧名单裁决，人刚说的话对这一次没有
     *    任何影响。
     * 3. **再走闸门**，对着表态之后的新快照（`rebaseFence`）。存下来的那份 fence
     *    必然对不上，而对不上的原因是**人自己刚说的话** —— 那不是 fence 要防的东西。
     *
     * 表态本身**不推动闸门**：它只改 gaps。推动闸门的仍然只有 `decision` 那一格，
     * 走 `questions.apply` 这一条路（§5.3：没有第二条能推动闸门的路）。
     */
    try {
      questions.assertFenceHolds(questionId);
    } catch (error: unknown) {
      if (!(error instanceof GateMovedError)) throw error;
      questions.settle(questionId);
      json(response, {
        asked: true, answered: true, phase, questionId, answer,
        reason: "gate_moved",
      });
      return;
    }

    const responded = responsesFrom({ question, answer, openGaps });
    const applied = Object.keys(responded.responses).length === 0
      ? { refused: [] as { id: string; code: string }[] }
      : gaps.respond(changeId, phase, responded.responses);
    // 人自己提的那一条 —— 它挡闸门，所以要在裁决之前落进去。
    const raised = responded.raised === ""
      ? null
      : gaps.raise(changeId, phase, responded.raised, raiseRound);

    /*
     * 裁决可能在人自己的表态之后就不合法了 —— 最典型的是他刚提了一条新要求，
     * 又选了「批准」。**那时闸门该拒，而且要说出来**：默默当成没发生，人会以为
     * 批准了。
     */
    let outcome: unknown;
    try {
      outcome = questions.apply(questionId, { rebaseFence: true });
    } catch (error: unknown) {
      if (!(error instanceof GateRefusedError)) throw error;
      questions.settle(questionId);
      outcome = { kind: "refused", action: error.action, reason: error.reason };
    }

    /*
     * **批准了就归档这个阶段的线程。**
     *
     * 用户 2026-07-30 拍板的那一半：「Archive 只能我在 stage 跑完了之后，才能自动地
     * archive。」归档从此标记的是「这个阶段结束了」，而不是「Codex 那边有人清了一下」。
     *
     * 只由批准触发，别的地方一概不许调 —— 一个**还没批准**的阶段的线程被归档，
     * 下一次 resume 就会一起来就死，那正是这条路要收拾的事。
     *
     * `phase` 是转移**之前**的那个，也就是刚被批准的那个，正好是要归档的那一条。
     * Fix 会被反复进入（§6.5 规则 2），但它被批准时活儿也确实完了；下次再进 Fix，
     * `launchInto` 那边会自动把它解开。
     */
    if (
      typeof outcome === "object" && outcome !== null
      && (outcome as { kind?: unknown }).kind === "advanced"
      && (outcome as { action?: unknown }).action === "approve"
    ) {
      const bound = new BindingStore(database).find(changeId, phase);
      if (bound?.status === "bound") {
        const done = archiveFinished(bound.threadId, sessions.archive);
        console.log(`[panel] ${changeId}/${phase} 已批准，线程 ${bound.threadId} —— ${done}`);
      }
    }

    /*
     * 选了「再来一轮」就**直接续跑**，不用人再回面板按一次「跑这个阶段」。
     *
     * 用户 2026-07-30：「把现在的两步合成一步。」两步之所以是坑，不只是多点一下 ——
     * 中间那一步**看不出来还需要它**：裁决落完之后 Change 回到 pending，界面上没有
     * 任何东西说「还差一次派发」，人会以为下一轮已经在跑了。
     *
     * 「再来一轮」和「重跑一次」都续 —— 两条路上活儿都留在这个阶段，中间那一步
     * 一样看不出来。**「打回去修」不续**：那时 Change 已经换到 Fix 了，自动在一个
     * 刚到的阶段上开跑，等于替人决定了 Fix 该做什么。
     */
    const decided = answer.content[DECISION_FIELD];
    const continued = runsAgainHere(decided)
      // 那个阶段的终端这时还活着（题就是送进去的），所以先关掉它 —— 不然
      // `runRound` 会撞上 §6.5 规则 5 直接拒。这不是绕过那条规则：那一轮的活
      // 干完了，它只是坐在 composer 上没事干。
      ? (sessions.close(changeId, phase),
        await runRound({ changeId, phase, sessions, options }))
      : null;

    json(response, {
      asked: true, answered: true, phase, questionId, answer,
      /** 每一条表态落地了没有，没落地的说清是为什么 —— 人已经走了，不许静默丢掉。 */
      responses: responded.responses,
      refused: applied.refused,
      raised: raised?.id ?? null,
      outcome,
      /** 续跑了没有，以及那一轮的结果。null = 这次裁决不是「再来一轮」。 */
      continued,
      state: changes.read(changeId).state,
    });
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
    const changes = new ChangeStore(database);
    let change: { title: string | null; state: { phase: Phase } };
    try {
      change = changes.read(changeId);
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    const phase = change.state.phase;
    const busy = cannotAskNow(database, sessions, changeId, phase);
    if (busy) {
      json(response, { asked: false, phase, ...busy });
      return;
    }

    /*
     * 第一步：让模型读仓库，提问题。用一次普通的 turn，不用对抗轮 —— 提问题不需要
     * 有人反驳它，而一轮对抗要好几分钟。
     *
     * **插件在这里就得注册上**，虽然这一步用不到它：第二段提示词是**打进同一个
     * 会话**的（见 `PanelSessions.type`），而 MCP 工具是启动时注册的。这时候不注册，
     * 后面打字让它调 `stagepass_ask` 只会得到「没有这个工具」。
     */
    const pluginConfig = pluginConfigFor(database, changeId);
    const transport = new CodexTuiTransport({
      ...options.session,
      ...(options.turnTimeoutMs === undefined ? {} : { timeoutMs: options.turnTimeoutMs }),
      // argv 由这里自己配，不用 transport 给的那份 —— 它不知道要带插件。
      launch: () => {
        sessions.launchInto(changeId, phase, codexArgv({
          threadId: null,
          sandbox: options.session.sandbox,
          approval: options.session.approval,
          model: options.session.model,
          reasoningEffort: options.session.reasoningEffort,
          config: pluginConfig,
          prompt: briefContract({ changeTitle: change.title }),
        }));
      },
    });

    let items;
    try {
      const proposed = await transport.runTurn({
        threadId: null,
        prompt: briefContract({ changeTitle: change.title }),
      });
      items = readBriefProposal(proposed.text);
    } catch (error: unknown) {
      // 模型一条都没提、或者提得不成形 —— **不许降级成「不需要问」**，那样需求录入
      // 就被静默跳过了，而下游那份 PRD 仍然会生成出来，看着一切正常。
      json(response, {
        asked: false,
        reason: error instanceof BriefProposalVoidError ? error.code : "proposal_failed",
        detail: error instanceof Error ? error.message : String(error),
        phase,
      });
      return;
    }

    /*
     * 第二步：把它组成题问人。**两趟。**
     *
     * 第一趟纯选项格，一路回车就答得完；只有点了「都不对，我自己写」的那几题，
     * 才有第二趟给他写字（`followUpFields`）。全用选项答完的人一个字都不用打。
     *
     * 为什么非分两趟不可：客户端**空的自由文本格会吃掉回车**，`optional` 不管用
     * （2026-07-30 实测）。所以「选了就不用打字」只有在第一趟里根本没有文本格时
     * 才是真的 —— 用户 2026-08-03 明确要求过这件事。
     */
    const gate = new CommandStore(database).gateFor(changeId);
    const questions = new QuestionStore(database);

    /** 问一趟，等人答完。返回 null = 这一趟没走通，原因已经写进响应了。 */
    const askOnce = async (
      fields: readonly ClarificationItem[], title: string,
    ): Promise<Answer | null> => {
      const question = clarificationQuestion({ title, items: fields })!;
      const questionId = `BR-${changeId}-${Date.now()}`;
      questions.ask({
        id: questionId, changeId, phase, kind: "clarification",
        question, expectedSnapshot: gate.snapshot,
      });

      /*
       * **打进同一个会话，不另起进程。** 完整理由在 `PanelSessions.type` 那段注释里，
       * 两句话：`launchInto` 会把活着会话的 argv 丢掉；`close` 再起会掐断浏览器正在
       * 读的流。两条我都踩过。
       *
       * 一行，因为 composer 里的换行就是提交。
       */
      const typed = await sessions.type(changeId, phase,
        "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数**。"
        + "它会把「这次改动要什么」交给我来答。不要替我回答，不要猜我想要什么，调用完就停下。");
      if (!typed) {
        // 会话在这中间死了。**不许假装问出去了** —— 题已经落库，人却永远看不到它。
        questions.settle(questionId);
        json(response, { asked: false, reason: "session_died_before_asking", phase });
        return null;
      }

      const deadline = Date.now() + (options.askTimeoutMs ?? 15 * 60_000);
      let sessionDied = false;
      while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
        /*
         * **进程没了就别再等了。**
         *
         * 2026-07-30 实测：这个阶段绑的裁判线程被 Codex 归档了，`codex resume` 一起来
         * 就退。而这里原来只盯答案，于是它对着一个已经死掉的终端等满 15 分钟，界面上
         * 一句话都没有 ——「在等你选」和「那边早就没了」长得一模一样。
         *
         * 判据是**进程状态**，不是 pty 的输出（§9.3）。
         */
        if (!sessions.has(changeId, phase)) { sessionDied = true; break; }
        await new Promise((resolve) => { setTimeout(resolve, 1_000); });
      }
      const given = questions.readAnswerFor(questionId);
      questions.settle(questionId);
      if (!given) {
        json(response, {
          asked: true, answered: false, phase, questionId,
          /**
           * 没答上有两种，而它们要做的事完全不同：一种是人还没去答，另一种是**那边
           * 的进程早就没了**。原来两种回来的都是同一个空结果。
           */
          reason: sessionDied ? "session_died_before_answering" : "no_answer_in_time",
          /** 死了的时候把线程 id 给出去 —— 最常见的原因是它被归档了，而解药要这个 id。 */
          threadId: sessionDied
            ? new BindingStore(database).find(changeId, phase)?.threadId ?? null
            : null,
        });
        /*
         * **放弃了就把会话关掉。**
         *
         * 原来这里直接 `return` —— 于是问人超时之后进程还留着，`sessions.has()`
         * 永远 true，这个阶段的**每一个动作**都被闸门拒掉，而界面上没有杀掉终端的
         * 入口。2026-08-03 现场复现过这个死锁：录需求说「阶段在跑」，跑阶段说
         * 「还没有需求」，而挡着的那个会话是 StagePass 自己 15 分钟前放弃、却忘了
         * 关的僵尸。
         *
         * 关掉是安全的：这条路已经决定不等了，那个进程再没有人会去读它。
         */
        sessions.close(changeId, phase);
        return null;
      }
      return given;
    };

    const first = await askOnce(items, `${changeId}：先把这次改动要什么说清楚`);
    if (!first) return;

    /*
     * 第二趟只在真有人要写字的时候才弹。**一条都没有就不弹** —— 「全用选项答完的人
     * 一个字都不用打」如果还要他再点一次「提交」，那句话就打了折。
     */
    const more = followUpFields(items, first);
    let content = first.content;
    if (more.length > 0) {
      const second = await askOnce(more, `${changeId}：你说要自己写的那几条`);
      if (!second) return;
      content = { ...content, ...second.content };
    }
    const answer: Answer = { action: first.action, content };

    const brief = briefFrom(items, answer);

    /*
     * 办完了就把这个会话关掉。
     *
     * **和前面那次「中途 close」是两件事**：中途关会掐断浏览器正在读的流，让人看不见
     * 选择器（我踩过）。这里是流程真的走完了 —— 题问过、答案拿到、需求落库，那个
     * Codex 只是坐在 composer 上没事干。
     *
     * 不关的话它一直 `live`，而 §6.5 规则 5 会挡住下一次派发：「跑这个阶段」永远是
     * 灰的，界面上又没有结束终端的入口 —— 人就卡在录完需求之后那一步（2026-07-30
     * 实测到这个死角）。
     */
    sessions.close(changeId, phase);

    if (brief === null) {
      // 按了 Esc，或者必答的没答完。**不拿一段空白往下走** —— 那等于又回到那份
      // 编出来的 PRD。
      json(response, { asked: true, answered: true, recorded: false, phase });
      return;
    }
    changes.setBrief(changeId, brief);
    json(response, { asked: true, answered: true, recorded: true, phase, brief });
    return;
  }

  if (url.pathname === "/api/waive" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    const changes = new ChangeStore(database);
    let phase: Phase;
    try {
      phase = changes.read(changeId).state.phase;
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    const busy = cannotAskNow(database, sessions, changeId, phase);
    if (busy) {
      json(response, { asked: false, phase, ...busy });
      return;
    }

    const gaps = new GapStore(database);
    const waivable = gaps.all(changeId, phase).filter((gap) =>
      gap.status === "open" && gap.kind === "finding" && gap.severity === "P1");
    const question = waiveQuestion({ phase, waivable });
    if (!question) {
      json(response, { asked: false, reason: "nothing_waivable", phase });
      return;
    }

    const gate = new CommandStore(database).gateFor(changeId);
    const questionId = `W-${changeId}-${phase}-${Date.now()}`;
    const questions = new QuestionStore(database);
    questions.ask({
      id: questionId, changeId, phase, kind: "waive",
      question, expectedSnapshot: gate.snapshot,
    });

    const bound = new BindingStore(database).find(changeId, phase);
    sessions.launchInto(changeId, phase, codexArgv({
      threadId: bound?.status === "bound" ? bound.threadId : null,
      sandbox: options.session.sandbox,
      approval: options.session.approval,
      model: options.session.model,
      reasoningEffort: options.session.reasoningEffort,
      config: pluginConfigFor(database, changeId),
      prompt: [
        "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数** ——",
        "问哪一个由 StagePass 决定。",
        "它会把「哪几条风险可以带着走」交给我来选。",
        "不要替我做决定，不要评价这些风险，调用完就停下。",
      ].join("\n"),
    }));

    const deadline = Date.now() + (options.askTimeoutMs ?? 15 * 60_000);
    let sessionDied = false;
    while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
      /*
       * **进程没了就别再等了。**
       *
       * 2026-07-30 实测到的那一次：这个阶段绑的裁判线程被 Codex **归档**了，于是
       * `codex resume <id>` 一起来就退（`session … is archived`）。而这里原来只盯
       * 答案，于是它对着一个已经死掉的终端等满 15 分钟，界面上一句话都没有 ——
       * 「在等你选」和「那边早就没了」长得一模一样，正是这个项目从头到尾在防的那种。
       *
       * 判据是**进程状态**，不是 pty 的输出（§9.3）。
       */
      if (!sessions.has(changeId, phase)) { sessionDied = true; break; }
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    }
    const answer = questions.readAnswerFor(questionId);
    if (!answer) {
      json(response, {
        asked: true, answered: false, phase, questionId,
        /**
         * 没答上有两种，而它们要做的事完全不同：一种是人还没去答，另一种是**那边
         * 的进程早就没了**。原来两种回来的都是同一个空结果。
         */
        reason: sessionDied ? "session_died_before_answering" : "no_answer_in_time",
        /** 死了的时候把线程 id 给出去 —— 最常见的原因是它被归档了，而解药要这个 id。 */
        threadId: sessionDied
          ? new BindingStore(database).find(changeId, phase)?.threadId ?? null
          : null,
      });
      // 放弃了就把会话关掉 —— 理由和录需求那条一样：留着它，这个阶段的每个动作
      // 都会被闸门拒掉，而界面上没有杀掉终端的入口。
      sessions.close(changeId, phase);
      return;
    }

    /*
     * **第二趟：只问真被接受的那几条要理由。**
     *
     * 第一趟纯选项格（客户端空文本格吃回车），和裁决表、录需求那两张表同一个形状。
     * 一条都没接受就不弹 —— 全点「不接受」的人一个字都不用打。
     */
    let full = answer;
    const moreWaive = waiveFollowUpQuestion(waivable, answer);
    if (moreWaive) {
      const moreId = `${questionId}-x`;
      questions.ask({
        id: moreId, changeId, phase, kind: "waive",
        question: moreWaive, expectedSnapshot: gate.snapshot,
      });
      if (!await sessions.type(changeId, phase, ASK_TOOL_LINE)) {
        questions.settle(moreId);
        json(response, {
          asked: true, answered: false, phase, reason: "session_died_before_asking",
        });
        sessions.close(changeId, phase);
        return;
      }
      const until = Date.now() + (options.askTimeoutMs ?? 15 * 60_000);
      while (Date.now() < until && !questions.readAnswerFor(moreId)) {
        if (!sessions.has(changeId, phase)) break;
        await new Promise((resolve) => { setTimeout(resolve, 1_000); });
      }
      const second = questions.readAnswerFor(moreId);
      questions.settle(moreId);
      if (!second) {
        json(response, { asked: true, answered: false, phase, reason: "no_answer_in_time" });
        sessions.close(changeId, phase);
        return;
      }
      full = { action: answer.action, content: { ...answer.content, ...second.content } };
    }

    const accepted = waiveFrom(waivable, full);
    if (accepted.length === 0) {
      // 人一条都没选、按了 Esc、或者理由留空。三种都不是「接受了」。
      questions.settle(questionId);
      json(response, { asked: true, answered: true, waived: false, phase, questionId });
      return;
    }

    /*
     * fence：人想了多久是他的事，但他的决定必须落在他看见过的那份证据上。
     *
     * `/api/ask` 那条路由 `questions.apply()` 把 fence 交给 command 层查；接受
     * 风险不推动状态机、没有 command 可走，所以这里显式查一次。少了它，这条防线
     * 就只覆盖一半的答案。
     */
    try {
      questions.assertFenceHolds(questionId);
    } catch (error: unknown) {
      if (!(error instanceof GateMovedError)) throw error;
      questions.settle(questionId);
      json(response, {
        asked: true, answered: true, waived: false, reason: "gate_moved",
        phase, questionId,
      });
      return;
    }

    // 一次能接多条 —— 用户 2026-08-04：接四条不该走四遍完整流程。
    for (const each of accepted) {
      gaps.waive(changeId, phase, each.gapId, each.reason);
    }
    questions.settle(questionId);
    json(response, {
      asked: true, answered: true, waived: true, phase, questionId,
      gapIds: accepted.map((each) => each.gapId),
    });
    return;
  }

  if (url.pathname === "/api/run" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    let phase: Phase;
    try {
      phase = new ChangeStore(database).read(changeId).state.phase;
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    json(response, await runRound({ changeId, phase, sessions, options }));
    return;
  }

  /*
   * 结束一个阶段的终端。
   *
   * **这是界面上一直缺的那个出口。** 每个动作按钮在 `live` 时都禁用（一个阶段同时
   * 只许一个进程，§6.5 规则 5），而 TUI 跑完一轮不会自己退出 —— 于是人一按「进入
   * 终端」，那个阶段就永远卡住：所有按钮全灰，只剩「进入终端」能按，没有出路。
   * 用户 2026-07-30 报的「I don't know what to do next」就是这个。
   *
   * 结束一个进程不是业务决策：它不推动闸门，也不对任何产物下判断。
   */
  /*
   * **明确要一个终端。** 和「看一眼」分开的那半。
   *
   * 看的那条路（`GET /pty/...`）绝不起进程了，所以要有一个地方能起。它是一个
   * 显式动作、有自己的名字，人按下去就知道自己在起一个 Codex —— 这正是
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
    // 那一轮拥有这个座位。
    const busy = phaseBusy(database, changeId);
    if (busy) { json(response, { opened: false, ...busy }); return; }
    try {
      sessions.openForChat(changeId, phase, pluginConfigFor(database, changeId));
    } catch (error: unknown) {
      response.writeHead(409).end(
        error instanceof Error ? error.message : "could not open a terminal");
      return;
    }
    json(response, { opened: true, phase });
    return;
  }

  if (url.pathname === "/api/close" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    const phase = url.searchParams.get("phase") ?? "";
    if (!isPhase(phase)) { response.writeHead(400).end("no such phase"); return; }
    const was = sessions.has(changeId, phase);
    sessions.close(changeId, phase);
    json(response, { closed: was, phase });
    return;
  }

  const pty = /^\/pty\/([^/]+)\/([^/]+)(\/in|\/resize)?$/.exec(url.pathname);
  if (pty) {
    const changeId = decodeURIComponent(pty[1]!);
    const phase = decodeURIComponent(pty[2]!);
    if (!isPhase(phase) || phase === "Done") {
      response.writeHead(404).end("no such phase");
      return;
    }
    const action = pty[3];

    if (action === undefined && request.method === "GET") {
      /*
       * **看一眼绝不起进程。**
       *
       * 这里原来走 `open()`，而它见没有会话就起一个 —— 于是「我只想看看状态」
       * 变成「这个阶段废了」：新进程一活着，`cannotAskNow` 就把这个阶段的每个动作
       * 都拒掉。用户 2026-08-03 连着栽了两次。
       *
       * 现在三种情况各说各的：活着就接上；死了就把最后一屏（`corpses`）给出去，
       * 让人看得见死因；从没跑过就 409，前端说「这个阶段还没有进程」。
       *
       * 409 也是 C3 重连的判据（`?existing=1`）：前端据此保留死亡注解，而不是
       * 循环重连或者对着一个空 composer 以为一切正常。
       */
      const entry = sessions.current(changeId, phase);
      if (!entry) {
        const corpse = sessions.lastScreen(changeId, phase);
        if (corpse.length === 0) {
          response.writeHead(409).end("no session for this phase");
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        });
        for (const chunk of corpse) response.write(chunk);
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      // Without this the headers wait for the first byte, so the browser's
      // fetch does not resolve until Codex happens to print something -- and a
      // terminal that has not printed yet is the normal case, not an edge one.
      response.flushHeaders();
      // What the session has already drawn, so an attaching viewer sees the
      // screen rather than waiting for the next keystroke to produce one.
      for (const chunk of entry.scrollback) response.write(chunk);
      // Forwarded, not read. See the note at the top of this file.
      const listener = (bytes: Uint8Array): void => { response.write(bytes); };
      entry.listeners.add(listener);

      /*
       * 进程没了就**结束这条响应**。
       *
       * 这是浏览器唯一能知道「终端死了」的途径：`fetch` 的 reader 拿到 done，
       * 客户端才说得出「这个终端不再接受输入」。少了它，人对着一帧静止的画面
       * 一直打字（2026-07-30 用户报的就是这个）。
       *
       * 两个方向都要清理：进程先死（enders）、或者人先走开（request close）。
       */
      const end = (): void => {
        entry.listeners.delete(listener);
        response.end();
      };
      entry.enders.add(end);
      request.on("close", () => {
        entry.listeners.delete(listener);
        entry.enders.delete(end);
      });
      return;
    }
    if (action === "/in" && request.method === "POST") {
      /*
       * **没有进程就不起一个来接这几个字节。** 原来这里也走 `open()` —— 于是一次
       * 误触的按键就能凭空造出一个 Codex（而且是没有插件的那种）。
       */
      const live = sessions.current(changeId, phase);
      if (!live) { response.writeHead(409).end("no session for this phase"); return; }
      live.session.write(await readBody(request));
      response.writeHead(204).end();
      return;
    }
    if (action === "/resize" && request.method === "POST") {
      const cols = Number(url.searchParams.get("cols"));
      const rows = Number(url.searchParams.get("rows"));
      /*
       * **一个几列宽的终端不是一个合法的请求，是浏览器还没量出尺寸。**
       *
       * 实测两次（2026-07-29 / 07-30）：一个尺寸为 0 的窗口会让 xterm 的 fit 算出
       * 1 列，然后 StagePass 老老实实把 `cols=1` 传给 pty —— Codex 从此把每个字符
       * 单独排一行，画面竖成一条。**而它是持久的**：窗口恢复正常之后那一屏已经
       * 那样画出去了，字节回放重排不了，看着像终端坏了。
       *
       * `cols > 0` 挡不住这个：1 是「> 0」的。所以设一个下限 —— 比这更窄的终端里
       * 什么 TUI 都没法用，所以拒掉它一定比照做更接近人的意图。
       */
      const MIN_COLS = 20;
      const MIN_ROWS = 5;
      if (
        Number.isFinite(cols) && Number.isFinite(rows)
        && cols >= MIN_COLS && rows >= MIN_ROWS
      ) {
        // 同上：没有进程就没有可以 resize 的东西，不为此起一个。
        sessions.current(changeId, phase)?.session.resize(cols, rows);
      }
      response.writeHead(204).end();
      return;
    }
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
      console.error(`[panel] ${request.method ?? "?"} ${request.url ?? "?"} —— ${detail}`);
      if (error instanceof Error && error.stack !== undefined) {
        console.error(error.stack);
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
  }, everyMs);
  // Node 不该为了这个定时器活着。
  reaper.unref();

  server.on("close", () => { clearInterval(reaper); sessions.closeAll(); });
  return { server, sessions };
}
