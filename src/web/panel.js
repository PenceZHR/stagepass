/*
 * The browser half of the terminal panel — Abstract Cloud & Sea + Circular
 * Stage Orbit, as confirmed on 2026-07-24.
 *
 * Things that are decisions rather than styling, so do not "simplify" them:
 *
 *  - Nodes sit on ONE shared centre and radius. They are placed by rotating out
 *    and counter-rotating back, so the card stays upright and hover scaling
 *    never disturbs the ring.
 *  - Every stage carries a ring; the one whose process is alive breathes. That
 *    is the state you can read across the room.
 *  - Entering a stage fires the portal, converges, and brings the stage in from
 *    slightly small, ~680ms. Repeat triggers are blocked or navigations race.
 *
 * 信息分两层（用户 2026-07-29 定，交接 §5.0.2）。这条决定这个文件的形状：
 *
 *   悬停一个阶段 → 左侧 40% 的常驻面板刷成它的**概要**
 *   点击一个阶段 → 弹窗显示它的**明细**（全部问题 + 闸门 + 动作）
 *   环那一屏本身**什么都不加**
 *
 * 所以：觉得主屏少了点什么，答案是 renderStatus 或 drawSheet，不是往环那屏塞
 * 一块新东西。原来压在环底下那条决策区就是这么长出来的，已经整条撤掉了。
 *
 * And the rule the panel exists under: bytes arrive as Uint8Array and go
 * straight into xterm.js. Nothing here decodes them, because nothing here may
 * understand them (PRD §9.3).
 */
const params = new URLSearchParams(location.search);
const changeId = params.get("change") || "CHG-1";
const projectParam = params.get("project");
const startCollapsed = params.get("collapsed") === "1";

/**
 * 按 id 取元素，**取不到就当场炸**。
 *
 * 三个理由，第三个是这次（2026-08-05 给 panel.js 上类型检查）才补的：
 *
 * 1. `getElementById` 的返回类型是 `HTMLElement | null`，而这里每一个 id 都在
 *    `panel.html` 里写死存在 —— 取不到就是 html 和 js 对不上，那是**开发期的
 *    结构错误**，不该在运行时静默变成 `null.textContent` 之后再报。
 * 2. 报的时候要说出**是哪个 id**。`Cannot read properties of null` 说不出。
 * 3. 收窄类型。`button()` / `field()` / `dialog()` 各自返回对应的元素类型，
 *    于是 `.disabled` / `.value` / `.showModal()` 不用在 30 个使用点各写一次
 *    断言 —— **一处收窄，全文可用**。
 */
function pick(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`panel.html 里没有 #${id}`);
  return found;
}
/** @returns {HTMLButtonElement} */
function button(id) { return /** @type {HTMLButtonElement} */ (pick(id)); }
/** @returns {HTMLInputElement} */
function field(id) { return /** @type {HTMLInputElement} */ (pick(id)); }
/** @returns {HTMLDialogElement} */
function dialog(id) { return /** @type {HTMLDialogElement} */ (pick(id)); }

const orbitView = pick("orbit-view");
const stageView = pick("stage-view");
const graphView = pick("graph-view");
const wrap = pick("orbit-wrap");
const portal = pick("portal");
const columns = pick("columns");
const stageName = pick("stage-name");
const stageThread = pick("stage-thread");
const stageNote = pick("stage-note");
/** 终端底下那行注解的原话。say() 会盖掉它，进终端时还原。 */
const NOTE_DEFAULT = stageNote.textContent;

// 左侧 40% 的常驻面板
const statusKicker = pick("status-kicker");
const statusTitle = pick("status-title");
const statusMark = pick("status-mark");
const statusLine = pick("status-line");
const statusFacts = pick("status-facts");
const statusFoot = pick("status-foot");

// 环心的太阳，和点它翻出来的那张状态卡
const sunButton = button("sun");
const sunCard = pick("sun-card");
const sunKicker = pick("sun-kicker");
const sunTitle = pick("sun-title");
const sunLine = pick("sun-line");
const sunCount = pick("sun-count");

// 点小环打开的弹窗
const sheet = dialog("sheet");
const sheetKicker = pick("sheet-kicker");
const sheetTitle = pick("sheet-title");
const sheetMark = pick("sheet-mark");
const sheetLine = pick("sheet-line");
const sheetGaps = pick("sheet-gaps");
const sheetRubric = pick("sheet-rubric");
const tabGaps = pick("tab-gaps");
const tabRubric = pick("tab-rubric");
const enterButton = button("enter");
const waiveButton = button("waive");
const briefButton = button("brief");
const closeTermButton = button("close-term");
const briefDraftButton = button("brief-draft");
const briefConfirmButton = button("brief-confirm");
const openTermButton = button("open-term");
const nextStepLine = pick("next-step");
const lastOutcomeLine = pick("last-outcome");
const roundProgress = pick("round-progress");
const runButton = button("run");
const askButton = button("ask");

pick("crumb-change").textContent = changeId;

