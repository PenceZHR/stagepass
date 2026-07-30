import type { Criterion, RubricVerdict } from "./rubric";

/**
 * 一份 rubric 判定的行协议，以及读它的规则。
 *
 * ## 结构是 StagePass 的
 *
 * 模型收到的是一份**它没有参与设计**的清单：每条 criterion 的 key 和正文都由这里
 * 发出去，它只能逐条回答。这不是对格式的洁癖 —— 判据始终是「结构由谁决定」，而
 * 不是「格式是不是 JSON」。
 *
 * 一行一条，而不是一个 JSON 数组：数组允许悄悄少一项，而**少一项和答了 no 是完全
 * 不同的两件事**。一行一条之后，「恰好 N 行」是机械可查的，缺的那几条也就有了确
 * 定的去处。
 *
 * ## 只有两种结局
 *
 * - **能读**：每条 criterion 都有判定，漏答的记 `not_assessed`。
 * - **作废整份**：出现了不该出现的东西。
 *
 * 作废而不是尽力而为，是因为**作废可以重试** —— 模型有机会改一个错字；而
 * `not_assessed` 是永久记账。两者都 fail-closed，但作废更保守，且不会被误读成一次
 * 真实的判定。
 *
 * ## `not_assessed` 不是模型可以选的答案
 *
 * 它是解析器发现缺行时填的记账。模型写了它就作废整份 —— 能写就等于给了它一条
 * 「跳过这题」的路，而漏答被静默当成通过，正是这套机制存在的理由。
 *
 * ## 这个模块是纯的
 */

const FENCE = /```rubric\s*([\s\S]*?)```/g;
/** key 里不会有空白（都是 RBC-<uuid>），所以按空白切三段就够。 */
const LINE = /^([^\s]+)[ \t]+([^\s]+)[ \t]*(.*)$/;

const ANSWERABLE = new Set(["yes", "no"]);
const RESERVED = "not_assessed";

export class RubricOutputVoidError extends Error {
  constructor(
    readonly code: "unknown_key" | "unknown_verdict" | "reserved_verdict" | "duplicate_key",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RubricOutputVoidError";
  }
}

export interface ReadAssessment {
  readonly criterionKey: string;
  readonly verdict: RubricVerdict;
  readonly evidence: string | null;
}

/**
 * 发给模型的那份清单。
 *
 * **不提 `not_assessed`。** 契约里出现它就等于邀请模型去用它，而它根本不是一个
 * 可选的答案。
 */
/**
 * `subject` 说的是**判的是谁的活儿**。
 *
 * 从「每个角色对照自己那份」改成「判别人那份」之后（用户 2026-07-30：绝对不能红方
 * 自评），这句话就不能省：一份主语中立的契约递给蓝方，它会顺理成章地对照自己刚写的
 * 那些问题打分，而我们要的是它判红方的产出。
 */
export function rubricContract(
  criteria: readonly Criterion[],
  subject: string,
): string {
  if (criteria.length === 0) return "本阶段没有需要逐条判定的标准。";

  return [
    `对照下面 ${criteria.length} 条标准逐条判定${subject}，每条只答「满足」或「不满足」。`,
    "不要打分，不要写「部分满足」，不要合并或跳过任何一条。",
    "",
    ...criteria.map((entry) => `${entry.key}  ${entry.text}`),
    "",
    "按下面的格式作答，一条一行，除此之外写什么都可以：",
    "```rubric",
    "<上面的编号> <yes|no> <一句话说明依据>",
    "```",
  ].join("\n");
}

/**
 * 读模型的判定，补齐漏答的。
 *
 * 返回的顺序**按 rubric，不按模型写的顺序** —— 后者是模型能影响的东西，让它决定
 * 呈现次序等于把一点点结构还给它。
 *
 * 散文被忽略而不是被拒绝：契约管的是结构由谁决定，不是模型必须闭嘴。最后一个
 * fence 赢，因为改主意的模型会再写一个，取第一个就是照着它已经作废的草稿办事。
 * 一个 fence 都没有时退回整段文本 —— key 是 uuid，散文撞上的可能性可以忽略，而
 * 为此让一次本来读得懂的输出作废并不划算。
 */
export function readAssessments(
  text: string,
  criteria: readonly Criterion[],
): ReadAssessment[] {
  if (criteria.length === 0) return [];

  const known = new Set(criteria.map((entry) => entry.key));
  const fences = [...text.matchAll(FENCE)].map((match) => match[1]!);
  const body = fences.length > 0 ? fences[fences.length - 1]! : text;

  const answered = new Map<string, ReadAssessment>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const match = LINE.exec(line);
    if (!match) continue; // 散文

    const [, key, token, rest] = match as unknown as [string, string, string, string];
    if (!known.has(key)) {
      // 规则一句话：**fence 里面是结构化区域，外面是捡的。**
      //
      // fence 里出现不认识的 key，作废整份 —— 忽略它等于允许模型凭空多答一条，而
      // 那一条会变成一个没有标准的判定。
      //
      // 没有 fence 时整段都是散文，任何三段式的句子都会撞上这个正则，所以只认识
      // 得出来的 key 才算数。这条宽容只会让某条记成 not_assessed（fail-closed），
      // 永远不会造出一个假的判定。
      if (fences.length === 0) continue;
      throw new RubricOutputVoidError("unknown_key", key);
    }

    const verdict = token.toLowerCase();
    if (verdict === RESERVED) {
      throw new RubricOutputVoidError("reserved_verdict", key);
    }
    if (!ANSWERABLE.has(verdict)) {
      throw new RubricOutputVoidError("unknown_verdict", `${key} -> ${token}`);
    }
    if (answered.has(key)) {
      throw new RubricOutputVoidError("duplicate_key", key);
    }

    const evidence = rest.trim();
    answered.set(key, {
      criterionKey: key,
      verdict: verdict as RubricVerdict,
      evidence: evidence === "" ? null : evidence,
    });
  }

  return criteria.map((entry) => answered.get(entry.key) ?? {
    criterionKey: entry.key,
    verdict: "not_assessed" as const,
    evidence: null,
  });
}
