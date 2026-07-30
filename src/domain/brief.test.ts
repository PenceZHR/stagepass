import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ESCAPE_OPTION,
  ownFieldId,
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
  it("每题摊成两个字段：选项一格、自己写一格", () => {
    const items = readBriefProposal(fenced(THREE));
    /*
     * elicitation 的硬约束：一个字段有 enum 就是下拉，没有就是自由输入 ——
     * **没有「选项 + 或者自己写」那种字段**。所以想让人越过选项说话，只能给第二格。
     */
    assert.deepEqual(items.slice(0, 4).map((item) => item.id),
      ["B01", "B01x", "B02", "B02x"]);
    assert.equal(items[0]?.question, "这个改动主要给谁用？");
    // 模型没有机会决定 id，也删不掉那个逃逸项。
    assert.deepEqual(items[0]?.options,
      ["只给我自己", "团队里的人", "外部用户", ESCAPE_OPTION]);
    // 自己写那格没有 enum，所以是自由文本。
    assert.deepEqual(items[1]?.options, []);
  });

  it("**id 排序之后就是显示顺序** —— 客户端按字段名排，不按这里的书写顺序", () => {
    /*
     * 2026-07-30 在 Codex TUI 实测出来的：这里按 `B1, B1x, …, B0` 的顺序写出去，
     * 选择器画的第一格是 `B0`（`Field 1/17`）。客户端把 properties 排了序，
     * 所以**顺序只能编码在名字里**。
     *
     * 这条测试盯的是补零和 `BZ` 那两个决定：任何一个被"简化"掉，它就红。
     */
    const items = readBriefProposal(fenced(THREE));
    const ids = items.map((item) => item.id);
    assert.deepEqual(ids, [...ids].sort(),
      "字段名排序必须等于要给人看的顺序，否则选择器会把题和它的自由填写格拆开");
    // 每一题紧跟着自己那格，自由填写那格排最后。
    assert.deepEqual(ids,
      ["B01", "B01x", "B02", "B02x", "B03", "B03x", FREE_TEXT_ID]);
  });

  it("每题那格「你自己怎么说」是 optional —— 否则「选了也可以补充」是假话", () => {
    /*
     * 客户端把 `required` 当硬闸门：还有必填没答时按回车**什么都不发生**，没有
     * 报错也没有提示（2026-07-30 实测，`Field 3/17 (17 required unanswered)`）。
     * 所以「选了也可以补充」这句话必须落到 schema 上，不能只写在标题里。
     */
    const items = readBriefProposal(fenced(THREE));
    for (const item of items) {
      if (item.id === FREE_TEXT_ID) continue; // 它必填，理由见下一条
      const own = item.options.length === 0;
      assert.equal(item.optional === true, own,
        `${item.id}：有选项的必答，「你自己怎么说」可留空`);
    }
  });

  it("**最后那一格必填** —— 空的自由文本格会吃掉回车，而整张表只能从最后一格提交", () => {
    /*
     * 这一条是纯粹的实测约束，不是产品偏好（2026-07-30）：
     *
     *   光标停在一个空的自由文本格上按回车 → 屏幕上什么都不发生。
     *   `optional` 不管用，必填项全答完了也不管用，底下写着 `enter to submit all`
     *   也不管用。
     *
     * 而提交只发生在最后一格。所以最后一格要么是选项格（回车总有值可提交），要么
     * 必填。它是自由文本，于是必填。**把 optional 加回去，这张表就交不上去了。**
     */
    const items = readBriefProposal(fenced(THREE));
    const last = items.at(-1)!;
    assert.equal(last.id, FREE_TEXT_ID);
    assert.notEqual(last.optional, true,
      "最后一格是可留空的自由文本 = 表单交不上去，而且不说为什么");
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
      "```brief", "初稿的问题？ | 甲 | 乙 | 丙", "```",
      "想了一下，换成：",
      "```brief", "改好的问题？ | 丁 | 戊 | 己", "```",
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

  it("**只给两个选项也作废** —— 那几乎总是一个假二分", () => {
    // 用户 2026-07-30：「三个选项不够，应该由模型自己定给几个」。下限提到 3，
    // 上限不设 —— 几个够用由读过仓库的模型判断。
    assert.throws(() => readBriefProposal(fenced("要不要做？ | 要 | 不要")),
      (error: unknown) => {
        assert.ok(error instanceof BriefProposalVoidError);
        assert.equal(error.code, "too_few_options");
        return true;
      });
  });

  it("给四个、五个都行 —— 上限不设", () => {
    const five = readBriefProposal(fenced("几档？ | 一 | 二 | 三 | 四 | 五"));
    assert.equal(five[0]?.options.length, 6, "五个选项 + 一个逃逸项");
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
    const many = Array.from({ length: 9 }, (_, i) => `问题 ${i}？ | 甲 | 乙 | 丙`).join("\n");
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
        B01: "团队里的人", B02: "有测试覆盖", B03: "不动数据库",
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
      content: { B01: "只给我自己", B02: "页面上看得到结果", B03: "没有明确排除" },
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
      briefFrom(items, { action: "accept", content: { B01: "只给我自己" } }),
      null);
  });
});