const term = new Terminal({
  convertEol: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  theme: {
    background: "rgba(0,0,0,0)",
    foreground: "#e6dfd2",
    cursor: "#e4cfad",
    selectionBackground: "rgba(228,207,173,0.28)",
  },
  allowTransparency: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(pick("term"));

/**
 * 阶段的 pass / fail，用**词**说一遍。
 *
 * 判据在服务端（panel-server.ts 的 markOf），这里只负责显示：绿 = 有人批准过这个
 * 阶段，黄 = 有挡着的问题或上一轮失败了。别在这里凭 gap 数量另算一套 —— 两份拷贝
 * 迟早会互相打架。
 *
 * 文案本身是设计稿 §3 要的"颜色之外的第二个信号"，不是可有可无的提示。
 */
const MARK = {
  approved: { label: "已批准", line: "有人在 Codex 里批准了这个阶段，闸门从这里放行。" },
  problem: { label: "有问题", line: "这个阶段有挡着闸门的问题，或者上一轮跑失败了。" },
};

let phases = [];
let panelState = null;
let current = null;
let stream = null;
let moving = false;
/** 弹窗正在显示哪个阶段，没开时是 null。 */
let sheetPhase = null;
/** run / ask 留下的一句话，盖过默认说明，直到弹窗重开。 */
let notice = null;
/** 弹窗当前在哪个页签。 */
let sheetTab = "gaps";
/** 正在编辑的那份 rubric —— 角色、作用域、以及还没保存的 criteria。 */
let editing = null;

const path = (phase, suffix = "") =>
  `/pty/${encodeURIComponent(changeId)}/${encodeURIComponent(phase)}${suffix}`;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Keystrokes out. Text until they are sent; bytes from there on. */
const send = (phase, data) =>
  fetch(path(phase, "/in"), { method: "POST", body: new TextEncoder().encode(data) });

function resize(phase) {
  fit.fit();
  return fetch(path(phase, `/resize?cols=${term.cols}&rows=${term.rows}`), { method: "POST" });
}

const SEAT_WORDS = {
  pending: "并行座位开着，还没跑",
  running: "并行座位上一轮在跑",
  settled: "并行座位跑完了，等主线走到时收编",
  blocked: "并行座位上一轮失败了",
};

function statusOf(entry) {
  if (entry.live) return { short: "进程活着", long: "线程活着，点开直接接上去。" };
  // 并行座位（批 3）：主线在别处，这一格自己在攒轮次。
  if (entry.seat) {
    return {
      short: `并行·${entry.seat}`,
      long: `${SEAT_WORDS[entry.seat] ?? entry.seat}。主线走到这儿时会把进度收编进来。`,
    };
  }
  if (entry.threadId) return { short: "有线程", long: "有线程，点开会恢复它的历史。" };
  if (entry.current) return { short: "待运行", long: "Change 就停在这个阶段。跑它会派发一次真的 turn。" };
  return { short: "未开始", long: "还没轮到它。点开只是打开一个终端看看。" };
}

/**
 * 一个阶段的一句话，左面板和弹窗共用。
 *
 * **裁决优先于位置**：`statusOf` 说的是"有没有线程、是不是当前"，一个已经批准过
 * 的阶段照样两样都没有，于是会掉进"还没轮到它"—— 而它明明已经走过去了。所以有
 * mark 就先说 mark。
 */
const lineFor = (entry) => (entry.mark ? MARK[entry.mark].line : statusOf(entry).long);

/*
 * ── 跑一轮时说得出它在干什么 ──────────────────────────────
 *
 * 用户 2026-07-30 的原话：「跑一轮的时候界面几分钟不说话，我以为它挂了。」
 *
 * 而它不只是不好看。同一天撞到过更糟的那一格：`status = running` 而那个阶段一个活
 * 进程都没有 —— 派出去的 Codex 早就没了，面板会一直坐到 30 分钟超时。
 * **「在跑」和「已经死了」在界面上是同一个样子**，而这一段就是为了把它们分开。
 *
 * 两条硬约束都守住：一个字节都不碰 pty（PRD §9.3），进度只来自 `/api/progress`
 * （库 + 进程状态）；**只写弹窗和左面板，环那一屏什么都不加**（交接 §5.0 第 4 条）。
 */
const PROGRESS_EVERY_MS = 3_000;

/** 轮询而不是 SSE：笨，但一个只读的 GET 骗不了人，断了也自己会好。 */
let progressTimer = null;

const STAGE_WORDS = {
  judge_starting: "裁判起来了，还没派生红蓝",
  red_writing: "红方在写",
  blue_attacking: "蓝方在挑毛病",
};

/** 里程碑的顺序 —— 和 panel.html 里 #round-progress 三段的书写顺序是同一份。 */
const STAGE_ORDER = ["judge_starting", "red_writing", "blue_attacking"];

/** 3:20 这种。毫秒对人没有意义。 */
function spell(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * 一次进度，翻成一句话。
 *
 * 说不出阶段就**说不出**，不编一个阶段名 —— 这一屏存在的意义就是不再让人猜，
 * 编一个就白做了。
 */
function progressWords(progress) {
  if (progress.processGone) {
    return `⚠ ${progress.phase} 记着在跑，但那个 Codex 进程已经不在了`
      + `（已经 ${spell(progress.job?.elapsedMs ?? 0)}）。`
      + "它会一直等到超时才报错 —— 这一轮实际上已经死了。";
  }
  if (progress.status !== "running") return null;
  const elapsed = spell(progress.job?.elapsedMs ?? 0);
  return progress.stage === null
    ? `${progress.phase} 在跑，已经 ${elapsed}。还看不出走到哪一步`
      + "（第一轮看不出来 —— 裁判的线程要跑完才绑上）。"
    : `${progress.phase} 在跑，已经 ${elapsed}：${STAGE_WORDS[progress.stage] ?? progress.stage}。`;
}

/**
 * 一轮的进度条（§2.3）：三个**看得见的里程碑**，亮到走到的那一段。
 *
 * 不是百分比 —— 百分比只能编，而里程碑是从「裁判派生了几个子 Agent」真实数出来
 * 的（/api/progress 的 stage）。说不出走到哪（第一轮开头）就一段都不亮：条在、
 * 全灰 —— 「在跑但看不出位置」和「没在跑」长得不一样。挂了（processGone）就收起
 * 来，让那句 ⚠ 单独说话，不摆一条还在走的条骗人。
 */
function paintRoundProgress(progress) {
  const running = progress.status === "running" && !progress.processGone;
  roundProgress.hidden = !running;
  if (!running) return;
  const reached = progress.stage === null ? -1 : STAGE_ORDER.indexOf(progress.stage);
  [...roundProgress.children].forEach((piece, index) => {
    piece.classList.toggle("reached", index <= reached);
  });
}

/** 裁判线程离墙多远，一小句。说不出就空 —— 不编（§3.3·11）。 */
function contextWords(progress) {
  const context = progress.context;
  if (!context || typeof context.used !== "number" || !context.window) return "";
  const percent = Math.round((context.used / context.window) * 100);
  return `　线程上下文已用 ${percent}%`
    + `（${Math.round(context.used / 1000)}k / ${Math.round(context.window / 1000)}k）。`;
}

async function pollProgress() {
  let progress;
  try {
    const response = await fetch(
      `/api/progress?change=${encodeURIComponent(changeId)}`);
    // 404（Change 没了）不算失联 —— 别拿它去触发重连。
    if (!response.ok) return;
    progress = await response.json();
  } catch {
    // 连 fetch 都失败，多半是面板在重启 —— 交给自愈那条路（§5.5.3），
    // 它会说一声、按间隔重试，回来时整屏一起刷新。
    void loadOrReconnect();
    return;
  }
  paintRoundProgress(progress);
  const words = progressWords(progress);
  if (words === null) return;
  // 写在弹窗那一行。人是从弹窗里按下「跑这个阶段」的，结果就该回到那儿。
  sheetLine.textContent = words + contextWords(progress);
  if (progress.status === "running" && !progress.processGone) {
    runButton.textContent = `在跑 ${spell(progress.job?.elapsedMs ?? 0)}`;
  }
}

function startProgress() {
  if (progressTimer !== null) return;
  void pollProgress();
  progressTimer = setInterval(() => { void pollProgress(); }, PROGRESS_EVERY_MS);
}

function stopProgress() {
  roundProgress.hidden = true;
  if (progressTimer === null) return;
  clearInterval(progressTimer);
  progressTimer = null;
}

/**
 * 「没答上」的两种，翻成人话。
 *
 * 它们要做的事完全不同：一种是人还没去答，另一种是**那边的进程早就没了**。
 * 后者最常见的原因是这个阶段绑的线程被 Codex 归档了 —— 而解药要那个线程 id，
 * 所以服务端把它一起给了过来。
 */
function unansweredWords(result) {
  if (result.reason === "ask_turn_ended_without_answer") {
    // 补问过一次还是没端出问题来 —— 两次都是模型抽风，不是人没答。
    return `${result.phase} 的 Codex 把那一轮跑完了，却没把问题交给你`
      + "（补问过一次也一样）。会话已收 —— 再点一次就重新问。";
  }
  if (result.reason !== "session_died_before_answering") {
    return "问题已经在终端里了，等你在 Codex 的选择器里选。";
  }
  return `${result.phase} 的 Codex 一起来就退了，所以没人被问到。`
    + (result.threadId
      ? "最常见的原因是这个阶段绑的线程被 Codex 归档了 ——"
        + ` 在终端里跑 codex unarchive ${result.threadId} 再试一次。`
      : "");
}
/**
 * 服务端把这次请求整个搞砸了吗。
 *
 * 服务端现在会把真实原因回给我们（原来是一个空 body 的 500，什么都不说）。
 * **看见了就原样显示** —— 翻译它等于又把真实原因藏起来一次。
 */
function crashed(result) {
  return result?.failed === true ? `出错了：${result.error}` : null;
}

/** 没派起来时说清是哪一种。原样吐一个 reason 等于没说。 */
function runRefusal(result) {
  if (result.reason === "phase_already_running") {
    // `busy` 说的是挡路的是什么：一个闲终端，还是账本上没了结的一轮 ——
    // 两者的出路不同，一句话不能混着说。
    return result.busy === "terminal"
      ? `${result.phase} 已经开着一个终端了。同一个阶段线程同时只许有一个进程 ——`
        + "先「结束这个终端」。"
      : `${result.phase} 有一轮没了结（${result.busy ?? "?"}）。等它跑完，`
        + "或者按「中止这一轮」。";
  }
  if ((result.reason ?? "").startsWith("phase_cannot_queue:")) {
    const status = result.reason.slice("phase_cannot_queue:".length);
    return status === "blocked"
      ? `${result.phase} 上一轮跑失败了，现在只接受 retry —— 而 retry 是你的裁决，`
        + "走「请 Codex 问我」，不走这个按钮。"
      : status === "settled"
        ? `${result.phase} 这一轮跑完了，先裁决（批准 / 再来一轮）再说。`
        : `${result.phase} 现在是 ${status}，派不了新的一轮。`;
  }
  if (result.reason === "change_has_no_brief") {
    return "还没说清楚这次改动要什么。先按「说清楚我要什么」。";
  }
  if (result.reason === "project_has_no_path") {
    return "这个项目没有路径，Codex 不知道该在哪跑。";
  }
  if (result.reason === "workspace_not_trusted") {
    /*
     * 这一条必须给出**具体怎么办**，因为出路不在这个界面上：Codex 的目录信任只有
     * 人自己答得了（替他答就是往他的 ~/.codex/config.toml 里写东西）。
     *
     * 不拦的后果实测过：Codex 起来、停在那个提问上、没人按，这一侧等满 30 分钟拿到
     * 一句「TUI 好像没起来」。
     */
    return `Codex 还没信任过 ${result.workspace}。派下去它会停在「Do you trust the`
      + " contents of this directory?」上等人按，而这一屏看不见它 —— 所以先拦住了。"
      + "出路：在那个目录里手动跑一次 codex，答 Yes，然后回来再按。";
  }
  if (result.reason === "workspace_dirty") {
    /*
     * Build 的产出是一个 commit，而 StagePass 提交的是工作树里所有的改动 —— 它分不出
     * 哪一行是红方写的、哪一行是你自己写了一半的。所以把文件列出来：「树脏了」这句话
     * 本身没法让人动手。
     */
    const files = (result.dirty ?? []).join("、");
    return `${result.phase} 要在干净的工作树上跑，现在有没提交的改动：${files}。`
      + "这一轮的产出会记成一个 commit，而 StagePass 分不出哪一行是模型写的、"
      + "哪一行是你自己写了一半的 —— 先提交或撤掉它们。";
  }
  if (result.reason === "upstream_artifact_missing") {
    /*
     * 不拦的后果实测过（2026-07-31）：任务书把一份磁盘上不存在的上游产物列给红方，
     * 一整轮几分钟只换来一句「输入不见了」，下游四个角色还各自又发现了一遍。
     */
    const items = (result.missing ?? [])
      .map((each) => `${each.phase} 的 ${each.id}`).join("、");
    return `上游产物不在了：${items}。这一阶段的任务书要把它们当输入交给正方 ——`
      + "先弄清它去哪了（被移走/改名/仓库回退），必要时回那个阶段重跑一轮。";
  }
  return `没跑起来：${result.reason}`;
}

/**
 * Dispatch the Change's current phase.
 *
 * Which phase runs comes from the state machine, not from what is selected --
 * you cannot run a phase out of order, and the button only appears on the one
 * the Change is actually at.
 */
async function run() {
  /*
   * 跑的是哪个座位（批 3）：主线的格子不带 phase（老语义）；开着并行座位的
   * 格子把自己的阶段带上 —— 服务端按它路由到座位。
   */
  const at = phases.find((each) => each.phase === sheetPhase);
  const seatParam = at && !at.current && at.seat !== null
    ? `&phase=${encodeURIComponent(at.phase)}` : "";
  runButton.disabled = true;
  runButton.textContent = "派发中…";
  /*
   * 这个 fetch 现在**排完队就回**（2026-08-05，BACKLOG §3.4）—— 原来它要等整一轮，
   * 而实测一轮 60~343 分钟，浏览器和代理会先超时，那时人看到「网络错误」而轮跑得
   * 好好的。进度一直靠下面这条独立的只读轮询，不靠这个响应。
   */
  startProgress();
  try {
    const result = await (await fetch(
      `/api/run?change=${encodeURIComponent(changeId)}${seatParam}`,
      { method: "POST" },
    )).json();
    const broke = crashed(result);
    if (broke !== null) {
      say(broke);
    } else if (result.ran === false) {
      say(runRefusal(result));
    } else {
      // **说「派出去了」，不说「跑完了」。** 它还在跑，而说错这一句就是让人
      // 以为可以去裁决了 —— 那正是这个面板最该防的那类。
      say(`${result.phase} 这一轮派出去了，正在跑。进度看环上那条，跑完了这里会变。`);
    }
  } finally {
    stopProgress();
    runButton.textContent = "跑这个阶段";
    await loadOrReconnect();
  }
}

/**
 * 把一句结果留在你按按钮的地方。
 *
 * 派发和问人都是从弹窗里按下去的，所以结果回到弹窗；而「请 Codex 问我」会把你送
 * 进终端、弹窗随即关掉，所以同一句话也写进终端底下那行注解 —— 否则它就没了。
 *
 * 主屏上**没有**一条能挂消息的横幅，这是 §5.0 第 4 条要的：新东西不进主屏。
 */
function say(message) {
  notice = message;
  sheetLine.textContent = message;
  stageNote.textContent = message;
}

/** 服务端说某一条表态没落地时的原因，翻成人话。 */
const REFUSAL_WORDS = {
  reason_missing: "没写理由，所以这一条留着没动",
  unknown_gap: "这一条在你回答的时候已经不是未解决状态了",
  standard_not_waivable: "这是一条标准，出口是在「标准」页签里撤下它",
  p0_not_waivable: "P0 不许豁免 —— 出口是红方改掉它，或者你判它不成立",
};

/**
 * 你刚刚说了什么，以及有没有哪一条没落地。
 *
 * **没落地的必须说出来。** 人已经答完走了，一次静默跳过等于他点了一下什么都没发生 ——
 * 而那正是这个项目从头到尾在防的那一种失败。
 */
function saidWhat(result) {
  const parts = [];
  const responded = Object.keys(result.responses ?? {}).length;
  if (responded > 0) parts.push(`你对 ${responded} 条问题表了态`);
  if (result.raised) parts.push(`你自己提的那条记成了 ${result.raised}`);
  if (result.outcome?.kind === "refused") {
    // 他自己刚提的要求挡住了他自己的批准，这种最要说清楚。
    parts.push(`⚠ 闸门拒了这次「${result.outcome.action}」：`
      + `${GATE_REFUSAL_WORDS[result.outcome.reason] ?? result.outcome.reason}`);
  } else {
    parts.push(`裁决 → ${JSON.stringify(result.outcome)}`);
  }
  for (const refused of result.refused ?? []) {
    parts.push(`⚠ ${refused.id}：${REFUSAL_WORDS[refused.code] ?? refused.code}`);
  }
  // 「再来一轮」会当场续跑，不用人再按一次「跑这个阶段」—— 所以要说出来它已经在跑了。
  if (result.continued) {
    /*
     * §5.5.5：没派出去的原因要**整句**上屏，不是光吐一个 reason 码 ——
     * `runRound` 带回来的 dirty 文件名单、没被信任的目录、缺的上游产物都在
     * `continued` 里，`runRefusal` 正是给它们配的那套人话。真机现场：retry 被
     * 干净树预检拒掉，代码里带着文件名单，人看到的只有「点了没反应」。
     */
    parts.push(result.continued.ran
      ? "下一轮已经派出去了"
      : `下一轮没派出去 —— ${runRefusal(result.continued)}`);
  }
  return parts.join("；");
}

/**
 * Put the gate decision to the human, in Codex.
 *
 * This opens the phase's terminal because that is where the answer happens --
 * the selector is drawn by Codex there, and the page has no way to answer it.
 */
async function ask() {
  askButton.disabled = true;
  askButton.textContent = "已送进终端…";
  try {
    const result = await (await dispatchThenEnter(() => fetch(
      `/api/ask?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    ))).json();
    const broke = crashed(result);
    if (broke !== null) {
      say(broke);
    } else if (!result.asked) {
      say(result.reason === "no_decision_available"
        ? "这个闸门现在没有可做的裁决。"
        : `没问成：${result.reason}`);
    } else if (!result.answered) {
      say(unansweredWords(result));
    } else {
      say(saidWhat(result));
    }
  } finally {
    askButton.textContent = "请 Codex 问我";
    await loadOrReconnect();
  }
}

/**
 * One shared centre, one shared radius.
 *
 * 0.40 和 CSS 里 `.halo { inset: 10% }` 是同一个数：轨道半径也是
 * (1 - 2×0.10) / 2 = 0.40 倍环宽，节点因此正好骑在轨道上。**改一个就要改另一个**，
 * 否则节点会浮在轨道内侧或外侧。
 */
/**
 * 录入需求：模型读仓库提问题 -> 人在选择器里答。
 *
 * **和 approve / waive 同一条路**：网页只组题、把题送进那个阶段的终端，答在 Codex
 * 自己的选择器里发生。网页不代答，也没有「直接填需求」的输入框。
 *
 * 在这之前这一步整个不存在，于是 PRD 阶段的红方收到的是一句写死的通用指令，
 * 「this change」是哪个 change 它从来不知道 —— 那份 PRD 只能是编的。
 */
/*
 * ── 顺序很要紧，别调回来 ──────────────────────────────
 *
 * 三个动作（录需求 / 问闸门 / 接受风险）都要「派一个 turn 进这个阶段的终端，然后进
 * 去看」。**必须先发请求，再进终端。**
 *
 * 反过来就坏：`enter()` 会通过 `/pty/...` 开一个**浏览用**的会话（没有提示词），
 * 而服务端那三个端点看见「这个阶段已经有活进程」就直接拒 `phase_already_running`
 * —— 于是它被自己刚开的终端挡住了。2026-07-30 实测，症状是「点了没反应」，
 * 而且一旦终端开过一次就永远失败。
 *
 * 等一下再进：服务端收到请求后毫秒级就把 pty 起来了，这时 `enter()` 里的 attach
 * 会接上**同一个**会话（`sessions.open` 对活着的会话是原样返回），人就看得见提示词
 * 和选择器。
 */
const DISPATCH_THEN_ENTER_MS = 1200;

async function dispatchThenEnter(request) {
  const at = phases.find((entry) => entry.current);
  closeSheet();
  const answered = request();               // 先发，别 await —— 它要等人答，几分钟
  await wait(DISPATCH_THEN_ENTER_MS);
  if (at) void enter(at.phase);
  return answered;
}

async function recordBrief() {
  briefButton.disabled = true;
  briefButton.textContent = "模型在读仓库…";
  // 成功那条路自己走了 leave()（里面已经 load 过），finally 不要再 load 一次 ——
  // 再 load 会把刚打开的弹窗内容重画，把那句结论盖掉。
  let briefLanded = false;
  try {
    const result = await (await dispatchThenEnter(() => fetch(
      `/api/brief?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    ))).json();
    const broke = crashed(result);
    if (broke !== null) {
      say(broke);
    } else if (!result.asked) {
      say(result.reason === "no_items"
        ? "模型一条问题都没提出来。这不算「不需要问」—— 再试一次，或看终端里它说了什么。"
        : `没问成：${result.reason}${result.detail ? `（${result.detail}）` : ""}`);
    } else if (!result.answered) {
      say(unansweredWords(result));
    } else if (!result.recorded) {
      say("没记下任何需求 —— 你按了 Esc，或者有必答的没填。");
    } else {
      /*
       * 录完之后**把人带回阶段环**，别留在一个已经被关掉的终端前面。
       *
       * 服务端在需求落库之后会关掉那个会话（它的活干完了，不关就一直挡着
       * 「跑这个阶段」）。但从人那边看，答完选择器紧接着屏幕就死了 —— 用户
       * 2026-07-30 报的「Terminal shut down / can't type anything」就是这个。
       * 事情是成的，观感是崩的。
       *
       * 所以主动走回环上，并把那个阶段的卡片打开：结论、以及现在亮起来的
       * 「跑这个阶段」，都在人的视线里。
       */
      briefLanded = true;
      const at = phases.find((entry) => entry.current)?.phase ?? null;
      await leave();
      if (at) {
        openSheet(at);
        say("需求记下了，那个终端的活也干完了（所以它关掉了）。"
          + "现在可以跑这个阶段 —— 红方会拿着你写的东西去做，而不是自己猜。");
      }
      return;   // leave() 已经 load() 过了
    }
  } finally {
    briefButton.textContent = "说清楚我要什么";
    if (!briefLanded) await loadOrReconnect();
  }
}

/**
 * 接受一条已知风险。
 *
 * 同样走选择器：选哪一条、写什么理由都在 Codex 里。这里没有、也不许有一个「直接
 * 接受」的按钮 —— 那就成了网页上的裁决入口（PRD §1）。
 */
async function waive() {
  waiveButton.disabled = true;
  waiveButton.textContent = "已送进终端…";
  try {
    const result = await (await dispatchThenEnter(() => fetch(
      `/api/waive?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    ))).json();
    const broke = crashed(result);
    if (broke !== null) {
      say(broke);
    } else if (!result.asked) {
      say(result.reason === "nothing_waivable"
        ? "这个阶段没有可以接受的风险（只有 P1 的问题可以，P0 不行）。"
        : `没问成：${result.reason}`);
    } else if (!result.answered) {
      say(unansweredWords(result));
    } else if (result.reason === "gate_moved") {
      say("闸门在你想的这段时间里动了 —— 这个决定作废，重新看一遍再定。");
    } else if (!result.waived) {
      say("没有接受任何风险 —— 你一条都没选、按了 Esc，或者名单在这期间变了。");
    } else {
      const ids = result.gapIds ?? [];
      say(`已接受 ${ids.length} 条：${ids.join("、")}。`
        + "它们还在，只是不再挡闸门，交付说明里会列出来。");
    }
  } finally {
    waiveButton.textContent = "接受风险";
    await loadOrReconnect();
  }
}

function placeNodes() {
  const radius = wrap.clientWidth * 0.40;
  // querySelectorAll 给的是 Element；只有 HTMLElement 才有 style。
  wrap.querySelectorAll(".stage-node").forEach((node) => {
    if (node instanceof HTMLElement) node.style.setProperty("--r", `${radius}px`);
  });
}

/*
 * ── 环上的地图（§5.9.3 / §5.9.4）────────────────────────────
 *
 * 用户 2026-08-04：「环的形状还是要的，只是不能暗示用户下个阶段一定是这个，
 * 可以用箭头指示，不管是向前还是跳转到别的阶段。」
 *
 * ## 三种东西，三种画法 —— 而且**不重复画**
 *
 * ```
 * 向前的历史   已经是那道进度弧了       这儿不画（画了就是同一件事说两遍）
 * 回头的历史   穿过中心的弦，实线永久     §5.9.3④：形状本身带语义
 * 自环的历史   节点圆的颜色深浅，越跑越深   §5.9.4；画在节点上（drawOrbit 的 --depth）
 * 能去的边     虚线 + 流动，随状态变      §5.9.3②：和历史必须一眼分得开
 * ```
 *
 * ## 边从哪来
 *
 * 历史来自 `panel.journey`（账本投影），能去的来自 `panel.options`（闸门长出来的）。
 * **两样都不在这儿算** —— 前端自己推第二份判据，就会画出闸门不认的箭头，那正是
 * 老树那五个死按钮的形状（§5.4）。
 */
/*
 * 环有多大。**这个数、CSS 的 `.halo/.progress { inset: 10% }`、placeNodes 的 0.40
 * 是同一件事的三处写法，改一处就要改三处。**
 *
 * 2026-08-09 从 45.5 收到 40：45.5 的环把节点顶到了栏的边上 —— 三点/九点方向的
 * 节点盘边离窗口只剩 5px，**周围根本没有地方放轨道和阶段名**。症状是火箭连着字
 * 一起飞、贴边那几个节点的轨道被窗口切掉。环小一档，节点周围才腾得出那圈地盘。
 */
const MAP_RADIUS = 40;

/** 第 n 个阶段在方格里的坐标。十二点起、顺时针 —— 和节点的摆法同一套。 */
function nodeAt(index, total) {
  const radians = (index / total) * Math.PI * 2;
  return {
    x: 50 + MAP_RADIUS * Math.sin(radians),
    y: 50 - MAP_RADIUS * Math.cos(radians),
  };
}

/*
 * ── 节点周围那一圈的地盘：**每次重画按真实像素量，不许写死** ──────
 *
 * 这里有一个会咬人的单位错配：
 *
 * ```
 * 节点圆      CSS 固定 56px（半径 28）      —— 像素
 * 阶段名      CSS 固定在圆心下 70px          —— 像素
 * 轨道 / 火箭 画在 viewBox 里                —— 100 分之一个环宽
 * ```
 *
 * 一个 viewBox 单位有多少像素**随环的大小变**（1280 宽的窗口上是 4.32px）。所以
 * 「节点圆半径是几个单位」不是常数：写死的那一版填的是 4.86，而实测是 6.48 ——
 * 火箭的「地表」因此落在节点圆**里面**，看起来是从盘子底下钻出来的；卫星的内道
 * 也正好骑在盘边上。同一批数在别的窗口尺寸下只会错得更多。
 *
 * `nodeGeometry()` 每次重画量一遍，下面所有半径都从它派生。**改 panel.html 里
 * 那两个 px 就要改这里的两个 px**，它们是同一件事的两半。
 */
const NODE_DISC_PX = 28;    // .stage-node button 是 56px 见方
const LABEL_TOP_PX = 52;    // .stage-node button span 的 top:80px 减去 button 的 -28px
const LABEL_BOTTOM_PX = 64; // 再加那行 12px 的字高
/** 火箭/卫星自己的径向半展（viewBox 单位，跟着 SCALE 走，与窗口大小无关）。 */
const GLYPH_RADIAL = 1.75;
/** 图形和盘边／字之间留的空气。 */
const GLYPH_AIR = 0.6;

/**
 * 上一次量到的「一个 viewBox 单位有多少像素」。
 *
 * **量不到时绝不能拿 100 当环宽兜底。** 那样 unit 变成 1，盘半径就成了 28 个
 * viewBox 单位（比整个环还大），轨道跟着膨胀 —— 2026-08-09 实测过一次：卫星
 * 直接飞到环外面去了。而量不到是常事：标签页在后台没绘制、环所在的那一栏正被
 * 切走，`clientWidth` 都会是 0。记住上一次的真值，下一次重画自己就纠正回来。
 */
let ringUnit = 4.3;

function nodeGeometry() {
  const measured = wrap.clientWidth / 100;
  if (measured > 0) ringUnit = measured;
  const unit = ringUnit;
  const disc = NODE_DISC_PX / unit;
  const label = LABEL_TOP_PX / unit;
  const surface = disc + GLYPH_RADIAL + GLYPH_AIR;   // 贴着盘边能飞的最内圈
  /*
   * 天花板按阶段名的**下沿**算，不是上沿。
   *
   * 节点那一层（盘 + 字）z-index 6，地图层是 auto —— 火箭是从字**背后**过去的，
   * 属于遮挡不是压字。按上沿算那一版把轨道带压到只剩 1.5 个单位：两颗卫星塞不下，
   * 螺旋也几乎不扩张，「越来越远」那句话就没了。让它飞到字的另一头，中间那一下
   * 是「钻到牌子后面」。
   */
  const ceiling = LABEL_BOTTOM_PX / unit - GLYPH_RADIAL - GLYPH_AIR;
  return { disc, label, surface, ceiling: Math.max(surface + 1.5, ceiling) };
}

function svgNode(tag, attributes, tooltip) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  if (tooltip) {
    // 理由挂在原生 tooltip 上：§5.0 第 4 条要的是「环那一屏不加东西」，而一条
    // 悬停才出现的说明不占版面 —— 但「每条边都说得出后果」这条不能少。
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = tooltip;
    element.append(title);
  }
  return element;
}


/** SMIL 不受 CSS 的 `animation: none` 管，所以每个造动画的函数都要自己问它。 */
const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * 绕着一个节点转一整圈的轨道，半径自己给。
 *
 * 「再来一轮」放**两枚火箭在两条不同半径的圈上**，周期还不一样 —— 用户
 * 2026-08-09：「小火箭不要追着，要在不同轨道」。同一条圈上前后跟两枚，读起来
 * 是排队；分层各转各的，读起来才是这个节点在自转。
 */
function circleAround(at, radius) {
  return `M ${at.x} ${at.y - radius} `
    + `A ${radius} ${radius} 0 1 1 ${at.x - 0.01} ${at.y - radius} Z`;
}

/*
 * ── 回跳 = 螺旋出轨 → 转移 → 螺旋入轨（用户 2026-08-09 定的设计语言，第五版）──
 *
 * 「就做到直接绕圈，但是绕圈的时候轨道要越来越远，降落的轨道越来越近直到着陆。」
 *
 * 火箭从 stage 圆的**边上**（nodeGeometry().surface，贴着盘边再留出自己半个身位）
 * 起旋，绕圈且一圈比一圈远，爬到 outerOrbit 切线脱离、走转移弦；到目的 stage 从
 * 外圈切入，绕圈且一圈比一圈近，贴回盘边。第四版在两端加了垂直起竖/降落的贝塞尔，
 * 被用户否掉 —— 那两笔和绕圈不是一种语言，还会甩出难看的尖刺。
 *
 * ringPoint 的参数角和 nodeAt 同一套：0 = 正上方，顺时针增，速度方向恰好是
 * (cos a, sin a) —— 螺旋、贝塞尔连成一笔，rotate="auto" 全程不跳。
 */
const ORBIT_TURNS = 2;      // 两端各绕两圈
const ROCKET_SCALE = 1.45;  // 剪纸版比原来的细描边壳大一号，形状才读得出来
const SATELLITE_SCALE = 1.4;    // 摊平之后径向只占 1.8，放得大才认得出是卫星
/**
 * 允许溢出 viewBox 的那一点点。
 *
 * **实测**（2026-08-09，1280 宽窗口）：环那一格的右边界在 1266px、窗口 1280px，
 * 也就是 viewBox 只铺得到 x≈103.2；`overflow` 一路都是 visible，裁掉火箭的不是
 * CSS 而是**窗口边缘**。3 是留够安全的溢出量。
 */
const ORBIT_BLEED = 3;

/**
 * 这个节点的外圈能放多大。**两条上限，取小的那条**：
 *
 * - 阶段名那行字（`nodeGeometry().ceiling`）—— 越过去火箭就从字上飞过；
 * - 到 viewBox 边的余量 —— 越过去火箭飞出窗口不见（三点/九点那两个节点只剩 4.5）。
 *
 * 地板是「贴着盘边能飞的最内圈」再往外一点，否则「越来越远」这句话就没了。
 */
function outerOrbit(at) {
  const geo = nodeGeometry();
  // 余量要**减掉火箭自己的半展**：路径在界内不等于图形在界内。
  const room = Math.min(at.x, 100 - at.x, at.y, 100 - at.y) + ORBIT_BLEED - GLYPH_RADIAL;
  return Math.max(geo.surface + 1.5, Math.min(geo.ceiling, room));
}

/** centre 半径 radius 的圆上参数角 a 处的点。 */
function ringPoint(centre, radius, a) {
  return { x: centre.x + radius * Math.sin(a), y: centre.y - radius * Math.cos(a) };
}

/**
 * 绕 centre 从角 aStart 顺时针扫过 sweep 弧度的**螺旋**，半径由 r0 线性到 r1。
 *
 * SVG 没有螺旋原语，切成 ≤90° 一段的三次贝塞尔逼近。每段的控制点长度是
 * `(4/3)·tan(θ/4)·r`（θ=90° 时正好是那个眼熟的 0.5523）—— 按实际步长算，
 * 不是拿 90° 的常数硬套，否则非整圈的那一段会鼓出去。
 *
 * **扫角是任意的，不必是整圈**：回程要从「上一段结束的那个角」转到「转移弦要求
 * 的那个角」，差多少补多少，路径才接得上（见 rocketFlight）。每个接缝两侧的切向
 * 都是纯周向，拼起来 G1 连续，看不出段。
 */
function spiralArc(centre, aStart, sweep, r0, r1) {
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  let d = "";
  for (let i = 0; i < steps; i += 1) {
    const a0 = aStart + i * step;
    const a1 = a0 + step;
    const rA = r0 + (r1 - r0) * (i / steps);
    const rB = r0 + (r1 - r0) * ((i + 1) / steps);
    const p0 = ringPoint(centre, rA, a0);
    const p3 = ringPoint(centre, rB, a1);
    const c1x = p0.x + k * rA * Math.cos(a0);
    const c1y = p0.y + k * rA * Math.sin(a0);
    const c2x = p3.x - k * rB * Math.cos(a1);
    const c2y = p3.y - k * rB * Math.sin(a1);
    d += `C ${c1x} ${c1y} ${c2x} ${c2y} ${p3.x} ${p3.y} `;
  }
  return d;
}

/*
 * ── 禁飞区（用户 2026-08-09：「小火箭绝对不能穿过任何 stage 和太阳」）──
 *
 * 这是**路径中心线**的禁入半径，所以要把火箭自己的身长算进去：剪纸火箭缩放后
 * 从头到尾约 5.6，半身 2.8。
 *
 * 太阳是环宽的百分比（`.sun` 占 21% → 半径 10.5，光芒到 9.2），所以它可以是常数；
 * **别的 stage 不行** —— 节点圆是固定 56px，换算成 viewBox 单位随窗口变，只能问
 * `nodeGeometry()`。写死 10 那一版在 1280 宽的窗口上就已经比真值小了一圈。
 *
 * 螺旋段天生安全，不用查：它绕着自己那个节点转，最远也就十几个单位 —— 离环心还有
 * 三十多，离最近的邻居还有二十多。会闯祸的只有两条转移弦。
 */
const SUN_KEEPOUT = 15.5;
const KEEPOUT_AIR = 2.3;
const nodeKeepout = () => nodeGeometry().disc + 2.8 + KEEPOUT_AIR;

/**
 * 转移弦的控制点：摆在两点角平分线上，**深度选到让曲线中点正好落在 lane 上**。
 *
 * 二次贝塞尔在 t=0.5 的径向分量是 `0.5·R·cos(Δ/2) + 0.5·Rc`，令它等于 lane 就
 * 解出 `Rc = 2·lane − R·cos(Δ/2)`。Rc 允许是负的 —— 那表示控制点翻到角平分线的
 * 反侧，曲线照样被拉到 lane 那么深，公式不用分情况。
 *
 * 有了这个，「转移弦有多深」就是一个可以直接说出口的数，而不是一个弯度系数的
 * 副作用 —— 躲太阳、躲别的 stage 才有得调。
 */
function transferApex(fromIndex, toIndex, total, lane) {
  const step = (Math.PI * 2) / total;
  let delta = (toIndex - fromIndex) * step;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  return ringPoint(
    { x: 50, y: 50 },
    2 * lane - MAP_RADIUS * Math.cos(delta / 2),
    fromIndex * step + delta / 2,
  );
}

/**
 * 这条转移弦躲不躲得开太阳和 `blocked` 里那些 stage。采样查，别推公式。
 *
 * **60 个采样点不是随便取的。** 25 点那一版实测漏过一条：真实最小余量 8.98，
 * 而它在采样点上量到的都 ≥ 9，于是放行 —— 采样太疏就是这么骗人的。
 */
function transferClears(p0, apex, p1, blocked) {
  const keepout = nodeKeepout();
  for (let i = 0; i <= 60; i += 1) {
    const t = i / 60;
    const u = 1 - t;
    const x = u * u * p0.x + 2 * u * t * apex.x + t * t * p1.x;
    const y = u * u * p0.y + 2 * u * t * apex.y + t * t * p1.y;
    if (Math.hypot(x - 50, y - 50) < SUN_KEEPOUT) return false;
    for (const node of blocked) {
      if (Math.hypot(x - node.x, y - node.y) < keepout) return false;
    }
  }
  return true;
}

/**
 * 从几条候选内道里挑第一条**飞得过去**的。
 *
 * 转移弦的两头不是节点圆心，是各自轨道上的切点，而切点又由控制点定 —— 所以
 * 每条候选都得按 rocketFlight 里同一套算出真实两头再查，不能拿圆心糊弄。
 *
 * 一条都不过就用最后一条（最深的那条）：那时候环上大概率是别的地方出了问题，
 * 让它贴着太阳飞也比不画强 —— 但候选表要保证正常拓扑下第一条就过。
 */
function safeApex(from, to, candidates, blocked) {
  const outFrom = outerOrbit(from);
  const outTo = outerOrbit(to);
  for (const apex of candidates) {
    const aD = Math.atan2(apex.y - from.y, apex.x - from.x);
    const aA = Math.atan2(to.y - apex.y, to.x - apex.x);
    if (transferClears(
      ringPoint(from, outFrom, aD), apex, ringPoint(to, outTo, aA), blocked,
    )) return apex;
  }
  return candidates[candidates.length - 1];
}

/** 把角度归一化到 [0, 2π) —— 补角用，别让它算出负的扫角把螺旋倒着画。 */
function wrapAngle(radians) {
  const turn = Math.PI * 2;
  return ((radians % turn) + turn) % turn;
}

/**
 * 整条飞行路线的 `d` —— **一次完整的往返，六段**（用户 2026-08-09 第六次拍板）。
 *
 * ```
 * ① 起点地表 → 螺旋升到起点轨道
 * ② 转移到目标轨道（向心弯的弦）
 * ③ 螺旋降到目标地表
 * ④ 螺旋从目标地表再升回目标轨道
 * ⑤ 转移回起点轨道（弦的另一侧，不是原路）
 * ⑥ 螺旋降回起点地表 —— 正好是 ① 的出发点，闭环
 * ```
 *
 * 上一版的回程是从目标**地表直接拉一条线**回起点地表 —— 用户原话：「你是直接从
 * 球里出来，那是不对的，两个都是有轨道的过程」。去和回是对称的两趟任务，不是一趟
 * 任务加一条捷径。
 *
 * ## 角度怎么接上
 *
 * 转移弦的两头要和螺旋相切，切点的角度是弦自己定的（`atan2`），而螺旋走完整圈会
 * 回到原角。所以 ①③ 走整圈就够；**④⑥ 要在整圈之外补上一个差角** —— 从「上一段
 * 停在的角」补到「这一段的弦要求的角」。补角用 `wrapAngle` 取正值：取负会让螺旋
 * 倒着画，路径当场自交。
 *
 * 闭环的额外好处：**没有瞬移，也就不需要淡出**，`repeatCount=indefinite` 接得严丝
 * 合缝。匀速跑（paced）不需要分段路程，所以只回一个字符串。
 */
function rocketFlight(from, to, apexOut, apexBack) {
  const outFrom = outerOrbit(from);   // 两头各按自己的余量放大，贴边的收窄
  const outTo = outerOrbit(to);
  const surface = nodeGeometry().surface;
  const aD = Math.atan2(apexOut.y - from.y, apexOut.x - from.x);   // 去程出轨角
  const aA = Math.atan2(to.y - apexOut.y, to.x - apexOut.x);       // 去程入轨角
  const bD = Math.atan2(apexBack.y - to.y, apexBack.x - to.x);     // 回程出轨角
  const bA = Math.atan2(from.y - apexBack.y, from.x - apexBack.x); // 回程入轨角
  const full = ORBIT_TURNS * 2 * Math.PI;

  const pad = ringPoint(from, surface, aD);       // ① 的起点，也是 ⑥ 的终点
  const arrive = ringPoint(to, outTo, aA);
  const back = ringPoint(from, outFrom, bA);

  return `M ${pad.x} ${pad.y} `
    + spiralArc(from, aD, full, surface, outFrom)
    + `Q ${apexOut.x} ${apexOut.y} ${arrive.x} ${arrive.y} `
    + spiralArc(to, aA, full, outTo, surface)
    + spiralArc(to, aA, full + wrapAngle(bD - aA), surface, outTo)
    + `Q ${apexBack.x} ${apexBack.y} ${back.x} ${back.y} `
    + spiralArc(from, bA, full + wrapAngle(aD - bA), outFrom, surface)
    + "Z";
}

/*
 * 转移弦想走的深度（**首选**，不是唯一选择）。
 *
 * 回跳挖得深（去 22 / 回 30）：那是「穿过环内回头」；推进走得浅（去 34 / 回 26）：
 * 那是「沿着环往前」。同一趟里去和回不同深度，两条道就分得开，不会看成原路折返。
 */
const TRANSFER_LANES = {
  backwardOut: 22, backwardHome: 30,
  forwardOut: 34, forwardHome: 26,
};
/** 安全带：太阳那头进不去，节点那头（环在 40）也贴不上。 */
const LANE_MIN = 12;
const LANE_MAX = 36;

/**
 * 候选深度，**按离首选的远近排**：先试首选，不行就往两边一格一格挪。
 *
 * 手写五个数那一版栽在对径跳上：回程那串最深只到 18，而实测那个方向要 16 以内
 * 才躲得开两个邻居 —— 五条全不过，`safeApex` 只好用最后一条，余量 10.95 < 11.61。
 * 排成阶梯就不会再有「表里正好没有那一档」这种事。
 */
function laneLadder(preferred) {
  const lanes = [];
  for (let step = 0; step <= LANE_MAX - LANE_MIN; step += 2) {
    if (preferred + step <= LANE_MAX) lanes.push(preferred + step);
    if (step > 0 && preferred - step >= LANE_MIN) lanes.push(preferred - step);
  }
  return lanes;
}

/**
 * 把「哪两个节点、哪种边」翻成 `rocketFlight` 要的四个参数，顺带**挑一条飞得过去
 * 的内道** —— 用户 2026-08-09：「小火箭绝对不能穿过任何 stage 和太阳」。
 *
 * 挡路的名单是**除这两头之外的所有节点**：自己那两个不算，火箭本来就要绕着它们
 * 转。太阳是所有边都要躲的，写在 transferClears 里。
 */
function tripArgs(fromIndex, toIndex, total, backward) {
  const from = nodeAt(fromIndex, total);
  const to = nodeAt(toIndex, total);
  const blocked = phases
    .map((entry, index) => index)
    .filter((index) => index !== fromIndex && index !== toIndex)
    .map((index) => nodeAt(index, total));
  const lanes = laneLadder(backward ? TRANSFER_LANES.backwardOut : TRANSFER_LANES.forwardOut);
  const homeLanes = laneLadder(backward ? TRANSFER_LANES.backwardHome : TRANSFER_LANES.forwardHome);
  return [
    from,
    to,
    safeApex(from, to, lanes.map((lane) => transferApex(fromIndex, toIndex, total, lane)), blocked),
    safeApex(to, from, homeLanes.map((lane) => transferApex(toIndex, fromIndex, total, lane)), blocked),
  ];
}


/**
 * 剪纸小火箭，头朝 +x、原点在箭身中心 —— rotate="auto" 才能让它顺着路径扭。
 *
 * **和太阳同一种语言**（用户 2026-08-09：「整体风格统一一下」）：平涂的色块、
 * 没有描边、窗户是挖空的一个洞。上一版是细描边的空心壳，那是给环上那些发丝
 * 线条配的；线全撤掉、环心又放了一颗剪纸太阳之后，它成了屏幕上唯一一个还在说
 * 旧方言的东西。
 *
 * **不给它挂 tooltip。** 试过把 `edge.why` 挂在这儿，但 `.orbit-map` 整层是
 * `pointer-events: none`，那个 `<title>` 谁也悬停不到 —— 一个装作能用的东西。
 * 回跳能不能走、为什么，左边那块常驻面板的「闸门」那行已经在说了。
 */
function rocketGlyph(className) {
  /*
   * 两层 g 是**必须的**：外层归 `animateMotion` 用（它自己往上写 transform），
   * 内层放缩放。写在同一个 g 上会被 animateMotion 的 transform 顶掉，火箭就回到
   * 原始尺寸 —— 而原始尺寸是照着细描边那一版定的，填色之后小得看不出形状。
   */
  const rocket = svgNode("g", { class: className });
  const shell = svgNode("g", { transform: `scale(${ROCKET_SCALE})` });
  /*
   * 叠放顺序就是剪纸的贴纸顺序：火苗在最底下，然后两片鳍，再盖上机身，最后挖窗。
   * 第一版把火苗贴在最上面，它压在机身尾巴上；而火苗和鳍又同一个橙 —— 两样东西
   * 糊成一整块楔形，看不出哪是鳍哪是火。现在火苗**更亮更黄**（和太阳的脸同族）
   * 且从鳍后面探出去，一眼分得开。
   */
  const flame = svgNode("path", {
    class: "flame",
    d: "M -1.0 -0.3 C -1.7 -0.22 -2.35 -0.08 -2.35 0 C -2.35 0.08 -1.7 0.22 -1.0 0.3 Z",
  });
  if (!reducedMotion()) {
    const flicker = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    flicker.setAttribute("attributeName", "opacity");
    flicker.setAttribute("values", "1;.35;1");
    flicker.setAttribute("dur", "0.55s");
    flicker.setAttribute("repeatCount", "indefinite");
    flame.append(flicker);
  }
  shell.append(
    flame,
    svgNode("path", {
      class: "fin",
      d: "M -0.26 -0.54 L -1.16 -1.2 L -0.98 -0.32 Z M -0.26 0.54 L -1.16 1.2 L -0.98 0.32 Z",
    }),
    svgNode("path", {
      class: "body",
      d: "M 1.39 0 C 1.01 -0.71 0.26 -0.79 -0.86 -0.59 L -0.86 0.59 C 0.26 0.79 1.01 0.71 1.39 0 Z",
    }),
    svgNode("circle", { class: "port", cx: 0.38, cy: 0, r: 0.32 }),
  );
  rocket.append(shell);
  return rocket;
}

/**
 * 剪纸小卫星：中间一个机身，上下伸出两片太阳能板，前头一盏信标灯。
 *
 * **「再来一轮」是绕着自己转，那是卫星干的事**（用户 2026-08-09）。火箭要点火、
 * 要变轨，它属于跨阶段那趟旅行；一个原地打转的阶段配的是一颗待在那儿一圈一圈
 * 绕的卫星。所以它没有尾焰，改成信标灯一明一暗 —— 会动，但不是在推进。
 *
 * `rotate="auto"` 让机身始终朝切线、板子朝径向，正好是真卫星对地定向的姿态，
 * 不用另外算。两层 g 的理由和火箭那边一样：外层归 animateMotion，内层放缩放。
 */
function satelliteGlyph() {
  const sat = svgNode("g", { class: "sat" });
  const shell = svgNode("g", { transform: `scale(${SATELLITE_SCALE})` });
  const beacon = svgNode("circle", { class: "beacon", cx: 0, cy: 0.66, r: 0.26 });
  if (!reducedMotion()) {
    const blink = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    blink.setAttribute("attributeName", "opacity");
    blink.setAttribute("values", "1;.2;1");
    blink.setAttribute("dur", "1.9s");
    blink.setAttribute("repeatCount", "indefinite");
    beacon.append(blink);
  }
  /*
   * **板子沿飞行方向左右展开，不是径向立着。**
   *
   * 立着那一版径向要占 3.4 个单位，而正轴那四个节点从地表到轨道只剩 2.6 —— 放大
   * 到读得出形状就会压到节点圆，不放大就是一个 14px 的橙点，谁也认不出是卫星。
   * 摊平之后径向只占 1.8，可以放大到 22px 长，塞进那条窄缝还有富余。真卫星侧视
   * 本来也是这个样子。
   *
   * 桁架用**机身那个奶油色**，不是板子的橙：三样都是橙的时候整枚糊成一条，
   * 现在读起来是「机身两边各伸一根支架挑着一片板」。
   *
   * 碟子朝 local +y。`rotate="auto"` 之下 local +y 正好指向节点圆心 —— 对地定向，
   * 不用另外算。
   */
  shell.append(
    svgNode("path", {
      class: "boom",
      d: "M 0.5 -0.08 L 1.0 -0.08 L 1.0 0.08 L 0.5 0.08 Z"
        + " M -1.0 -0.08 L -0.5 -0.08 L -0.5 0.08 L -1.0 0.08 Z",
    }),
    svgNode("path", {
      class: "panel",
      d: "M 0.98 -0.62 L 1.86 -0.62 L 1.86 0.62 L 0.98 0.62 Z"
        + " M -1.86 -0.62 L -0.98 -0.62 L -0.98 0.62 L -1.86 0.62 Z",
    }),
    svgNode("path", {
      class: "body",
      d: "M -0.5 -0.42 L 0.3 -0.42 Q 0.54 -0.42 0.54 -0.18 L 0.54 0.18"
        + " Q 0.54 0.42 0.3 0.42 L -0.5 0.42 Z",
    }),
    beacon,
  );
  sat.append(shell);
  return sat;
}

/**
 * 让火箭骑上飞行路径，**从头到尾一个速度**。
 *
 * 用户 2026-08-09 第四次看后定的：「小火箭不要急停，线性的速度变化」。前一版
 * 用 keyPoints + keySplines 分段调速（起旋慢／转移快／着陆前收），再抱着终点
 * 停 16% 的时长 —— 那个停顿就是「急停」，而分段无论怎么配缓动，交接处总归是
 * 人眼看得出的换挡。
 *
 * 现在什么都不设：`animateMotion` 的默认 calcMode 是 **paced**，按弧长匀速走完
 * 整条路。没有 keyPoints 就没有档可换，也没有终点那一拍停顿。
 *
 * 路线都是闭环（去了要回来），所以**连淡入淡出也不需要了** —— 起点就是终点，
 * 一圈接一圈接得严丝合缝。上一版靠 opacity 抹掉单程的瞬移，那笔现在是多余的。
 */
function rocketRide(rocket, pathId, seconds) {
  const motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
  motion.setAttribute("rotate", "auto");
  const mpath = document.createElementNS("http://www.w3.org/2000/svg", "mpath");
  mpath.setAttribute("href", `#${pathId}`);
  mpath.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${pathId}`);
  motion.append(mpath);
  if (reducedMotion()) {
    // 停在路径起点，朝向仍由 rotate="auto" 给出。这一支要 keyPoints，
    // 所以它（也只有它）得把 calcMode 从默认的 paced 掰回 linear。
    motion.setAttribute("calcMode", "linear");
    motion.setAttribute("dur", "1s");
    motion.setAttribute("repeatCount", "1");
    motion.setAttribute("fill", "freeze");
    motion.setAttribute("keyPoints", "0;0");
    motion.setAttribute("keyTimes", "0;1");
    rocket.append(motion);
    return rocket;
  }
  motion.setAttribute("dur", `${seconds}s`);
  motion.setAttribute("repeatCount", "indefinite");
  rocket.append(motion);
  return rocket;
}

function drawMap(panel) {
  const map = pick("orbit-map");
  map.replaceChildren();
  const total = phases.length;
  const indexOf = (phase) => phases.findIndex((entry) => entry.phase === phase);

  /*
   * ① 走过的回头路：**一条线都不画**（用户 2026-08-09：「轨道不要画出来」）。
   *
   * 先前留过一条全透明的粗描边当 hover 命中区，好把「第几轮、什么理由」保在
   * tooltip 上。撤掉了，两个理由：看不见的悬停目标没人找得到；而它那条弦正好
   * 横穿环心，会把太阳的点击吃掉 —— 而太阳现在是**要点的**。
   *
   * 这一趟历史唯一的去处是幽灵火箭：最近一跳由它重飞。Fix 不在环上时 indexOf
   * 找不到，跳过就是了，不去猜一个坐标。
   */
  let lastTrip = null;   // 最近一次认得出的回跳 —— 幽灵火箭要重飞它
  /*
   * ── 彗星：旁路会话（用户 2026-08-11 定的画法）─────────────────
   *
   * 旁路不属于任何阶段 —— 它原来混在左侧那堆**跟着当前 stage 刷新**的按钮里
   * （和「跑这个阶段」「结束这个终端」并列），读起来像是某个阶段的一个动作，
   * 而它恰恰是唯一不占任何阶段座位的东西。
   *
   * 彗星说对了三件事：**不在任何一条轨道上**（一个倾斜的真椭圆，和阶段那个
   * 正圆一眼分得开）、**能到达环上任何地方**、**它留下尾迹**（动过手的那几趟
   * 在账本里，`panel.aside.touched`）。
   *
   * ## 几何是量出来的，不是拍的（2026-08-11 在真面板上量）
   *
   * ```
   * 太阳（含日冕）半径 ≈ 9.7   →  椭圆短半轴不许小于 15
   * 节点圆半径 6，圆心在 45.5  →  节点内缘 39.5，长半轴不许大于 37
   * ```
   *
   * 第一版写的是 46×30，两头都撞（穿太阳、压 stage）—— 这两个数是实测的安全带，
   * 改之前先重新量，别照着 viewBox 猜。
   *
   * ## 倾角按 Change 的 id 定
   *
   * 用户要「随机一点」，但随机不能是每次刷新都换一个角度 —— 那样环会在人眼前
   * 自己转。取 id 的哈希：同一个 Change 永远同一条轨道，不同的 Change 各不相同。
   */
  const ASIDE_A = 36;    // 长半轴（< 39.5，不碰节点）
  const ASIDE_B = 17;    // 短半轴（> 9.7 的日冕，留足余量）
  const aside = panel.aside ?? { visits: 0, touched: 0, lastNote: null };
  const tilt = ((() => {
    let hash = 0;
    for (const ch of String(panel.changeId ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return hash;
  })() / 360) * Math.PI - Math.PI / 2;
  const end = (sign) => ({
    x: 50 + sign * ASIDE_A * Math.cos(tilt),
    y: 50 + sign * ASIDE_A * Math.sin(tilt),
  });
  const [a1, a2] = [end(-1), end(1)];
  const deg = (tilt * 180) / Math.PI;
  // 两段半弧拼成一个**完整的椭圆**（第一版是一段起终点几乎重合的弧，收口处有个尖角）。
  const cometPath = `M ${a1.x} ${a1.y} A ${ASIDE_A} ${ASIDE_B} ${deg} 1 0 ${a2.x} ${a2.y}`
    + ` A ${ASIDE_A} ${ASIDE_B} ${deg} 1 0 ${a1.x} ${a1.y}`;
  const cometId = "map-comet";
  const cometTip = aside.touched > 0
    ? `旁路：来过 ${aside.visits} 趟，其中 ${aside.touched} 趟动过手`
      + (aside.lastNote ? `\n最近一趟：${aside.lastNote}` : "")
    : `旁路（点开一个不属于任何阶段的窗口）${
      aside.visits > 0 ? `\n来过 ${aside.visits} 趟，都只是聊过` : ""}`;
  map.append(svgNode("path", { id: cometId, class: "comet-orbit", d: cometPath }));
  /*
   * **点得中是这颗彗星能用的前提。** 第一版把点击挂在那条 0.3 宽的虚线上，
   * 而且只有彗星头（r=0.62）—— 一个在动的、比光标还小的目标。
   * 现在两处都能点：一条透明的粗描边罩着整条轨道，外加彗星自己带一个大命中圈。
   */
  const hit = svgNode("path", { class: "comet-hit", d: cometPath }, cometTip);
  hit.addEventListener("click", () => { void openAside(); });
  map.append(hit);
  /*
   * 彗星本身：**核 + 彗发 + 散开的尾**，三层。
   *
   * 第一版是「一个圆点拖一条直线」，用户判丑，判得对 —— 那不是彗星的样子。
   * 真彗星的尾从核那头细、往远处**发散**并淡掉，核外面裹着一层彗发（coma）。
   * 三层各干各的：尾给方向和速度感，彗发给「它在发光」，核给一个准确的位置。
   *
   * 命中用的那个圈**完全透明** —— 第一版给了它 .06 的填充，于是环上多出一个
   * 说不出所以然的浅色圆盘，正是丑的一半。它是命中区，不是画面的一部分。
   */
  // 尾巴长度：动过手越多越长，四趟封顶 —— 再长会绕到轨道另一头，读起来就不是尾巴了。
  const tail = 6 + 4 * Math.min(aside.touched, 4) / 4;
  const grad = svgNode("defs", {});
  /*
   * **模糊是这颗彗星好看不好看的分水岭。**
   *
   * 前两版一版实心锥（像探照灯）、一版四条线（像梳子）—— 病根都一样：
   * path 的边是硬的，而彗尾是发光的雾，它根本没有边。一个高斯模糊比任何
   * 形状上的功夫都管用；形状只要给个大概的走向，剩下的交给它。
   */
  const blur = svgNode("filter", {
    id: "comet-glow", x: "-60%", y: "-60%", width: "220%", height: "220%",
  });
  blur.append(svgNode("feGaussianBlur", { stdDeviation: "0.42" }));
  const tailGrad = svgNode("linearGradient", {
    id: "comet-tail-grad", x1: "1", y1: "0", x2: "0", y2: "0",
  });
  tailGrad.append(
    svgNode("stop", { offset: "0", "stop-color": "#e8f4ff", "stop-opacity": ".5" }),
    svgNode("stop", { offset: ".35", "stop-color": "#bcd9ff", "stop-opacity": ".26" }),
    svgNode("stop", { offset: "1", "stop-color": "#89b6ff", "stop-opacity": "0" }),
  );
  const comaGrad = svgNode("radialGradient", { id: "comet-coma-grad" });
  comaGrad.append(
    svgNode("stop", { offset: "0", "stop-color": "#ffffff", "stop-opacity": ".85" }),
    svgNode("stop", { offset: ".4", "stop-color": "#d8ecff", "stop-opacity": ".35" }),
    svgNode("stop", { offset: "1", "stop-color": "#8fc0ff", "stop-opacity": "0" }),
  );
  grad.append(blur, tailGrad, comaGrad);
  map.append(grad);

  const comet = svgNode("g", { class: "comet" });
  /*
   * 尾巴是**几缕散开的丝**，不是一个实心的锥。
   *
   * 第一版画了个对称的梯形加渐变，放大看是一束探照灯 —— 实心、对称、张角大，
   * 末端还留着一条硬边。真彗尾没有边界，它是几缕亮度不等的流，越远越散。
   * 细线也更贴这一屏已有的笔法：火箭、卫星、V 字都是描边画的，只有太阳是实心。
   *
   * 四缕的长度、张角、亮度都不一样 —— 一模一样的四条会读成一把梳子。
   */
  const wide = tail * 0.26;
  const fog = svgNode("g", { class: "comet-fog", filter: "url(#comet-glow)" });
  fog.append(
    /*
     * 尾的主体：一片**不对称**的雾。两侧张得不一样开（真彗尾受太阳风吹，
     * 从来不是轴对称的），末端斜着收，靠模糊和渐变一起化掉，不留边。
     */
    svgNode("path", {
      class: "comet-tail",
      d: `M -0.4 -0.32`
        + ` C ${-tail * 0.32} ${-wide * 0.5} ${-tail * 0.68} ${-wide * 0.82} ${-tail} ${-wide}`
        + ` L ${-tail * 0.92} ${wide * 1.25}`
        + ` C ${-tail * 0.55} ${wide * 0.86} ${-tail * 0.22} ${wide * 0.4} -0.4 0.36 Z`,
    }),
    // 两缕更亮的流，压在雾上 —— 彗尾里总有几条更密的。
    svgNode("path", {
      class: "comet-strand", "stroke-opacity": ".5",
      d: `M -0.5 -0.06 Q ${-tail * 0.45} ${-wide * 0.34} ${-tail * 0.96} ${-wide * 0.72}`,
    }),
    svgNode("path", {
      class: "comet-strand", "stroke-opacity": ".3",
      d: `M -0.5 0.1 Q ${-tail * 0.4} ${wide * 0.45} ${-tail * 0.8} ${wide * 0.95}`,
    }),
    svgNode("circle", { class: "comet-coma", cx: 0, cy: 0, r: 2.1 }),
  );
  comet.append(fog);
  // 核不进模糊：整颗彗星只有这一点是锐的，位置才说得准。
  comet.append(svgNode("circle", { class: "comet-core", cx: 0, cy: 0, r: 0.62 }));
  const halo = svgNode("circle", { class: "comet-halo", cx: 0, cy: 0, r: 4.5 }, cometTip);
  halo.addEventListener("click", () => { void openAside(); });
  comet.append(halo);
  if (aside.touched > 0) comet.classList.add("marked");
  map.append(rocketRide(comet, cometId, 55));

  for (const jump of panel.journey ?? []) {
    if (jump.kind !== "backward") continue;
    const from = indexOf(jump.fromPhase);
    const to = indexOf(jump.toPhase);
    if (from < 0 || to < 0) continue;
    lastTrip = { from, to };
  }

  /*
   * **幽灵火箭：最近一跳定期重飞**（用户 2026-08-09 第二次拍板）。
   *
   * 回跳选项开着的时刻很短，只给活边配火箭的话，它 99% 的时间没有出场机会 ——
   * 用户第一眼就问「火箭怎么没有」。所以病历的最后一笔由一枚淡一级的火箭
   * 循环重演，环上随时看得到「它是怎么回去的」；更老的账保持静态，环不变机场。
   *
   * 路径本身不画（rail）。周期和活边那枚（22s）故意不整除，两枚就算同路也不会
   * 长期同相叠住 —— 叠住看起来只有一枚，那是白飞。
   */
  if (lastTrip !== null) {
    map.append(svgNode("path", {
      id: "map-ghost",
      class: "rail",
      d: rocketFlight(...tripArgs(lastTrip.from, lastTrip.to, total, true)),
    }));
    map.append(rocketRide(rocketGlyph("rocket ghost"), "map-ghost", 27));
  }

  /*
   * ② 每个节点跑过几轮 —— 不在这儿画。轮数是**节点圆自己的颜色深浅**
   * （§5.9.4，2026-08-09 从分段刻度改过来的），在 drawOrbit 里以 `--depth`
   * 写到节点上，精确数字挂在节点的 tooltip 上。
   */

  /*
   * ③ **正在跑的阶段：卫星绕着它转**（用户 2026-08-09：「在跑 Stage 的小卫星呢」）。
   *
   * 判据是 `entry.live` —— 那个阶段有活着的进程。卫星是「这儿正在干活」的状态灯，
   * 所以它跟着进程走，不跟着闸门的选项走。
   *
   * **遍历而不是只看 current**：并行座位可以同时有两个阶段在跑（BuildPlan∥TestPlan、
   * Build∥Test），两个都该有卫星。而且它必须排在下面那个「没有当前阶段就收工」的
   * 早返回**之前** —— 在跑就该看得见，跟环上有没有当前阶段无关。
   */
  phases.forEach((entry, index) => {
    if (!entry.live) return;
    drawSatellites(map, nodeAt(index, total), index);
  });

  /*
   * ④ 现在能去哪 —— **摆选项，不摆结论**（用户：一切都是由我来决定）。
   */
  const here = phases.findIndex((entry) => entry.current);
  if (here < 0) return;
  const from = nodeAt(here, total);
  panel.options?.forEach((edge, order) => {
    /*
     * 「再来一轮」这条自环**环上不画**。
     *
     * 它是一个**选项**（你可以让这个阶段再跑一次），而卫星说的是**状态**（这个
     * 阶段此刻正在跑）—— 见下面 ④。挂在这条选项上那一版把两者搞反了：闸门在等人
     * 裁决时卫星在转，真正在跑的时候环上反而一动不动（闸门 running 时 options
     * 是空的）。这条选项由左边那块面板的「闸门」那行和弹窗里的按钮说。
     */
    if (edge.kind === "self") return;
    const to = indexOf(edge.to);
    if (to < 0) return;
    const id = `map-live-${order}`;
    /*
     * 两种边共用同一趟**六段往返**（地表→轨道→转移→地表→轨道→转移→地表），
     * 差别只在两条转移弦怎么弯 —— 形状带语义那条没丢（§5.9.3④）：
     *
     *   回跳  去程向心弯的弦，回程翻到弦的另一侧
     *   推进  去程贴着环走，回程走环内 12 个单位的内道
     *
     * 跑道本身不画也不吃鼠标（`rail`）—— 用户要的是「轨道不要画出来」。
     */
    const back = edge.kind === "backward";
    map.append(svgNode("path", {
      id, class: "rail", d: rocketFlight(...tripArgs(here, to, total, back)),
    }));
    map.append(rocketRide(rocketGlyph("rocket"), id, back ? 22 : 18));
  });
}

/**
 * 一个阶段头上的卫星：两颗分处不同半径、周期还不整除，于是永远错开、永远不成
 * 队形 —— 排成一队跟飞读起来是「有个东西在爬」，分层各转各的读起来才是这个节点
 * 在自转。
 *
 * **地方不够就只放一颗。** 贴着 viewBox 边的那几个节点外圈被收窄，从盘边到轨道
 * 剩不下两条道 —— 硬塞两颗会叠在一起，那还不如一颗。
 */
function drawSatellites(map, at, key) {
  const outer = outerOrbit(at);
  const inner = nodeGeometry().surface;
  const room = outer - inner;
  const lanes = room >= 3.5
    ? [
        { radius: inner + room * 0.3, seconds: 6.5 },
        { radius: outer, seconds: 10 },
      ]
    : [{ radius: inner + room * 0.5, seconds: 8 }];
  lanes.forEach((lane, laneIndex) => {
    const id = `map-sat-${key}-${laneIndex}`;
    map.append(svgNode("path", {
      id, class: "rail", d: circleAround(at, lane.radius),
    }));
    map.append(rocketRide(satelliteGlyph(), id, lane.seconds));
  });
}

function drawOrbit() {
  wrap.querySelectorAll(".stage-node").forEach((node) => { node.remove(); });

  phases.forEach((entry, index) => {
    // Twelve o'clock first, clockwise, so PRD reads first.
    //
    // No -90 offset: the node is placed by rotating the frame and then moving
    // UP (translateY(-r)), so angle 0 already points at twelve o'clock.
    // Subtracting 90 here is the obvious-looking mistake -- it lands PRD at
    // nine o'clock, because it rotates "up" a quarter turn counter-clockwise.
    const angle = (index / phases.length) * 360;
    const node = document.createElement("div");
    // mark 放在最后，CSS 里对应的规则也排在 .bound / .live 之后 —— 一个阶段可以
    // 同时有线程、有进程、又被批准过，颜色以裁决为准。
    // parallel：这一格开着并行座位（批 4 的分叉）—— 环的形状不变（用户
    // 2026-08-09 拍：不要钻石画法，就要圆环），并行只用节点自己的记号说。
    node.className = "stage-node"
      + (entry.threadId ? " bound" : "")
      + (entry.live ? " live" : "")
      + (entry.seat ? " parallel" : "")
      + (entry.mark ? ` ${entry.mark}` : "");
    node.style.setProperty("--a", `${angle}deg`);

    /*
     * 跑过几轮 = 圆的颜色深浅（§5.9.4，2026-08-09 从分段刻度改过来的）。
     *
     * 0 轮就是底色；跑过至少一轮要**一眼看得出和没跑过不一样**，所以给个
     * 0.35 的地板，再往上按轮数爬，8 轮封顶（和刻度时代同一个上限 ——
     * 再深也深不出区别）。深浅数不出精确轮数，精确数字在 tooltip 上。
     */
    const rounds = entry.rounds ?? 0;
    node.style.setProperty("--depth",
      rounds === 0 ? "0" : String(0.35 + 0.65 * Math.min(rounds, 8) / 8));

    if (entry.current) node.classList.add("current");

    const status = statusOf(entry);
    const button = document.createElement("button");
    button.type = "button";
    button.title = (entry.threadId ? `线程 ${entry.threadId}` : "还没有线程")
      + (rounds > 0 ? `\n跑了 ${rounds} 轮` : "");

    const pip = document.createElement("i");
    const name = document.createElement("span");
    name.textContent = entry.phase;
    const state = document.createElement("em");
    state.textContent = entry.mark ? MARK[entry.mark].label : status.short;
    button.append(pip, name, state);

    // 悬停 → 左边那块常驻面板刷成这个阶段；离开所有节点 → 回到 Change 概览。
    // 点击 → 弹窗看明细。两层，不是二选一（交接 §5.0.2）。
    button.addEventListener("mouseenter", () => { hoverOn(entry.phase); });
    button.addEventListener("focus", () => { hoverOn(entry.phase); });
    button.addEventListener("mouseleave", hoverOff);
    button.addEventListener("blur", hoverOff);
    button.addEventListener("click", () => { openSheet(entry.phase); });

    node.append(button);
    wrap.append(node);
  });

  placeNodes();
}

/**
 * The two workspace columns.
 *
 * Selecting either one only narrows what is shown. It starts no turn and moves
 * no gate -- the design is explicit that picking a Project or a Change must
 * never change flow state.
 */
function drawWorkspace(panel) {
  const selected = panel.selectedProject
    ?? panel.changes.find((change) => change.id === panel.changeId)?.projectId
    ?? panel.projects[0]?.id;

  const projectRows = panel.projects.map((project) => {
    const row = document.createElement("button");
    row.className = "row";
    row.type = "button";
    row.setAttribute("aria-selected", String(project.id === selected));

    const name = document.createElement("strong");
    name.textContent = project.name;
    const sub = document.createElement("span");
    sub.textContent = project.id;
    const count = document.createElement("span");
    count.className = "muted";
    // **路径要看得见。** 一个项目最要紧的事实就是「Codex 会在哪跑」；不显示它，
    // 「跑在正确的仓库」和「跑在恰好启动时那个仓库」在界面上一模一样。
    count.textContent = project.path === null
      ? `${project.changes} changes · 没有路径，跑不了`
      : `${project.changes} changes · ${project.path}`;
    if (project.path === null) count.classList.add("bad");
    const remove = document.createElement("span");
    remove.className = "remove";
    remove.textContent = "\u00d7";
    remove.title = "删掉这个项目";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeThing("project", project.id,
        `连同它底下的 ${project.changes} 个 Change 全部删掉。`);
    });
    // 项目图谱（spec 2026-08-12）。项目级的入口，所以挂在项目行上 ——
    // 挂在 Change 底下是反的。纯读：点它不起进程、不写库。
    const graph = document.createElement("span");
    graph.className = "graph-open";
    graph.textContent = "◈ 图谱";
    graph.title = "看这个项目的代码长什么样";
    graph.addEventListener("click", (event) => {
      event.stopPropagation();
      openGraphView(project);
    });
    row.append(name, sub, count, graph, remove);

    // Clicking a project toggles the workspace open and shut. Picking a
    // DIFFERENT one selects it and opens; picking the one already selected
    // collapses down to just this Change's orbit.
    row.addEventListener("click", () => {
      if (project.id !== selected) {
        location.search =
          `?change=${encodeURIComponent(changeId)}&project=${encodeURIComponent(project.id)}`;
        return;
      }
      setCollapsed(!columns.classList.contains("collapsed"));
    });
    return row;
  });
  pick("projects").replaceChildren(...projectRows);
  pick("project-count").textContent =
    String(panel.projects.length).padStart(2, "0");

  const rows = panel.changes.map((change) => {
    const row = document.createElement("button");
    row.className = "row";
    row.type = "button";
    row.setAttribute("aria-selected", String(change.id === panel.changeId));
    const name = document.createElement("strong");
    name.textContent = change.title ?? change.id;
    const sub = document.createElement("span");
    sub.textContent = `${change.id} · ${change.phase} · ${change.status}`;
    const remove = document.createElement("span");
    remove.className = "remove";
    remove.textContent = "\u00d7";
    remove.title = "删掉这个 Change";
    remove.addEventListener("click", (event) => {
      // 不要顺带把这一行「选中」了 —— 点的是删除。
      event.stopPropagation();
      void removeThing("change", change.id,
        `连同它的全部 gap、判定、产物记录和账本一起删掉。`);
    });
    row.append(name, sub, remove);
    // Switching Change reloads with a new id; it starts nothing and moves no
    // gate, which is what the design says selection must never do.
    row.addEventListener("click", () => {
      location.search = `?change=${encodeURIComponent(change.id)}`;
    });
    return row;
  });
  pick("changes").replaceChildren(...rows);
  pick("change-count").textContent =
    String(panel.changes.length).padStart(2, "0");
  // Change 的标题现在是左侧常驻面板的默认标题，由 renderStatus(null) 写 —— 环那
  // 一屏上已经没有标题栏了（§5.0 第 1 条）。
}

/**
 * Open or shut the two workspace columns.
 *
 * The orbit is laid out from its container's size, and that size changes over
 * half a second, so the nodes are re-placed while the transition runs -- once at
 * the end would show them jump into position after the ring has finished moving.
 *
 * The state goes in the URL so a reload keeps it, and so a collapsed view can be
 * linked to. `replaceState` rather than a navigation: reloading the page here
 * would tear down every attached terminal to record a layout preference.
 */
function setCollapsed(collapsed) {
  columns.classList.toggle("collapsed", collapsed);

  const next = new URLSearchParams(location.search);
  if (collapsed) next.set("collapsed", "1");
  else next.delete("collapsed");
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);

  const until = Date.now() + 620;
  const settle = () => {
    placeNodes();
    if (current) void resize(current);
    if (Date.now() < until) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}

/**
 * 删掉一个 Change 或一个项目。
 *
 * **删除是不可逆的，所以先问一次** —— 而且把「会连带删掉什么」说出来，不是问一句
 * 干巴巴的「确定吗」。人点删除的时候想知道的正是这个。
 *
 * 服务端有活儿在跑时会拒（`phase_already_running`），那时照实说是什么在跑 ——
 * 「删不掉」和「删不掉因为那一轮还在跑」是两句话。
 */
async function removeThing(kind, id, what) {
  if (!window.confirm(`删掉 ${id}？\n\n${what}\n\n这一步不可逆。`)) return;
  const query = kind === "change" ? `change=${encodeURIComponent(id)}`
    : `project=${encodeURIComponent(id)}`;
  const result = await (await fetch(`/api/${kind}?${query}`, { method: "DELETE" })).json();
  if (!result.deleted) {
    window.alert(result.busy
      ? `删不掉：${result.changeId ?? id} 还有活儿在跑（${result.busy}）。等它跑完或先让它失败。`
      : `删不掉：${result.reason ?? "未知原因"}`);
    return;
  }
  // 删掉的可能正是当前这一个 —— 那就没有「留在原地」这回事了。
  location.search = "";
}

async function load() {
  const panel = await (await fetch(
    `/api/panel?change=${encodeURIComponent(changeId)}`
    + (projectParam ? `&project=${encodeURIComponent(projectParam)}` : ""))).json();
  phases = panel.phases;
  panelState = panel;
  // 一轮跑完文件就是新的了 —— 缓存活过 load() 会让人读到上一轮的产出。
  artifactCache.clear();
  drawWorkspace(panel);
  drawOrbit();
  drawMap(panel);

  drawProgress();
  renderStatus(null);
  // run / ask 走完都会 load()，闸门和问题可能已经变了 —— 弹窗还开着就重画它。
  if (sheetPhase) drawSheet(sheetPhase);

  /*
   * **一轮可能不是这个页面派出去的**：D 的「再来一轮」在 /api/ask 里就续跑了，
   * 而人也可能是跑到一半才打开这个页面。所以进度轮询由「库里是不是在跑」决定，
   * 不只由「我刚按过跑」决定。
   */
  if (panel.status === "running") startProgress();
  else stopProgress();
}

/**
 * §5.5.3 自愈：`load()` 挂了（最常见：面板正在重启的那几秒）不许让页面从此
 * 冻在旧状态 —— 原来一抛循环就死，服务器回来之后按钮不变灰、点了没反应、
 * 终端不动，人第一反应是「系统坏了」，而其实只差一次刷新。
 *
 * 所以：抓住、把失败原样说出来（不翻译 —— 它也可能是这一屏自己画不出来，
 * 那时原样的报错正是要给人看的）、按固定间隔重试，成的那一刻整屏刷新并说一声。
 */
const RELOAD_RETRY_MS = 2_000;
let reloadTimer = null;
async function loadOrReconnect() {
  try {
    await load();
    if (reloadTimer !== null) {
      clearInterval(reloadTimer);
      reloadTimer = null;
      say("面板回来了，这一屏已经刷新。");
    }
  } catch (error) {
    if (reloadTimer !== null) return; // 已经在重试了，别叠着说
    say(`这一屏刷新失败（${error?.message ?? error}）—— 会自动重试，`
      + "面板回来会自己刷新。");
    reloadTimer = setInterval(() => { void loadOrReconnect(); }, RELOAD_RETRY_MS);
  }
}

/**
 * 闸门里**要人裁决**的那几项。
 *
 * 只有这三个会被拿去问人。`start` / `settle` / `fail` 是系统在陈述发生了什么，
 * 所以一个只允许这些的闸门根本没有要人做的决定 —— 在那儿放出问人的按钮，会组出
 * 一道没有选项的题，然后回来一个 `no_decision_available`。
 * 这份名单和 domain/question.ts 里的 `gateDecisionQuestion` 是同一份。
 */
function decidableActions() {
  /*
   * **读服务端算好的那份边，不在这儿再筛一遍名单。**
   *
   * 原来这里写死 `approve / reject / retry` 三个 —— 于是 2026-08-05 加
   * `sendBack` 和 `rerun` 时它一个字都没跟上：一份漂开了的判据拷贝，而它决定
   * 「请 Codex 问我」这个按钮亮不亮。`options` 是 `optionsFrom` 从闸门长出来的
   * （panel-server），这里读它就永远不会和裁决表说两件事。
   */
  return (panelState?.options ?? []).map((edge) => edge.action);
}

/** 闸门此刻说了什么，一句话。只陈述，永远不提供改变它的控件。 */
function gateSentence() {
  const decidable = decidableActions();
  if (decidable.length === 0) {
    return (panelState?.gate?.permitted ?? []).length === 0
      ? "闸门没有可做的动作" : "现在没有要人裁决的事";
  }
  const refusal = panelState?.gate?.refusals?.approve;
  return `可裁决：${decidable.join(" / ")}`
    + (refusal ? `（approve 被拒：${refusal}）` : "");
}

const openGaps = (entry) => entry.gaps.filter((gap) => gap.status === "open");

/** 闸门拒人的理由，翻成人话。前三条对应 `domain/gate.ts` 的 RefusalReason。 */
const GATE_REFUSAL_WORDS = {
  blocking_problem_outstanding: "还有问题挡着闸门",
  nothing_was_produced: "这个阶段什么都没产出",
  not_legal_in_this_status: "现在这个状态不接受这个动作",
  // question-store 的那半个决定：裁决选了打回上游，目标那格却是「不打回」。
  no_target_chosen: "选了「打回上游」，但没选打回哪一份 —— 再裁一次，把那格也选上",
};

/**
 * 上次裁决的下场，翻成一句留得住的话（§3.2·5）。
 *
 * 只有被拒的下场要挂出来 —— 落地成功的那些，环上的标记已经在说了；给它们也挂
 * 一条横幅，警示色就不再意味着警示。null = 没什么要挂的。
 */
function lastOutcomeWords(outcome) {
  if (!outcome) return null;
  if (outcome.kind === "unanswered") {
    // 「没答上」也是下场（§3.2·5）—— 不写出来，一次静默流产的裁决就没有任何痕迹。
    const at = typeof outcome.at === "string"
      ? `（${new Date(outcome.at).toLocaleString()}）` : "";
    const why = {
      ask_turn_ended_without_answer: "Codex 跑完那一轮却没把问题端出来（补问过一次也一样）",
      session_died_before_answering: "那边的进程在你答之前就没了",
      session_died_before_asking: "会话在把题送进去之前就没了",
      no_answer_in_time: "等到超时也没人答",
    }[outcome.reason] ?? outcome.reason;
    return `⚠ 上次那道题没答上${at}：${why}。再点一次就重新问。`;
  }
  if (outcome.kind !== "refused") return null;
  const reason = GATE_REFUSAL_WORDS[outcome.reason] ?? outcome.reason;
  const at = typeof outcome.at === "string"
    ? `（${new Date(outcome.at).toLocaleString()}）` : "";
  return `⚠ 上次裁决被闸门拒了${at}：「${outcome.action}」没落地 —— ${reason}。`
    + "处理掉挡着的问题，再裁一次。";
}

/** 一行「词条 / 值」。左侧面板和弹窗共用同一种写法。 */
function factRows(rows) {
  statusFacts.replaceChildren(...rows.map(([term, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.title = value;
    row.append(dt, dd);
    return row;
  }));
}

function paintMark(element, mark) {
  element.className = "mark-pill" + (mark ? ` ${mark}` : "");
  element.textContent = mark ? MARK[mark].label : "未裁决";
  element.hidden = false;
}

/**
 * 左侧 40% 的常驻面板。
 *
 * 传一个阶段进来就显示那个阶段，传 null 就回到 Change 概览 —— 悬停驱动的那两种
 * 状态（交接 §5.0.2）。这里**只陈述**：一个控件都没有，动作全在弹窗里。
 */
function renderStatus(entry) {
  if (!entry) {
    const at = phases.find((item) => item.current);
    const approved = phases.filter((item) => item.mark === "approved").length;
    const problems = phases.filter((item) => item.mark === "problem").length;

    statusKicker.textContent = "Change Gate Orbit";
    statusTitle.textContent = panelState?.changes
      ?.find((change) => change.id === changeId)?.title ?? changeId;
    statusMark.hidden = true;
    statusLine.textContent = at
      ? (panelState?.status === "settled"
          ? "证据已到齐，等你的明确决定。"
          : "证据未到齐，跑一次当前阶段。")
      : "这个 Change 不在库里，环是空的。";
    factRows([
      ["当前阶段", at ? at.phase : "—"],
      ["闸门状态", panelState?.status ?? "—"],
      ["已批准", `${approved} / ${phases.length}`],
      ["有问题的阶段", String(problems)],
      ["闸门", gateSentence()],
    ]);
    statusFoot.textContent = "把鼠标移到环上任一阶段看它的状态，点开看它的问题。";
    return;
  }

  const open = openGaps(entry);
  statusKicker.textContent = entry.current ? "Current Stage" : "Stage";
  statusTitle.textContent = entry.phase;
  paintMark(statusMark, entry.mark);
  statusLine.textContent = lineFor(entry);
  factRows([
    ["线程", entry.threadId ? entry.threadId.slice(0, 8) : "还没有"],
    ["进程", entry.live ? "活着" : "没开"],
    ["未解决的问题", String(open.length)],
    ["问题总数", String(entry.gaps.length)],
    ["当前阶段", entry.current ? "是" : "否"],
    // 悬停这一层也要看得见「上次为什么没推动」—— 明细在弹窗那条横幅里。
    ...(entry.lastOutcome?.kind === "refused"
      ? [["上次裁决", `被闸门拒了：${GATE_REFUSAL_WORDS[entry.lastOutcome.reason] ?? entry.lastOutcome.reason}`]]
      : []),
  ]);
  statusFoot.textContent = "点这个阶段的小圈，看它的问题明细。";
}

/**
 * 进度圆弧走到当前阶段，不是走到「批准了几个」。
 *
 * 问的是「走到哪了」，而那是 Change 的位置 —— 一个阶段可以正在跑、还没批准，
 * 弧线该已经到它那儿。用批准数会让弧线永远落后一格，看着像卡住了。
 */
function drawProgress() {
  const at = phases.find((entry) => entry.current);
  const reached = at === undefined ? 0 : phases.indexOf(at) / phases.length;
  pick("progress").style.setProperty("--progress", String(reached));
  // 卡开着的时候数字得跟着轮询走，否则它停在点开那一刻，越看越不对。
  if (!sunCard.hidden) fillSunCard();
}

/**
 * 环心状态卡的内容。
 *
 * 这几行字本来常驻在环心圆盘上，2026-08-09 用户嫌它占地方删掉了；同一天他又要
 * 回来 —— 但要的是「点一下才看」。所以内容和当初一模一样，**出场方式不同**：
 * 平时环心只有一颗太阳，问了才答。
 */
function fillSunCard() {
  const at = phases.find((entry) => entry.current);
  const approved = phases.filter((entry) => entry.mark === "approved").length;
  sunKicker.textContent = panelState?.status
    ? `Gate · ${panelState.status}` : "Stage Orbit";
  sunTitle.textContent = at ? at.phase : "—";
  sunLine.textContent = at
    ? `${phases.length} 个阶段，停在第 ${phases.indexOf(at) + 1} 个。`
    : `${phases.length} 个阶段，每个阶段一个 Codex 线程。`;
  sunCount.replaceChildren(
    document.createTextNode(`${approved} / ${phases.length}`),
  );
  const unit = document.createElement("em");
  unit.textContent = "Approved";
  sunCount.append(unit);
}

/** 点太阳：开，或者关。卡摆在太阳下方不盖住它，所以一个开关管两头。 */
function toggleSunCard() {
  const opening = sunCard.hidden;
  sunCard.hidden = !opening;
  sunButton.setAttribute("aria-expanded", String(opening));
  if (opening) fillSunCard();
}

/*
 * 悬停：进节点就刷面板，离开所有节点就回默认。
 *
 * 离开要等一帧再恢复 —— 从一个节点划到隔壁会先 leave 再 enter，立刻恢复的话中间
 * 会闪一下 Change 概览，看着像面板在抽搐。
 */
let hoverTimer = null;

function hoverOn(phase) {
  if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
  renderStatus(phases.find((entry) => entry.phase === phase) ?? null);
}

function hoverOff() {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoverTimer = null; renderStatus(null); }, 70);
}

/*
 * ── 阶段弹窗 ──────────────────────────────────────────────
 *
 * 点小环打开，显示这个阶段的问题明细（用户 2026-07-29 第 3 条）。它和左边那块
 * 常驻面板是两层：**悬停看概要，点击看明细**，不是二选一。
 *
 * 底下三个动作：进终端 / 跑这个阶段 / 请 Codex 问我。
 * **没有 approve / reject，也不许加** —— 裁决只发生在 Codex 自己的选择器里
 * （PRD §1、§5.2b）。要在这里加一个"接受风险"的按钮之前，先读交接 §5.1：waive
 * 同样是人的裁决，同样必须在选择器里问。
 */
const GAP_STATUS = { open: "未解决", closed: "已关闭", waived: "已接受风险" };

function openSheet(phase) {
  notice = null;
  // 每次打开都回到「问题」。改标准是要专门去做的事，不该因为上次停在那儿就
  // 直接把人放在一个能改闸门的页面上。
  showTab("gaps");
  drawSheet(phase);
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  sheetPhase = null;
  notice = null;
  if (sheet.open) sheet.close();
}

function drawSheet(phase) {
  const entry = phases.find((item) => item.phase === phase);
  if (!entry) { closeSheet(); return; }
  sheetPhase = phase;

  sheetKicker.textContent = entry.current ? "Current Stage" : "Stage";
  sheetTitle.textContent = entry.phase;
  paintMark(sheetMark, entry.mark);
  sheetLine.textContent = notice
    // 没录需求是**最要紧的那件事**，盖过闸门那句 —— 不然人看到的是"跑它会派发一次
    // 真的 turn"，而按钮偏偏是灰的，两句话互相打脸。
    ?? (entry.current && panelState?.brief === null
      ? "还没说清楚这次改动要什么。先按「说清楚我要什么」—— 没有它，红方只能自己猜。"
      : entry.current ? `${lineFor(entry)}　闸门：${gateSentence()}` : lineFor(entry))

  /*
   * 上次裁决被拒 —— **留得住**（§3.2·5）。它原来只写进 stageNote / sheetLine，
   * 而「进程已经结束了」会盖掉它，那正是答完之后必然发生的事。这里每次重画都从
   * 库里的 lastOutcome 来：盖不掉，刷新也还在；下一次裁决落地它自己就换掉了。
   */
  const refusedWords = lastOutcomeWords(entry.lastOutcome);
  lastOutcomeLine.hidden = refusedWords === null;
  lastOutcomeLine.textContent = refusedWords ?? "";

  drawGaps(entry);
  sheetGaps.prepend(drawProduced(entry));

  // run / ask 只出现在 Change 真正停着的那个阶段上：跑哪个阶段由状态机决定，不由
  // 你点开了谁决定。点开一个未来的阶段只是打开看看。
  // 只有 open 的 P1 finding 可以被接受。P0 不许豁免；standard 的出口是撤下那条
  // 标准，不是接受风险 —— 两句话不是一回事。
  const waivable = entry.gaps.filter((gap) =>
    gap.status === "open" && gap.kind === "finding" && gap.severity === "P1");
  waiveButton.hidden = !entry.current || waivable.length === 0;
  waiveButton.disabled = entry.live;

  /*
   * 没录需求之前，「说清楚我要什么」是唯一能按的动作。
   *
   * 服务端也会拦（/api/run 在排队之前就拒），但界面不该摆一个按了必然被拒的按钮 ——
   * 那正是老树的病：有标签、有渲染、永远执行不了。
   */
  const needsBrief = panelState?.brief === null;
  briefButton.hidden = !entry.current;
  briefButton.disabled = entry.live;
  // 批 2 的两步跟着 brief 那个按钮走同一个可见性：都是「说清这次要什么」的入口。
  // 不随 entry.live 禁用 —— 它们走旁路线程，不占这个阶段的座。
  briefDraftButton.hidden = !entry.current;
  briefConfirmButton.hidden = !entry.current;

  const decidable = decidableActions();
  // 并行座位开着的格子也能跑（批 3）——「跑」发给座位，不发给主线。
  runButton.hidden = !(entry.current || entry.seat !== null);
  /*
   * **能派的只有 `pending` 和 `running`**，和服务端 `runRound` 那份名单同一份。
   *
   * `running` 也在里面不是笔误：人 `retry` 之后状态就在那儿，而那时正需要派一轮。
   * 真正在跑的那一轮由 `entry.live` 挡住（一个阶段同时只许一个进程）。
   *
   * 2026-07-30 实测：在 `blocked` 上按下去回来的是 HTTP 500、空 body，界面显示
   * 「没跑起来：undefined」—— 亮着的按钮、按下去什么也没有，正是老树那种病。
   */
  const status = entry.seat ?? panelState?.status ?? "pending";
  /*
   * 预检已经说了会拒，就别摆一个按下去必然失败的按钮（2026-08-07 真机的那一课）。
   * 判据来自服务端那份 `dispatchPrecheck`，不是这里另算的。
   */
  const barred = entry.current && Boolean(panelState?.blocked);
  runButton.disabled = entry.live || needsBrief || barred
    || (status !== "pending" && status !== "running");
  askButton.hidden = !entry.current;
  /*
   * **预检会拒的时候，连问都别问**（2026-08-07 真机）。
   *
   * 那天闸门只放行 `retry`，而 retry 落地之后必然要派一轮 —— 派发被预检拒掉，
   * 人白走一趟选择器、白烧一个 Codex 会话，末了眼前是个被关掉的终端。
   *
   * **只在「唯一能裁决的动作都要靠派发才有意义」时才挡**：blocked 上只有 retry，
   * 而 retry 就是「再派一轮」。settled 上还有批准/打回，那些不派轮，照旧能问。
   */
  const onlyRetry = decidable.length > 0 && decidable.every((each) => each === "retry");
  askButton.disabled = decidable.length === 0 || entry.live
    || (onlyRetry && barred);

  /*
   * 出口：**两个来源都问**（交接 §5.5.2）。注册表里有活进程，或者账本上有一轮
   * 在飞（queued / running 的 job）—— 后者在进程死了、或面板重启过之后照样成立，
   * 而那正是原来出口被藏、人一个能按的都没有的那个死结。
   * 没有出口，上面每一个 disabled 都是一个没有出路的死结。
   */
  const flying = roundInFlight(entry);
  closeTermButton.hidden = !(entry.live || flying);
  // 有一轮在飞时，这个出口收的不只是进程，还有账本上的那一轮（job 记失败、
  // Change 回 blocked、retry 有路）—— 名字要说实话。
  closeTermButton.textContent = flying ? "中止这一轮" : "结束这个终端";
  // 「开一个」和「结束这个」互斥：一个阶段同时只许一个进程。
  openTermButton.hidden = entry.live || flying;

  drawNextStep(entry);
}

/**
 * 下一步该干什么，写成一句话。
 *
 * ## 为什么这不是装饰
 *
 * 在这之前，人只能靠「哪个按钮是亮的」去反推下一步 —— 而按钮全灰的时候（有活进程）
 * 他连反推都做不到。用户 2026-07-30 的原话：**「我知道我在 PRD，但我不知道接下来该
 * 做什么。」** 需求文档 §1 要的是「让缺少完整软件工程经验的用户也能按可靠流程完成
 * 开发」，说出下一步就是这条本身。
 *
 * ## 一个来源
 *
 * 这里的判断和上面那些 `disabled` 用的是**同一批事实**，顺序也刻意排成一样。要改
 * 「什么时候能按什么」，两处一起改 —— 让按钮亮着而这里说做不了（或者反过来），比
 * 两边都不说更糟。
 */
function drawNextStep(entry) {
  const step = nextStep(entry);
  nextStepLine.hidden = step === null;
  if (step === null) return;

  nextStepLine.replaceChildren();
  const what = document.createElement("b");
  what.textContent = `下一步：${step.what}`;
  const why = document.createElement("span");
  why.textContent = step.why;
  nextStepLine.append(what, why);
}

/**
 * 这一格上有一轮在飞吗 —— 按**账本**判（queued / running 的 job），不按注册表。
 * 出口的判据（§5.5.2）和「下一步」的话术都读它，两处必须是同一份。
 */
function roundInFlight(entry) {
  const job = panelState?.job ?? null;
  if (job?.status !== "queued" && job?.status !== "running") return false;
  // 活儿自己说它在哪个座位（批 3）；老行没有这一格，按主线算。
  const at = job.phase ?? panelState?.currentPhase;
  return entry.phase === at && (entry.current || entry.seat !== null);
}

function nextStep(entry) {
  // 顺序 = 优先级。第一条命中的就是答案。
  /*
   * **派发前的五条预检，摆在人按下去之前**（2026-08-07 真机）。
   *
   * 那天：闸门只放行 retry，人在选择器里选了它，题落地了，然后干净树预检当场
   * 把这一轮拒掉、终端被关，人眼前只剩一个死终端 —— 而屏幕上事先一个字都没说
   * 「这个阶段现在根本派不出去」。它排在最前面：别的「下一步」都建立在
   * 「这个阶段派得出去」上，而这一条正说它派不出去。
   */
  if (entry.current && panelState?.blocked) {
    return {
      what: "先清掉这个路障",
      why: runRefusal(panelState.blocked)
        + "（这一条在你按任何按钮之前就成立 —— 现在去跑、或者去 retry，都会被它拒掉。）",
    };
  }
  if (roundInFlight(entry)) {
    return entry.live
      ? {
          what: "等这一轮跑完",
          why: "红蓝对抗在跑，进度看上面那条。不想等了就按「中止这一轮」——"
            + "它会把这一轮记成失败（可以 retry），不会推动任何闸门。",
        }
      : {
          what: "按「中止这一轮」",
          why: "账本记着一轮在飞，可它的进程不在了（进程死了，或面板重启过）——"
            + "等下去只会等到超时。中止把这一轮当场记成失败，然后就能 retry。",
        };
  }
  if (entry.live) {
    return {
      what: "先结束这个终端",
      why: "一个阶段同时只许有一个 Codex 进程，它开着的时候派不出新的东西 ——"
        + "所以别的按钮都是灰的。看完就按「结束这个终端」。",
    };
  }
  if (!entry.current) {
    return {
      what: "回到当前阶段",
      why: `流程停在 ${panelState?.currentPhase ?? "别处"}，不是这里。`
        + "点开一个未来的阶段只是打开看看，不会推动任何东西。",
    };
  }
  if (panelState?.brief === null) {
    return {
      what: "说清楚我要什么",
      why: "还没人问过你这次要什么。没有它，红方只能自己编一份需求，"
        + "而后面每个阶段都建在那份编出来的东西上。",
    };
  }
  if (panelState?.status === "blocked") {
    /*
     * §5.5.4：失败原因一直写在 jobs.error 里，屏幕上原来一个字都没有 ——
     * 这里原来说「失败的原因在『问题』里」，而那是假话：超时、树脏这类原因
     * 从来不进 gaps。拒绝的派发现在也落账（`recordRefusal`），所以「最近一条」
     * 就是这一次的真原因，不再是上一轮的旧话。
     */
    const error = panelState?.job?.error;
    return {
      what: "请 Codex 问我",
      // 这一行是当成纯文本渲染的（`textContent`），所以不写 markdown 的星号 ——
      // 界面上会原样出现两个 `**`。
      why: "上一轮跑失败了。这个阶段现在只接受 retry，而 retry 是你的裁决 ——"
        + "所以它在 Codex 的选择器里问，不在这个按钮上。"
        + (error ? `这一次失败的原因：${error}` : "原因没被记下来。"),
    };
  }
  if (panelState?.status === "settled") {
    return decidableActions().length > 0
      ? {
          what: "请 Codex 问我",
          why: openGaps(entry).length > 0
            ? `这一轮跑完了。选择器里会把这 ${openGaps(entry).length} 条问题一条一道题地`
              + "问你 —— 同意 / 不同意 / 先接受风险 / 我自己说，每条都能写自己的话，"
              + "最后问你「再来一轮，还是就这样批准」。选再来一轮就当场续跑，"
              + "不用回来再按一次。"
            : "这一轮跑完了，闸门在等你的明确决定。裁决发生在 Codex 自己的选择器里，"
              + "网页上没有、也不会有 approve 按钮。",
        }
      : {
          what: "看「问题」里挡着的东西",
          why: "跑完了，但闸门现在没有可裁决的动作 —— 通常是还有问题挡着。",
        };
  }
  return {
    what: "跑这个阶段",
    why: "需求已经记下了。跑它会派一轮红蓝对抗：红方拿你写的需求去做，蓝方挑毛病，"
      + "裁判裁决，三个角色各自还要过一遍标准。要几分钟。",
  };
}

/**
 * 结束这个阶段的终端。
 *
 * **这是那个缺失的出口。** 结束一个进程不是业务决策 —— 它不推动闸门，也不对任何
 * 产物下判断，所以它可以是网页上的一个按钮。
 */
/**
 * 明确起一个 Codex 聊天窗口。
 *
 * 和「看这个终端」分开的那一半 —— 看的那条路绝不起进程了（用户 2026-08-03：
 * 「我点进入终端只是想看看状态……而不是点了就报废」）。起进程要有自己的名字，
 * 人按下去就知道自己在做什么。
 */
async function openTerminal() {
  const phase = sheetPhase;
  if (!phase) return;
  openTermButton.disabled = true;
  try {
    const response = await fetch(
      `/api/terminal?change=${encodeURIComponent(changeId)}`
      + `&phase=${encodeURIComponent(phase)}`, { method: "POST" },
    );
    const result = response.ok ? await response.json() : { opened: false };
    await loadOrReconnect();
    // 起成了就直接进去 —— 人要的是那个终端，不是「已开启」四个字。
    if (result.opened) { closeSheet(); await enter(phase); return; }
    if (sheetPhase) drawSheet(sheetPhase);
  } finally {
    openTermButton.disabled = false;
  }
}

async function closeTerminal() {
  const phase = sheetPhase;
  if (!phase) return;
  closeTermButton.disabled = true;
  try {
    const result = await (await fetch(
      `/api/close?change=${encodeURIComponent(changeId)}`
      + `&phase=${encodeURIComponent(phase)}`, { method: "POST" },
    )).json();
    // 连账本一起收掉了一轮，就要说出来 —— job 记了失败、Change 回了 blocked，
    // 静默的话人不知道现在已经可以 retry 了。
    if (result.aborted) {
      say(`这一轮中止了（${result.aborted}）。`
        + "现在可以 retry ——「请 Codex 问我」，在选择器里选。");
    }
    /*
     * **旁路里动过手，就当场要一句话**（彗星的账本，2026-08-11）。
     *
     * 判据在服务端（进出旁路时两个 HEAD 不同），这里只负责问。只聊过的那种
     * `needsNote` 是假的，一个字都不问 —— 轻的用法保持轻，正是那条账的判据。
     *
     * 人不写也不拦他（旁路本来就不推闸门）；不写的代价是环上那颗彗星留着一条
     * 说不出来历的尾迹，而下游会对着一份来历不明的树干活。
     */
    if (result.needsNote) {
      const note = window.prompt(
        "这趟旁路动了工作树（有新的 commit）。用一句话说清做了什么 ——\n"
        + "它是下游唯一能知道「环外发生过什么」的地方。");
      if (note && note.trim()) {
        await fetch(
          `/api/aside?change=${encodeURIComponent(changeId)}`
          + `&visit=${encodeURIComponent(result.visit)}`,
          { method: "POST", body: note },
        );
      }
    }
    await loadOrReconnect();
    if (sheetPhase) drawSheet(sheetPhase);
  } finally {
    closeTermButton.disabled = false;
  }
}

/**
 * 读过的产出正文，`阶段\n路径` -> 那次响应。
 *
 * 有它是因为 `drawSheet` 会被重画好几次（load 之后、切页签、按完按钮），每次都重新
 * 取一遍会让正文闪成「读取中…」再回来。`load()` 里清掉 —— 一轮跑完文件就是新的了。
 */
const artifactCache = new Map();

/**
 * 红方这一阶段产出了什么 —— **连正文一起**。
 *
 * 「红蓝双方主张摘要」在新树上就是两样：蓝方的主张是下面那些 finding，红方的主张
 * 是它产出的东西。**只看得见「有人挑了三条毛病」而看不见「他挑的是什么东西」，
 * 那个列表是悬着的。**
 *
 * 所以正文直接摊在这儿，不藏在一次点击后面：用户 2026-07-30 的原话是「他们把 PRD
 * 和建议一起带回给我 —— 现在只有建议，我拿不到那份 PRD」。**只显示文件名等于没带
 * 回来。** 高度封顶、自己滚，这样它不会把下面的问题列表顶出视野。
 */
function drawProduced(entry) {
  const box = document.createElement("div");
  const head = document.createElement("p");
  head.className = "sheet-section";
  head.textContent = "这个阶段产出了什么";
  box.append(head);

  if ((entry.produced ?? []).length === 0) {
    const none = document.createElement("p");
    none.className = "sheet-empty";
    none.textContent = "还没有产出。闸门不会放行一个什么都没产出的阶段。";
    box.append(none);
    return box;
  }
  for (const artifact of entry.produced) {
    const row = document.createElement("div");
    row.className = "artifact";

    const path = document.createElement("p");
    path.className = "artifact-path";
    /*
     * Build 的产出是一个 commit（用户 2026-07-30），所以这一格会是一串 sha。
     * **给它一个词自报家门** —— 一串裸的十六进制和一个古怪的文件名长得一样，
     * 而人得知道下面那段是 diff 不是文件正文。
     *
     * 判据和服务端同一条（`looksLikeSha`）。这里是显示用的一句话，不是判定：
     * 真正决定读文件还是读 commit 的是服务端，界面认错了最多是标签不好看。
     */
    const isCommit = /^[0-9a-f]{7,40}$/.test(artifact);
    path.textContent = isCommit ? `commit ${artifact}` : artifact;
    path.title = artifact;

    const body = document.createElement("pre");
    body.className = "artifact-body";
    body.textContent = "读取中…";
    row.append(path, body);
    box.append(row);
    fillArtifact(entry.phase, artifact, body);
  }
  return box;
}

/** 服务端读不到时的原因，翻成人话。原样显示 `not_produced_here` 等于没说。 */
const ARTIFACT_REFUSALS = {
  not_produced_here: "库里没把这份东西记成这个阶段的产出 —— 面板不去别处找它。",
  project_has_no_path: "这个项目没有路径，所以不知道该到哪儿去找这份产出。",
  gone: "这份产出不在了 —— 被移走或删掉了。库里还记着它，磁盘上没有。",
  outside_project: "这条路径落在项目目录外面，不给读。",
  not_a_file: "这条路径不是一个文件。",
  too_big: "这份东西太大，不在弹窗里读。",
};

/**
 * 把正文填进去。
 *
 * 读不到就**说出来**，不留一块空白：一块空白和「这份 PRD 是空的」看着一模一样，
 * 而两者要做的事完全不同（M7）。
 */
async function fillArtifact(phase, artifact, into) {
  const key = `${phase}\n${artifact}`;
  let read = artifactCache.get(key);
  if (!read) {
    try {
      read = await (await fetch(
        `/api/artifact?change=${encodeURIComponent(changeId)}`
        + `&phase=${encodeURIComponent(phase)}&id=${encodeURIComponent(artifact)}`)).json();
    } catch (error) {
      read = { readable: false, reason: `fetch_failed:${error.message}` };
    }
    artifactCache.set(key, read);
  }
  // 弹窗可能已经换到别的阶段去了；那时这个节点已经不在文档里，写它没有意义。
  if (!into.isConnected) return;

  if (read.readable) {
    into.classList.remove("bad");
    into.textContent = read.text === "" ? "（这份产出是空的。）" : read.text;
    return;
  }
  into.classList.add("bad");
  into.textContent = ARTIFACT_REFUSALS[read.reason]
    ?? `读不到这份产出：${read.reason}`;
}

function drawGaps(entry) {
  if (entry.gaps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sheet-empty";
    empty.textContent = entry.threadId || entry.current
      ? "这个阶段还没有记录到问题。"
      : "还没轮到这个阶段，没有问题可看。";
    sheetGaps.replaceChildren(empty);
    return;
  }

  // 未解决的排最前，然后按严重度。挡着闸门的东西不该要人往下滚才看得见。
  const rank = { P0: 0, P1: 1, P2: 2 };
  const sorted = [...entry.gaps].sort((left, right) =>
    (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1)
    || rank[left.severity] - rank[right.severity]
    || left.openedRound - right.openedRound);

  const open = openGaps(entry).length;
  const heading = document.createElement("p");
  heading.className = "sheet-section";
  heading.textContent = open > 0
    ? `${open} 项挡着闸门 · 共 ${entry.gaps.length} 项`
    : `${entry.gaps.length} 项，都已了结`;

  sheetGaps.replaceChildren(heading, ...sorted.map((gap) => {
    const row = document.createElement("div");
    row.className = `gap ${gap.status}`;

    const severity = document.createElement("b");
    severity.className = "gap-sev";
    // 一条 standard 没有严重度 —— 它答的是「满足了没有」，二元。这里写死一个
    // P 几，或者让 null 直接渲染成 "null"，都是在假装它有那一维。
    severity.textContent = gap.kind === "standard" ? "标准" : gap.severity;

    const text = document.createElement("div");
    text.className = "gap-text";
    const title = document.createElement("strong");
    title.textContent = gap.title;
    const meta = document.createElement("span");
    meta.textContent =
      `${gap.id} · ${GAP_STATUS[gap.status]} · 第 ${gap.openedRound} 轮发现`;
    text.append(title, meta);
    // 结案理由。"修好了"和"这一轮忘了提"的区别全在这一行上，所以它必须显示出来，
    // 而不是只留在库里（domain/gap.ts 开头那段说的就是这件事）。
    if (gap.resolution) {
      const why = document.createElement("em");
      why.textContent = gap.resolution;
      text.append(why);
    }
    /*
     * 人对这一条说过的话。
     *
     * **它跟着这条问题进了下一轮的提示词**，所以人得看得见自己说过什么 —— 否则
     * 「我上一轮已经交代过了」和「我以为我交代过了」在界面上一模一样。
     */
    if (gap.note) {
      const mine = document.createElement("em");
      mine.className = "gap-note";
      mine.textContent = `你说：${gap.note}`;
      text.append(mine);
    }

    row.append(severity, text);
    return row;
  }));
}

/** Ring -> stage. Timed and guarded; see the note at the top. */
async function enter(phase) {
  if (moving) return;
  moving = true;
  current = phase;

  const entry = phases.find((item) => item.phase === phase);
  stageName.textContent = phase;
  stageThread.textContent = entry?.threadId ? entry.threadId.slice(0, 8) : "新线程";
  // 上一次 run / ask 的结果不该跟着你进下一个阶段。ask() 会在这之后再写一次。
  stageNote.textContent = NOTE_DEFAULT;

  portal.classList.remove("go");
  void portal.offsetWidth; // restart the animation rather than skip it
  portal.classList.add("go");
  orbitView.classList.add("entering");

  await wait(620);
  orbitView.hidden = true;
  orbitView.classList.remove("entering");
  portal.classList.remove("go");

  stageView.hidden = false;
  void stageView.offsetWidth;
  stageView.classList.add("active");
  await wait(120);
  moving = false;

  term.reset();
  term.focus();
  await attach(phase);
}

async function leave() {
  if (moving) return;
  moving = true;
  if (stream) { stream.abort(); stream = null; }
  current = null;

  stageView.classList.remove("active");
  await wait(420);
  stageView.hidden = true;

  orbitView.hidden = false;
  orbitView.classList.add("entering");
  void orbitView.offsetWidth;
  orbitView.classList.remove("entering");
  await wait(300);
  moving = false;

  await loadOrReconnect();
}

/*
 * ── 项目图谱（spec 2026-08-12）：第三个互斥 view ─────────────
 *
 * 图谱本体在 graph-view.js（panel.js 已经三千行，新东西不再往里塞）。
 * 两边只握一次手：这里管「哪个 view 在台上」，那边管图谱里发生的一切。
 * 进图谱是只读动作 —— 不起进程、不写库（「看状态不该有副作用」）。
 */
function openGraphView(project) {
  // 台上如果是终端，按 leave() 的规矩收干净 —— 只是不播它的动画。
  if (stream) { stream.abort(); stream = null; }
  current = null;
  stageView.classList.remove("active");
  stageView.hidden = true;
  orbitView.hidden = true;
  graphView.hidden = false;
  window.stagepassGraph?.open({ id: project.id, name: project.name });
}

function closeGraphView() {
  window.stagepassGraph?.close();
  graphView.hidden = true;
  orbitView.hidden = false;
  void loadOrReconnect();
}

pick("graph-back").addEventListener("click", () => closeGraphView());

async function attach(phase, reattaching = false) {
  stream = new AbortController();
  const mine = stream;
  if (!reattaching) await resize(phase);

  /*
   * **这条路只看，不起进程**（服务端 2026-08-03 起就是这个语义）。三种回法：
   *
   *   200 + 流   进程活着，接上去
   *   200 + 完整 进程死了，这是它的最后一屏（服务端给完就 end）
   *   409        这个阶段从没跑过 —— 说出来，别留一片空白
   */
  const response = await fetch(
    path(phase, reattaching ? "?existing=1" : ""), { signal: stream.signal });
  if (!response.ok) {
    if (mine !== stream) return;
    /*
     * **空白和「没有进程」在人眼里一模一样**，所以要写出来。这正是这个面板从头
     * 到尾在防的那类：做了事却看不出做了，或者没做事却看不出没做。
     */
    if (!reattaching) {
      term.reset();
      term.write("\r\n  这个阶段还没有进程。\r\n\r\n");
      term.write("  要跑这个阶段，回阶段环按「跑这个阶段」；\r\n");
      term.write("  只想在这条线程里跟 Codex 说话，按「开一个终端」。\r\n");
    }
    // 重连扑空（409）：进程真的死了。注解已经在屏幕下面，保留尸体，不再试。
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    /*
     * **换过一格就不许再往这块屏幕上画。**
     *
     * `abort()` 之后这条 `read()` 通常会抛，但那是「通常」：切走的那一刻可能已经有
     * 一次 read 在路上，它照样会 resolve 出数据。少了这一行，实测就是**两个终端的
     * 输出叠在同一屏上** —— 而标签页存在的全部意义就是让人分得清哪个是哪个。
     *
     * `mine !== stream` 是这个文件里已有的那把尺子（下面那个收尾判断用的就是它），
     * 这里只是把它挪到写之前。
     */
    if (mine !== stream) return;
    // value is a Uint8Array. It is drawn, never inspected.
    term.write(value);
  }

  /*
   * 流断了就说一句。
   *
   * **死终端和卡住的终端长得一模一样** —— xterm 停在最后一帧，光标还在，人以为
   * 它在想事情，于是一直等、一直打字，什么都不发生。用户 2026-07-30 撞到的正是
   * 这个（那次是 StagePass 自己在录完需求之后关掉了会话）。
   *
   * 只写终端**下面**那行注解，不往 xterm 里写字：终端那块画面是 Codex 的，
   * StagePass 一个像素都不画（PRD §9.3）。
   *
   * `mine` 那个判断是必需的：`leave()` 会 abort 这条流，那种结束是人主动走开，
   * 不该报「进程结束了」。
   */
  if (stream === mine) {
    stageNote.textContent =
      `${phase} 的进程已经结束了 —— 这个终端不再接受输入。返回阶段环继续。`;
    /*
     * **自动重连一次**（交接 C3）。
     *
     * 流断掉有两种：服务端换了会话（「答完直接续跑」关旧起新 —— 接上新的就好，
     * 原来这里没有任何重连，人对着死流干等），和进程真的死了（上面那行注解就是
     * 给这种看的）。重连带 `existing=1`，后者会拿到 409、注解留着 —— 两种不再
     * 长得一样。
     *
     * 只连一次（reattaching 不再递归），免得在一个反复断的服务上转圈。
     *
     * ## 这里曾经有一个 `&& label === null`，它让整个重连从来没有发生过
     *
     * `label` 是 aside 那套东西的变量。`7d8e53b` 把整套 aside 撤掉时删掉了它，
     * **漏了这一处引用**。于是每次流一断，这一行就抛 `ReferenceError: label is
     * not defined`，下面两行永远执行不到 —— 症状是「Codex 问完话、或者阶段一动，
     * 终端就再也不动了，可底下明明在跑」。用户 2026-08-04 报的就是这个。
     *
     * 它躲过了 `pnpm check`：`tsconfig.src.json` 的 include 只有 `src/**\/*.ts`
     * 和 `scripts/**\/*.ts`，**这个文件根本不在类型检查范围内**。一个裸标识符
     * 引用在浏览器里才会炸，而没有任何一层在它炸之前看过它。
     */
    if (!reattaching) {
      await wait(800);
      if (stream !== mine) return; // 人已经走开或换了格子
      await attach(phase, true);
    }
  }
}

/**
 * 旁路窗口：不属于任何阶段的 Codex 聊天（DESIGN §3.3）。
 *
 * **永远能按** —— 一轮对抗跑着的时候想问个名词，不用等它跑完。服务端不查
 * phaseBusy（这正是旁路的定义），所以这里也没有 disabled 逻辑可写。
 */
async function openAside() {
  try {
    const response = await fetch(
      `/api/aside?change=${encodeURIComponent(changeId)}`, { method: "POST" });
    if (!response.ok) {
      say(`旁路窗口没开成：${await response.text()}`);
      return;
    }
    closeSheet();
    await enter("aside");
  } finally {
  }
}

/**
 * 批 2「模型起草，人改」的两步。中间那段（人在编辑器里改文件）不经过这个页面 ——
 * 它本来就是人的活儿。机械判据（未经修改不算）在服务端。
 */
const DRAFT_REFUSAL_WORDS = {
  no_aside_conversation: "还没有旁路对话可整理 —— 先按「旁路窗口」谈这次要什么，"
    + "谈完再来起草。",
  // 2026-08-06 真机：判据原来是「有没有会话」，而按一下「旁路窗口」会话当场就建好，
  // 于是模型交回一份四节全是「本会话尚未谈到」的草稿，还被当成草稿写进了文件。
  no_conversation_yet: "那个窗口开着，但你还没在里面说过话 —— 没有对话就只能编一份"
    + "需求出来。先去旁路窗口聊清楚这次要做什么，再回来起草。",
};

async function draftBriefFromAside() {
  briefDraftButton.disabled = true;
  /*
   * 起草那一轮要跑几分钟（xhigh），而它跑在旁路窗口里 —— 把人送进去看着，
   * 比让他对着一个「整理中…」的按钮干等强。这也是 2026-08-06 那个「卡住」的
   * 另一半：屏幕上没有任何东西说它在跑。
   */
  briefDraftButton.textContent = "模型在整理那段对话…";
  const pending = fetch(
    `/api/brief-draft?change=${encodeURIComponent(changeId)}`, { method: "POST" });
  closeSheet();
  await enter("aside");
  stageNote.textContent = "正在让模型把这段对话整理成 brief 草稿 ——"
    + "它就在这个窗口里跑，几分钟。写好之后这行会给出草稿文件的路径。";
  try {
    const result = await (await pending).json();
    if (result.kind === "drafted") {
      say(`草稿写好了：${result.editPath} —— 在编辑器里改它（未经修改不算数），`
        + "改完回阶段卡片按「brief 定稿」。");
    } else {
      say(DRAFT_REFUSAL_WORDS[result.kind] ?? `没起草成：${result.detail ?? result.kind}`);
    }
  } finally {
    briefDraftButton.disabled = false;
    briefDraftButton.textContent = "闲聊起草 brief";
  }
}

const CONFIRM_BRIEF_WORDS = {
  nothing_drafted: "还没起草过（或者草稿文件被删了）。先按「闲聊起草 brief」。",
  edit_missing: "工作稿不见了 —— 先重新起草一份。",
  draft_unedited: "这份和模型的草稿逐字相同 —— 未经你编辑的草稿不算 brief。"
    + "在文件里改成你的话（删掉不对的、补上你真正要的），再来定稿。",
  empty_brief: "文件被改成了一片空白 —— 一段空 brief 等于回到编出来的需求。",
};

async function confirmBriefEdit() {
  briefConfirmButton.disabled = true;
  try {
    const result = await (await fetch(
      `/api/brief-confirm?change=${encodeURIComponent(changeId)}`,
      { method: "POST" })).json();
    if (result.kind === "recorded") {
      // 顶掉一份已经存在的 brief = 换掉下游每个阶段的地基。**必须说出来。**
      say(`brief 定稿了（${result.brief.length} 字）。现在可以跑这个阶段 ——`
        + "红方拿的是你改过的那份，不是模型猜的。"
        + (result.replaced
          ? `⚠ 它顶掉了原来那份 brief（${result.replaced.length} 字）——`
            + "下游每个阶段的任务书从此读的是新的这份。"
          : ""));
      await loadOrReconnect();
      if (sheetPhase) drawSheet(sheetPhase);
    } else {
      say(CONFIRM_BRIEF_WORDS[result.kind] ?? `没定稿成：${result.kind}`);
    }
  } finally {
    briefConfirmButton.disabled = false;
  }
}

button("back").addEventListener("click", () => { void leave(); });
briefDraftButton.addEventListener("click", () => { void draftBriefFromAside(); });
briefConfirmButton.addEventListener("click", () => { void confirmBriefEdit(); });
runButton.addEventListener("click", () => { void run(); });
askButton.addEventListener("click", () => { void ask(); });
briefButton.addEventListener("click", () => { void recordBrief(); });
closeTermButton.addEventListener("click", () => { void closeTerminal(); });
openTermButton.addEventListener("click", () => { void openTerminal(); });
waiveButton.addEventListener("click", () => { void waive(); });
button("expand").addEventListener("click", () => { setCollapsed(false); });

/*
 * 新建 Project / Change。
 *
 * 用 prompt 而不是自建一层表单弹窗：这一屏的规矩是「新东西默认不进主屏」，
 * 为了收一个名字铺一整块常驻 UI 正是它要挡的。**要改成好看的表单之前先读
 * 交接 §5.0 第 4 条。**
 */
/*
 * 新建 Project。
 *
 * 表单而不是 prompt：**路径是要粘贴、要核对的东西**。prompt 是两个先后弹出的框，
 * 看不见彼此，服务端的拒绝原因也只能落到一个 alert 里 —— 而这里的错（不是绝对路径 /
 * 目录不存在）恰恰需要贴在字段旁边说。
 *
 * 仍然不进主屏：它是个 <dialog>，和阶段弹窗同一个位置。
 */
const projectSheet = dialog("project-sheet");
const projectName = field("project-name");
const projectPath = field("project-path");
const projectError = pick("project-error");

/** 服务端的拒绝原因，翻成人话。原样显示 `path_must_be_absolute` 等于没说。 */
const PROJECT_REFUSALS = {
  name_required: "名字不能空。",
  path_required: "得给一个路径 —— Codex 要在某个目录里跑。",
  path_must_be_absolute: "要绝对路径。相对路径相对谁？相对服务端的目录，那就又回到「不知道跑在哪」了。",
  path_does_not_exist: "这个路径不存在。",
  path_is_not_a_directory: "这是个文件，不是目录。",
};

function openProjectSheet() {
  projectName.value = "";
  projectPath.value = "";
  projectError.hidden = true;
  if (!projectSheet.open) projectSheet.showModal();
  projectName.focus();
}

async function createProject() {
  const name = projectName.value.trim();
  const path = projectPath.value.trim();
  // 先在本地挡掉空值，省一次往返；服务端仍然会各查一遍（两层都要有）。
  if (name === "") { showProjectError("name_required"); projectName.focus(); return; }
  if (path === "") { showProjectError("path_required"); projectPath.focus(); return; }

  const response = await fetch(
    `/api/project?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`,
    { method: "POST" },
  );
  if (!response.ok) {
    showProjectError((await response.text()).trim());
    projectPath.focus();
    return;
  }
  const created = await response.json();
  projectSheet.close();
  // 建完直接切过去 —— 建了却停在原地，人得再找一次它在哪。
  location.search = `?change=${encodeURIComponent(changeId)}`
    + `&project=${encodeURIComponent(created.id)}`;
}

function showProjectError(reason) {
  projectError.textContent = PROJECT_REFUSALS[reason] ?? `没建成：${reason}`;
  projectError.hidden = false;
}

button("new-project").addEventListener("click", () => {
  openProjectSheet();
});
button("project-create").addEventListener("click", () => {
  void createProject();
});
button("project-cancel").addEventListener("click", () => {
  projectSheet.close();
});
// 在任一字段里回车就提交 —— 填完路径还要去找按钮，是没必要的一步。
for (const field of [projectName, projectPath]) {
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void createProject(); }
  });
}

/*
 * 新建 Change。和新建 Project 同一个形状 —— 两个入口长得一样，人不用记两套。
 *
 * 顶上那句写的是「建在哪个项目、哪个仓库」：Change 落在哪个项目，就决定了 Codex 会
 * 在哪个目录里跑。不说的话，又是一次「建了但不知道建在哪」—— 用户 2026-07-30 在
 * Project 上撞的就是这个。
 */
const changeSheet = dialog("change-sheet");
const changeTitle = field("change-title");
const changeTarget = field("change-target");
const changeError = pick("change-error");

/** 服务端的拒绝原因，翻成人话。 */
const CHANGE_REFUSALS = {
  title_required: "得给一句话，否则列表里认不出它是哪个。",
  no_such_project: "这个项目不在库里了 —— 刷新一下再试。",
};

/** 这个新 Change 会落在哪个项目上。选中的优先，否则跟着当前 Change，最后取第一个。 */
function targetProject() {
  const id = panelState?.selectedProject
    ?? panelState?.changes.find((change) => change.id === changeId)?.projectId
    ?? panelState?.projects[0]?.id;
  return panelState?.projects.find((project) => project.id === id) ?? null;
}

function openChangeSheet() {
  const project = targetProject();
  if (!project) return;

  changeTitle.value = "";
  changeError.hidden = true;
  changeTarget.textContent = project.path === null
    // 没路径的项目建了也跑不了，当场说清楚，而不是等他按「跑这个阶段」才发现。
    ? `建在「${project.name}」里 —— 但这个项目没有路径，建完也跑不了。`
    : `建在「${project.name}」里，Codex 会在 ${project.path} 跑。`;
  if (!changeSheet.open) changeSheet.showModal();
  changeTitle.focus();
}

async function createChange() {
  const project = targetProject();
  if (!project) return;
  const title = changeTitle.value.trim();
  if (title === "") {
    changeError.textContent = CHANGE_REFUSALS.title_required;
    changeError.hidden = false;
    changeTitle.focus();
    return;
  }

  const response = await fetch(
    `/api/change?project=${encodeURIComponent(project.id)}`
    + `&title=${encodeURIComponent(title)}`, { method: "POST" },
  );
  if (!response.ok) {
    const reason = (await response.text()).trim();
    changeError.textContent = CHANGE_REFUSALS[reason] ?? `没建成：${reason}`;
    changeError.hidden = false;
    return;
  }
  const created = await response.json();
  changeSheet.close();
  location.search = `?change=${encodeURIComponent(created.id)}`;
}

button("new-change").addEventListener("click", () => {
  openChangeSheet();
});
button("change-create").addEventListener("click", () => {
  void createChange();
});
button("change-cancel").addEventListener("click", () => {
  changeSheet.close();
});
changeTitle.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void createChange(); }
});

