import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  nextVersion,
  retiredBy,
  UntrustedKeyError,
  InvalidCriterionError,
  type Criterion,
  type CriterionDraft,
} from "./rubric";

/**
 * criterion_key 的稳定性，以及一次编辑退休掉了什么。
 *
 * 这两件事在新树里是承重的，不是整洁问题：
 *
 * - `gate.snapshotOf` 哈希的是 blocker 的 **id**，而 rubric 派生的 gap id 从
 *   `criterion_key` 派生。key 一动，snapshot 就动，**每一个 open question 的 fence
 *   当场作废** —— 人正在回答的问题被拒绝。所以「改一个错别字不许换 key」不是风格，
 *   是不能坏的。
 * - 「这次编辑退休掉了哪些活着的阻断项」是 PRD §1.1 那条理由要求的判据：网页可以
 *   改标准，但**不能静默地**把一个正挡着闸门的问题撤掉。
 *
 * 见 docs/RUBRIC-REMAP-2026-07-29.md §3.2 / §3.3。
 */

const mint = (index: number): string => `MINTED-${index}`;

const criterion = (
  key: string, ordinal: number, text: string, blocking: boolean,
): Criterion => ({ key, ordinal, text, blocking });

const draft = (
  text: string, blocking: boolean, key?: string | null,
): CriterionDraft => (key === undefined ? { text, blocking } : { text, blocking, key });

describe("rubric · criterion_key 跨版本稳定", () => {
  it("正文改了也沿用编辑器回传的 key —— 这条是承重的", () => {
    const previous = [criterion("K1", 0, "验收标准必须可测", true)];
    const next = nextVersion(previous, [draft("验收标准必须可以测量", true, "K1")], mint);

    // key 不动，所以 RB:<key> 派生的 gap id 不动，snapshot 不动，
    // 已经在等人回答的 question 不会被 fence 拒掉。
    assert.deepEqual(next, [criterion("K1", 0, "验收标准必须可以测量", true)]);
  });

  it("没有回传 key 时按正文原样匹配，作为后备", () => {
    const previous = [criterion("K1", 0, "验收标准必须可测", true)];
    const next = nextVersion(previous, [draft("验收标准必须可测", false)], mint);

    assert.equal(next[0]?.key, "K1");
    assert.equal(next[0]?.blocking, false);
  });

  it("正文是新的就铸新 key", () => {
    const previous = [criterion("K1", 0, "验收标准必须可测", true)];
    const next = nextVersion(previous, [
      draft("验收标准必须可测", true, "K1"),
      draft("每条需求要有反例", true),
    ], mint);

    assert.deepEqual(next.map((entry) => entry.key), ["K1", "MINTED-1"]);
  });

  it("回传一个本 scope 没有的 key —— 拒绝整次编辑，不是悄悄铸一个", () => {
    const previous = [criterion("K1", 0, "验收标准必须可测", true)];

    // 信了它，就等于允许一个请求把一条新写的 criterion 绑到别人已经开着的 gap 上。
    assert.throws(
      () => nextVersion(previous, [draft("随便写的", true, "K-别的-scope")], mint),
      UntrustedKeyError,
    );
  });

  it("同一个 key 用两次 —— 拒绝", () => {
    const previous = [criterion("K1", 0, "验收标准必须可测", true)];
    assert.throws(
      () => nextVersion(previous, [
        draft("一", true, "K1"),
        draft("二", true, "K1"),
      ], mint),
      InvalidCriterionError,
    );
  });

  it("文本匹配不许把同一条旧 criterion 认领两次", () => {
    const previous = [criterion("K1", 0, "同一句话", true)];
    const next = nextVersion(previous, [
      draft("同一句话", true),
      draft("同一句话", true),
    ], mint);

    // 先到先得，第二条是新的。两条都拿 K1 会让一个 gap 有两个来源。
    assert.deepEqual(next.map((entry) => entry.key), ["K1", "MINTED-1"]);
  });

  it("空正文 —— 拒绝", () => {
    assert.throws(
      () => nextVersion([], [draft("   ", true)], mint),
      InvalidCriterionError,
    );
  });

  it("ordinal 按这次提交的顺序重排", () => {
    const previous = [
      criterion("K1", 0, "一", true),
      criterion("K2", 1, "二", true),
    ];
    const next = nextVersion(previous, [
      draft("二", true, "K2"),
      draft("一", true, "K1"),
    ], mint);

    assert.deepEqual(next.map((entry) => [entry.key, entry.ordinal]), [["K2", 0], ["K1", 1]]);
  });

  it("空 rubric 合法 —— 等于这个阶段不做 rubric 判定", () => {
    assert.deepEqual(nextVersion([], [], mint), []);
  });
});

describe("rubric · 一次编辑退休掉了什么", () => {
  const previous = [
    criterion("K1", 0, "挡着的一条", true),
    criterion("K2", 1, "不挡的一条", false),
    criterion("K3", 2, "另一条挡着的", true),
  ];

  it("删掉一条阻断 criterion，它进退休名单", () => {
    const next = nextVersion(previous, [
      draft("不挡的一条", false, "K2"),
      draft("另一条挡着的", true, "K3"),
    ], mint);
    assert.deepEqual(retiredBy(previous, next).map((entry) => entry.key), ["K1"]);
  });

  it("取消勾选阻断，也进退休名单", () => {
    const next = nextVersion(previous, [
      draft("挡着的一条", false, "K1"),
      draft("不挡的一条", false, "K2"),
      draft("另一条挡着的", true, "K3"),
    ], mint);
    assert.deepEqual(retiredBy(previous, next).map((entry) => entry.key), ["K1"]);
  });

  it("只改正文不算退休 —— 标准还在，只是话说得清楚了", () => {
    const next = nextVersion(previous, [
      draft("挡着的一条（说清楚一点）", true, "K1"),
      draft("不挡的一条", false, "K2"),
      draft("另一条挡着的", true, "K3"),
    ], mint);
    assert.deepEqual(retiredBy(previous, next), []);
  });

  it("删掉一条本来就不阻断的，不算退休 —— 它从没派生过阻断项", () => {
    const next = nextVersion(previous, [
      draft("挡着的一条", true, "K1"),
      draft("另一条挡着的", true, "K3"),
    ], mint);
    assert.deepEqual(retiredBy(previous, next), []);
  });

  it("一次编辑退休多条，全部列出 —— 理由要覆盖到每一条", () => {
    assert.deepEqual(
      retiredBy(previous, nextVersion(previous, [draft("不挡的一条", false, "K2")], mint))
        .map((entry) => entry.key),
      ["K1", "K3"],
    );
  });
});
