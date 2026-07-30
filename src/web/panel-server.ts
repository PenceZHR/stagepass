import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

import { PHASES, isPhase, type Phase } from "../domain/phase";
import { codexArgv } from "../codex/invocation";
import { CodexTuiTransport } from "../codex/tui-transport";
import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";
import { createSubAgentLookup, readRoleTranscript } from "../codex/subagent";
import { RoundTurnRunner } from "../work/round-turn-runner";
import {
  gateDecisionQuestion, waiveQuestion, waiveFrom, clarificationQuestion,
} from "../domain/question";
import { briefContract, readBriefProposal, briefFrom, BriefProposalVoidError } from "../domain/brief";
import { GateMovedError } from "../domain/gate";
import type { Gap } from "../domain/gap";
import type { ChangeState } from "../domain/change-state";
import { BindingStore } from "../store/binding-store";
import { ChangeStore, type LedgerEntry } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore, ReasonRequiredError } from "../store/rubric-store";
import {
  RUBRIC_ROLES, UntrustedKeyError, InvalidCriterionError, type RubricRole,
} from "../domain/rubric";
import { parseRubricEdit, UnreadableEditError } from "../domain/rubric-edit";
import { retireStandards } from "../domain/rubric-gaps";
import { QuestionStore } from "../store/question-store";
import { TurnLoop } from "../work/turn-loop";
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
 * The phases that can hold a thread: eleven of the twelve.
 *
 * `Done` is excluded because it is terminal -- nothing is dispatched there, so
 * a terminal for it would be a tab that can never show anything. Eleven is a
 * fixed number, which is what lets the panel be enumerated rather than being a
 * list that grows (PRD §6.5 rule 1). Do not introduce a third count.
 */
