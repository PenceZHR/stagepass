import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { AskStore } from "./ask-store";
import { ChangeStore } from "./change-store";

/**
 * 提问的留档：**文件为准，库为索引。**
 *
 * ## 为什么往返测试是这份文件的中心
 *
 * 「库丢了能从文件重建，反过来不行」是 TechSpec §五 的原话，而这句话在代码里没有
 * 任何形状 —— 它是两条写路径之间的一个约定。约定靠不住：谁在 `record` 里先写库
 * 再写文件，或者在 `answer` 里只更新库，这句话当天就变成一句口号，而**在库还活着
 * 的那段时间里，一切看起来都正常**。往返是它唯一的证明。
 *
 * ## 这是这棵树上第一个往「项目目录」写文件的 store
 *
 * 生产上它写 `<项目>/.stagepass/asks.jsonl`。测试里路径写错一次，就会在真仓库里
 * 落一个 `.stagepass/`，而且没有任何东西会报错。所以每个测试都自己
 * `mkdtempSync(join(tmpdir(), "ask-"))`，并且有一条测试专门盯着这一点。
 */

const CHANGE = "CHG-ASK";
const OTHER = "CHG-OTHER";
const PHASE = "Spec" as const;

/** 建过的临时目录，跑完一起收掉 —— 留着会在 /tmp 里堆出上千个空目录。 */
const TEMP_DIRS: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-"));
  TEMP_DIRS.push(dir);
  return dir;
}

const tmpJsonl = (): string => join(tmpDir(), "asks.jsonl");

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/**
 * 一个全新的空库 + 一个指着 `path` 的 store。
 *
 * 时钟一格一秒地走：`askedAt` 要能排序，而固定时钟会让「按时间列出来」这条判据
 * 变成一个永远成立的空断言。
 */
function open(path: string): { database: Database.Database; store: AskStore } {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const changes = new ChangeStore(database, { now: () => new Date("2026-08-19T00:00:00.000Z") });
  changes.create(CHANGE);
  changes.create(OTHER);

  let tick = 0;
  return {
    database,
    store: new AskStore(database, path, () => new Date(Date.UTC(2026, 7, 19, 0, 0, tick += 1))),
  };
}

const asked = (patch: Partial<Parameters<AskStore["record"]>[0]> = {}) => ({
  changeId: CHANGE, phase: PHASE, round: 1,
  rubricId: "K-4", ordinal: 4,
  question: "两种做法选哪个？", why: null,
  options: ["A", "B"] as readonly string[],
  ...patch,
});

