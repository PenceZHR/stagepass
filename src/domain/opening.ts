import { parseTemplateSections } from "./phase-template";
import type { Phase } from "./phase";

/**
 * 一个阶段的开场白 —— 人开新会话时原样粘进去的那段话。
 *
 * ## 为什么它必须由 StagePass 给，而不是人自己记
 *
 * 这段话里有三个工具名和一套规矩，而工具是会变的（今天 `stagepass_ask` 就从
 * 一次一条改成了一次一批）。人记在脑子里或者存在别处，改了之后他不会知道 ——
 * 表现是他粘了一段过时的话进去，模型照着做，然后两边对不上。
 *
 * **面板上一点就复制**（用户 2026-08-19：「可以点击一个复制按键复制，而不是手动
 * 复制」）—— 手动选中一段多行文本本来就是这套东西最不该有的那种手续。
 *
 * ## 文本在 markdown 里
 *
 * `src/prompts/opening.md`，和阶段模板同一个格式、同一个解析器。用户 2026-08-13
 * 拍板：提示词要模块化、文本储存，代码只装配。
 */
export type OpeningRole = "producer" | "blue";

/** 开场白里唯一的占位符。多一个就多一处会写错的地方。 */
const PHASE_MARK = "{{phase}}";

export function renderOpening(
  source: string, phase: Phase, role: OpeningRole,
): string | null {
  const section = parseTemplateSections(source).find((one) => one.key === role);
  if (section === undefined) return null;
  return section.asks.split(PHASE_MARK).join(phase);
}
