import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  briefContract,
  readBriefProposal,
  briefFrom,
  BriefProposalVoidError,
  FREE_TEXT_ID,
} from "./brief";

/**
 * 录入需求：模型读完仓库提问题，人在选择器里答，答出来的那一段就是需求。
 *
 * ## 为什么需要这一层
 *
 * 在这之前，PRD 阶段的红方收到的是一句写死的通用指令（`Write the product
 * requirement for this change…`），而"this change" 是哪个 change **从来没被告知**。
 * 于是那份 PRD 只能是编的，而下游每个阶段都写着"Turn the approved PRD into…" ——
 * 整条流水线建在一份凭空产生的需求上。
 *
 * 需求文档 §2.1 列的第一条职责就是「引导用户表达需求」。这一层就是它。
 *
 * ## 谁定什么（用户 2026-07-29 选的）
 *
 *   问什么   —— 模型定。它先读仓库，所以问题贴这个项目。
 *   信封     —— StagePass 定。id 由这里分配，选项数量、条数上下限由这里校验。
 *   一道自由填写 —— StagePass 无条件追加，模型删不掉。
 *
 * 最后一条是承重的：模型的想象力不该限定你能说什么。
 */

const fenced = (body: string): string =>
  ["我读了仓库，建议问这几件事：", "```brief", body, "```"].join("\n");

const THREE = [
  "这个改动主要给谁用？ | 只给我自己 | 团队里的人 | 外部用户",
  "怎样算成功？ | 页面上看得到结果 | 有测试覆盖 | 别人能照文档用起来",
  "这次明确不做什么？ | 不动数据库 | 不改对外接口 | 没有明确排除",
].join("\n");

describe("brief · 读模型提的问题清单", () => {
  it("问题和选项都读出来，id 由 StagePass 分配", () => {
    const items = readBriefProposal(fenced(THREE));
    // 模型没有机会决定 id —— 它决定不了的东西就不会撞上任何东西。
    assert.deepEqual(items.slice(0, 3).map((item) => item.id), ["B1", "B2", "B3"]);
    assert.equal(items[0]?.question, "这个改动主要给谁用？");
    assert.deepEqual(items[0]?.options, ["只给我自己", "团队里的人", "外部用户"]);
  });

  it("**总是多出一道自由填写，模型删不掉**", () => {
    const items = readBriefProposal(fenced(THREE));
    const last = items.at(-1);
    assert.equal(last?.id, FREE_TEXT_ID);
    // 空选项 = 没有 enum = 自由文本。模型的想象力不该限定你能说什么。
    assert.deepEqual(last?.options, []);
  });

  it("散文忽略，最后一个 fence 赢", () => {
    const items = readBriefProposal([
      "```brief", "初稿的问题？ | 甲 | 乙", "```",
      "想了一下，换成：",
      "```brief", "改好的问题？ | 丙 | 丁", "```",
    ].join("\n"));
    assert.equal(items[0]?.question, "改好的问题？");
  });

  it("一条都没提 —— 作废", () => {
    /*
     * **这是这一层最要紧的一条。** 「模型没提问题」和「这个改动不需要问」长得
     * 一模一样，都是空的。要是放过去，需求录入就被静默跳过了 —— 而下游那份 PRD
     * 仍然会被生成出来，看着一切正常。
     */
    assert.throws(() => readBriefProposal("我看了一圈，没什么要问的。"),
      (error: unknown) => {
        assert.ok(error instanceof BriefProposalVoidError);
        assert.equal(error.code, "no_items");
        return true;
      });
  });

  it("只给一个选项 —— 作废，那不是在问", () => {
    assert.throws(() => readBriefProposal(fenced("要不要做？ | 要")),
      (error: unknown) => {
        assert.ok(error instanceof BriefProposalVoidError);
        assert.equal(error.code, "too_few_options");
        return true;
      });
  });

  it("问题是空的 —— 作废", () => {
    assert.throws(() => readBriefProposal(fenced("  | 甲 | 乙")),
      (error: unknown) => {
        assert.ok(error instanceof BriefProposalVoidError);
        assert.equal(error.code, "question_empty");
        return true;
      });
  });

  it("提太多 —— 作废，一次问二十件事没人答得完", () => {
    const many = Array.from({ length: 9 }, (_, i) => `问题 ${i}？ | 甲 | 乙`).join("\n");
    assert.throws(() => readBriefProposal(fenced(many)),
      (error: unknown) => {
        assert.ok(error instanceof BriefProposalVoidError);
        assert.equal(error.code, "too_many");
        return true;
      });
  });
});

describe("brief · 人答完之后那一段就是需求", () => {
  it("把问答拼成一段可读的需求", () => {
    const items = readBriefProposal(fenced(THREE));
    const brief = briefFrom(items, {
      action: "accept",
      content: {
        B1: "团队里的人", B2: "有测试覆盖", B3: "不动数据库",
        [FREE_TEXT_ID]: "上线前要能一键回滚",
      },
    });
    assert.ok(brief);
    // 问题和答案都留着 —— 只留答案的话，下游读到「团队里的人」不知道在答什么。
    assert.match(brief, /这个改动主要给谁用？/);
    assert.match(brief, /团队里的人/);
    assert.match(brief, /上线前要能一键回滚/);
  });

  it("自由填写留空是允许的 —— 它是补充，不是必答", () => {
    const items = readBriefProposal(fenced(THREE));
    const brief = briefFrom(items, {
      action: "accept",
      content: { B1: "只给我自己", B2: "页面上看得到结果", B3: "没有明确排除" },
    });
    assert.ok(brief);
    assert.doesNotMatch(brief, /undefined/);
  });

  it("人按了 Esc —— 没有需求，返回 null", () => {
    // 不是"空需求"。没答就是没答，让调用方决定怎么办，而不是拿一段空白往下走。
    const items = readBriefProposal(fenced(THREE));
    assert.equal(briefFrom(items, { action: "decline", content: {} }), null);
  });

  it("一道必答的没答 —— 返回 null", () => {
    const items = readBriefProposal(fenced(THREE));
    assert.equal(
      briefFrom(items, { action: "accept", content: { B1: "只给我自己" } }),
      null);
  });
});

describe("brief · 发给模型的契约", () => {
  it("告诉它先读仓库，并把 Change 的标题给它当线索", () => {
    const contract = briefContract({ changeTitle: "给 PRD 页面加一个重新生成按钮" });
    assert.match(contract, /给 PRD 页面加一个重新生成按钮/);
    assert.match(contract, /```brief/);
  });

  it("**明确告诉它别被仓库带跑**", () => {
    /*
     * 读仓库有个真实的副作用：模型容易开始问「现有代码怎么样」，而人想做的事可能
     * 和仓库里现在有什么毫无关系。契约里必须把这句写出来。
     */
    const contract = briefContract({ changeTitle: null });
    assert.match(contract, /可能和仓库里现在有什么无关|不要只问现有代码/);
  });

  it("没有标题也给得出契约", () => {
    assert.equal(typeof briefContract({ changeTitle: null }), "string");
  });
});