describe("L1 · 提问留档 —— 文件为准、库为索引", () => {
  it("**这份测试写的每一个文件都在 tmpdir 里，不在仓库里**", () => {
    // 写错一次不会有任何东西报错，只会在用户的真仓库里落一个 `.stagepass/`。
    // 所以把这条判据做成一条会失败的测试，而不是一句注释。
    const path = tmpJsonl();
    assert.ok(path.startsWith(tmpdir()), `落在了 tmpdir 之外：${path}`);
    assert.ok(!path.startsWith(process.cwd()), `落进了项目目录：${path}`);
  });

  it("库丢了能从 jsonl 逐条重建", () => {
    const path = tmpJsonl();
    const first = open(path);
    const one = first.store.record(asked());
    first.store.record(asked({
      rubricId: null, ordinal: null, question: "这一轮没有判据单，随便问", why: "因为",
    }));
    first.store.answer(one.id, "A", "因为便宜");

    // 换一个全新的空库，只喂那份文件
    const rebuilt = open(path);
    assert.equal(rebuilt.store.rebuildFrom(path), 2);

    const before = first.store.list(CHANGE);
    const after_ = rebuilt.store.list(CHANGE);
    // 先证明它不是「两个空数组相等」—— deepEqual 对两个空数组永远成立。
    assert.equal(before.length, 2, "原库里就没有两条，这条往返什么都没证明");
    assert.deepEqual(after_, before);
    assert.equal(after_[0]?.chosen, "A", "答过的那条重建之后要还是答过的");
    assert.equal(after_[1]?.chosen, null, "没答过的那条重建之后不能凭空有答案");
  });

  it("回答是追加一条补记，不改原行", () => {
    const path = tmpJsonl();
    const { store } = open(path);
    const one = store.record(asked());
    const before = readFileSync(path, "utf8");

    store.answer(one.id, "A", "因为便宜");

    // 只追加的文件不能原地改写，否则 diff 会撒谎 —— 半年后翻 git 记录，看到的
    // 会是「他当时就是这么问的」，而不是「他问完之后答了」。
    const now = readFileSync(path, "utf8");
    assert.ok(now.startsWith(before), "原来那一行被改写了");

    const lines = now.trim().split("\n");
    assert.equal(lines.length, 2);
    const original = JSON.parse(lines[0]!) as Record<string, unknown>;
    const supplement = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.equal(original.chosen, undefined);
    assert.equal(supplement.id, one.id, "补记要认得出它补的是哪一条");
    assert.equal(supplement.chosen, "A");
    assert.equal(supplement.note, "因为便宜");
  });

  it("**文件写不进去时，库里也不许有** —— 重建以文件为准，库里多的那条永远回不去", () => {
    const path = join(tmpDir(), "asks.jsonl");
    // 把路径做成一个目录：任何往它上面的追加都会失败，而且和权限无关（root 也一样）。
    mkdirSync(path);
    const { store } = open(path);

    assert.throws(() => store.record(asked()), "文件写不进去却安静地成功了");
    assert.deepEqual([...store.list(CHANGE)], [], "文件里没有，库里却有 —— 重建会把它抹掉");
  });

  it("list 只回这个 Change 的，按提问时间升序", () => {
    // 升序：面板要倒序（TechSpec §七）自己 reverse 一下就行，而账本天然是往下长的。
    const { store } = open(tmpJsonl());
    store.record(asked({ question: "第一个" }));
    store.record(asked({ question: "第二个" }));
    store.record(asked({ changeId: OTHER, question: "别的 Change 的" }));

    const mine = store.list(CHANGE);
    assert.deepEqual(mine.map((ask) => ask.question), ["第一个", "第二个"]);
    assert.deepEqual(store.list(OTHER).map((ask) => ask.question), ["别的 Change 的"]);
    assert.deepEqual([...mine.map((ask) => ask.askedAt)].sort(), mine.map((ask) => ask.askedAt));
  });

  it("答完之后只多了选择、备注和时间，别的字段一个都不动", () => {
    const { store } = open(tmpJsonl());
    const one = store.record(asked());
    const before = store.list(CHANGE)[0]!;

    store.answer(one.id, "B", "因为改起来便宜");

    const now = store.list(CHANGE)[0]!;
    assert.equal(now.chosen, "B");
    assert.equal(now.note, "因为改起来便宜");
    assert.notEqual(now.answeredAt, null);
    // 把新增的三格抹回去，剩下的必须逐字节相等 —— 「答一次」不该顺手改别的东西。
    assert.deepEqual({ ...now, chosen: null, note: null, answeredAt: null }, before);
  });

  it("没写备注就是 null，不是空串 —— 「他没说」和「他说了空话」不是一回事", () => {
    const { store } = open(tmpJsonl());
    const one = store.record(asked());
    store.answer(one.id, "A", null);
    assert.equal(store.list(CHANGE)[0]?.note, null);
  });

  it("`record` 回来的那条就是落进去的那条 —— 调用方不必再查一次", () => {
    const { store } = open(tmpJsonl());
    const one = store.record(asked({ why: "两种都能跑，代价不一样" }));
    assert.deepEqual(store.list(CHANGE)[0], one);
    // 选项存的是 JSON 列，读回来还得是同一个数组，不是一句 `["A","B"]` 的字符串。
    assert.deepEqual([...store.list(CHANGE)[0]!.options], ["A", "B"]);
  });

  it("id 各不相同，而且长成 `ASK-…` —— 人会在散文里引用它（TechSpec §五）", () => {
    // 判据单上写「这条我判不了，见 ASK-0007」是设计里明写的用法，所以 id 不是
    // 一串随便什么都行的东西：它要在一段中文里认得出来。
    const { store } = open(tmpJsonl());
    const one = store.record(asked());
    const two = store.record(asked());
    assert.match(one.id, /^ASK-/);
    assert.notEqual(one.id, two.id);
  });

  it("重建两次不会翻倍 —— 重放要幂等", () => {
    // 面板可能起两次、人可能手点两次「从文件重建」。翻倍的话，同一个问题在
    // asking 流里出现两遍，而人分不出哪一条是真的。
    const path = tmpJsonl();
    const first = open(path);
    first.store.record(asked());
    first.store.record(asked({ question: "第二个" }));

    const rebuilt = open(path);
    assert.equal(rebuilt.store.rebuildFrom(path), 2);
    rebuilt.store.rebuildFrom(path);
    assert.equal(rebuilt.store.list(CHANGE).length, 2);
  });

  it("空文件重建出零条，而不是抛 —— 一个还没问过任何问题的项目是正常的", () => {
    const path = tmpJsonl();
    writeFileSync(path, "");
    const { store } = open(path);
    assert.equal(store.rebuildFrom(path), 0);
    assert.deepEqual([...store.list(CHANGE)], []);
  });
});