enterButton.addEventListener("click", () => {
  const phase = sheetPhase;
  closeSheet();
  if (phase) void enter(phase);
});
button("sheet-close").addEventListener("click", () => { closeSheet(); });
// 点遮罩也关。<dialog> 的遮罩不是独立元素，点在它上面时 event.target 就是 dialog
// 自己 —— 点在内容上时 target 是里面的节点，所以这个判断足够分开两者。
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});
// Esc 走原生的 cancel/close，不经过 closeSheet，所以状态要在这里跟上。
sheet.addEventListener("close", () => { sheetPhase = null; notice = null; });

// Applied before the first paint, and without a transition -- animating from
// three columns to none on load would look like the page changing its mind.
if (startCollapsed) columns.classList.add("collapsed");
term.onData((data) => { if (current) void send(current, data); });
addEventListener("resize", () => {
  if (current) void resize(current);
  else placeNodes();
});

void loadOrReconnect();

/*
 * ── 标准编辑器 ────────────────────────────────────────────
 *
 * **网页上唯一可以改的东西**（PRD §1.1）。边界写成一句话：
 *
 *   Web 可以改「标准」。Web 永远不可以对「这一次的产物」下判断。
 *
 * 它站得住是因为撤下一条标准**不需要人说谎** —— 它不声称产物满足了标准，它撤销
 * 标准。approve 是在说「这份 PRD 够好了」，那是对产物的判断，必须在人被正面问到
 * 时回答。
 *
 * 所以这里可以有输入框和保存按钮，而**永远不许有 approve / reject / 接受风险**。
 * 要在这个文件里加那样一个按钮之前，先回去读 PRD §1.1。
 */
