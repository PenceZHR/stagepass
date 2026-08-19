import type Database from "better-sqlite3";

import type { RepoOps } from "../work/repo";

import { confirmBrief, draftBrief } from "../app/converge-brief";
import { decideGate } from "../app/decide-gate";
import { saveRubric as applyRubricEdit } from "../app/edit-rubric";
import { recordBrief } from "../app/record-brief";
import { waive } from "../app/waive";
import { createChange, createProject } from "../app/workspace";
import { isPhase, type Phase } from "../domain/phase";
import { RUBRIC_ROLES, type RubricRole } from "../domain/rubric";
import { parseRubricEdit, UnreadableEditError } from "../domain/rubric-edit";
import { archiveFinished } from "../codex/archive";
import { AsideStore } from "../store/aside-store";
import { ParallelStore } from "../store/parallel-store";
import { ChangeStore } from "../store/change-store";
import { JobStore } from "../work/job-store";
import { QuestionStore } from "../store/question-store";
import { answerFromChoices, openQuestionOf } from "../web/panel-view";
import type { PluginRuntime } from "./runtime";
import { ASIDE } from "./seats";

/**
 * 会改库的那些路 —— 答题、豁免、建 Change / 项目、存判据、进出旁路。
 *
 * ## 为什么和 `api.ts` 分开
 *
 * `api.ts` 是**只读**的：它拿的库句柄是只读打开的，所以「看一眼」在物理上就不可能
 * 写坏什么（用户的界面原则：看状态不该有副作用）。这个文件是另一半 —— 它必须能写，
 * 所以它拿的是另一个句柄。**两个句柄，不是一个句柄两种用法**：后者要靠纪律，
 * 而纪律会在某次改动里悄悄失效。
 *
 * ## 翻译只发生在这一层
 *
 * 用例（`app/*`）返回的是「一个说得清的下场」（`WaiveOutcome` 这种）。把它翻成
 * 界面认识的 JSON 只在这里做一次 —— 判据留在用例里，措辞留在这里。
 */

export interface ActionDeps {
  /** **可写**的库句柄。和 `api.ts` 那个只读的不是同一个。 */
  readonly database: Database.Database;
  /** 进旁路要记下当时的 HEAD —— 出来时比一次，才知道这一趟有没有动过手。 */
  readonly repo: RepoOps;
  /** 这个 Change 的代码在哪。没有路径就记不了 HEAD，旁路照开。 */
  readonly workspaceFor: (changeId: string) => string | null;
  /** 执行通道。派一轮、裁决里的「再来一轮」都从它走。 */
  readonly runtime: PluginRuntime;
  /**
   * brief 的两份文件（草稿 + 工作稿）落在哪。生产在 `~/.stagepass/briefs/`。
   *
   * **注进来而不是在这一层直接写磁盘**：这两份文件是「改没改过」那条机械判据的
   * 唯一依据，测试要能在不碰用户真实草稿的前提下把两份都摆出来。
   */
  readonly briefFiles: {
    write(name: string, content: string): string;
    read(name: string): string | null;
  };
}

export interface ActionResponse {
  readonly status: number;
  readonly body: unknown;
}

const fail = (status: number, error: string): ActionResponse => ({ status, body: { error } });

/**
 * 现在能不能问人：账本闲着才行。
 *
 * 旧的判据还多一格「没有活进程」——那要问座位注册表。执行通道接上之前这里只看账本，
 * **少看一格是宁松勿紧**：多拒一次人会以为坏了，漏拒一次最多是撞上「已经在跑」。
 */
function cannotAskNow(
  database: Database.Database,
  changeId: string,
  phase: Phase,
): { reason: string; busy: string; jobId?: string } | null {
  const job = new JobStore(database).busyFor(changeId, phase);
  return job === null
    ? null
    /*
     * `reason` 是**界面在精确匹配的那个字符串**（`panel.js`），不许改。要说得更细
     * 就往旁边加字段 —— 把「在等什么」编进 reason 会当场弄坏界面。
     */
    : { reason: "phase_already_running", busy: job.status, jobId: job.id };
}

