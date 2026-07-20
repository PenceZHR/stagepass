import type { RubricRole } from "./rubric-assessment";
import type { RubricVersionRecord } from "./rubric-service";

/**
 * Renders the rubric section appended to a stage's prompt.
 *
 * Built in code rather than kept in server/templates/prompts/*.md on purpose.
 * The criteria are DB rows, so the list is dynamic either way, but the protocol
 * instructions around it are a contract with parseRubricLineProtocol(): the
 * keyword, the field count, the yes/no vocabulary, and "an unknown id voids the
 * output" all have to say exactly what the parser enforces. A template file is
 * editable per project (.ship/prompts/), which is right for wording and wrong
 * for a wire format -- a project that edited the field order would get every
 * rubric reply voided with no way to tell why. The criteria themselves are the
 * user-editable part, and they live in the database where the UI can reach them.
 *
 * rubric-prompt.test.ts feeds this section's own worked example back through the
 * parser, so the two cannot drift.
 */

const ROLE_FRAMING: Record<RubricRole, { title: string; stance: string }> = {
  producer: {
    title: "交付自证清单",
    stance: "你是本阶段产物的作者。交付前，对下面每一条标准自证你是否真的满足了它。",
  },
  critic: {
    title: "独立复核清单",
    stance: "你是独立审查方。对下面每一条标准，判断被审查的产物是否满足它；不要采信作者的自证结论。",
  },
  verdict: {
    title: "裁决清单",
    stance: "你是裁决方，输入是正方与反方各自的产出。对下面每一条标准给出最终判定。",
  },
};

export function renderRubricPromptSection(rubric: RubricVersionRecord): string | null {
  if (rubric.criteria.length === 0) return null;
  const framing = ROLE_FRAMING[rubric.role];

  const criteriaLines = rubric.criteria
    .map((criterion, index) => `${index + 1}. \`${criterion.id}\` — ${criterion.text}`)
    .join("\n");

  const exampleId = rubric.criteria[0]!.id;

  return [
    `## ${framing.title}（RUBRIC 判定，必答）`,
    "",
    framing.stance,
    "",
    "在你其余全部输出的**最后面**，为下面清单里的**每一条**写且只写一行：",
    "",
    "```",
    "RUBRIC: criterionId | yes 或 no | evidence",
    "```",
    "",
    "字段说明：",
    "- `criterionId`：下面清单中该条的 ID，必须**逐字符照抄**，不要改写、翻译或缩写。",
    "- 判定只能是 `yes` 或 `no`。**没有第三个取值**：不要写 `not_assessed`、`n/a`、`partial`、`unknown` 或任何分数。",
    "  一条你无法确定的标准，就是 `no`。",
    "- `evidence`：支撑该判定的具体依据（引用产物中的原文或小节）。`yes` 也必须给证据，"
    + "「符合要求」这类没有指向的说法不算证据。",
    "",
    "清单：",
    "",
    criteriaLines,
    "",
    "硬性规则（违反会导致整份判定被系统驳回并要求重跑）：",
    `- 每条标准**恰好一行**，共 ${rubric.criteria.length} 行；同一个 ID 不能写两行。`,
    "- 不要发明清单以外的 ID。出现未知 ID 时，系统会把你**整份判定作废**，因为无法确定你答的是哪张清单。",
    "- 漏答一条不会被当作通过：系统会把它记为「未评估」，与 `no` 同等对待。",
    "- RUBRIC 行是给系统解析的，不是文档内容；系统会在写入产物前把它们摘除。",
    "",
    "示例（仅示意格式）：",
    "",
    `RUBRIC: ${exampleId} | no | 第 3 节只写了「支持导出」，没有给出任何可判定的验收条件`,
    "",
  ].join("\n");
}
