import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rubricContract, readAssessments, answeredKeysIn, RubricOutputVoidError,
} from "./rubric-protocol";
import type { Criterion } from "./rubric";

/**
 * 读一份 rubric 判定。
 *
 * 这一层只有两种结局，中间地带是故意没有的：
 *
 * - **能读**：每条 criterion 都有一个判定，漏答的那些记 `not_assessed`。
 * - **作废整份**：出现了不该出现的东西（不认识的 key、不认识的 verdict、模型自己
 *   写了 `not_assessed`、同一条答了两次）。
 *
 * 为什么作废而不是尽力而为：作废**可以重试** —— 模型有机会改一个错字；而
 * `not_assessed` 是永久记账。两者都 fail-closed，但作废更保守，而且不会被误读成
 * 一次真实的判定。见 docs/RUBRIC-REMAP-2026-07-29.md §3.6。
 */

const criterion = (key: string, ordinal: number, text: string, blocking = true): Criterion =>
  ({ key, ordinal, text, blocking });

const CRITERIA: Criterion[] = [
  criterion("RBC-a", 0, "每条需求都有可测的验收标准"),
  criterion("RBC-b", 1, "术语与上游文档一致", false),
];

const fenced = (body: string): string => ["前面的散文。", "```rubric", body, "```", "后面的散文。"].join("\n");

describe("rubric 协议 · 能读的情况", () => {
  it("答齐了就逐条返回，顺序按 rubric 而不是按模型写的顺序", () => {
    const read = readAssessments(fenced([
      "RBC-b yes 用的都是 Spec 里的叫法",
      "RBC-a no 第 2 条只写了「要快」",
    ].join("\n")), CRITERIA);

    assert.deepEqual(read, [
      { criterionKey: "RBC-a", verdict: "no", evidence: "第 2 条只写了「要快」" },
      { criterionKey: "RBC-b", verdict: "yes", evidence: "用的都是 Spec 里的叫法" },
    ]);
  });

  it("漏答的记 not_assessed —— 沉默不能被当成通过", () => {
    const read = readAssessments(fenced("RBC-a yes 都写了"), CRITERIA);
    assert.deepEqual(read[1], {
      criterionKey: "RBC-b", verdict: "not_assessed", evidence: null,
    });
  });

  it("一个字都没答，整份仍然可读 —— 全部 not_assessed", () => {
    const read = readAssessments("我看完了，没什么要说的。", CRITERIA);
    assert.deepEqual(read.map((entry) => entry.verdict), ["not_assessed", "not_assessed"]);
  });

  it("没有理由就是 null，不是空字符串", () => {
    const read = readAssessments(fenced("RBC-a yes"), CRITERIA);
    assert.equal(read[0]?.evidence, null);
  });

  it("verdict 大小写不计较 —— 计较它只会换来一次毫无意义的重试", () => {
    const read = readAssessments(fenced("RBC-a YES 都写了"), CRITERIA);
    assert.equal(read[0]?.verdict, "yes");
  });

  it("没有 fence 也能读，散文照样忽略", () => {
    const read = readAssessments([
      "我的判定如下：",
      "RBC-a no 缺验收标准",
      "以上。",
    ].join("\n"), CRITERIA);
    assert.equal(read[0]?.verdict, "no");
  });

  it("写了两个 fence —— 最后一个赢（模型改主意时会再写一个）", () => {
    const read = readAssessments([
      "```rubric", "RBC-a yes 初稿看着还行", "```",
      "再看一遍，改判：",
      "```rubric", "RBC-a no 其实第 2 条不可测", "```",
    ].join("\n"), CRITERIA);
    assert.equal(read[0]?.verdict, "no");
    assert.equal(read[0]?.evidence, "其实第 2 条不可测");
  });

  it("空 rubric 返回空 —— 这个阶段不做判定，输出里写什么都不看", () => {
    assert.deepEqual(readAssessments(fenced("RBC-谁知道 yes 随便写"), []), []);
  });
});

