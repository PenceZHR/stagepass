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

const orbitView = document.getElementById("orbit-view");
const stageView = document.getElementById("stage-view");
const wrap = document.getElementById("orbit-wrap");
const portal = document.getElementById("portal");
const centerKicker = document.getElementById("center-kicker");
const centerTitle = document.getElementById("center-title");
const centerLine = document.getElementById("center-line");
const centerCount = document.getElementById("center-count");
const columns = document.getElementById("columns");
const stageName = document.getElementById("stage-name");
const stageThread = document.getElementById("stage-thread");
const stageNote = document.getElementById("stage-note");
/** 终端底下那行注解的原话。say() 会盖掉它，进终端时还原。 */
const NOTE_DEFAULT = stageNote.textContent;

// 左侧 40% 的常驻面板
const statusKicker = document.getElementById("status-kicker");
const statusTitle = document.getElementById("status-title");
const statusMark = document.getElementById("status-mark");
const statusLine = document.getElementById("status-line");
const statusFacts = document.getElementById("status-facts");
const statusFoot = document.getElementById("status-foot");

// 点小环打开的弹窗
const sheet = document.getElementById("sheet");
const sheetKicker = document.getElementById("sheet-kicker");
const sheetTitle = document.getElementById("sheet-title");
const sheetMark = document.getElementById("sheet-mark");
const sheetLine = document.getElementById("sheet-line");
const sheetGaps = document.getElementById("sheet-gaps");
const sheetRubric = document.getElementById("sheet-rubric");
const tabGaps = document.getElementById("tab-gaps");
const tabRubric = document.getElementById("tab-rubric");
const enterButton = document.getElementById("enter");
const waiveButton = document.getElementById("waive");
const briefButton = document.getElementById("brief");
const closeTermButton = document.getElementById("close-term");
const termTabs = document.getElementById("term-tabs");
const nextStepLine = document.getElementById("next-step");
const runButton = document.getElementById("run");
const askButton = document.getElementById("ask");

document.getElementById("crumb-change").textContent = changeId;

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
term.open(document.getElementById("term"));

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

/**
 * 现在这块屏幕上画的是哪一格：`null` = 这个阶段的主线终端（裁判），
 * 字符串 = 补问那一格的标签。
 *
 * 补问跑在**另一条线程**上，所以它不是主线终端的一部分；而它跑完就被服务端收掉，
 * 所以这个值随时可能失效 —— `attach` 拿不到就退回主线，见那边。
 */
let viewing = null;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Keystrokes out. Text until they are sent; bytes from there on.
 *
 * **打给屏幕上正在画的那一格，不是永远打给主线。** `viewing` 记的就是这件事，
 * 而它原来只用于画面 —— 于是人在补问那格里敲的键全落到裁判那条主线上。
 * 2026-08-03 真机上一整轮死在这里：那下回车打断了裁判正在跑的 turn。
 */
const send = (phase, data) =>
  fetch(
    path(phase, viewing === null
      ? "/in"
      : `/in?label=${encodeURIComponent(viewing)}`),
    { method: "POST", body: new TextEncoder().encode(data) },
  );

function resize(phase) {
  fit.fit();
  return fetch(path(phase, `/resize?cols=${term.cols}&rows=${term.rows}`), { method: "POST" });
}

