import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readSheet, type Claim, type SheetRead } from "./rubric-sheet";
import { readWorklistAnswers, type WorkItemDraft } from "./worklist";

/**
 * 判据单答案文件的读回。
 *
 * ## 它撑着的是闸门，所以「读丢了一条」不能是静默的
 *
 * `computeGate` 的第三条判据（T7）读的就是这里吐出来的 `missing`。所以这一份里
 * 每一条测试的真正问句都是同一个：**一条没被正确读回来的答案，会不会看起来像
 * 「答了」。** 会的话，闸门就被悄悄打开了 —— 而 2026-08-19 那次事故（题面叫裁判
 * 调一个已经删掉的工具、1177 条全绿）正是同一个形状的反面：闸门被悄悄关死。
 *
 * ## 为什么它必须和 `worklist` 同构
 *
 * 一个人手里两种格式，就是两次答错的机会（`domain/worklist.ts` 的原话）。所以最后
 * 一条测试把**同一份文本**喂给两个 reader，比它们解出来的东西 —— 那是「同构」唯一
 * 机械可查的形式，写在注释里的「和 xx 逐字同形」保不住任何东西。
 */

const CLAIMS: readonly Claim[] = ["pass", "blocked", "n_a"];

/** 断言用：把结果压成好读的形状，失败信息里能直接看出解成了什么。 */
const shapeOf = (read: SheetRead): {
  lines: [number, Claim, string][]; missing: number[]; problems: string[];
} => ({
  lines: read.lines.map((line) => [line.ordinal, line.claim, line.evidence]),
  missing: [...read.missing],
  problems: [...read.problems],
});

describe("L0 · 判据单读回 —— 按序号，答一半不作废", () => {
  it("答一半不作废 —— 少一行就是少一条，不会让别的条错位", () => {
    // 反方那份判定数不对就整份作废（它按位置映射）。这一份不是：每行自带序号，
    // 映射逐条独立。把这两条规矩混起来，人写漏一行就会丢掉他写对的那几条。
    const out = readSheet("1: pass 见 spec.md\n3: blocked 判不了", 4);
    assert.deepEqual([...out.missing], [2, 4]);
    assert.equal(out.lines.length, 2);
    assert.deepEqual(shapeOf(out).lines, [
      [1, "pass", "见 spec.md"],
      [3, "blocked", "判不了"],
    ]);
  });

  it("三种 claim 都认得，而且原样回来 —— 它是枚举，不是散文", () => {
    const text = CLAIMS.map((claim, index) => `${index + 1}: ${claim} 理由${index + 1}`).join("\n");
    assert.deepEqual(shapeOf(readSheet(text, 3)).lines, [
      [1, "pass", "理由1"], [2, "blocked", "理由2"], [3, "n_a", "理由3"],
    ]);
  });

  it("claim=pass 但没写证据，算 missing 不算 problem", () => {
    // 它不是格式错，是没交代 —— 闸门要拦的正是这个。进 problems 的话，面板上
    // 会显示成「这一行写坏了」，人会去改格式，而真正缺的是那句话。
    const out = readSheet("1: pass", 1);
    assert.deepEqual([...out.missing], [1]);
    assert.deepEqual([...out.problems], []);
    assert.deepEqual([...out.lines], []);
  });

  it("**blocked / n_a 不写证据是答了** —— PRD §3.1 只对 pass 要求证据", () => {
    // 反过来做（一律要求证据）会让「这条我判不了」变成一条永远填不完的格子，
    // 而那正是它存在的意义：判不了也是一种交代。
    const out = readSheet("1: blocked\n2: n_a", 2);
    assert.deepEqual([...out.missing], []);
    assert.deepEqual(shapeOf(out).lines, [[1, "blocked", ""], [2, "n_a", ""]]);
  });

  it("序号重复：进 problems 且带序号，而且第二条不覆盖第一条", () => {
    const out = readSheet("1: pass 第一次\n1: blocked 第二次\n2: pass 另一条", 2);
    assert.deepEqual(shapeOf(out).lines, [[1, "pass", "第一次"], [2, "pass", "另一条"]]);
    assert.equal(out.problems.length, 1, `problems=${JSON.stringify(out.problems)}`);
    assert.match(out.problems[0]!, /\b1\b/);
  });

  it("序号越界：进 problems 且带序号，不进 lines", () => {
    const out = readSheet("1: pass 有的\n7: pass 没有第七条", 2);
    assert.deepEqual(shapeOf(out).lines, [[1, "pass", "有的"]]);
    assert.deepEqual([...out.missing], [2]);
    assert.equal(out.problems.length, 1, `problems=${JSON.stringify(out.problems)}`);
    assert.match(out.problems[0]!, /\b7\b/);
  });

  it("**认不出的 claim 既要进 problems、也要留在 missing**", () => {
    /*
     * 这一条是这份文件里最贵的一条。
     *
     * 只进 problems 的话，那一条就从 `missing` 里消失了 —— 一张全写着 `maybe`
     * 的判据单会**一条 missing 都没有**，闸门当场放行，而 lines 是空的。
     * 那正是 2026-08-19 那次事故的形状：不是报错，是一个看起来合法的绿。
     *
     * 只进 missing 的话，人只看见「你没答第 1 条」，而他明明写了 —— 他会再写一遍
     * 同样的东西。两个都要。
     */
    const out = readSheet("1: maybe 我不确定\n2: pass 见 spec.md", 2);
    assert.deepEqual(shapeOf(out).lines, [[2, "pass", "见 spec.md"]]);
    assert.deepEqual([...out.missing], [1], "认不出的 claim 不能算「答过了」");
    assert.equal(out.problems.length, 1, `problems=${JSON.stringify(out.problems)}`);
    assert.match(out.problems[0]!, /\b1\b/);
  });

  it("读不懂的行不是问题 —— 标题、空行、说明照旧放行", () => {
    // 和 `readWorklistAnswers` 同一条规矩。把标题判成格式错，人打开面板看到的是
    // 一串假警报，真警报就淹在里面了。
    const out = readSheet("# 判据单\n\n（下面逐条写）\n\n1: pass 见 spec.md\n", 2);
    assert.deepEqual([...out.problems], []);
    assert.deepEqual([...out.missing], [2]);
  });

  it("一条都没写 = 全缺，而不是「没什么要答的」", () => {
    assert.deepEqual([...readSheet("", 3).missing], [1, 2, 3]);
    assert.deepEqual([...readSheet("   \n\n", 3).missing], [1, 2, 3]);
  });

  it("判据单本来就是零条时，什么都不缺", () => {
    // 闸门要能区分「这个阶段没有判据单」和「有判据单但没填」。前者不该挡门。
    const out = readSheet("", 0);
    assert.deepEqual([...out.missing], []);
    assert.deepEqual([...out.lines], []);
    assert.deepEqual([...out.problems], []);
  });

  it("**missing 升序且不重复** —— 它要直接摆到面板上给人照着补", () => {
    const out = readSheet("4: pass 见 a\n2: pass 见 b", 5);
    assert.deepEqual([...out.missing], [1, 3, 5]);
  });
});