describe("rubric 协议 · 作废整份的情况", () => {
  const voided = (text: string, code: string) => {
    assert.throws(() => readAssessments(fenced(text), CRITERIA), (error: unknown) => {
      assert.ok(error instanceof RubricOutputVoidError);
      assert.equal(error.code, code);
      return true;
    });
  };

  it("不认识的 criterion key —— 作废，不是忽略那一行", () => {
    // 忽略它等于允许模型凭空多答一条；而它多答的那条会被当成一条没有标准的判定。
    voided("RBC-a yes 都写了\nRBC-不存在 no 瞎说的", "unknown_key");
  });

  it("不认识的 verdict —— 作废，不是记 not_assessed", () => {
    voided("RBC-a maybe 说不好", "unknown_verdict");
  });

  it("模型自己写 not_assessed —— 作废", () => {
    // 能写就等于给了它一条「跳过这题」的路。not_assessed 是解析器发现缺行时填的
    // 记账，不是模型可以选的第三个答案。
    voided("RBC-a not_assessed 我没看", "reserved_verdict");
  });

  it("同一条答两次 —— 作废", () => {
    // 一轮对一条标准只能有一个判定。两行会让「这一轮说了什么」没有答案。
    voided("RBC-a yes 行\nRBC-a no 不行", "duplicate_key");
  });

  it("但没有 fence 时，不认识的 key 只是散文 —— 这处不对称是故意的", () => {
    /*
     * 规则一句话：**fence 里面是结构化区域，外面是捡的。**
     *
     * 没有 fence 时整段都是散文，任何三段式的句子都会撞上那个正则。若照样作废，
     * 一句「我 看完 了」就能让一份本来读得懂的输出报废。
     *
     * 这条宽容是安全的：它最多让某条记成 not_assessed（fail-closed），
     * **永远不会造出一个假的判定** —— 那才是不可接受的方向。
     */
    const read = readAssessments([
      "我 看完 了",
      "RBC-a no 缺验收标准",
      "以上 就是 全部",
    ].join("\n"), CRITERIA);

    assert.equal(read[0]?.verdict, "no");
    assert.equal(read[1]?.verdict, "not_assessed");
  });
});

describe("rubric 协议 · 契约由 StagePass 生成", () => {
  it("把每条 criterion 的 key 和正文都摆出来", () => {
    const contract = rubricContract(CRITERIA, "正方这一轮的产出");
    for (const entry of CRITERIA) {
      assert.ok(contract.includes(entry.key), `契约里没有 ${entry.key}`);
      assert.ok(contract.includes(entry.text), `契约里没有 ${entry.text} 的正文`);
    }
  });

  it("不告诉模型 not_assessed 这个值存在", () => {
    // 契约里出现它，就等于邀请模型去用它。
    assert.ok(!rubricContract(CRITERIA, "正方这一轮的产出").includes("not_assessed"));
  });

  it("**说清判的是谁的活儿** —— 少了它，蓝方会去判自己刚写的那些问题", () => {
    // 从「各自对照自己那份」改成「判别人那份」之后，主语不能省（用户 2026-07-30）。
    assert.ok(rubricContract(CRITERIA, "正方这一轮的产出").includes("正方这一轮的产出"));
  });

  it("空 rubric 也给得出契约，不抛", () => {
    assert.equal(typeof rubricContract([], "正方这一轮的产出"), "string");
  });
});

/**
 * 「不属于你」和「不存在」不是一回事。
 *
 * 输入取自 2026-07-31 在 `.stagepass/verification/build-0730/panel.db` 和对应
 * rollout 里读到的真实错位，不是编的：
 *
 * - Review 第 6 轮，裁判在一个围栏里答了 8 条 —— 它本职的 4 条 critic + 反方那
 *   4 条 producer。作废规则把它答对的 4 条一起扔了，其中两条是实打实的 `no`。
 * - Retro 第 1 轮，反方答的 4 条 key 全是 critic 的（等于在给自己打分），而且没包
 *   围栏，于是走「没围栏就捡认识的」那条路，4 行全被静默跳过。
 */