const ROLE_LABEL = { producer: "正方", critic: "反方", verdict: "裁判" };

function showTab(name) {
  sheetTab = name;
  tabGaps.setAttribute("aria-selected", String(name === "gaps"));
  tabRubric.setAttribute("aria-selected", String(name === "rubric"));
  sheetGaps.hidden = name !== "gaps";
  sheetRubric.hidden = name !== "rubric";
  if (name !== "rubric") return;
  // 先清空再去取：不清的话，切过来的一瞬间显示的是**上一个阶段**那份 rubric，
  // 等 fetch 回来才换掉。那一下看着像数据串了。
  sheetRubric.replaceChildren();
  void loadRubric(sheetPhase, editing?.role ?? "producer")
    .catch((error) => {
      const failed = document.createElement("p");
      failed.className = "rubric-note bad";
      failed.textContent = `读不到这个阶段的标准：${error.message}`;
      sheetRubric.replaceChildren(failed);
    });
}

async function loadRubric(phase, role) {
  if (!phase) return;
  const read = await (await fetch(
    `/api/rubric?change=${encodeURIComponent(changeId)}&phase=${encodeURIComponent(phase)}`,
  )).json();
  const mine = read.roles.find((entry) => entry.role === role);
  editing = {
    phase, role,
    scope: mine?.scope ?? "project",
    // 这一份由谁判，null = 不进对抗（人自己看）。**服务端给的,这边不算。**
    // 「谁判谁」那条链的判据只有一份（work/rubric-round.ts 的 ASSESSED_BY），
    // 在这里抄一遍就是第二份拷贝,而漂移的那天界面会理直气壮地说错话。
    assessedBy: mine?.assessedBy ?? null,
    // 存的那一版留一份，用来算「这次编辑会退休掉什么」—— 那决定要不要问理由。
    saved: mine?.criteria ?? [],
    drafts: (mine?.criteria ?? []).map((entry) => ({
      key: entry.key, text: entry.text, blocking: entry.blocking,
      // **section 必须原样带回去。** 少了它，保存一次就把这一份和产出模板脱钩了
      // （`domain/rubric.ts` 的 section 那一格 = 「越界」的机械判据），而界面上
      // 什么都看不出来。人在这里编辑的是文字，不是这条挂接关系。
      section: entry.section ?? null,
    })),
    note: null,
  };
  drawRubric();
}