const THREADED_PHASES: readonly Phase[] =
  PHASES.filter((phase) => phase !== "Done");

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
  /**
   * 一轮最多等多久。默认 30 分钟。
   *
   * 不只是给测试用的旋钮：一轮对抗真的会停在审批上等人（PRD §6.6），而
   * 「窗口还开着、什么也没发生」和成功长得一模一样 —— 总得有个东西替它说话。
   */
  readonly turnTimeoutMs?: number;
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

  constructor(private readonly options: PanelOptions) {}

  private static key(changeId: string, phase: Phase): string {
    return `${changeId} ${phase}`;
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
   * The session for a phase, started if it is not running.
   *
   * Returning the existing one rather than starting a second is the guarantee
   * described above; it is not an optimisation.
   */
  open(changeId: string, phase: Phase): LiveSession {
    const bound = new BindingStore(this.options.database).find(changeId, phase);
    // Browsing, not running: no prompt, so Codex opens at the composer and no
    // turn is dispatched. Running a phase goes through `launchInto`, where the
    // transport supplies the argv that carries the prompt.
    return this.launchInto(changeId, phase, codexArgv({
      threadId: bound?.status === "bound" ? bound.threadId : null,
      sandbox: this.options.session.sandbox,
      approval: this.options.session.approval,
      model: this.options.session.model,
      reasoningEffort: this.options.session.reasoningEffort,
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

    const start = this.options.start ?? startPtySession;
    const session = start({
      changeId, phase, argv,
      options: { ...this.options.session, cwd },
    });

    const entry: LiveSession = {
      session, listeners: new Set(), enders: new Set(), scrollback: [],
    };
    let buffered = 0;
    session.onBytes((bytes) => {
      entry.scrollback.push(bytes);
      buffered += bytes.byteLength;
      while (buffered > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
        buffered -= entry.scrollback.shift()!.byteLength;
      }
      for (const listener of entry.listeners) listener(bytes);
    });
    session.onExit(() => {
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
    const selectedProject = url.searchParams.get("project");
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
    if (sessions.has(changeId, phase)) {
      json(response, { asked: false, reason: "phase_already_running", phase });
      return;
    }

    const gate = new CommandStore(database).gateFor(changeId);
    const blockers = new GapStore(database).blockers(changeId, phase);
    const question = gateDecisionQuestion({
      phase,
      gate,
      summary: blockers.length === 0
        ? "证据已到齐，没有挡住闸门的问题。"
        : `${blockers.length} 项问题仍然挡着闸门：`
          + blockers.map((blocker) => `${blocker.id}[${blocker.severity}]`).join(" "),
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
      config: [
        `mcp_servers.stagepass.command="npx"`,
        `mcp_servers.stagepass.args=["tsx","${join(HERE, "..", "plugin", "server.ts")}"]`,
        `mcp_servers.stagepass.env={STAGEPASS_DB="${database.name}"}`,
      ],
      prompt: [
        `调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次，questionId 用 "${questionId}"。`,
        "它会把 StagePass 的问题交给我来选。",
        "不要替我做决定，不要解释我该选什么，调用完就停下。",
      ].join("\n"),
    }));

    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    }
    const answer = questions.readAnswerFor(questionId);
    if (!answer) {
      json(response, { asked: true, answered: false, phase, questionId });
      return;
    }
    json(response, {
      asked: true, answered: true, phase, questionId, answer,
      outcome: questions.apply(questionId),
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
    if (sessions.has(changeId, phase)) {
      json(response, { asked: false, reason: "phase_already_running", phase });
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
    const pluginConfig = [
      `mcp_servers.stagepass.command="npx"`,
      `mcp_servers.stagepass.args=["tsx","${join(HERE, "..", "plugin", "server.ts")}"]`,
      `mcp_servers.stagepass.env={STAGEPASS_DB="${database.name}"}`,
    ];
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

    // 第二步：把它组成一道题，在 Codex 的选择器里问人。
    const gate = new CommandStore(database).gateFor(changeId);
    const question = clarificationQuestion({
      title: `${changeId}：先把这次改动要什么说清楚`,
      items,
    })!;
    const questionId = `BR-${changeId}-${Date.now()}`;
    const questions = new QuestionStore(database);
    questions.ask({
      id: questionId, changeId, phase, kind: "clarification",
      question, expectedSnapshot: gate.snapshot,
    });

    /*
     * **打进同一个会话，不另起进程。** 完整理由在 `PanelSessions.type` 那段注释里，
     * 两句话：`launchInto` 会把活着会话的 argv 丢掉；`close` 再起会掐断浏览器正在读
     * 的流。两条我都踩过。
     *
     * 一行，因为 composer 里的换行就是提交。
     */
    const typed = await sessions.type(changeId, phase,
      `调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次，questionId 用 "${questionId}"。`
      + "它会把「这次改动要什么」交给我来答。不要替我回答，不要猜我想要什么，调用完就停下。");
    if (!typed) {
      // 会话在这中间死了。**不许假装问出去了** —— 题已经落库，人却永远看不到它，
      // 而那正是这一整轮排查花掉的时间。
      questions.settle(questionId);
      json(response, { asked: false, reason: "session_died_before_asking", phase });
      return;
    }

    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    }
    const answer = questions.readAnswerFor(questionId);
    if (!answer) {
      json(response, { asked: true, answered: false, phase, questionId });
      return;
    }

    const brief = briefFrom(items, answer);
    questions.settle(questionId);

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
      json(response, { asked: true, answered: true, recorded: false, phase, questionId });
      return;
    }
    changes.setBrief(changeId, brief);
    json(response, { asked: true, answered: true, recorded: true, phase, questionId, brief });
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
    if (sessions.has(changeId, phase)) {
      json(response, { asked: false, reason: "phase_already_running", phase });
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
      config: [
        `mcp_servers.stagepass.command="npx"`,
        `mcp_servers.stagepass.args=["tsx","${join(HERE, "..", "plugin", "server.ts")}"]`,
        `mcp_servers.stagepass.env={STAGEPASS_DB="${database.name}"}`,
      ],
      prompt: [
        `调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次，questionId 用 "${questionId}"。`,
        "它会把「接受哪一条风险」交给我来选。",
        "不要替我做决定，不要评价这些风险，调用完就停下。",
      ].join("\n"),
    }));

    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    }
    const answer = questions.readAnswerFor(questionId);
    if (!answer) {
      json(response, { asked: true, answered: false, phase, questionId });
      return;
    }

    const accepted = waiveFrom(question, answer);
    if (!accepted) {
      // 人按了 Esc，或者答案对不上他当时看见的那份名单。两种都不是「接受了」。
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

    gaps.waive(changeId, phase, accepted.gapId, accepted.reason);
    questions.settle(questionId);
    json(response, {
      asked: true, answered: true, waived: true, phase, questionId,
      gapId: accepted.gapId,
    });
    return;
  }

  if (url.pathname === "/api/run" && request.method === "POST") {
    const changeId = url.searchParams.get("change") ?? "";
    let phase: Phase;
    let brief: string | null;
    try {
      const change = new ChangeStore(database).read(changeId);
      phase = change.state.phase;
      brief = change.brief;
    } catch {
      response.writeHead(404).end("no such change");
      return;
    }
    if (sessions.has(changeId, phase)) {
      // §6.5 rule 5: one live process per phase thread. Dispatching into a
      // terminal someone already has open would interleave two turns.
      json(response, { ran: false, reason: "phase_already_running", phase });
      return;
    }
    /*
     * 没有录入需求就不跑。**在排队之前拦住，不是让它跑起来再失败。**
     *
     * RoundTurnRunner 里也有同一条检查（防御在两层），但只靠那一层是不够的：
     * TurnLoop 会把 runner 抛的错当成「这一轮跑失败了」，于是给 Change 应用 fail、
     * 标成 blocked。而「还没录需求」是前置条件不满足，**不是这一轮失败** —— 因为它
     * 把 Change 打成阻塞，就得再去 retry 才能恢复，白折腾一圈。
     */
    if (brief === null) {
      json(response, { ran: false, reason: "change_has_no_brief", phase });
      return;
    }
    /*
     * 项目没写路径也不跑。
     *
     * 和上面那条同一个形状、同一个理由：**前置条件不满足不该把 Change 打成 blocked**。
     * `PanelSessions.launchInto` 里也会拒（防御在两层），但那一层抛出来会被 TurnLoop
     * 当成「这一轮跑失败了」。
     */
    if (sessions.workspaceFor(changeId) === null) {
      json(response, { ran: false, reason: "project_has_no_path", phase });
      return;
    }

    /*
     * 「跑这个阶段」跑的是**一轮对抗**，不是一次 turn。
     *
     * 单次 turn 是让一个模型自己写、自己说没问题，闸门读它的自述 —— 这个产品存在
     * 的理由就是不许那样。所以这里直接换掉 runner，而不是在界面上多一个按钮：
     * 两个「跑」、没人说得清哪个是真的，那是老树的病。
     *
     * 裁判仍然跑在这个阶段自己的 pty 里（`launch` 那一行），所以你在面板上看得见
     * 它，也看得见它什么时候停下来问你。
     */
    const lookup = createSubAgentLookup();
    const loop = new TurnLoop({
      database,
      runner: new RoundTurnRunner({
        transport: new CodexTuiTransport({
          ...options.session,
          ...(options.turnTimeoutMs === undefined
            ? {} : { timeoutMs: options.turnTimeoutMs }),
          launch: ({ argv }) => { sessions.launchInto(changeId, phase, argv); },
        }),
        gaps: new GapStore(database),
        rubrics: new RubricStore(database),
        changes: new ChangeStore(database),
        bindings: new BindingStore(database),
        readRole: (parentThreadId, agentPath) =>
          readRoleTranscript({ lookup, parentThreadId, agentPath }),
        taskFor: (phase) => MINIMAL_PHASE_INSTRUCTIONS[phase as Phase],
      }),
    });
    const at = Date.now();
    const jobId = `JOB-${changeId}-${phase}-${at}`;
    loop.queueTurn({
      changeId, jobId, deadlineAt: at + 30 * 60_000, maxAttempts: 1,
    });
    const outcome = await loop.runOnce({
      owner: "panel", token: jobId, now: at, ttlMs: 30 * 60_000,
    });
    json(response, { ran: true, phase, outcome });
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
      const entry = sessions.open(changeId, phase);
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
      sessions.open(changeId, phase).session.write(await readBody(request));
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
        sessions.open(changeId, phase).session.resize(cols, rows);
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
    void handle(request, response, sessions, options).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("close", () => { sessions.closeAll(); });
  return { server, sessions };
}