describe("rubric 协议 · 别人那一份的 key", () => {
  const MINE: Criterion[] = [
    criterion("RBC-mine-1", 0, "我这份的第一条"),
    criterion("RBC-mine-2", 1, "我这份的第二条"),
  ];
  const THEIRS = new Set(["RBC-theirs-1", "RBC-theirs-2"]);

  it("**多答了别人那份 —— 我这份照常读出来，不再连坐作废**", () => {
    const read = readAssessments(fenced([
      "RBC-mine-1 no 这一条没做到",
      "RBC-mine-2 yes 这一条做到了",
      "RBC-theirs-1 yes 不归我判的那一条",
      "RBC-theirs-2 no 也不归我判",
    ].join("\n")), MINE, THEIRS);

    assert.deepEqual(read.map((entry) => entry.verdict), ["no", "yes"]);
    assert.equal(read[0]!.evidence, "这一条没做到");
  });

  it("**凭空多答一条谁都不认识的 —— 仍然作废整份**", () => {
    // 这条规则没有被改松：一个没有标准的判定是假证据。
    assert.throws(
      () => readAssessments(fenced("RBC-mine-1 yes 好\nRBC-凭空 yes 编的"), MINE, THEIRS),
      (error: unknown) =>
        error instanceof RubricOutputVoidError && error.code === "unknown_key",
    );
  });

  it("不给 elsewhere 时行为和以前逐字一致 —— 别人那份也照旧作废", () => {
    assert.throws(
      () => readAssessments(fenced("RBC-theirs-1 yes 别人那条"), MINE),
      (error: unknown) => error instanceof RubricOutputVoidError,
    );
  });

  it("只答了别人那份 —— 我这份全是 not_assessed，而不是作废", () => {
    const read = readAssessments(
      fenced("RBC-theirs-1 yes 甲\nRBC-theirs-2 no 乙"), MINE, THEIRS,
    );
    assert.deepEqual(read.map((entry) => entry.verdict), ["not_assessed", "not_assessed"]);
  });
});

describe("rubric 协议 · 这一份是被谁答的", () => {
  const KEYS = new Set(["RBC-x", "RBC-y"]);

  it("**没包围栏也认得出来** —— Retro 那次就是这么被静默吞掉的", () => {
    const text = [
      "我先说明一下我的判断依据。",
      "RBC-x no 两条 blocker 只有概括性标题",
      "RBC-y yes 仅针对正方给出的内容提出",
    ].join("\n");
    assert.deepEqual(answeredKeysIn(text, KEYS).sort(), ["RBC-x", "RBC-y"]);
  });

  it("和 readAssessments 用同一个取围栏的规矩 —— 最后一个赢", () => {
    const text = [
      "```rubric", "RBC-x yes 草稿", "```",
      "改主意了：", "```rubric", "RBC-y no 定稿", "```",
    ].join("\n");
    assert.deepEqual(answeredKeysIn(text, KEYS), ["RBC-y"]);
  });

  it("**只认 yes / no** —— 写了别的不算「答了」，那是另一种坏法", () => {
    assert.deepEqual(answeredKeysIn("RBC-x 部分满足 含糊其辞", KEYS), []);
    assert.deepEqual(answeredKeysIn("RBC-x not_assessed 跳过", KEYS), []);
  });

  it("名单外的 key 不算", () => {
    assert.deepEqual(answeredKeysIn("RBC-别的 yes 好", KEYS), []);
  });

  it("一条都没答 —— 空数组", () => {
    assert.deepEqual(answeredKeysIn("我什么标准都没答。", KEYS), []);
  });
});