export async function handleAction(
  pathname: string,
  params: URLSearchParams,
  body: string,
  deps: ActionDeps,
): Promise<ActionResponse> {
  const database = deps.database;
  const changeId = params.get("change") ?? "";

  if (pathname === "/api/answer") return answer(deps, params, changeId);
  if (pathname === "/api/waive") return waiveGap(database, changeId);
  if (pathname === "/api/change") return newChange(database, params);
  if (pathname === "/api/project") return newProject(database, params);
  if (pathname === "/api/rubric") return saveRubric(database, params, body);
  if (pathname === "/api/aside") return aside(deps, params, changeId, body);
  if (pathname === "/api/run") return run(deps, params, changeId);
  if (pathname === "/api/ask") return ask(deps, changeId);
  if (pathname === "/api/brief") return brief(deps, changeId);
  if (pathname === "/api/brief-draft") return briefDraft(deps, changeId);
  if (pathname === "/api/brief-confirm") return briefConfirm(deps, changeId);
  if (pathname === "/api/close") return close(deps, params, changeId);

  /*
   * 界面会 POST 的路**已经全部接上**（2026-08-18 晚）。所以走到这里只剩一种情况：
   * 路径不认识 —— 界面比服务端新，或者写错了。
   *
   * 仍然回 501 + `reason`：见 `api.ts` 里那条注释，**501 不等于把话说清楚了**，
   * 话是这个字段说的。少了它，屏幕上是「没问成：undefined」。
   */
  return {
    status: 501,
    body: {
      error: "not_wired_yet",
      path: pathname,
      reason: "插件里没有这条路 —— 界面要的东西如果本该有，那是漏接了。"
        + "先核对装着的插件是不是最新那份（装完要开新会话）。",
    },
  };
}

/**
 * 把人在界面上选的那几项落成一次回答。
 *
 * 两道闸都是「界面停在旧状态上」的防线：现在有没有在等的题、等的是不是人看到的那道。
 * 少任何一道，一次迟到的点击会落到**另一道题**上。
 */
async function answer(
  deps: ActionDeps,
  params: URLSearchParams,
  changeId: string,
): Promise<ActionResponse> {
  const database = deps.database;
  const questions = new QuestionStore(database);
  const pending = questions.open(changeId);
  if (pending === null) return fail(409, "nothing_to_answer");
  const open = openQuestionOf(questions, changeId, pending.phase);
  if (open === null) return fail(409, "nothing_to_answer");
  if (params.get("question") !== open.id) return fail(409, "question_moved_on");

  const choices: Record<string, string> = {};
  for (const field of open.fields) {
    const value = params.get(field.id);
    if (value !== null) choices[field.id] = value;
  }
  const chosen = answerFromChoices(open, choices);
  if (chosen === null) return fail(400, "bad_choice");

  /*
   * 账本收的是 elicitation 那个信封（`{action, content}`），不是裸的答案表。
   * 换的是人在哪儿答，**不是账本的语义** —— 落进库里的形状必须和以前一字不差。
   */
  questions.answer(open.id, { action: "accept", content: chosen });

  /*
   * **答完就把用例喊回来。**
   *
   * 界面是照「答完自动落地，不用再按别的」写的，它等的是回包里这个 `driven`
   * （`panel.js` 的 `submitAnswer`）。而服务端原来只落答案就返回 —— 于是人答完一道
   * 裁决题，屏幕上只有「已记下」，闸门一动不动（2026-08-19 真机）。
   *
   * 把「答」和「消费答案」拆成两次点击，是这套东西最不该有的形状：**人答完一道
   * 裁决题，他做的就是那个决定本身**，不该还要再找一个按钮把它提交一次。
   *
   * 用例从**题的种类**认，不是从界面传来的什么字段 —— 题是谁问的，就该由谁消费。
   * 三种题、三个用例，一一对得上（`domain/question.ts` 的 `QUESTION_KINDS`）。
   */
  const kind = pending.kind;
  const driven = kind === "gate_decision" ? (await ask(deps, changeId)).body
    : kind === "waive" ? (await waiveGap(database, changeId)).body
      : (await brief(deps, changeId)).body;
  return { status: 200, body: { answered: true, question: open.id, kind, driven } };
}

async function waiveGap(database: Database.Database, changeId: string): Promise<ActionResponse> {
  const { outcome } = await waive({
    database,
    changeId,
    cannotAskNow: (phase) => cannotAskNow(database, changeId, phase),
  });
  if (outcome.kind === "no_such_change") return fail(404, "no_such_change");

  const phase = outcome.phase;
  switch (outcome.kind) {
    case "busy":
      return { status: 200, body: { asked: false, phase, ...outcome.busy } };
    case "nothing_waivable":
      return { status: 200, body: { asked: false, reason: "nothing_waivable", phase } };
    case "asked":
      /*
       * 题摆在页面上了，还没答。**这不是失败** —— 答落库时 `/api/answer` 会再走
       * 一遍这个用例，那时才有 waived / none_accepted 的结论。
       */
      return {
        status: 200,
        body: { asked: true, answered: false, phase, questionId: outcome.questionId },
      };
    case "none_accepted":
      return {
        status: 200,
        body: { asked: true, answered: true, waived: false, phase, questionId: outcome.questionId },
      };
    case "gate_moved":
      return {
        status: 200,
        body: {
          asked: true, answered: true, waived: false, reason: "gate_moved", phase,
          questionId: outcome.questionId,
        },
      };
    case "waived":
      return {
        status: 200,
        body: {
          asked: true, answered: true, waived: true, phase,
          questionId: outcome.questionId, gapIds: outcome.gapIds,
        },
      };
  }
}

