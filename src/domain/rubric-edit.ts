import type { CriterionDraft } from "./rubric";

/**
 * 一次 rubric 编辑请求长什么样，以及怎么从字节里把它读出来。
 *
 * ## 为什么解码住在这里而不是 `src/web/`
 *
 * 第五条常驻护栏禁止 `src/web/` 出现 `TextDecoder` / `JSON.parse` 之类 —— 那条规则
 * 是终端面板被接受的前提：**面板不许把字节变成字符串**，因为一旦开始解析 Codex 的
 * 输出，它就会长出自己的界面，而那是被明确否掉的方案。
 *
 * 这里读的是**浏览器发来的 HTTP body**，和 pty 一个字节的关系都没有。但护栏是故意
 * 机械的（"it cannot be left to judgement"），所以正确的做法是把解码放在 `web/`
 * 外面，而不是去放宽那条规则。放宽它是重开一个已经定了的决定。
 *
 * 搬过来还顺带得到一件东西：请求形状的校验从 handler 里的一段内联代码，变成了一个
 * 可以穷举证明的纯函数。
 *
 * ## 这个模块是纯的
 */

export interface RubricEdit {
  /** 改项目级默认，还是只给这个 Change 覆盖。**不给默认值，人要显式选。** */
  readonly scope: "project" | "change";
  readonly drafts: readonly CriterionDraft[];
  /** 撤下一条活着的阻断标准时必填。这里不判断必不必填，那是 store 的事。 */
  readonly reason: string | undefined;
}

export class UnreadableEditError extends Error {
  constructor(
    readonly code: "not_json" | "not_an_object" | "bad_scope" | "bad_drafts",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "UnreadableEditError";
  }
}

/**
 * 把任意值截成一段可读的说明。
 *
 * **`JSON.stringify(undefined)` 返回的是 `undefined`，不是字符串** —— 直接
 * `.slice()` 会抛一个 TypeError，于是调用方收到的不是这里定义的错误类型，而是一个
 * 和本意毫无关系的崩溃。缺字段恰恰是最常见的坏请求，所以这条路必须走得通。
 */
const detail = (value: unknown): string => String(JSON.stringify(value)).slice(0, 120);

const isDraft = (value: unknown): value is CriterionDraft => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.text === "string"
    && typeof entry.blocking === "boolean"
    && (entry.key === undefined || entry.key === null || typeof entry.key === "string");
};

export function parseRubricEdit(bytes: Uint8Array): RubricEdit {
  const text = new TextDecoder().decode(bytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnreadableEditError("not_json", text.slice(0, 120));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UnreadableEditError("not_an_object", text.slice(0, 120));
  }

  const record = parsed as Record<string, unknown>;

  // scope 必须写明。默认成 "project" 会让一次本想只影响这个 Change 的编辑，
  // 悄悄改掉所有 Change 的默认标准；默认成 "change" 则会让人以为改了全局其实没有。
  // 两个方向都是静默的错，所以不给默认。
  if (record.scope !== "project" && record.scope !== "change") {
    throw new UnreadableEditError("bad_scope", detail(record.scope));
  }

  const drafts = record.drafts;
  if (!Array.isArray(drafts) || !drafts.every(isDraft)) {
    throw new UnreadableEditError("bad_drafts", detail(drafts));
  }

  return {
    scope: record.scope,
    drafts: drafts as CriterionDraft[],
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}
