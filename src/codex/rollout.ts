/**
 * Reading a Codex session file.
 *
 * A rollout is the record of everything that happened in a thread: one JSON
 * object per line, appended as the turn runs. It is the only place StagePass
 * can learn what a TUI turn did, because a TUI is not a child process handing
 * back a return value -- it is a window somebody is watching.
 *
 * ## Why this is where StagePass listens
 *
 * Measured 2026-07-28: the TUI, the Desktop app and `codex mcp-server` all
 * share `~/.codex` -- the App's `app-server` process was holding both
 * `state_5.sqlite` and a rollout file created by mcp-server open at the same
 * time. And `codex resume` appends to the file its thread already had rather
 * than starting a new one. So the rollout is the substrate every surface writes
 * to, which makes it the one thing StagePass can depend on without caring which
 * window the human is in.
 *
 * ## This module is pure
 *
 * Lines in, findings out. No filesystem, no clock -- so "did this turn finish"
 * is provable offline against captured records instead of by running a turn and
 * watching a window.
 */

export interface RolloutRecord {
  readonly type?: unknown;
  readonly payload?: {
    type?: unknown;
    message?: unknown;
    /** `response_item` 的正文：`[{type:"input_text", text:"…"}]`。 */
    content?: unknown;
    /** 以下四个只有 `session_meta` 有 —— 见 `lineageOf`。 */
    id?: unknown;
    parent_thread_id?: unknown;
    thread_source?: unknown;
    source?: unknown;
    timestamp?: unknown;
    /** 只有 `token_count` 有 —— 见 `contextUsageOf`。 */
    info?: unknown;
  } | undefined;
  readonly timestamp?: unknown;
}

export function parseRollout(text: string): RolloutRecord[] {
  const records: RolloutRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RolloutRecord);
    } catch {
      // A half-written last line is normal: the file is being appended to
      // while it is read. Skipping it and reading again is correct; throwing
      // would make a routine race look like a corrupt session.
    }
  }
  return records;
}

function eventType(record: RolloutRecord): string | null {
  if (record.type !== "event_msg") return null;
  const type = record.payload?.type;
  return typeof type === "string" ? type : null;
}

export interface TurnOutcome {
  /** Everything the model said in the completed turn. */
  readonly text: string;
}

export interface ContextUsage {
  /** 最近一次请求真实装进上下文的 token 数（input 已含全部历史 + 这次的 output）。 */
  readonly used: number;
  readonly window: number;
}

/**
 * 这条线程离上下文墙多远（BACKLOG §3.3·11）。
 *
 * 每次请求后 Codex 都往 rollout 里落一条 `token_count`，`info.last_token_usage`
 * 是**这一次**请求的量 —— 它的 `input_tokens` 已经装着全部历史，加上这次的输出
 * 就是下一次的起点。取**最后一个**读得出来的：线程一直在长，旧的读了就是假话。
 *
 * （`total_token_usage` 不是它 —— 那是跨请求的累计账单，第二轮起就超过窗口。）
 *
 * 读不出来往前找，一个都没有就 null —— 「说不出」照实说，不编一个数。
 */
export function contextUsageOf(
  records: readonly RolloutRecord[],
): ContextUsage | null {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (eventType(record) !== "token_count") continue;
    const info = record.payload?.info;
    if (typeof info !== "object" || info === null) continue;
    const last = (info as { last_token_usage?: unknown }).last_token_usage;
    const window = (info as { model_context_window?: unknown }).model_context_window;
    if (typeof last !== "object" || last === null || typeof window !== "number") continue;
    const input = (last as { input_tokens?: unknown }).input_tokens;
    const output = (last as { output_tokens?: unknown }).output_tokens;
    if (typeof input !== "number" || typeof output !== "number") continue;
    return { used: input + output, window };
  }
  return null;
}

/**
 * The result of the first turn that both starts and finishes after `fromIndex`.
 *
 * `fromIndex` is how many records the file held before StagePass asked for this
 * turn. Without it the scan would happily return the answer to the PREVIOUS
 * question -- a rollout accumulates every turn the thread has ever had, and
 * `codex resume` appends to the same file.
 */
export function findCompletedTurn(
  records: readonly RolloutRecord[],
  fromIndex: number,
): TurnOutcome | null {
  let started = false;
  const said: string[] = [];

  for (let index = fromIndex; index < records.length; index += 1) {
    const record = records[index]!;
    const type = eventType(record);
    if (type === "task_started") {
      // A new turn begins: anything collected so far belonged to an earlier
      // one that never completed.
      started = true;
      said.length = 0;
      continue;
    }
    if (!started) continue;
    if (type === "agent_message") {
      const message = record.payload?.message;
      if (typeof message === "string" && message !== "") said.push(message);
      continue;
    }
    if (type === "task_complete") {
      return { text: said.join("\n") };
    }
  }
  return null;
}