/**
 * 同构：**同一份文本，两个 reader 解出来的行必须一致。**
 *
 * 「和 worklist 逐字同形」在 TechSpec 和源码注释里各写了一遍，而注释挡不住任何
 * 东西：谁在 `readSheet` 里少写一句「去掉前面的 `- `」，两份格式就在那一天分家了，
 * 而人不会收到任何提示 —— 他只会在某一份文件里写了同样的话却没被收下。
 */
describe("L0 · 判据单和名单是同一种行格式", () => {
  /** 三条判据 ≙ 三条名单项，可选项就是三个 claim。 */
  const items: readonly WorkItemDraft[] = CLAIMS.map((_, index) => ({
    kind: "criterion" as const,
    target: `K${index + 1}`,
    prompt: `第 ${index + 1} 条`,
    choices: CLAIMS,
  }));

  /** 排版上人真会写出来的四种变体，一次全塞进去。 */
  const TEXT = [
    "1: pass 见 spec.md §2.3",
    "2：blocked —— 这条我判不了，见 ASK-0007",
    "- 3 : n_a  这个阶段不适用",
  ].join("\n");

  it("干净的一份：两边解出同样的 (序号, 枚举, 散文)", () => {
    const sheet = readSheet(TEXT, 3);
    const worklist = readWorklistAnswers(TEXT, items);

    assert.deepEqual(
      sheet.lines.map((line) => [line.ordinal, line.claim, line.evidence]),
      worklist.answers.map((answer) => [answer.ordinal, answer.answer, answer.reason]),
    );
    assert.deepEqual([...sheet.problems], [], "判据单这边报了名单没报的问题");
    assert.deepEqual([...worklist.problems], [], "名单这边报了判据单没报的问题");
    assert.equal(sheet.lines.length, 3, "三种排版变体应该三条都读得回来");
  });

  it("越界的一份：两边都报，而且都带那个序号", () => {
    const bad = "9: pass 没有第九条";
    const sheet = readSheet(bad, 3);
    const worklist = readWorklistAnswers(bad, items);

    assert.equal(sheet.lines.length, 0);
    assert.equal(worklist.answers.length, 0);
    assert.ok(sheet.problems.some((problem) => /\b9\b/.test(problem)),
      `判据单没报越界：${JSON.stringify(sheet.problems)}`);
    assert.ok(worklist.problems.some((problem) => /\b9\b/.test(problem)),
      `名单没报越界：${JSON.stringify(worklist.problems)}`);
  });
});