describe("brief · 自己写的优先于选项", () => {
  /*
   * 用户 2026-07-30 的要求：「模型给了四个选项，但都不满足我，我需要在空白处打出
   * 我自己的想法，让模型看到我真正在想什么，而不是只能点它给的选项。」
   *
   * 所以选项是**备选**，人的原话是**答案**。两者冲突时后者说了算 —— 否则那一格
   * 就是装饰。
   */
  const items = readBriefProposal(fenced(THREE));
  const answer = (content: Record<string, string>) =>
    briefFrom(items, { action: "accept", content });

  it("选了「都不对」并写了自己的话 —— 只留他的话", () => {
    const brief = answer({
      B01: ESCAPE_OPTION, [ownFieldId("B01")]: "给我们组里另外两个后端",
      B02: "有测试覆盖", B03: "不动数据库",
    });
    assert.ok(brief);
    assert.match(brief, /给我们组里另外两个后端/);
    assert.doesNotMatch(brief, new RegExp(ESCAPE_OPTION), "逃逸项本身不该进需求");
  });

  it("**选了某一项又补充了文字 —— 两句都留着**", () => {
    // 备选说明他大致同意哪一档，补充说明他到底要什么。丢掉任何一句都是丢信息。
    const brief = answer({
      B01: "团队里的人", [ownFieldId("B01")]: "但只限后端，前端不算",
      B02: "有测试覆盖", B03: "不动数据库",
    });
    assert.ok(brief);
    assert.match(brief, /团队里的人/);
    assert.match(brief, /但只限后端，前端不算/);
  });

  it("说了「都不对」却什么也没写 —— 这一题算没答", () => {
    // 不许拿一个空的逃逸项充数：那是「我不同意你列的」，不是一个答案。
    assert.equal(answer({
      B01: ESCAPE_OPTION, B02: "有测试覆盖", B03: "不动数据库",
    }), null);
  });

  it("只写了自己的话、没点选项 —— 也算答了", () => {
    const brief = answer({
      [ownFieldId("B01")]: "其实是给运维用的",
      B02: "有测试覆盖", B03: "不动数据库",
    });
    assert.ok(brief);
    assert.match(brief, /其实是给运维用的/);
  });

  it("自己写那些格子不单独成行 —— 它们跟着自己的题", () => {
    const brief = answer({
      B01: "团队里的人", B02: "有测试覆盖", B03: "不动数据库",
      [ownFieldId("B02")]: "端到端那种",
    });
    assert.ok(brief);
    // 「↑ 上面这题」那句提示语是给选择器看的，不该出现在需求里。
    assert.doesNotMatch(brief, /↑ 上面这题/);
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