/**
 * 录需求：模型提问题 → 人在页面上答 → 答案落成 brief。
 *
 * 提问题那一趟跑在**当前阶段的座位**上。跑错座位不会报错 —— 它会占掉另一个阶段的
 * 线程，而「同一阶段只许一轮」从此挡住那边，症状离原因隔着好几屏。
 *
 * 干完要**把座位放掉**：不放，`progressView` 的 `live` 一直是真，界面会一直显示
 * 「在跑」，一路显示到人自己起疑。放弃那条路同理，理由在 `BriefResult.closeSession`。
 */
async function brief(deps: ActionDeps, changeId: string): Promise<ActionResponse> {
  const database = deps.database;
  const { outcome, closeSession } = await recordBrief({
    database,
    changeId,
    cannotAskNow: (phase) => cannotAskNow(database, changeId, phase),
    propose: (prompt) => deps.runtime.askInPhase(
      changeId, new ChangeStore(database).read(changeId).state.phase, prompt,
    ),
  });
  if (outcome.kind === "no_such_change") return fail(404, "no_such_change");
  if (closeSession) deps.runtime.releaseSeat(changeId, outcome.phase);

  const phase = outcome.phase;
  switch (outcome.kind) {
    case "busy":
      return { status: 200, body: { asked: false, phase, ...outcome.busy } };
    case "proposal_failed":
      return {
        status: 200,
        body: { asked: false, reason: outcome.reason, detail: outcome.detail, phase },
      };
    case "asked":
      /*
       * 题摆在页面上了，还没答。**这不是失败** —— 答落库时 `/api/answer` 会再走
       * 一遍这个用例，那时才有 recorded / not_recorded 的结论。
       */
      return {
        status: 200,
        body: { asked: true, answered: false, phase, questionId: outcome.questionId },
      };
    case "not_recorded":
      return { status: 200, body: { asked: true, answered: true, recorded: false, phase } };
    case "recorded":
      return {
        status: 200,
        body: { asked: true, answered: true, recorded: true, phase, brief: outcome.brief },
      };
  }
}

/**
 * 把旁路里谈过的东西整理成一份草稿。
 *
 * 判据全在 `app/converge-brief.ts`：没有旁路线程、人一句没说、读不出那段记录 ——
 * 三种是三个不同的答案，**界面按 `kind` 逐条说人话**，所以下场原样交出去。
 */
async function briefDraft(deps: ActionDeps, changeId: string): Promise<ActionResponse> {
  const outcome = await draftBrief({
    database: deps.database,
    changeId,
    saidIn: (threadId) => deps.runtime.saidIn(threadId),
    runTurn: (_threadId, prompt) => deps.runtime.talkAside(changeId, prompt),
    writeBriefFile: deps.briefFiles.write,
  });
  return outcome.kind === "no_such_change"
    ? fail(404, "no_such_change")
    : { status: 200, body: outcome };
}

/** 人改过的那份落库。机械判据（逐字相同 = 没改过 = 不算 brief）在用例里。 */
function briefConfirm(deps: ActionDeps, changeId: string): ActionResponse {
  const outcome = confirmBrief({
    database: deps.database,
    changeId,
    readBriefFile: deps.briefFiles.read,
  });
  return outcome.kind === "no_such_change"
    ? fail(404, "no_such_change")
    : { status: 200, body: outcome };
}

/**
 * 收掉一个座位 —— 以及，有一轮在飞时，**把那一轮当场收掉**。
 *
 * ## 光放掉会话不算出口
 *
 * 「这个 (Change,阶段) 上有没有活儿」有两个来源：手上那条会话，和账本里 queued /
 * running 的 job。原来只收前者：会话放掉了，账本上那一轮照旧挂着，Change 停在
 * `running` 等满三小时超时 —— 这段时间里人一个能按的都没有，而界面上什么都不说。
 *
 * 所以两个都收：会话放掉，账本上的活儿记成 `aborted_by_human`、Change 收回可重试。
 * 迟到的工人失败由 `TurnLoop.runOnce` 的「谁先收尾谁说了算」兜住，不会把账翻回去。
 *
 * ## 只收这个阶段的账
 *
 * 人关一个历史阶段的闲座位，不该顺手把另一个阶段正在跑的那一轮打掉 —— 那是
 * 「点了一下关闭，三小时白跑了」。
 *
 * 这不是裁决入口：中止一轮不推闸门、不对任何产物下判断，只陈述「人把这一轮停了」，
 * 和收尸人对过期租约做的是同一件事，只是由人当场触发。
 */
