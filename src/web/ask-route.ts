import { readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { checkAsk } from "../domain/ask";
import { AskStore, askById } from "../store/ask-store";
import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import { HandoffStore } from "../store/handoff-store";
import { ProjectStore } from "../store/project-store";
import { defaultChange } from "./bind-project";
import { projectRootOf, sameProject, wrongProjectReason } from "./same-project";

/**
 * 模型在自己的会话里问了人一句 —— 这条路把它接进工作台。
 *
 * ## 它组装什么
 *
 * 模型交上来的只有**一个小整数和散文**（`domain/ask.ts` 开头说了为什么）。于是
 * 「这是哪个 Change、哪个阶段、第几轮、哪一条判据」四样全得由 StagePass 自己认：
 *
 *   备着的轮      有且只有一条 `waiting` 的 `HandedRound`，那就是它
 *   判据单条数    `HandedRound.blueRubric.count`
 *   ordinal→判据  `HandedRound.rubricIds` —— **备那一刻的版本**
 *
 * ## 每一种失败都要让模型自己走得下去
 *
 * 这条路的调用方是一个模型，它看不到面板、也看不到日志。所以 `reason` 里必须有它
 * 能照着做的下一步（改哪个参数、或者告诉人去按哪个按钮）。范式来自
 * `domain/worklist.ts` 的 `bad_answer`：答错不抛异常，把允许值原样回给它。
 *
 * ## 认不出唯一那一轮时**不猜**
 *
 * 两轮同时备着是 StagePass 自己的 bug（TechSpec §十一·3：一个项目同时只允许一条
 * `waiting`）。挑一条最近的接着往下走，会把这一问挂到另一个 Change 上，而落档之后
 * 没有任何东西说得出它挂错了 —— 照直说，比猜对九次强。
 */

export interface AskRouteDeps {
  /** **可写**的库句柄 —— 这条路要落档。 */
  readonly database: Database.Database;
  /**
   * 工作台绑着的那个项目。**必填** —— 少了它，别的项目里一条没结算的旧轮就能
   * 把这一问接走（见 `HandoffStore.allWaiting`）。
   */
  readonly boundProjectId: string;
  /** 注进来，好让测试里的时间是确定的。 */
  readonly now?: () => Date;
}

export interface AskedOne {
  readonly askId: string;
  readonly ordinal: number | null;
  readonly question: string;
  /** 这一条挂着的判据原文，拿得到才有。 */
  readonly rubricText?: string;
}

export interface AskFromModelResult {
  readonly ok: boolean;
  /** 这一批真的落进账本的那几条，**按送来的顺序**。 */
  readonly asked?: readonly AskedOne[];
  readonly error?: string;
  readonly reason?: string;
}

/**
 * 判据单铺的是**哪一份 rubric** —— `work/rubric-round.ts` 的 `ASSESSED_BY` 说了算：
 * `by: "blue"` 的只有 `producer` 一个角色（那边有断言挡着，真多出第二份会当场抛）。
 *
 * 这一层够不着那张表（它在 L5，这条路在 L4，分层是单向的），所以角色名在这儿写了
 * 第二遍。**对不上时给 null，不换一个角色顶上**：挂错版本的留档比没有版本更坏 ——
 * 后者一眼看得出缺，前者半年后没人分辨得出来。
 */
const SHEET_ROLE = "producer";

const fail = (error: string, reason: string): AskFromModelResult =>
  ({ ok: false, error, reason });

/**
 * 这一问该挂在哪儿。
 *
 * ## 判据从「哪一轮」降成了「哪个 Change、哪个阶段」（2026-08-19 晚）
 *
 * 原来这里要求先有一条 `status='waiting'` 的 `HandedRound`，没有就回 `no_open_round`。
 * **而人的实际场景里，提问发生在还没有轮的时候** —— 他和模型先自由聊，聊得差不多了
 * 模型才调这个工具确认理解对不对。那时「备一轮」这一步压根还没发生，也不该发生。
 *
 * 用户原话：「我压根没法点击取题面和我自己跑」「我和 AI 先聊聊，差不多了，AI 调面板
 * 我来选择确定」。那堵墙是我加的，不是他的流程需要的。
 *
 * 阶段本来就在 Change 的状态里，所以降一级之后什么都不缺。备着的轮**仍然优先**
 * —— 有轮的时候它带着判据单，`ordinal` 才有东西可挂。
 *
 * ## 为什么必须把认到的 Change 报回去
 *
 * 一个项目里可能有好几条 Change，而模型说不出自己在哪一条上；这里挑的是面板默认
 * 看的那一条（`defaultChange`，同一个函数，所以两边天然一致）。人在浏览器上看着
 * 另一条时就会错位 —— **让它错得看得见**：把 Change 和阶段一起念给模型，它会转告。
 * 悄悄记到别的 Change 上，比记不上更坏。
 */
interface AskTarget {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly sheetCount: number;
  readonly rubricId: string | null;
  readonly criteriaPath: string | null;
}

/** 备着多于一轮 —— 这是账不对，不是问错了。**不挑一条。** */
class AmbiguousRoundError extends Error {
  constructor(readonly rounds: readonly { changeId: string; phase: Phase; round: number }[]) {
    super("ambiguous_round");
  }
}

function targetFor(deps: AskRouteDeps): AskTarget | null {
  const waiting = new HandoffStore(deps.database).allWaiting(deps.boundProjectId);
  /*
   * **降级之后这道闸更要留着。** 有轮的时候它带着判据单，挑错一条就是把这一问挂到
   * 别的阶段的判据上 —— 而降级那条路（挂到默认 Change）根本不碰判据单，两者不是
   * 一回事，不能拿后者去兜前者的错。
   */
  if (waiting.length > 1) throw new AmbiguousRoundError(waiting);
  const round = waiting[0];
  if (round !== undefined) {
    return {
      changeId: round.changeId,
      phase: round.phase,
      round: round.round,
      sheetCount: round.blueRubric?.count ?? 0,
      rubricId: round.rubricIds[SHEET_ROLE] ?? null,
      criteriaPath: round.blueRubric?.criteriaPath ?? null,
    };
  }

  const changeId = defaultChange(deps.database, deps.boundProjectId);
  if (changeId === null) return null;
  /*
   * **第 0 轮 = 还没交过稿的那一段。** 起草期的问答不属于任何一轮，而 `asks.round`
   * 是 NOT NULL —— 用 0 表示它，比编一个 1 出来诚实：账本上「第 0 轮」一眼看得出
   * 是聊出来的，不是某一轮跑出来的。
   */
  return {
    changeId,
    phase: new ChangeStore(deps.database).read(changeId).state.phase,
    round: 0,
    sheetCount: 0,
    rubricId: null,
    criteriaPath: null,
  };
}

export function askFromModel(deps: AskRouteDeps, body: string): AskFromModelResult {
  let round: AskTarget | null;
  try {
    round = targetFor(deps);
  } catch (error) {
    if (!(error instanceof AmbiguousRoundError)) throw error;
    const which = error.rounds
      .map((one) => `${one.changeId}/${one.phase} 第 ${one.round} 轮`).join("、");
    return fail(
      "ambiguous_round",
      `现在同时备着 ${error.rounds.length} 轮（${which}），而一次只该有一轮在等人。`
      + "这是 StagePass 自己的账不对，不是你问错了 —— 请人去面板上把多余的那几轮"
      + "撤掉或结算掉，再问一次。**我不替你猜是哪一轮。**",
    );
  }
  if (round === null) {
    return fail(
      "no_change",
      "这个项目里还没有任何 Change，所以这一问挂不上任何东西。"
      + "请人去 StagePass 面板上新建一条，再问一次。",
    );
  }

  /*
   * **项目对不上就到此为止** —— 在读题面、落档之前。放到后面判，前面那几步
   * 已经按错的项目算过一遍了。
   */
  let cwd: unknown;
  try { cwd = (JSON.parse(body) as { cwd?: unknown }).cwd; } catch { cwd = undefined; }
  const root = projectRootOf(deps.database, deps.boundProjectId);
  if (!sameProject(root, cwd)) {
    return fail("wrong_project", wrongProjectReason(root, cwd));
  }

  const sheetCount = round.sheetCount;
  const checked = checkAsk(body, sheetCount);
  if (!checked.ok) return fail(checked.error, checked.reason);

  const path = asksPathOf(deps.database, round.changeId);
  if (path === null) {
    return fail(
      "project_has_no_path",
      "这个项目还没填代码目录，问答的正本（.stagepass/asks.jsonl）没地方落。"
      + "请人去面板上把项目路径填上 —— 留档落不下来的话，这一问就问过即忘了。",
    );
  }

  const store = deps.now === undefined
    ? new AskStore(deps.database, path)
    : new AskStore(deps.database, path, deps.now);

  /*
   * **整批一起落，一条都不许半途而废。**
   *
   * 中途写失败时前面几条已经在账本里了，而模型会以为整批都没问出去 —— 那时人在
   * 面板上看到几条没人答的提问，而会话里谁都不知道它们存在。所以失败的那一句要
   * 说清**已经落了几条**，别只说「失败了」。
   */
  const asked: { askId: string; ordinal: number | null; question: string; rubricText?: string }[] = [];
  for (const request of checked.requests) {
    try {
      const one = store.record({
        changeId: round.changeId,
        phase: round.phase,
        round: round.round,
        // 判据单为空时不挂判据 —— `checkAsk` 已经保证那时 `ordinal` 是 null。
        rubricId: request.ordinal === null ? null : round.rubricId,
        ordinal: request.ordinal,
        question: request.question,
        why: request.why,
        options: request.options,
      });
      const text = rubricTextOf(round, request.ordinal);
      asked.push({
        askId: one.id, ordinal: request.ordinal, question: request.question,
        ...(text === null ? {} : { rubricText: text }),
      });
    } catch (error) {
      return fail(
        "cannot_record",
        `留档写到第 ${asked.length + 1} 条就断了（${String(error)}）。`
        + (asked.length === 0
          ? "一条都没落，这一批没有发生过，别等答案。"
          : `**前 ${asked.length} 条已经落进账本了**（${asked.map((a) => a.askId).join("、")}），`
            + "它们是真的在等人答。剩下的没落。"),
      );
    }
  }

  /*
   * **不再有顶层的 `askId` / `rubricText`。** 一批里它们各是各的，留一个顶层的
   * 就是「第一条的」—— 那种字段在单条时看着没错，在一批时会让调用方悄悄用错人。
   */
  return { ok: true, asked };
}

/**
 * 判据单第 N 条的原文。**从这一轮自己那份题面文件里读**。
 *
 * 不去库里按 rubric id 取，有两条理由：一是这一层够不着 `store/rubric-store`（L5）；
 * 二是这份文件正是**模型眼前看着的那一份** —— 回给它的原文和它读到的是同一串字，
 * 「你问的是不是这一条」才问得出答案。
 *
 * 读不回来就不给（返回 null）：这一格是拿来确认的，宁可没有，也不能给一条对不上的。
 * 文件的样子由 `work/rubric-round.ts` 的 `blueRubricFiles` 铺（`1. 正文`）。
 */
function rubricTextOf(round: AskTarget, ordinal: number | null): string | null {
  if (ordinal === null || round.criteriaPath === null) return null;
  let text: string;
  try {
    text = readFileSync(round.criteriaPath, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split("\n")) {
    const matched = /^\s*(\d+)\.\s+(.*\S)\s*$/.exec(raw);
    if (matched && Number(matched[1]) === ordinal) return matched[2]!;
  }
  return null;
}

/**
 * 这个 Change 的问答正本落在哪：`<项目>/.stagepass/asks.jsonl`。
 *
 * 跟着 Change 走、可 commit、可 diff（TechSpec §五）。**代价是 StagePass 会往人的
 * 项目里写一个目录** —— 进不进 `.gitignore` 由他自己定，不由 StagePass 替他写。
 *
 * 项目没填路径就是 null：没地方落正本，而「只写库」正是这套东西不肯要的那一半。
 *
 * `api.ts` 里有一份同形的 `projectRoot`（产物那条路要它）。没有合并，是因为这一层
 * 够不着那一层（L4 / L5，分层是单向的）。**它们查的是同一件事，改一个要看另一个。**
 */
function asksPathOf(
  database: Database.Database,
  changeId: string,
): string | null {
  try {
    const change = new ChangeStore(database).read(changeId);
    if (change.projectId === null) return null;
    const root = new ProjectStore(database).read(change.projectId).path;
    return root === null || root === "" ? null : join(root, ".stagepass", "asks.jsonl");
  } catch {
    return null;
  }
}

/** 人答完之后回填。**只回填**，不判对错 —— 对错是人的事。 */
export interface AnswerAskResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly reason?: string;
}

const answerFail = (error: string, reason: string): AnswerAskResult =>
  ({ ok: false, error, reason });

/**
 * 把人选的那一项落回那条提问。
 *
 * ## 为什么它必须存在
 *
 * 没有它，`AskStore.answer` 全树没有生产调用方 —— 留档只记得住「问过什么」，
 * 记不住「答了什么」，而**账本记一半比不记更坏**：半年后翻到一条没有答案的提问，
 * 分不清是当时没答，还是这条路根本没接上。
 *
 * ## 三道闸都是「正本只追加」逼出来的
 *
 * 正本一条提问占两行（问一行、答一行）。所以重答会追加第二条补记，而重建时后一条
 * 覆盖前一条 —— 那等于**悄悄改写已经落地的账**。宁可拒。
 */
export function answerAsk(deps: AskRouteDeps, body: string): AnswerAskResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return answerFail("unreadable_request", "请求不是一份能读的 JSON。");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return answerFail("unreadable_request", "请求要是一个对象：{ askId, chosen, note? }。");
  }
  const { askId, chosen, note } = parsed as Record<string, unknown>;
  if (typeof askId !== "string" || askId === "") {
    return answerFail("no_ask_id", "要说清楚回填的是哪一条提问（askId）。");
  }
  if (typeof chosen !== "string" || chosen === "") {
    return answerFail("no_choice", "没有选择可落 —— 人没选就别回填，让它留着当未答。");
  }

  const ask = askById(deps.database, askId);
  if (ask === null) {
    return answerFail("no_such_ask", `账本里没有 ${askId} 这一条提问。`);
  }
  if (ask.answeredAt !== null) {
    return answerFail(
      "already_answered",
      `${askId} 已经在 ${ask.answeredAt} 答过「${ask.chosen}」了。`
      + "正本只追加，重答会在账上留下两个答案 —— 要改主意，问一条新的。",
    );
  }
  /*
   * 选项是 StagePass 铺的，人只能在里面挑。收到不在名单里的值，说明中间那一层
   * 改写过它 —— 把允许值原样回给调用方，和名单那边 `bad_answer` 同一个范式。
   */
  if (!ask.options.includes(chosen)) {
    return answerFail(
      "bad_choice",
      `「${chosen}」不在这一问的选项里。只能是：${ask.options.map((o) => `「${o}」`).join("、")}`,
    );
  }

  const path = asksPathOf(deps.database, ask.changeId);
  if (path === null) {
    return answerFail(
      "project_has_no_path",
      "这个项目没填代码目录，正本没地方追加 —— 而只写库正是这套东西不肯要的那一半。",
    );
  }
  const store = deps.now === undefined
    ? new AskStore(deps.database, path)
    : new AskStore(deps.database, path, deps.now);
  try {
    store.answer(askId, chosen, typeof note === "string" && note !== "" ? note : null);
  } catch (error) {
    return answerFail("cannot_record", `落不下去：${(error as Error).message}`);
  }
  return { ok: true };
}