/**
 * **最后**一个跑完的 turn。
 *
 * ## 和 `findCompletedTurn` 的分工
 *
 * 那一个给的是「我问出去之后的第一个答案」，靠调用方数出问之前有几条记录
 * （`CodexTuiTransport` 就是这么用的）。**这一个给的是「这条线程最新说完的那句」**，
 * 用在数不出那个数的地方。
 *
 * ## 数不出来的那个地方，是子 Agent
 *
 * 2026-07-30 在真 Codex 上撞到的：子 Agent 的线程**跨轮复用**，`/root/red` 那条
 * rollout 里同时躺着第 2 轮和第 3 轮的答案。而 `readRoleTranscript` 一直传
 * `fromIndex: 0` —— 于是**第二轮起，读到的一直是第一轮红蓝说的话**。
 *
 * 症状极隐蔽：轮次照常结算、gap 看着也合理，只是内容永远停在第一轮。实测那次红方
 * 第 3 轮明明读完了文档、报出一条新的 P0，库里记下来的还是第 2 轮那句「文件不存在」。
 *
 * StagePass 不盯子 Agent 的文件（它只在一轮结束后去读一次），所以那个「问之前有几条」
 * 根本不存在。取最后一个是这里唯一说得通的定义。
 *
 * 半截的最后一轮**不算** —— 交出没说完的话，等于把过程当成结论。
 */
export function findLastCompletedTurn(
  records: readonly RolloutRecord[],
): TurnOutcome | null {
  let started = false;
  let said: string[] = [];
  let latest: TurnOutcome | null = null;

  for (const record of records) {
    const type = eventType(record);
    if (type === "task_started") {
      started = true;
      said = [];
      continue;
    }
    if (!started) continue;
    if (type === "agent_message") {
      const message = record.payload?.message;
      if (typeof message === "string" && message !== "") said.push(message);
      continue;
    }
    if (type === "task_complete") {
      latest = { text: said.join("\n") };
      started = false;
      said = [];
    }
  }
  return latest;
}

/**
 * 这条线程里出现过的全部文本 —— **它说过的，和它被告知的。**
 *
 * ## 和上面两个的分工
 *
 * `findCompletedTurn` / `findLastCompletedTurn` 只收 `agent_message`，也就是**模型
 * 说过的话**。那是对的：一轮的产出、意见、裁决都在它说的话里，读别的只会把提示词
 * 当成答案。
 *
 * 但有一个问题它们答不了：**这条线程到底有没有收到过某样东西。** 契约在「它被问到
 * 的那一段」里，不在它说的话里。而「反方没答」和「反方压根没收到」是两件必须分开的
 * 事 —— 前者是它的问题，后者是转达断了，人要做的事完全不同（见
 * docs/DESIGN-rubric-delivery-2026-07-31.md §3.3）。
 *
 * ## 为什么可以拿它当「收到过」的判据
 *
 * 判据是 criterion key 出现过没有，而 key 是 `RBC-<uuid>`。散文撞上一个 uuid 的
 * 可能性可以忽略，所以这是个**机械可查的事实**，不是推测。
 *
 * ## 收哪些
 *
 * 2026-07-31 在真 rollout 上核过，转达进来的提示词同时落在两种记录上：
 *
 *   event_msg / user_message      -> payload.message
 *   response_item / message       -> payload.content[].text   （role 是 user / assistant / developer）
 *
 * 两种都收，重复无所谓 —— 这个函数的唯一用途是「找得到吗」，不是重建对话。
 * 按记录类型分别取字段，而不是递归地把所有 `text` 捞一遍：后者今天也能跑通，但
 * 它对 Codex 的记录结构不做任何假设，也就意味着结构变了它不会失败，只会安静地
 * 少捞或多捞。
 */
export function allTextIn(records: readonly RolloutRecord[]): string {
  const said: string[] = [];
  for (const record of records) {
    const message = record.payload?.message;
    if (typeof message === "string" && message !== "") said.push(message);

    const content = record.payload?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text !== "") said.push(text);
    }
  }
  return said.join("\n");
}