function close(
  deps: ActionDeps,
  params: URLSearchParams,
  changeId: string,
): ActionResponse {
  const database = deps.database;
  const phase = params.get("phase") ?? "";

  /*
   * 旁路只有会话可收，没有账 —— 它不产出、不占座、没有 job。
   * 但它有**结账**：比一次 HEAD，前后不同说明这一趟动过手。
   */
  if (phase === ASIDE) {
    deps.runtime.releaseSeat(changeId, ASIDE);
    const root = deps.workspaceFor(changeId);
    const settled = new AsideStore(database).close(
      changeId, root === null ? null : deps.repo.head(root),
    );
    return {
      status: 200,
      body: {
        closed: true, phase,
        ...(settled === null ? {} : { visit: settled.visit.seq, needsNote: settled.needsNote }),
      },
    };
  }
  if (!isPhase(phase)) return fail(400, "no_such_phase");

  deps.runtime.releaseSeat(changeId, phase);

  const jobs = new JobStore(database);
  const busy = jobs.busyFor(changeId, phase);
  if (busy === null) return { status: 200, body: { closed: true, phase } };

  let state: { phase: Phase; status: string } | null = null;
  try {
    const read = new ChangeStore(database).read(changeId).state;
    state = { phase: read.phase, status: read.status };
  } catch { /* Change 已经没了 —— 没有账可收 */ }

  const seat = state !== null && state.phase !== phase
    ? new ParallelStore(database).find(changeId, phase)
    : null;
  if (state === null || (state.phase !== phase && seat === null)) {
    return { status: 200, body: { closed: true, phase } };
  }

  jobs.abort(busy.id, "aborted_by_human");
  // 中止落在这一轮的座位上：主线收主线，并行座位收座位。
  if (state.phase === phase) {
    if (state.status === "running") new ChangeStore(database).apply(changeId, "fail");
  } else if (seat?.status === "running") {
    new ParallelStore(database).apply(changeId, phase, "fail");
  }
  return { status: 200, body: { closed: true, phase, aborted: busy.id } };
}

function newChange(database: Database.Database, params: URLSearchParams): ActionResponse {
  const outcome = createChange({
    database,
    projectId: params.get("project") ?? "",
    title: params.get("title") ?? "",
  });
  if (outcome.kind === "title_required") return fail(400, "title_required");
  if (outcome.kind === "no_such_project") return fail(404, "no_such_project");
  return { status: 200, body: { created: true, id: outcome.id, phase: outcome.phase } };
}

function newProject(database: Database.Database, params: URLSearchParams): ActionResponse {
  const outcome = createProject({
    database,
    name: params.get("name") ?? "",
    path: params.get("path") ?? "",
  });
  if (outcome.kind === "created") {
    return { status: 200, body: { created: true, id: outcome.id } };
  }
  /*
   * **拒绝要说得出为什么和怎么办。** 一个光秃秃的 `path_is_not_a_repository`
   * 在屏幕上和「坏了」没区别 —— 而这一条的解法只有一行命令，不说等于让人去猜。
   */
  return {
    status: 400,
    body: {
      error: outcome.kind,
      ...(outcome.kind === "path_is_not_a_repository"
        ? {
          reason: "这个目录不是 git 仓库。Codex 按仓库认项目 —— 不是仓库的目录在它"
            + "那儿根本不是一个项目，StagePass 开出来的会话你在 Codex 里看不到。"
            + "先在那个目录里跑一次 git init，再回来建。",
        }
        : {}),
    },
  };
}

/**
 * 存一份改过的判据表。
 *
 * 解码住在 `domain/rubric-edit.ts` —— 把字节变成结构是有判据的一步（谁都可以往
 * 这个口送任意 JSON），它该有自己的测试和自己的拒绝理由，不该散在路由里。
 */
