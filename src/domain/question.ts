import type { ChangeAction } from "./change-state";
import type { Gap, GapResponse } from "./gap";
import type { Gate } from "./gate";
import { isPhase, sendsToFix } from "./phase";

/**
 * A question StagePass puts to the human, and the answer it will accept.
 *
 * ## The shape is StagePass's, always
 *
 * The model never composes a decision. It is handed an opaque id and told to
 * ask it; the wording, the options and the fence all come from here. That is
 * not caution about the model -- it is that the legal options at a gate are a
 * fact only the state machine knows, and a model free to write the option list
 * is free to offer one the pipeline would refuse.
 *
 * ## Options are a JSON Schema enum, not a list of buttons
 *
 * A question becomes an MCP `elicitation/create` request, and the client
 * renders the selector from `requestedSchema`. Measured 2026-07-28 in the Codex
 * TUI: an `enum` renders as a native picker, several properties render as one
 * form answered in a single pass, and a human who declines comes back as
 * `{"action":"cancel"}` with no content.
 *
 * So "the human cannot choose an option that does not exist" is enforced by the
 * client's renderer rather than by StagePass trusting anyone -- which is the
 * strongest version of that rule available.
 *
 * ## This module is pure
 */

export const QUESTION_KINDS = ["gate_decision", "clarification", "waive"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** The field a gate decision's answer arrives under. */
export const DECISION_FIELD = "decision";

export interface RequestedSchema {
  readonly type: "object";
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, {
    readonly type: "string" | "boolean";
    readonly title: string;
    readonly enum?: readonly string[];
  }>>;
}

export interface Question {
  readonly message: string;
  readonly requestedSchema: RequestedSchema;
}

/** 一格。`options` 空 = 自由文本；`optional` = 可以留空。 */
interface Field {
  readonly id: string;
  readonly title: string;
  readonly options?: readonly string[] | undefined;
  readonly optional?: boolean | undefined;
}

export class BadQuestionShapeError extends Error {
  constructor(
    readonly code: "order_not_sorted" | "last_field_unsubmittable",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BadQuestionShapeError";
  }
}

/**
 * 一批格子变成一次 elicitation。**所有问题都从这里出去，只此一处。**
 *
 * 它挡住两件 2026-07-30 在 Codex TUI 上实测出来的事。两条都是**客户端的行为**，
 * 不是产品选择 —— 所以判据放在这里，而不是靠每个组题的人自己记得。
 *
 * ## 一、显示顺序 = 字段名排序，不是这里的书写顺序
 *
 * 实测：按 `B1, B1x, …, B8, B8x, B0` 写出去，选择器画出来的第一格是 `B0`。
 * 所以要控制顺序只能控制**名字**。这里要求传进来的顺序**已经等于排序后的顺序** ——
 * 不自己悄悄排：那样组题的人写下的顺序和人看到的顺序就永远对不上，而他不会知道。
 *
 * ## 二、最后一格必须能被回车提交
 *
 * 实测：光标停在一个**空的自由文本格**上按回车，屏幕上什么都不发生 —— `optional`
 * 不管用，必填项全答完也不管用，底下写着 `enter to submit all` 也不管用。而整张表
 * 只能从最后一格提交。**所以最后一格是「可留空的自由文本」= 这张表交不上去。**
 *
 * 选项格总有一个高亮着的候选值，回车提交得动；必填的自由文本会把「还差 1 个」显示
 * 出来，人知道该干什么。这两种都行，第三种不行。
 */
function compose(message: string, fields: readonly Field[]): Question {
  const ids = fields.map((field) => field.id);
  const sorted = [...ids].sort();
  if (ids.some((id, index) => id !== sorted[index])) {
    throw new BadQuestionShapeError("order_not_sorted",
      `${ids.join(",")} -> ${sorted.join(",")}`);
  }

  const last = fields[fields.length - 1];
  if (last && (last.options ?? []).length === 0 && last.optional === true) {
    throw new BadQuestionShapeError("last_field_unsubmittable", last.id);
  }

  const properties: Record<string, {
    type: "string"; title: string; enum?: readonly string[];
  }> = {};
  for (const field of fields) {
    const options = field.options ?? [];
    // **选项为空就不发 enum** —— 那是一道自由填写。无条件发 enum 的话，它会变成
    // 一个零个选项的下拉框：人打不开、也填不进去，看着像界面坏了。
    properties[field.id] = options.length === 0
      ? { type: "string", title: field.title }
      : { type: "string", title: field.title, enum: options };
  }
  return {
    message,
    requestedSchema: {
      type: "object",
      required: fields.filter((field) => field.optional !== true)
        .map((field) => field.id),
      properties,
    },
  };
}

/**
 * The elicitation for a settled phase: one field, whose enum is exactly the
 * actions the gate permits right now.
 *
 * Returns null when the gate permits no decision. A question with nothing to
 * choose is worse than no question -- it interrupts someone to show them a
 * decision they cannot make, which is how the tree this replaces produced cards
 * whose every button was refused.
 */
export function gateDecisionQuestion(input: {
  phase: string;
  gate: Gate;
  summary: string;
  /**
   * 这个阶段还开着的问题。给了就一条一道题，和裁决**同一次**问出来。
   *
   * 缺席时行为和加这个参数之前逐字一致 —— 一个 `decision` 字段，别的什么都没有。
   */
  openGaps?: readonly Gap[] | undefined;
}): Question | null {
  // `start`, `settle` and `fail` are the system reporting what happened. Only
  // these three are ever put to a person.
  const decisions: readonly ChangeAction[] = ["approve", "reject", "retry"];
  const offered = decisions.filter((action) =>
    input.gate.permitted.includes(action) || clearableByAnswer(action, input.gate));
  if (offered.length === 0) return null;

  return compose(`${input.phase}：${input.summary}`, [
    ...responseFields(input.openGaps ?? []),
    // `decision` 排在最后，因为小写 `d` 在 `R` 之后 —— 而它是选项格，所以整张表
    // 提交得动（见 `compose` 的第二条）。**这不是巧合，是挑名字时挑的。**
    {
      id: DECISION_FIELD,
      title: "请裁决",
      options: offered.map((action) => decisionLabel(action, input.phase)),
    },
  ]);
}

/**
 * 这个动作现在被拒，但**人在这同一次回答里就能把拒的原因清掉**吗。
 *
 * 只有一种情况算：`blocking_problem_outstanding`。人可以在同一道题里驳回或接受那些
 * 问题，于是等裁决落地时闸门已经放行了 —— 用户 2026-07-30 要的正是这一步：
 * 「现在再跑一轮，还是就这样批准？」两个都得能选，否则他清完了问题还要再问一次。
 *
 * ## 这不是放宽 §5.4
 *
 * §5.4 挡的是**永远执行不了**的选项（老树那五个死按钮：有标签、有渲染、不在任何
 * surface 的可执行集合里）。这一条不同：它可执行，只是要人先把挡着的东西处理掉。
 * 而**如果他没处理，闸门照样拒**，并且把原因报出来 —— 判断权一步都没有离开闸门。
 *
 * 「什么都没产出」不算：驳回一条问题变不出一份产物来，那个拒是清不掉的。
 */
function clearableByAnswer(action: ChangeAction, gate: Gate): boolean {
  return gate.refusals[action] === "blocking_problem_outstanding";
}

/**
 * 裁决那一格显示的字。
 *
 * ## 为什么不直接显示 `reject`
 *
 * 用户 2026-07-30 的原话：「**reject 这个词没人猜得到它是重跑。**」而它确实是：驳回
 * 一个设计阶段的意思是「在这儿再来一轮」，`transition` 里写着
 * `{ ...state, status: "pending" }`，阶段一步都没动。
 *
 * ## 同一个动作，两个阶段两句话
 *
 * 驳回 Review / QA 不是重跑那个阶段，是**把活打回 Fix**（`sendsToFix`）。用同一句
 * 「再来一轮」去说它，就是在界面上撒谎。所以文案跟着阶段走，判据用的是那个已经存在
 * 的谓词 —— 不在这里另算一套（E3）。
 */
const APPROVE_LABEL = "就这样批准，进下一个阶段";
const RETRY_LABEL = "重跑一次（上一轮跑失败了）";
const ANOTHER_ROUND_LABEL = "再来一轮（红蓝在这个阶段重新跑）";
const BACK_TO_FIX_LABEL = "打回去修（送到 Fix）";

export function decisionLabel(action: ChangeAction, phase: string): string {
  if (action === "approve") return APPROVE_LABEL;
  if (action === "retry") return RETRY_LABEL;
  return isPhase(phase) && sendsToFix(phase) ? BACK_TO_FIX_LABEL : ANOTHER_ROUND_LABEL;
}

/**
 * 人看见的那句话 → 动作。
 *
 * **enum 里的值就是人看见的字**（§5.2b），所以要有一张回来的表。它是全的：四个标签
 * 各自对应一个动作，两个 reject 的说法指向同一个动作。`decisionFrom` 之外没有第二处
 * 解释这些字符串。
 */
const ACTION_BY_LABEL: Readonly<Record<string, ChangeAction>> = {
  [APPROVE_LABEL]: "approve",
  [RETRY_LABEL]: "retry",
  [ANOTHER_ROUND_LABEL]: "reject",
  [BACK_TO_FIX_LABEL]: "reject",
};

/**
 * 这次裁决是不是「活儿留在这个阶段，再跑一次」—— 答完直接续跑那一步靠它判。
 *
 * 两句话都算：
 *
 *   再来一轮      设计阶段的 reject，阶段一步没动
 *   重跑一次      blocked 的 retry，阶段同样一步没动
 *
 * **`retry` 也算，不是顺手加的。** 用户要的是「把两步合成一步」，而 retry 那条路上
 * 中间那一步和 reject 那条一样看不出来：裁决落完之后 Change 停在 `running`，界面上
 * 没有任何东西说「还差一次派发」。同一个抱怨，两条路都得管。
 *
 * **「打回去修」不算**：那时 Change 已经换到 Fix 了，自动在一个刚到的阶段上开跑，
 * 等于替人决定了 Fix 该做什么。
 */
export const runsAgainHere = (label: unknown): boolean =>
  label === ANOTHER_ROUND_LABEL || label === RETRY_LABEL;

/**
 * 「回应蓝方」那四个选项。
 *
 * 值就是选择器里显示的字，也是回来要匹配的字 —— 中间没有第二张映射表（§5.2b：
 * 选项集合就是 schema 里的 enum）。
 */
export const RESPONSE_AGREE = "同意，红方下轮必须改";
export const RESPONSE_DISMISS = "不同意，这条不成立";
export const RESPONSE_WAIVE = "先接受这个风险";
export const RESPONSE_OWN = "我自己说";

/** 人自己提一个新问题那一格。排在所有 `R0n` 之后、`decision` 之前。 */
const RAISE_FIELD = "RY";

/** 第 n 条 open gap 那一对格子的 id。补零，理由和 `domain/brief.ts` 里那条一样。 */
const responseFieldId = (n: number): string => `R${String(n).padStart(2, "0")}`;

/**
 * 一条 open gap 一道题，形状和录需求那道一样：选项一格，自己写一格。
 *
 * ## 为什么这一步必须存在
 *
 * 用户 2026-07-30 的原话：「⑤ 我决定再来一轮还是接受 —— 路径存在但要两步、词是
 * `reject`、**我说的话没有容器**。」他觉得反方第一条提错了、第二条可以带着走、
 * 第三条必须改 —— 三种意思在这之前只能压成一个 `reject`，而下一轮的红方什么也不
 * 知道。
 *
 * ## 选项之外总有一格自己写
 *
 * 和录需求那道题同一个理由：elicitation 的一个字段有 enum 就是下拉、没有就是自由
 * 输入，**没有「选项 + 或者自己写」那种字段**。所以想让人越过四个选项说话，只能
 * 给第二格。
 */
function responseFields(openGaps: readonly Gap[]): Field[] {
  if (openGaps.length === 0) return [];
  const fields: Field[] = [];
  openGaps.forEach((gap, index) => {
    fields.push({
      id: responseFieldId(index + 1),
      title: `${gap.id}\u3000${gap.title}`,
      options: [RESPONSE_AGREE, RESPONSE_DISMISS, RESPONSE_WAIVE, RESPONSE_OWN],
    });
  });
  /*
   * **这一格也是选项。** 它原来是自由文本，于是每次裁决都多一个吃回车的空格子。
   * 想提的人点「有」，第二趟给他写（`responseFollowUps`）。
   */
  fields.push({
    id: RAISE_FIELD,
    title: "除了上面这些，你自己还要提什么问题？",
    options: [RAISE_NOTHING, RAISE_SOMETHING],
  });
  return fields;
}

/** 「你还要提什么」那一格的两个选项。点后面那个才进第二趟。 */
export const RAISE_NOTHING = "没有了";
export const RAISE_SOMETHING = "有，我来提";

/**
 * 裁决的第二趟：**只问那几条真的需要理由的。**
 *
 * ## 为什么第一趟不能有自由文本格
 *
 * 客户端**空的自由文本格会吃掉回车**（`optional` 也不管用，2026-07-30 实测）。
 * 原来每条 gap 摊成两格（选项 + 「你想说什么」），于是八条 gap 就是八个空格子要
 * 挨个动手 —— 2026-08-03 真机上用户在八格里各打了一个「1」纯粹为了过去，和录需求
 * 那张表被治好之前一模一样。
 *
 * ## 哪几条要进第二趟，是**语义**决定的，不是排版
 *
 * - **同意**：红方下轮照着改就是了，没有额外的话要说 —— 不进。
 * - **不同意 / 先接受这个风险**：两者都会关掉一条 gap，而**一次没有理由的关闭和
 *   「这一轮忘了提」在库里长得一模一样**（`domain/gap.ts` 开头）。理由是实质内容，
 *   不是过关费 —— 必须进。
 * - **我自己说**：他自己要求了要说话 —— 进。
 */
export function responseFollowUpQuestion(
  openGaps: readonly Gap[],
  answer: Answer,
): Question | null {
  if (answer.action !== "accept") return null;
  const read = (id: string): string => {
    const given = answer.content[id];
    return typeof given === "string" ? given.trim() : "";
  };

  const fields: Field[] = [];
  openGaps.forEach((gap, index) => {
    const id = responseFieldId(index + 1);
    const chosen = read(id);
    if (chosen !== RESPONSE_DISMISS && chosen !== RESPONSE_WAIVE
      && chosen !== RESPONSE_OWN) return;
    fields.push({
      id: `${id}x`,
      title: `\u2191\u3010${gap.id}\u3011${chosen} \u2014\u2014 为什么？`,
      optional: true,
    });
  });
  if (read(RAISE_FIELD) === RAISE_SOMETHING) {
    fields.push({
      id: `${RAISE_FIELD}x`,
      title: "你自己要提的问题（写了就作为你的要求进下一轮，红方不许当成建议）",
      optional: true,
    });
  }
  if (fields.length === 0) return null;

  /*
   * 压轴一格提交格。空文本格吃回车、整张表只能从最后一格提交（2026-07-30 实测）——
   * 所以最后一格必须是选项格，否则中途改主意留空的人就交不上去。
   */
  fields.push({
    id: FOLLOW_UP_CONFIRM,
    title: "确认",
    options: [FOLLOW_UP_CONFIRM_OPTION],
  });
  return compose("刚才你说要给理由的那几条", fields);
}

/** 第二趟的提交格。`z` 排在 `R` 和 `RY` 之后，所以它压得住轴。 */
const FOLLOW_UP_CONFIRM = "z-confirm";
export const FOLLOW_UP_CONFIRM_OPTION = "都写完了，提交";

/**
 * 人对每一条 open gap 说了什么。
 *
 * ## 位置对应，而 fence 兜着
 *
 * 第 n 条 gap ↔ `R{nn}`。位置耦合能成立是因为 **gap 名单变了 snapshot 就变了**
 * （`snapshotOf` 哈希 blockers 的 `id`），于是答案在落地之前会被 fence 拒掉 ——
 * 而不是被套到一条他没看见的问题上。
 *
 * ## 认不出来的就跳过，不猜
 *
 * 一个不在四个选项里的值、或者一道压根没有 `R{nn}` 的问题（普通闸门裁决就是），
 * 这里都当成「这一条没表态」。**沉默什么都不改**，和 `domain/gap.ts` 的规矩一致。
 */
export function responsesFrom(input: {
  question: Question;
  answer: Answer;
  openGaps: readonly Gap[];
}): { responses: Record<string, GapResponse>; raised: string } {
  if (input.answer.action !== "accept") return { responses: {}, raised: "" };

  const read = (id: string): string => {
    const given = input.answer.content[id];
    return typeof given === "string" ? given.trim() : "";
  };

  const responses: Record<string, GapResponse> = {};
  input.openGaps.forEach((gap, index) => {
    const id = responseFieldId(index + 1);
    // 这道题里压根没有这一格 —— 那它不是一次「回应蓝方」，什么都不做。
    if (!(id in input.question.requestedSchema.properties)) return;

    const chosen = read(id);
    const own = read(`${id}x`);
    if (chosen === RESPONSE_DISMISS) {
      responses[gap.id] = { kind: "dismiss", reason: own };
      return;
    }
    if (chosen === RESPONSE_WAIVE) {
      responses[gap.id] = { kind: "waive", reason: own };
      return;
    }
    // 「我自己说」等同「同意」：他的文字进下一轮，这一条留着。
    if (chosen === RESPONSE_AGREE || chosen === RESPONSE_OWN) {
      responses[gap.id] = { kind: "agree", note: own };
      return;
    }
    // 认不出来的值：只当他写了字（写了就留着），没写就什么都不做。
    if (own !== "") responses[gap.id] = { kind: "agree", note: own };
  });

  /*
   * 「你还要提什么」现在是第一趟的**选项格**，正文在第二趟那一格里
   * （`${RAISE_FIELD}x`）。点了「有」却没写，就当没提 —— 和录需求那张表同一条规矩。
   */
  return { responses, raised: read(`${RAISE_FIELD}x`) };
}

/*
 * 接受风险这道题的两个字段。**两个都必填**，理由见 `waiveQuestion`。
 *
 * 不导出：`waiveQuestion` 和 `waiveFrom` 都在这个文件里，外面拿不到字段名也不需要
 * 拿到 —— 调用方给的是问题和答案，不是字段。（`DECISION_FIELD` 导出是因为插件那
 * 边真的要用它。）
 */
/** 一条 gap 一格，序号和裁决表那边同一个形状（`W01`、`W02`…）。 */
const waiveFieldId = (index: number): string => `W${String(index).padStart(2, "0")}`;
/** 第二趟里那一条的理由格。`W01` -> `W01x`。 */
const waiveReasonId = (fieldId: string): string => `${fieldId}x`;
/** 压轴那一格：必须是选项格，整张表才提交得动（见 `compose`）。 */
const WAIVE_CONFIRM_FIELD = "z-confirm";
export const WAIVE_KEEP = "不接受，继续挡着闸门";
export const WAIVE_ACCEPT = "接受这个风险";

/**
 * 接受一条已知风险：**哪一条**，以及**为什么可以带着它走**。
 *
 * ## 为什么必须是一道题、两个字段
 *
 * 老树在这里失败过，而且失败得很典型：`waive_spec_p1` 的 schema 要 `gapId`，
 * 但它挂在一张**点一下就完事**的卡片上 —— 一次点击给不出「哪一条」，更给不出
 * 理由。于是那个动作有标签、有 contract 条目、有渲染，**永远执行不了**（§2.3）。
 *
 * elicitation 的表单能一次收多个字段（§5.2b 实测：三个字段含一个布尔一次返回），
 * 所以这道题问得出来。**理由是必填的** —— 「接受风险时必须留下理由」是产品规则，
 * 而一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
 *
 * ## 只有 P1 的 finding 可以被接受
 *
 * P0 不许豁免（严重到不可接受的问题不能靠普通确认绕过）。一条 `standard` 也不许
 * —— 它的出口是撤下那条标准，不是接受风险，两句话不是一回事（见 domain/gap.ts）。
 * 所以候选名单由调用方筛好传进来，这里不猜。
 *
 * 名单为空返回 null：一道没有选项的题比不问更糟，它打断人来展示一个做不了的决定。
 */
export function waiveQuestion(input: {
  phase: string;
  waivable: readonly { id: string; title: string }[];
}): Question | null {
  if (input.waivable.length === 0) return null;

  return compose(
    `${input.phase}：这几条风险，哪些你决定带着走？`
    + "\n接受一条意味着**问题还在**，只是不再挡闸门 —— 它会留在交付说明里。",
    [
      /*
       * **一条一格，标题就是那条问题本身。**
       *
       * 原来是一个单选格，enum 里是四个裸 id，标题只写在正文里。而正文在 TUI 里
       * 打印一次就滚上去了 —— 人做选择的那一刻眼前只有 `SPEC-XREF-1` 这种编号。
       * 用户 2026-08-04 的原话：「我点进去接受风险那个页面，那我只能知道风险的编号，
       * 我又不知道风险是啥。」和裁决表那边同一个修法（见 `responseFields`）。
       *
       * 顺带解决另一半：**一次能接多条**。原来一次一条，接四条就要走四遍完整流程，
       * 每遍起一个 Codex turn。
       */
      ...input.waivable.map((gap, index) => ({
        id: waiveFieldId(index + 1),
        title: `${gap.id}\u3000${gap.title}`,
        options: [WAIVE_KEEP, WAIVE_ACCEPT],
      })),
      /*
       * 压轴必须是选项格：客户端的空文本格会吃掉回车，而整张表只能从最后一格提交
       * （2026-07-30 实测）。理由走第二趟，只问真被接受的那几条。
       */
      {
        id: WAIVE_CONFIRM_FIELD,
        title: "选好了吗",
        options: ["就这些", "先不接受任何一条"],
      },
    ],
  );
}

/**
 * 接受风险的第二趟：**只问真被接受的那几条要理由。**
 *
 * 一条都没接受就不弹 —— 全点「不接受」的人一个字都不用打。和裁决表那边
 * `responseFollowUpQuestion` 同一个理由和同一个形状。
 */
export function waiveFollowUpQuestion(
  waivable: readonly { id: string; title: string }[],
  first: Answer,
): Question | null {
  const fields: Field[] = [];
  waivable.forEach((gap, index) => {
    const id = waiveFieldId(index + 1);
    if (first.content[id] !== WAIVE_ACCEPT) return;
    fields.push({
      id: waiveReasonId(id),
      title: `${gap.id}　为什么可以带着它走`,
    });
  });
  if (fields.length === 0) return null;
  return compose(
    "这几条你决定接受。**每条都要说清为什么可以带着它走** ——"
    + "一次没有理由的接受，和「忘了处理」在库里长得一模一样。",
    fields,
  );
}

export interface ClarificationItem {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  /**
   * 这一格可以留空吗。默认不可以 —— 一道问出去的题默认是要答的。
   *
   * **这不是排版偏好，`required` 在客户端是硬闸门**（2026-07-30 在 Codex TUI 实测）：
   * 选择器右上角写着 `Field 3/17 (17 required unanswered)`，而在还有必填没答的时候
   * 按回车 —— **屏幕上什么都不会发生**，没有报错、没有提示。人只会以为终端卡住了。
   *
   * 所以「可以留空」这句话必须落到 schema 上，否则它是一句假话：批次 A 把每题摊成
   * 两格之后，17 格全进了 `required`，标着「（可以留空）」和「选了也可以补充」的
   * 那 9 格一个都留不了空。
   */
  readonly optional?: boolean;
}

/**
 * The elicitation for a batch of open questions: one field each, all asked and
 * answered in a single pass.
 *
 * Measured, and the reason a batch needs no round trips: three fields including
 * a boolean came back together as
 * `{"action":"accept","content":{"q1":"…","q2":"…","q3":true}}`.
 *
 * **字段的显示顺序不由这里决定 —— 客户端按字段名排序。** 2026-07-30 实测：这里按
 * `B1, B1x, …, B8, B8x, B0` 的顺序写出去，选择器画出来的第一格是 `B0`。所以要让
 * 顺序符合预期，只能让**字段名本身**排出那个顺序（见 `domain/brief.ts`）。
 */
export function clarificationQuestion(input: {
  title: string;
  items: readonly ClarificationItem[];
}): Question | null {
  if (input.items.length === 0) return null;
  return compose(input.title, input.items.map((item) => ({
    id: item.id,
    title: item.question,
    options: item.options,
    optional: item.optional,
  })));
}

export const ANSWER_ACTIONS = ["accept", "decline", "cancel"] as const;
export type AnswerAction = (typeof ANSWER_ACTIONS)[number];

export interface ElicitationResult {
  readonly action?: unknown;
  readonly content?: unknown;
}

export interface Answer {
  readonly action: AnswerAction;
  readonly content: Readonly<Record<string, string | boolean>>;
}

export class UnreadableAnswerError extends Error {
  constructor(readonly code: "answer_action_unknown" | "answer_content_invalid") {
    super(code);
    this.name = "UnreadableAnswerError";
  }
}

/**
 * Read what came back from the client.
 *
 * A decline is a real answer with `action` set and no content -- not an error,
 * not a timeout, not an empty accept. StagePass would mistake all three for
 * something else, and treating a decline as a timeout turns "I will decide
 * later" into "that round was wasted".
 */
export function readAnswer(result: ElicitationResult): Answer {
  const action = result.action;
  if (typeof action !== "string"
    || !(ANSWER_ACTIONS as readonly string[]).includes(action)) {
    throw new UnreadableAnswerError("answer_action_unknown");
  }
  if (action !== "accept") return { action: action as AnswerAction, content: {} };

  const content = result.content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new UnreadableAnswerError("answer_content_invalid");
  }
  const read: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "boolean") {
      throw new UnreadableAnswerError("answer_content_invalid");
    }
    read[key] = value;
  }
  return { action: "accept", content: read };
}