function statusOf(entry) {
  if (entry.live) return { short: "进程活着", long: "线程活着，点开直接接上去。" };
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

async function pollProgress() {
  let progress;
  try {
    progress = await (await fetch(
      `/api/progress?change=${encodeURIComponent(changeId)}`)).json();
  } catch {
    return; // 一次没拉到不说话，下一次再说 —— 报「读不到进度」比没有进度更吵
  }
  const words = progressWords(progress);
  if (words === null) return;
  // 写在弹窗那一行。人是从弹窗里按下「跑这个阶段」的，结果就该回到那儿。
  sheetLine.textContent = words;
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
    return `${result.phase} 已经开着一个终端了。同一个阶段线程同时只许有一个进程 ——`
      + "先「结束这个终端」。";
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
  runButton.disabled = true;
  runButton.textContent = "派发中…";
  // 这个 fetch 要等整一轮（几分钟）。**进度靠一条独立的只读轮询**，不靠它 ——
  // 等它回来才说话，就是现在这个「几分钟不说话」。
  startProgress();
  try {
    const result = await (await fetch(
      `/api/run?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    )).json();
    const broke = crashed(result);
    if (broke !== null) {
      say(broke);
    } else if (result.ran === false) {
      say(runRefusal(result));
    } else {
      say(`${result.phase} 跑完了：${JSON.stringify(result.outcome)}`);
    }
  } finally {
    stopProgress();
    runButton.textContent = "跑这个阶段";
    await load();
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
    parts.push(`⚠ 闸门拒了这次「${result.outcome.action}」：${result.outcome.reason}`);
  } else {
    parts.push(`裁决 → ${JSON.stringify(result.outcome)}`);
  }
  for (const refused of result.refused ?? []) {
    parts.push(`⚠ ${refused.id}：${REFUSAL_WORDS[refused.code] ?? refused.code}`);
  }
  // 「再来一轮」会当场续跑，不用人再按一次「跑这个阶段」—— 所以要说出来它已经在跑了。
  if (result.continued) {
    parts.push(result.continued.ran
      ? "下一轮已经派出去了"
      : `下一轮没派出去：${result.continued.reason}`);
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
    await load();
  }
}

/**
 * One shared centre, one shared radius.
 *
 * 0.455 和 CSS 里 `.halo { inset: 4.5% }` 是同一个数：轨道半径也是
 * (1 - 2×0.045) / 2 = 0.455 倍环宽，节点因此正好骑在轨道上。**改一个就要改另一个**，
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
    if (!briefLanded) await load();
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
      say("没有接受任何风险 —— 你按了 Esc，或者名单在这期间变了。");
    } else {
      say(`已接受 ${result.gapId}。它还在，只是不再挡闸门，交付说明里会列出来。`);
    }
  } finally {
    waiveButton.textContent = "接受一条风险";
    await load();
  }
}

function placeNodes() {
  const radius = wrap.clientWidth * 0.455;
  wrap.querySelectorAll(".stage-node").forEach((node) => {
    node.style.setProperty("--r", `${radius}px`);
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
    node.className = "stage-node"
      + (entry.threadId ? " bound" : "")
      + (entry.live ? " live" : "")
      + (entry.mark ? ` ${entry.mark}` : "");
    node.style.setProperty("--a", `${angle}deg`);

    if (entry.current) node.classList.add("current");

    const status = statusOf(entry);
    const button = document.createElement("button");
    button.type = "button";
    button.title = entry.threadId ? `线程 ${entry.threadId}` : "还没有线程";

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
    row.append(name, sub, count, remove);

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
  document.getElementById("projects").replaceChildren(...projectRows);
  document.getElementById("project-count").textContent =
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
  document.getElementById("changes").replaceChildren(...rows);
  document.getElementById("change-count").textContent =
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

  drawCenter();
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
 * 闸门里**要人裁决**的那几项。
 *
 * 只有这三个会被拿去问人。`start` / `settle` / `fail` 是系统在陈述发生了什么，
 * 所以一个只允许这些的闸门根本没有要人做的决定 —— 在那儿放出问人的按钮，会组出
 * 一道没有选项的题，然后回来一个 `no_decision_available`。
 * 这份名单和 domain/question.ts 里的 `gateDecisionQuestion` 是同一份。
 */
function decidableActions() {
  return (panelState?.gate?.permitted ?? []).filter((action) =>
    action === "approve" || action === "reject" || action === "retry");
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
  ]);
  statusFoot.textContent = "点这个阶段的小圈，看它的问题明细。";
}

/**
 * 环心：Change 这一层的锚点，**不随悬停变**。
 *
 * 悬停已经由左边那块面板负责了；中心再跟着变一次，就是同一份信息在一屏上写两遍
 * —— 那正是 §5.0 第 4 条说的"污染"。所以这里放的是整条 Change 的进度。
 */
function drawCenter() {
  const at = phases.find((entry) => entry.current);

  /*
   * 进度圆弧走到当前阶段，不是走到「批准了几个」。
   *
   * 问的是「走到哪了」，而那是 Change 的位置 —— 一个阶段可以正在跑、还没批准，
   * 弧线该已经到它那儿。用批准数会让弧线永远落后一格，看着像卡住了。
   */
  const reached = at === undefined ? 0 : phases.indexOf(at) / phases.length;
  document.getElementById("progress").style.setProperty("--progress", String(reached));
  const approved = phases.filter((entry) => entry.mark === "approved").length;

  centerKicker.textContent = panelState?.status
    ? `Gate · ${panelState.status}` : "Stage Orbit";
  centerTitle.textContent = at ? at.phase : "—";
  centerLine.textContent = at
    ? `${phases.length} 个阶段，停在第 ${phases.indexOf(at) + 1} 个。`
    : "十一个阶段，每个阶段一个 Codex 线程。";
  centerCount.replaceChildren(
    document.createTextNode(`${approved} / ${phases.length}`),
  );
  const unit = document.createElement("em");
  unit.textContent = "Approved";
  centerCount.append(unit);
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

  const decidable = decidableActions();
  runButton.hidden = !entry.current;
  /*
   * **能派的只有 `pending` 和 `running`**，和服务端 `runRound` 那份名单同一份。
   *
   * `running` 也在里面不是笔误：人 `retry` 之后状态就在那儿，而那时正需要派一轮。
   * 真正在跑的那一轮由 `entry.live` 挡住（一个阶段同时只许一个进程）。
   *
   * 2026-07-30 实测：在 `blocked` 上按下去回来的是 HTTP 500、空 body，界面显示
   * 「没跑起来：undefined」—— 亮着的按钮、按下去什么也没有，正是老树那种病。
   */
  const status = panelState?.status ?? "pending";
  runButton.disabled = entry.live || needsBrief
    || (status !== "pending" && status !== "running");
  askButton.hidden = !entry.current;
  askButton.disabled = decidable.length === 0 || entry.live;

  // 出口：有活进程时才出现。没有它，上面每一个 disabled 都是一个没有出路的死结。
  closeTermButton.hidden = !entry.live;
  renderTermTabs(entry);

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

function nextStep(entry) {
  // 顺序 = 优先级。第一条命中的就是答案。
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
    return {
      what: "请 Codex 问我",
      // 这一行是当成纯文本渲染的（`textContent`），所以不写 markdown 的星号 ——
      // 界面上会原样出现两个 `**`。
      why: "上一轮跑失败了。这个阶段现在只接受 retry，而 retry 是你的裁决 ——"
        + "所以它在 Codex 的选择器里问，不在这个按钮上。失败的原因在「问题」里。",
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
async function closeTerminal() {
  const phase = sheetPhase;
  if (!phase) return;
  closeTermButton.disabled = true;
  try {
    await fetch(
      `/api/close?change=${encodeURIComponent(changeId)}`
      + `&phase=${encodeURIComponent(phase)}`, { method: "POST" },
    );
    await load();
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

  await load();
}

async function attach(phase, label = null, reattaching = false) {
  stream = new AbortController();
  const mine = stream;
  viewing = label;
  /*
   * **尺寸只跟主线走。** 补问那格是服务端按自己的需要开的，把这块屏幕的行列数
   * 推给它，会在人切回主线时让它重排一次。
   *
   * 按键则相反 —— 它跟着 `viewing` 走（见 `send`）。原来这里写的是「补问那格
   * 不接受这边的按键」，而实现把按键转给了主线；2026-08-03 真机上，人在补问格里
   * 按的回车打断了裁判正在跑的 turn。今天也证明了人确实需要能敲进那一格：
   * Codex 自己的 MCP 许可提示就出现在那里。
   */
  if (label === null && !reattaching) await resize(phase);

  /*
   * 重连（C3）带 `existing=1`：**只接活着的，不新起。**
   *
   * 裸的 GET 见没有会话就起一个浏览用的新进程 —— 重连走那条路，「进程死了」会被
   * 一个空 composer 盖掉，人以为一切正常。带上这个参数，死了就是 409，注解留在
   * 屏幕上。
   */
  const suffix = label === null
    ? (reattaching ? "?existing=1" : "")
    : `?label=${encodeURIComponent(label)}`;
  const response = await fetch(path(phase, suffix), { signal: stream.signal });
  /*
   * 补问那格跑完就被服务端收掉，于是 409。**退回主线，别把屏幕留在一片空白上** ——
   * 「那一格没了」和「那一格什么都没输出」在人眼里一模一样。
   */
  if (!response.ok) {
    if (mine !== stream) return;
    if (label !== null) {
      // 补问那格没了 —— 退回主线。
      viewing = null;
      term.reset();
      await attach(phase, null);
      return;
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
     */
    if (!reattaching && label === null) {
      await wait(800);
      if (stream !== mine) return; // 人已经走开或换了格子
      await attach(phase, null, true);
    }
  }
}

document.getElementById("back").addEventListener("click", () => { void leave(); });
runButton.addEventListener("click", () => { void run(); });
askButton.addEventListener("click", () => { void ask(); });
briefButton.addEventListener("click", () => { void recordBrief(); });
closeTermButton.addEventListener("click", () => { void closeTerminal(); });
waiveButton.addEventListener("click", () => { void waive(); });
document.getElementById("expand").addEventListener("click", () => { setCollapsed(false); });

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
const projectSheet = document.getElementById("project-sheet");
const projectName = document.getElementById("project-name");
const projectPath = document.getElementById("project-path");
const projectError = document.getElementById("project-error");

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

document.getElementById("new-project").addEventListener("click", () => {
  openProjectSheet();
});
document.getElementById("project-create").addEventListener("click", () => {
  void createProject();
});
document.getElementById("project-cancel").addEventListener("click", () => {
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
const changeSheet = document.getElementById("change-sheet");
const changeTitle = document.getElementById("change-title");
const changeTarget = document.getElementById("change-target");
const changeError = document.getElementById("change-error");

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

document.getElementById("new-change").addEventListener("click", () => {
  openChangeSheet();
});
document.getElementById("change-create").addEventListener("click", () => {
  void createChange();
});
document.getElementById("change-cancel").addEventListener("click", () => {
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
document.getElementById("sheet-close").addEventListener("click", () => { closeSheet(); });
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

void load();

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
  await load(); // 环上的颜色可能变了
}

tabGaps.addEventListener("click", () => { showTab("gaps"); });
tabRubric.addEventListener("click", () => { showTab("rubric"); });

/**
 * 补问那格的标签页。
 *
 * ## 为什么平时整条藏起来
 *
 * 补问只在一次对抗里存在（发现反方没答 → 直接问它 → 拿到答案 → 服务端收掉那一格）。
 * 绝大多数时候一个补问格都没有，而一条永远只有「裁判」一个标签的工具栏是纯噪音。
 *
 * ## 标签名是服务端给的，这里不猜
 *
 * 名字来自 `TurnDispatch.aside.label`，一路原样传到这儿。前端**不解释**它，
 * 也不自己拼 —— 同一个概念两处各写一份必然漂移，而漂移的那天界面会理直气壮地说错话。
 */
function renderTermTabs(entry) {
  const labels = entry?.asides ?? [];
  termTabs.hidden = labels.length === 0;
  if (labels.length === 0) {
    // 那一格没了而屏幕还停在它上面：退回主线。服务端那边已经 409 了，这里只是
    // 让状态跟上，免得下一次 render 还以为在看一个不存在的东西。
    if (viewing !== null && current) void attach(current, null);
    termTabs.replaceChildren();
    return;
  }

  const tab = (label, text) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-selected", String(viewing === label));
    button.addEventListener("click", () => {
      if (viewing === label || !current) return;
      if (stream) { stream.abort(); stream = null; }
      /*
       * **选中态当场就改，别等下一次轮询。**
       *
       * `attach` 是异步的，而重画标签页要等下一次 `/api/panel` 回来 —— 中间那一两秒
       * 里，人点了一下，屏幕清空了，可高亮还停在原来那一格。看起来就是「点了没反应」，
       * 而这正是这个面板从头到尾在防的那类：**做了事，却看不出做了。**
       */
      for (const each of termTabs.querySelectorAll("button")) {
        each.setAttribute("aria-selected", String(each === button));
      }
      term.reset();
      void attach(current, label);
    });
    return button;
  };

  termTabs.replaceChildren(
    tab(null, "裁判"),
    ...labels.map((label) => tab(label, label)),
  );
}