/** 这次编辑会退休掉哪些活着的阻断标准。和服务端 retiredBy 是同一条规则。 */
function wouldRetire() {
  if (!editing) return [];
  const stillBlocking = new Set(
    editing.drafts.filter((entry) => entry.blocking && entry.key).map((entry) => entry.key));
  return editing.saved.filter((entry) => entry.blocking && !stillBlocking.has(entry.key));
}

function drawRubric() {
  if (!editing) { sheetRubric.replaceChildren(); return; }
  const parts = [];

  const roles = document.createElement("div");
  roles.className = "rubric-roles";
  for (const role of ["producer", "critic", "verdict"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rubric-role";
    button.setAttribute("aria-pressed", String(role === editing.role));
    button.textContent = ROLE_LABEL[role];
    button.addEventListener("click", () => {
      sheetRubric.replaceChildren();
      void loadRubric(editing.phase, role).catch(() => { /* 上面那条已经报过 */ });
    });
    roles.append(button);
  }
  parts.push(roles);

  /*
   * 升级排在**判定和标准之前**。
   *
   * 它原来跟在这一轮的判定后面，于是被那一长串顶到折叠线以外 —— 2026-08-06 真机
   * 实测：DOM 里有、屏幕上看不见，和「这个按钮不存在」对使用者是同一件事。
   *
   * 而且位置本身也是错的：它是**项目级**的动作，和你正在看哪个阶段、哪个角色
   * 没有关系。埋在某一个阶段的判定底下，等于说它属于那个阶段。
   */
  parts.push(drawVerdicts());

  const scope = document.createElement("p");
  scope.className = "rubric-scope";
  scope.textContent = editing.scope === "change"
    ? "这一份只属于这个 Change，覆盖了项目级默认。"
    : "这是项目级默认，改它会影响这个项目里之后每一个 Change。";
  parts.push(scope);

  editing.drafts.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "criterion";

    const text = document.createElement("textarea");
    text.value = entry.text;
    text.rows = 2;
    text.addEventListener("input", () => { entry.text = text.value; });

    const block = document.createElement("label");
    block.className = "criterion-block" + (entry.blocking ? " on" : "");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = entry.blocking;
    box.addEventListener("change", () => {
      entry.blocking = box.checked;
      drawRubric(); // 重画：这一下可能让理由框冒出来
    });
    block.append(box, document.createTextNode("阻断"));

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "criterion-drop";
    drop.textContent = "✕";
    drop.title = "删掉这条标准";
    drop.addEventListener("click", () => {
      editing.drafts.splice(index, 1);
      drawRubric();
    });

    row.append(text, block, drop);
    parts.push(row);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "rubric-add";
  add.textContent = "+ 加一条标准";
  add.addEventListener("click", () => {
    // 没有 key 就是「新写的」。带一个假 key 回去会被服务端整次拒绝。
    editing.drafts.push({ text: "", blocking: true });
    drawRubric();
  });
  parts.push(add);

  const retiring = wouldRetire();
  const reason = document.createElement("div");
  reason.className = "rubric-reason";
  reason.hidden = retiring.length === 0;
  if (retiring.length > 0) {
    const why = document.createElement("p");
    why.textContent = `这次编辑会撤下 ${retiring.length} 条正挡着闸门的标准。`
      + "撤下它们等于关掉它们开出的问题 —— 说明理由。";
    const input = document.createElement("input");
    input.placeholder = "为什么这条本来就不该要求";
    input.value = editing.reason ?? "";
    input.addEventListener("input", () => { editing.reason = input.value; });
    reason.append(why, input);
  }
  parts.push(reason);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "rubric-add";
  save.textContent = "保存这一版";
  save.addEventListener("click", () => { void saveRubric(); });
  parts.push(save);

  if (editing.note) {
    const note = document.createElement("p");
    note.className = "rubric-note" + (editing.note.bad ? " bad" : "");
    note.textContent = editing.note.text;
    parts.push(note);
  }

  sheetRubric.replaceChildren(...parts);
}

const VERDICT_LABEL = {
  yes: "满足",
  no: "不满足",
  not_assessed: "未评估",
};

/**
 * 这一轮这个角色判了什么。
 *
 * **为什么非显示不可**：`no` 会派生出 standard gap，在「问题」页签看得到；但
 * `yes` 和 `not_assessed` **不留任何痕迹** —— 于是「都通过了」和「模型压根没照
 * 契约作答」在 gaps 里长得一模一样（两边都没有 standard）。
 *
 * 而这两件事的处理方式完全相反：前者可以放行，后者要去看契约为什么没被遵守。
 * 不显示出来，人就只能靠猜。
 */
function drawVerdicts() {
  const box = document.createElement("div");
  const entry = phases.find((item) => item.phase === editing.phase);
  const round = entry?.assessed;

  const head = document.createElement("p");
  head.className = "sheet-section";

  /*
   * 不进对抗的那一份（裁判自己那份）——**照实说**。
   *
   * 这一支要排在最前面：对它来说「这个阶段还没跑过判定」和「这个角色当时没有
   * rubric」两句话都是假的。标准在，只是链排到裁判就没有下一个模型了，让它对照
   * 自己那份打分等于把刚拿掉的毛病装回去。所以它交给人。
   *
   * 这一屏的文案不许写 markdown —— textContent 会把星号原样画出来。
   */
  if (editing.assessedBy === null) {
    head.textContent = "这一份不进对抗，由你自己判";
    box.append(head);
    const why = document.createElement("p");
    why.className = "rubric-note";
    why.textContent = "裁判是你直接在读的那一个：对照下面这几条，看它这一轮的表态"
      + "（关掉了哪些问题、理由站不站得住）。模型不判它 —— 让它给自己打分，"
      + "就回到「模型说没问题」了。";
    box.append(why);
    return box;
  }

  if (!round) {
    head.textContent = "这个阶段还没跑过 rubric 判定";
    box.append(head);
    return box;
  }

  const mine = round.byRole[editing.role] ?? [];
  head.textContent = `第 ${round.round} 轮判定`;
  box.append(head);

  if (mine.length === 0) {
    const none = document.createElement("p");
    none.className = "sheet-empty";
    none.textContent = "这个角色当时没有 rubric，所以没有判定。";
    box.append(none);
    return box;
  }

  const unanswered = mine.filter((item) => item.verdict === "not_assessed").length;
  if (unanswered === mine.length) {
    // 这一条要显眼：它和「全部通过」在 gaps 里是同一个样子。
    const warn = document.createElement("p");
    warn.className = "rubric-note bad";
    warn.textContent = "这一轮一条都没答上 —— 模型没照契约作答，不是「都通过了」。";
    box.append(warn);
  }

  for (const item of mine) {
    const row = document.createElement("div");
    row.className = `gap ${item.verdict === "yes" ? "closed" : "open"}`;

    const tag = document.createElement("b");
    tag.className = "gap-sev";
    tag.textContent = VERDICT_LABEL[item.verdict] ?? item.verdict;

    const text = document.createElement("div");
    text.className = "gap-text";
    const title = document.createElement("strong");
    // 判定当时的正文，不是当前 rubric 的 —— 快照，永不回溯派生。
    title.textContent = item.criterionText;
    text.append(title);
    if (item.evidence) {
      const why = document.createElement("em");
      why.textContent = item.evidence;
      text.append(why);
    }

    row.append(tag, text);
    box.append(row);
  }
  return box;
}

const SAVE_REFUSALS = {
  reason_required: "撤下正挡着闸门的标准要写明理由。",
  untrusted_key: "有一条 criterion 的编号不属于这份 rubric，整次编辑被拒绝了。",
  text_empty: "有一条标准是空的。",
  key_reused: "同一个编号出现了两次。",
};

async function saveRubric() {
  if (!editing) return;
  const response = await fetch(
    `/api/rubric?change=${encodeURIComponent(changeId)}`
    + `&phase=${encodeURIComponent(editing.phase)}&role=${encodeURIComponent(editing.role)}`,
    {
      method: "POST",
      body: JSON.stringify({
        scope: editing.scope,
        drafts: editing.drafts,
        reason: editing.reason,
      }),
    });

  if (!response.ok) {
    editing.note = { text: `没存成：${await response.text()}`, bad: true };
    drawRubric();
    return;
  }
  const result = await response.json();
  if (!result.saved) {
    editing.note = {
      text: SAVE_REFUSALS[result.reason] ?? `没存成：${result.reason}`, bad: true,
    };
    drawRubric();
    return;
  }

  // 存成了：重新读一遍，这样 saved 与 drafts 重新对齐，理由框也会收起来。
  await loadRubric(editing.phase, editing.role);
  editing.note = {
    text: `第 ${result.version} 版已保存。`
      + (result.retired.length > 0 ? `撤下了 ${result.retired.length} 条，它们开出的问题已退休。` : ""),
    bad: false,
  };
  drawRubric();
  await loadOrReconnect(); // 环上的颜色可能变了
}

tabGaps.addEventListener("click", () => { showTab("gaps"); });
tabRubric.addEventListener("click", () => { showTab("rubric"); });
sunButton.addEventListener("click", () => { toggleSunCard(); });