/**
 * The action a gate decision's answer stands for, or null if it is not one.
 *
 * Checked against the question's own enum rather than against the action list,
 * because the enum is what the human was actually shown. An answer naming
 * something that was not offered is refused here, before it can become a
 * command.
 */
export function decisionFrom(
  question: Question,
  answer: Answer,
): ChangeAction | null {
  if (answer.action !== "accept") return null;
  const offered = question.requestedSchema.properties[DECISION_FIELD]?.enum;
  if (!offered) return null;
  const chosen = answer.content[DECISION_FIELD];
  if (typeof chosen !== "string" || !offered.includes(chosen)) return null;
  // enum 里是**人看见的那句话**，不是动作名（见 `decisionLabel`）。认不出来的返回
  // null，于是答案被记下但不推动任何东西 —— 失败的方向是安全的那一边。
  return ACTION_BY_LABEL[chosen] ?? null;
}

/**
 * 一次接受风险的答案：哪一条 + 为什么。不是一次合法的接受就返回 null。
 *
 * 和 `decisionFrom` 一样，**对着问题自己的 enum 校验**，不是对着当前还有哪些 gap
 * —— enum 是人当时真正看见的东西。名单在他想的时候变了，这里就该拒绝，而不是把
 * 他的选择套到一条他没看见的问题上。
 *
 * 理由要求非空：一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
 */
export function waiveFrom(
  waivable: readonly { id: string; title: string }[],
  answer: Answer,
): { gapId: string; reason: string }[] {
  if (answer.action !== "accept") return [];
  const out: { gapId: string; reason: string }[] = [];
  waivable.forEach((gap, index) => {
    const id = waiveFieldId(index + 1);
    if (answer.content[id] !== WAIVE_ACCEPT) return;
    const reason = answer.content[waiveReasonId(id)];
    // 理由要求非空：一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
    if (typeof reason !== "string" || reason.trim() === "") return;
    out.push({ gapId: gap.id, reason: reason.trim() });
  });
  return out;
}
