import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const HERE = join(process.cwd(), "src", "web");
const script = readFileSync(join(HERE, "panel.js"), "utf-8");
const markup = readFileSync(join(HERE, "panel.html"), "utf-8");

/**
 * 界面说「按『X』」的时候，界面上得真有一个叫 X 的东西可按。
 *
 * ## 这条护栏是被真机打出来的
 *
 * 2026-08-18 用户截图：Spec 那一轮的进程死了，面板在最显眼的位置写着
 * **「下一步：按『中止这一轮』」** —— 而动作带里根本没有这个按钮（它跟着终端门户
 * 一起被删了，而说这句话的代码留了下来）。
 *
 * 那一刻人能做的只有干等到超时。**比没有建议更坏的是一个指向不存在的东西的建议**：
 * 前者让人去找别的路，后者让人以为是自己没找到。
 *
 * 判据只看**文案和界面对不对得上**，不看实现 —— 按钮删掉、改名、被条件藏死，
 * 这条都该红。
 */
describe("standing · 界面说得出名字的按钮都真的存在", () => {
  /** 环上那颗彗星（旁路）不是 `<button>`，它是图形上的一个可点区域。 */
  const NOT_A_BUTTON = new Set(["旁路窗口"]);
  /** 弹出式的那一条：题在等你答的时候才出现，标签由 JS 现写。 */
  const WRITTEN_BY_JS = new Set(["恢复上次回答"]);

  /** 界面上所有按钮的文字。 */
  const buttonLabels = [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)]
    .map((match) => match[1]!.trim())
    .filter((text) => text !== "");

  it("**每一句「按『X』」都指得到一个真的按钮**", () => {
    const named = [...script.matchAll(/按「([^」]+)」/g)].map((match) => match[1]!);
    assert.notEqual(named.length, 0, "一句都没找到 —— 这条护栏多半被正则改坏了");

    const missing = named
      .filter((label) => !NOT_A_BUTTON.has(label) && !WRITTEN_BY_JS.has(label))
      .filter((label) => {
        /*
         * **判据是「有个按钮的文字包含这个名字」，不是逐字相等** —— 界面上写的是
         * 「brief 定稿（我改完了）」，而话里说的是「按『brief 定稿』」。那不是矛盾。
         */
        const inMarkup = buttonLabels.some((text) => text.includes(label));
        // 标签也可能由 JS 现写（`textContent = "…"`），那也算数。
        const inScript = script.includes(`textContent = "${label}"`)
          || script.includes(`textContent = \`${label}`);
        return !inMarkup && !inScript;
      });

    assert.deepEqual(missing, [], "界面在叫人按一个不存在的东西");
  });
});