function saveRubric(
  database: Database.Database,
  params: URLSearchParams,
  body: string,
): ActionResponse {
  const phase = params.get("phase") ?? "";
  const role = params.get("role") ?? "";
  if (!isPhase(phase) || !(RUBRIC_ROLES as readonly string[]).includes(role)) {
    return fail(400, "bad_phase_or_role");
  }
  let edit;
  try {
    edit = parseRubricEdit(new TextEncoder().encode(body));
  } catch (error: unknown) {
    if (!(error instanceof UnreadableEditError)) throw error;
    return fail(400, error.code);
  }
  const outcome = applyRubricEdit({
    database,
    changeId: params.get("change") ?? "",
    phase,
    role: role as RubricRole,
    edit,
  });
  return outcome.kind === "saved"
    ? { status: 200, body: { saved: true, version: outcome.version, retired: outcome.retired } }
    : { status: 200, body: { saved: false, reason: outcome.kind } };
}

/**
 * 进旁路 / 给上一趟补一句理由。
 *
 * 旁路不属于任何阶段：不产出、不推闸门、不占座。所以它这里只有账，没有闸门判断。
 */
function aside(
  deps: ActionDeps,
  params: URLSearchParams,
  changeId: string,
  body: string,
): ActionResponse {
  const database = deps.database;
  const visit = params.get("visit");
  const store = new AsideStore(database);

  if (visit !== null) {
    const note = body.trim();
    if (note === "") return fail(400, "note_required");
    store.note(changeId, Number(visit), note);
    return { status: 200, body: { noted: true, visit: Number(visit) } };
  }
  try {
    new ChangeStore(database).read(changeId);
  } catch {
    return fail(404, "no_such_change");
  }
  /*
   * 进旁路记下当时的 HEAD —— 出来时比一次，前后不同 = 这一趟动过手。那是下游
   * 唯一能知道「环外发生过什么」的地方；只聊过的那种一个字都不问。
   */
  const root = deps.workspaceFor(changeId);
  // `open` 自己幂等 —— 开着就接上，账不重记，否则每点一次侧栏就记一趟空账。
  const opened = store.open(changeId, root === null ? null : deps.repo.head(root));
  return { status: 200, body: { opened: true, visit: opened.seq } };
}


/**
 * 派这个阶段一轮。
 *
 * 判据全在 `runtime.runRound` 里（同一阶段只许一轮、跑在主线还是座位上、状态能不能
 * 排队）。**这里只做翻译** —— 把「一个说得清的下场」翻成界面认识的那份 JSON。
 */
async function run(
  deps: ActionDeps,
  params: URLSearchParams,
  changeId: string,
): Promise<ActionResponse> {
  const asked = params.get("phase") ?? "";
  const phase = isPhase(asked)
    ? asked
    : new ChangeStore(deps.database).read(changeId).state.phase;
  const outcome = await deps.runtime.runRound(changeId, phase);
  return { status: 200, body: outcome };
}

/**
 * 把这一轮的裁决摆到人面前。
 *
 * **网页这一侧只负责组题和落答**：选哪一条、写什么理由，发生在人自己的界面上。
 * 批准之后归档那个阶段的线程 —— 归档标记的是「这个阶段结束了」，不是「有人清了一下」，
 * 所以只由批准触发，别处一概不许调。
 */
async function ask(deps: ActionDeps, changeId: string): Promise<ActionResponse> {
  const { outcome } = await decideGate({
    database: deps.database,
    sessions: {},
    changeId,
    cannotAskNow: (phase) => cannotAskNow(deps.database, changeId, phase),
    rerun: (phase) => deps.runtime.runRound(changeId, phase),
    onApproved: async ({ threadId }) => {
      const history = deps.runtime.archiveOps();
      if (history !== null) await archiveFinished(threadId, history);
    },
    roundBudget: deps.runtime.roundBudget,
  });
  if (outcome.kind === "no_such_change") return fail(404, "no_such_change");

  const phase = outcome.phase;
  switch (outcome.kind) {
    case "busy":
      return { status: 200, body: { asked: false, phase, ...outcome.busy } };
    case "no_decision":
      return { status: 200, body: { asked: false, reason: "no_decision_available", phase } };
    case "asked":
      return {
        status: 200,
        body: { asked: true, answered: false, phase, questionId: outcome.questionId },
      };
    case "gate_moved":
      return {
        status: 200,
        body: {
          asked: true, answered: true, phase, questionId: outcome.questionId,
          answer: outcome.answer, reason: "gate_moved",
        },
      };
    case "decided":
      return {
        status: 200,
        body: {
          asked: true, answered: true, phase, questionId: outcome.questionId,
          answer: outcome.answer, responses: outcome.responses, refused: outcome.refused,
          raised: outcome.raised, outcome: outcome.outcome,
          continued: outcome.continued, state: outcome.state,
        },
      };
  }
}
