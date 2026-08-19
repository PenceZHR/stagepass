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

/**
 * 界面不许自己编一个 Change id 出来。
 *
 * ## 这条也是被真机打出来的
 *
 * 2026-08-18 用户截图：面板右上角写着 `CHG-1`，而 `CHG-1` 在库的 `changes` 表里
 * **根本不存在** —— 底下显示的是另一个 Change（CHG-002）的状态。
 *
 * 成因是一句写死的兜底：`params.get("change") || __SP_CHANGE__ || "CHG-1"`。
 * 那是老树时代那条演示 Change 的遗物；插件里认不出项目时就掉进它。
 *
 * **认不出来要说认不出来。** 编一个 id 的代价不是「显示错了」，是**人以为自己在看
 * 这个 Change，实际在看另一个** —— 而他接下来按的每一个按钮都落在他没在看的那个上。
 */
describe("standing · 界面不编 Change id", () => {
  /*
   * **只看代码，不看散文。** 注释里当然会提到 `CHG-1`（这条护栏为什么存在，讲的
   * 就是它）—— 把注释也算进去，这条会永远红着，然后被人删掉。
   *
   * 整行的 `//` 和整段的块注释都刨掉；行尾注释不刨，那需要真解析器，而写死一个
   * Change id 不会藏在行尾注释里。
   */
  const code = script
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("**没有写死的 Change id 兜底**", () => {
    const hardcoded = [...code.matchAll(/["'`](CHG-[A-Za-z0-9_-]+)["'`]/g)]
      .map((match) => match[1]!);

    assert.deepEqual(hardcoded, [], "认不出是哪个 Change 时要说出来，不许编一个");
  });
});