/**
 * A thread id, taken from a rollout's filename.
 *
 * `rollout-<timestamp>-<uuid>.jsonl`. Reading it from the name rather than from
 * `state_5.sqlite` keeps StagePass out of Codex's database entirely -- a weaker
 * dependency, though still a convention rather than a published interface.
 */
const ROLLOUT_NAME =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function threadIdFromRolloutName(name: string): string | null {
  return ROLLOUT_NAME.exec(name)?.[1]?.toLowerCase() ?? null;
}

export interface ThreadLineage {
  readonly threadId: string;
  /**
   * 派生它的那条线程。**`null` 就是「不可当作某条线程的子 Agent」** ——
   * 「它不是子 Agent」和「它是子 Agent 但没记下爹」在这里合成同一个值，是刻意的：
   * 两者要做的事一样（不认它），分开只会让调用方多一个它无法处理的分支。
   */
  readonly parentThreadId: string | null;
  /** 它自己报的出生时刻。派生顺序靠它排，读不到就是 `null`。 */
  readonly startedAt: string | null;
}

/**
 * 一条线程的血缘，从它 rollout 的 `session_meta` 里读。
 *
 * ## 为什么这条能取代「让裁判报 id」
 *
 * 认红蓝原来靠 `state_5.sqlite` 的 `threads.agent_path`，而**那一列只有原生
 * `spawn_agent({task_name})` 会设** —— 那个工具不是每个会话都有（2026-07-30 实测），
 * 没有它的会话里每个阶段的每一轮都跑不了。于是 2026-07-30 改成让裁判把两个
 * `agent_id` 报进答案，而那把一个 36 字符的 UUID 放进了模型必须手抄的文本里：
 * 抄错一个字符，这一轮就作废，正反两方说的话谁也看不到（`02059a8` 是实测的一次）。
 *
 * `parent_thread_id` 和 `agent_path` 不是一回事 —— 它说的是线程血缘，不是 Agent
 * 起了什么名字。2026-08-02 在 CHG-003 那一趟的 100 条真线程上数过：
 *
 *     subagent 76 条
 *       parent_thread_id 有值：76/76
 *       agent_path       有值： 1/76
 *
 * 所以当年放弃走库那条路的理由，对这一列不成立。
 *
 * ## 判据要三样都对上
 *
 * `thread_source === "subagent"`、有 parent、**而且 `source.subagent.thread_spawn`
 * 在**。少任何一样都不认。
 *
 * 第三样不是多余的：**不是每个子 Agent 都是被 spawn 出来的红蓝。** 2026-08-02 在真
 * 会话目录里见到过 `source: {"subagent": {"other": "guardian"}}` —— Codex 自己派的
 * 一种审查子 Agent，它同样是 `thread_source: "subagent"`、同样带 parent。那一条挂在
 * 别的项目下，但只要它哪天挂到裁判线程下，就会被当成红方或蓝方，**而 StagePass 会
 * 把它说的话写进 gap**。
 *
 * 只看 parent 同理：将来 Codex 给 `resume` 之类也填上这一列，一条根本不是子 Agent
 * 的线程就会被认下来。fail-closed 的方向是宁可不认 —— 认不出两条会大声失败，
 * 而认错一条是静默地把别人的话记到红蓝头上。
 *
 * ## ⚠ 这些 id 是 UUIDv7，绝不能用前缀匹配
 *
 * 前 8 位是时间戳而不是随机数，隔几秒生成的两条线程前缀就撞（实测：`019fc396`
 * 派生的 7 个子 Agent 是 `019fc39f`/`019fc3a2`/`019fc3a5`/…）。`criterion_key`
 * 那边用的是 `randomUUID()`（v4，真随机），两者不能混为一谈。
 */
export function lineageOf(records: readonly RolloutRecord[]): ThreadLineage | null {
  for (const record of records) {
    if (record.type !== "session_meta") continue;
    const payload = record.payload;
    const threadId = payload?.id;
    if (typeof threadId !== "string" || threadId === "") return null;

    const parent = payload?.parent_thread_id;
    const subagent = (payload?.source as { subagent?: unknown } | null)?.subagent;
    const spawned = payload?.thread_source === "subagent"
      && (subagent as { thread_spawn?: unknown } | null)?.thread_spawn !== undefined;
    const startedAt = payload?.timestamp ?? record.timestamp;

    return {
      threadId: threadId.toLowerCase(),
      parentThreadId: spawned && typeof parent === "string" && parent !== ""
        ? parent.toLowerCase()
        : null,
      startedAt: typeof startedAt === "string" && startedAt !== "" ? startedAt : null,
    };
  }
  return null;
}
