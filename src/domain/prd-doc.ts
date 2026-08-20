import type { TemplateSection } from "./phase-template";

/**
 * 阶段产物那份 markdown，按模板的节切开。
 *
 * ## 为什么要切
 *
 * 人在浏览器上**逐节留意见**（2026-08-19 定案：正文归模型，人只判），意见挂在节的
 * `key` 上 —— 和 rubric 的 criterion 挂法是同一套（`phase-template.ts`）。所以这一层
 * 要能把一份自由写就的 markdown 对回那几个 key。
 *
 * ## 认节靠标题，不靠 `<!-- section: -->`
 *
 * 模板源文件里有那行注释，但**模型写出来的产物里没有** —— 要求它逐字抄一行注释，
 * 就是又开一个手抄面（`DESIGN-no-hand-transcription-2026-08-02.md`）。所以判据是
 * 标题，和 `missingSections` 用的是同一条，两处不许分岔。
 *
 * 认不出来的节 `body` 是空串，**不报错**：一份写了一半的 PRD 仍然要看得见、要能
 * 逐节留意见。缺哪几节由 `missingSections` 说，闸门读它。
 */
export interface DocSection {
  readonly key: string;
  readonly title: string;
  /** 这一节的正文。认不出来或者空着都是空串。 */
  readonly body: string;
}

/** 这个 Change 的阶段产物落在哪（项目根之下）。 */
export const artifactPathOf = (changeId: string, phase: string): string =>
  `docs/${phase}-${changeId}.md`;

const titleOf = (line: string): string | null =>
  /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1] ?? null;

export function splitSections(
  markdown: string,
  sections: readonly TemplateSection[],
): readonly DocSection[] {
  const lines = markdown.split("\n");
  return sections.map((section) => {
    const at = lines.findIndex((line) => titleOf(line) === section.title);
    if (at < 0) return { key: section.key, title: section.title, body: "" };
    const rest = lines.slice(at + 1);
    const until = rest.findIndex((line) => titleOf(line) !== null);
    const body = (until < 0 ? rest : rest.slice(0, until)).join("\n").trim();
    return { key: section.key, title: section.title, body };
  });
}
