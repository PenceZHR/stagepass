import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { AskStore } from "../store/ask-store";
import { ChangeStore } from "../store/change-store";
import { HandoffStore } from "../store/handoff-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { answerAsk, askFromModel } from "./ask-route";

/**
 * 把提问接进工作台。**这一层唯一的活儿是「模型说不出的东西，StagePass 自己认」。**
 *
 * ## 为什么模型说不出自己在哪
 *
 * `stagepass_ask` 的入参只有一个小整数和散文（TechSpec §三）—— 没有 changeId、
 * 没有阶段名、没有 rubricId。那不是省事，是 2026-08-02 立的硬规矩：凡是 StagePass
 * 拿去做精确匹配的字符串，都不许出现在模型必须生成的文本里。于是「这是哪一轮的
 * 问题」只能由这一层从库里认出来。
 *
 * 认不出来的两种情形各有各的说法，而**两种都不许猜**：
 *
 *   零条备着的轮   → `no_open_round`，并告诉他先去备一轮
 *   两条备着的轮   → `ambiguous_round`，照直说这是 StagePass 自己的 bug
 *
 * ## 正本落在人的项目里，所以这份测试的每一条路径都在 tmpdir 下
 *
 * 这条路会往 `<项目>/.stagepass/asks.jsonl` 写文件（TechSpec §五）。夹具里的项目
 * 路径**必须**是 `mkdtempSync` 出来的，否则测试会在真仓库里落一个 `.stagepass/`，
 * 而且没有任何东西会报错。
 */

const AT = "2026-08-19T00:00:00.000Z";
const PROJECT = "PRJ-ASK";
const CHANGE = "CHG-001";
const OTHER = "CHG-002";
const PHASE = "Spec" as const;

const TEMP_DIRS: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-"));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** 备这一轮时生效的那四条判据。序号就是它们在这个数组里的位置 + 1。 */
const CRITERIA_AT_PREPARE_TIME = [
  "每条需求都写明了不做什么",
  "范围和 PRD 不冲突",
  "每条需求都有可测的验收标准",
  "术语在全文里只有一个意思",
];

/** 人在这一轮跑着的时候把标准改成了这四条 —— 措辞和条数都变了。 */
const CRITERIA_AFTER_THE_SWAP = [
  "换掉的第一条", "换掉的第二条", "换掉的第三条", "换掉的第四条",
];

const SCOPE = { projectId: PROJECT, changeId: null, phase: PHASE, role: "producer" } as const;

/** 判据单那份题面文件，`work/rubric-round.ts` 的 `blueRubricFiles` 铺成什么样就写什么样。 */
function writeCriteriaFile(texts: readonly string[]): string {
  const path = join(tmpDir(), "rubric.md");
  writeFileSync(path, [
    "# 要判的标准：正方的产出",
    "",
    `一共 ${texts.length} 条。逐条判，按序号回答。`,
    "",
    ...texts.map((text, index) => `${index + 1}. ${text}`),
    "",
  ].join("\n"));
  return path;
}

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  // **项目路径是一个临时目录**：正本会落在它下面的 `.stagepass/` 里。
  const projectRoot = tmpDir();
  currentRoot = projectRoot;
  new ProjectStore(database).ensure(PROJECT, "提问面", projectRoot);
  const changes = new ChangeStore(database, { now: () => new Date(AT) });
  changes.create(CHANGE, { projectId: PROJECT });
  changes.create(OTHER, { projectId: PROJECT });

  // key 由测试铸，这样版本换掉之后「换回来的是哪一份」是看得见的，不是一串 uuid。
  let minted = 0;
  const rubrics = new RubricStore(database, {
    now: () => new Date(AT),
    mintKey: () => `K${(minted += 1)}`,
  });
  const handoffs = new HandoffStore(database, () => new Date(AT));
  const asksPath = join(projectRoot, ".stagepass", "asks.jsonl");
  // 只用来读回落档 —— 写是 `askFromModel` 自己做的，路径由它从项目算出来。
  const asks = new AskStore(database, asksPath, () => new Date(AT));

  return {
    database, rubrics, handoffs, asks, projectRoot, asksPath,
    deps: { database, boundProjectId: PROJECT, now: () => new Date(AT) },
  };
}

const saveRubric = (rubrics: RubricStore, texts: readonly string[]) =>
  rubrics.save(SCOPE, texts.map((text) => ({ text, blocking: true })), "这一轮的标准");

function prepare(
  handoffs: HandoffStore,
  input: {
    changeId?: string; round?: number; rubricId?: string | null;
    criteria?: readonly string[];
  },
): void {
  const criteria = input.criteria ?? CRITERIA_AT_PREPARE_TIME;
  const rubricId = input.rubricId === undefined ? null : input.rubricId;
  handoffs.prepare({
    changeId: input.changeId ?? CHANGE,
    phase: PHASE,
    round: input.round ?? 1,
    envelope: "你是本轮的裁判。阶段：Spec，第 1 轮。",
    scriptPath: "/tmp/stagepass-round-xyz/round-script-Spec-r1.md",
    files: {
      worklist: null,
      blueRubric: criteria.length === 0 ? null : {
        // 真写一份出来：回给模型的判据原文取自**它自己眼前那份文件**。
        criteriaPath: writeCriteriaFile(criteria),
        answersPath: "/tmp/stagepass-round-xyz/rubric-answers.md",
        count: criteria.length,
      },
      rubricIds: rubricId === null ? {} : { producer: rubricId },
    },
  });
}

const body = (patch: Record<string, unknown> = {}): string => JSON.stringify({
  // **cwd 每次都要带** —— 工作台按它判「这条会话是不是在我绑的项目里」。
  cwd: currentRoot, ordinal: 1, question: "两种做法选哪个？", options: ["A", "B"], ...patch,
});

/** `setup()` 每次换一个临时目录当项目根，夹具要跟着走。 */
let currentRoot = "";

describe("L4 · 提问接进工作台 —— 认不出来就照直说，不猜", () => {
  /*
   * **2026-08-19 晚，这条的期望整个反过来了。**
   *
   * 旧契约：没有备着的轮就拒（`no_open_round`）。
   * 新契约：**照样问得成**，挂在这个项目默认那条 Change 上，第 0 轮。
   *
   * 反转的理由是用户的真实场景：他和模型先自由聊，聊得差不多了模型才调这个工具确认
   * 理解对不对 —— 那时「备一轮」压根还没发生，也不该发生。旧的那道闸是多余的墙。
   *
   * 断言比旧的更硬：不只是「不拒」，还要落对 Change、落对轮次。
   */
  it("没有备着的轮，照样问得成 —— 挂在默认 Change 上，第 0 轮", () => {
    const kit = setup();
    const out = askFromModel(kit.deps, body({ ordinal: null }));
    assert.equal(out.ok, true);

    const one = kit.asks.list(CHANGE)[0]!;
    assert.equal(one.changeId, CHANGE);
    // **0 轮 = 聊出来的，不是某一轮跑出来的。** 编一个 1 出来会让账本说谎。
    assert.equal(one.round, 0);
    assert.equal(one.rubricId, null);
    assert.equal(one.ordinal, null);
  });

  it("一条 Change 都没有才拒，而且说得出该先做什么", () => {
    const kit = setup();
    // 换一个**空的**项目来绑：`DELETE FROM changes` 会撞外键，而且那也不是真实状态
    // —— 真实状态是「新绑的项目里还什么都没有」。
    const empty = "PRJ-EMPTY";
    new ProjectStore(kit.database).ensure(empty, "空项目", tmpDir());
    const out = askFromModel(
      { ...kit.deps, boundProjectId: empty },
      body({ ordinal: null }),
    );
    assert.equal(out.ok, false);
    assert.equal(out.error, "no_change");
    assert.match(out.reason!, /新建/);
  });

  it("**备着两轮就照直说，不挑一条** —— 挑错了是把问题挂到别的阶段上", () => {
    const { deps, rubrics, handoffs, asks } = setup();
    const version = saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(handoffs, { changeId: CHANGE, rubricId: version.id });
    prepare(handoffs, { changeId: OTHER, rubricId: version.id });

    const out = askFromModel(deps, body());

    assert.equal(out.ok, false);
    assert.equal(out.error, "ambiguous_round");
    assert.deepEqual([...asks.list(CHANGE)], []);
    assert.deepEqual([...asks.list(OTHER)], [], "猜了一条的实现会在这里露出来");
  });

  it("认出来之后，落档的身份来自那一轮 —— 不是模型报的", () => {
    const { deps, handoffs, rubrics, asks } = setup();
    const version = saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(handoffs, { rubricId: version.id, round: 3 });

    const out = askFromModel(deps, body({ ordinal: 2, why: "两种都能跑，代价不一样" }));

    assert.equal(out.ok, true, `被拒了：${out.error} / ${out.reason}`);
    assert.equal(out.asked![0]!.askId, asks.list(CHANGE)[0]?.id);

    const recorded = asks.list(CHANGE)[0]!;
    assert.equal(recorded.changeId, CHANGE);
    assert.equal(recorded.phase, PHASE);
    assert.equal(recorded.round, 3);
    assert.equal(recorded.ordinal, 2);
    assert.equal(recorded.question, "两种做法选哪个？");
    assert.equal(recorded.why, "两种都能跑，代价不一样");
    assert.deepEqual([...recorded.options], ["A", "B"]);
  });

  it("回给模型的是那一条判据的原文 —— 让它自己确认问对了没有", () => {
    // 这是「错误要能自救」的正面形式：序号是个哑数字，把原文回过去，模型能当场
    // 看出自己数错了行，而不是等人在面板上发现问题挂错了判据。
    const { deps, handoffs, rubrics } = setup();
    const version = saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(handoffs, { rubricId: version.id });

    const out = askFromModel(deps, body({ ordinal: 3 }));

    assert.equal(out.ok, true, `被拒了：${out.error} / ${out.reason}`);
    assert.equal(out.asked![0]!.rubricText, CRITERIA_AT_PREPARE_TIME[2]);
  });

  it("每个序号都换回它自己那一条 —— 差一格就是挂到隔壁那条上", () => {
    const { deps, handoffs, rubrics, asks } = setup();
    const version = saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(handoffs, { rubricId: version.id });

    for (const [index, text] of CRITERIA_AT_PREPARE_TIME.entries()) {
      const ordinal = index + 1;
      const out = askFromModel(deps, body({ ordinal, question: `第 ${ordinal} 条的问题` }));
      assert.equal(out.ok, true, `第 ${ordinal} 条被拒了：${out.error} / ${out.reason}`);
      assert.equal(out.asked![0]!.rubricText, text, `第 ${ordinal} 条回给模型的原文对不上`);
    }

    // 落档那一侧：序号逐条落对，而版本每一条都是备那一刻那个。
    assert.deepEqual(
      asks.list(CHANGE).map((ask) => [ask.ordinal, ask.rubricId]),
      CRITERIA_AT_PREPARE_TIME.map((_, index) => [index + 1, version.id]),
    );
  });

  it("**序号换回的是备那一刻的 rubric 版本**", () => {
    /*
     * 人可能在这一轮跑着的时候改了标准。改完之后再按序号去取「当前生效的那一份」，
     * 这个问题就挂到了一条它从没读过的判据上 —— 而且不会有任何东西报错。
     *
     * `HandedRound.rubricIds` 存的就是备那一刻的版本 id，这条测试盯的是它真的被用了。
     *
     * **落档的 `rubricId` 钉的是版本 id**，照 BuildPlan T3 步骤 4 的原话
     * 「从 `round.rubricIds` 取」。PRD §3.1 那一格写的是判据 id（`SPEC-04`），
     * 两份文档在这里不一致 —— 这一期以 BuildPlan 为准，分歧留给人裁。
     */
    const { deps, handoffs, rubrics, asks } = setup();
    const atPrepareTime = saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(handoffs, { rubricId: atPrepareTime.id });

    // 备完之后把库里的 rubric 换掉
    const afterTheSwap = saveRubric(rubrics, CRITERIA_AFTER_THE_SWAP);
    assert.notEqual(afterTheSwap.id, atPrepareTime.id, "夹具没换成，这条测试是空的");
    assert.equal(
      rubrics.current(SCOPE)?.id, afterTheSwap.id,
      "新版本没有成为当前生效的那份，这条测试是空的",
    );

    const out = askFromModel(deps, body({ ordinal: 2 }));

    assert.equal(out.ok, true, `被拒了：${out.error} / ${out.reason}`);
    assert.equal(asks.list(CHANGE)[0]?.rubricId, atPrepareTime.id, "挂到了别的版本上");
    assert.notEqual(asks.list(CHANGE)[0]?.rubricId, afterTheSwap.id);
    // 回给模型的原文也得是它眼前那一份，不是刚换上去的那一份。
    assert.equal(out.asked![0]!.rubricText, CRITERIA_AT_PREPARE_TIME[1]);
  });

  it("序号越界：表单根本不弹，而且一个字都不落档", () => {
    // 「不弹表单」在这一层唯一看得见的形式就是「库里没有这一条」——
    // 落了档再拒，人在面板上会看到一个从来没被问出去的问题。
    const { deps, handoffs, rubrics, asks } = setup();
    const version = saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(handoffs, { rubricId: version.id });

    const out = askFromModel(deps, body({ ordinal: 9 }));

    assert.equal(out.ok, false);
    assert.equal(out.error, "ordinal_out_of_range");
    assert.ok(out.reason !== undefined && /1[^\d]*4/.test(out.reason),
      `reason 里要有允许范围，实际是：${String(out.reason)}`);
    assert.deepEqual([...asks.list(CHANGE)], []);
  });

  it("这一轮没有判据单时，不带序号也问得出来（TechSpec §九 的 P0b）", () => {
    const { deps, handoffs, asks } = setup();
    prepare(handoffs, { rubricId: null, criteria: [] });

    const out = askFromModel(deps, body({ ordinal: null }));

    assert.equal(out.ok, true, `被拒了：${out.error} / ${out.reason}`);
    const recorded = asks.list(CHANGE)[0]!;
    assert.equal(recorded.ordinal, null);
    assert.equal(recorded.rubricId, null);
    assert.equal(out.asked![0]!.rubricText, undefined, "没有判据单却回了一条判据原文");
  });

  it("**正本落在 `<项目>/.stagepass/asks.jsonl`** —— 跟着 Change 走、可 commit、可 diff", () => {
    // TechSpec §五 把位置定死了，而它是这套东西「文件为准」的落点：只写库的话，
    // 半年后回答「当初为什么否掉方案 A」要去开一个 sqlite。
    const { deps, handoffs, rubrics, asksPath, projectRoot } = setup();
    prepare(handoffs, { rubricId: saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME).id });
    assert.ok(!existsSync(asksPath), "还没问就已经有正本了");

    const out = askFromModel(deps, body({ ordinal: 1 }));

    assert.equal(out.ok, true, `被拒了：${out.error} / ${out.reason}`);
    assert.ok(existsSync(asksPath), `正本没落在 ${asksPath}`);
    // 夹具自己的护栏：写出去的东西必须在临时目录里，不在这个仓库里。
    assert.ok(projectRoot.startsWith(tmpdir()) && !projectRoot.startsWith(process.cwd()));
  });

  it("body 不是一段合法 JSON 时不抛 —— 抛了模型只收到一句「工具失败」", () => {
    const { deps, handoffs, rubrics } = setup();
    prepare(handoffs, { rubricId: saveRubric(rubrics, CRITERIA_AT_PREPARE_TIME).id });

    for (const raw of ["{不是 json", "", "null", "[]", "\"一句话\""]) {
      let out: ReturnType<typeof askFromModel> | undefined;
      assert.doesNotThrow(() => { out = askFromModel(deps, raw); }, `body=${raw} 抛了`);
      assert.equal(out!.ok, false, `body=${raw} 居然通过了`);
      assert.ok((out!.reason ?? "").trim() !== "", `body=${raw} 拒了但没说为什么`);
    }
  });
});

/*
 * **回填这条路必须存在**：没有它，`AskStore.answer` 全树没有生产调用方，
 * 留档就只记得住「问过什么」、记不住「答了什么」。而账本记一半比不记更坏 ——
 * 半年后翻到一条没有答案的提问，分不清是当时没答、还是这条路根本没接上。
 */
describe("L4 · 人答完之后回填", () => {
  function asked() {
    const kit = setup();
    saveRubric(kit.rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(kit.handoffs, { rubricId: "K1" });
    const out = askFromModel(kit.deps, body());
    assert.equal(out.ok, true);
    return { ...kit, askId: out.asked![0]!.askId };
  }

  it("落回索引，也追加进正本", () => {
    const kit = asked();
    assert.deepEqual(answerAsk(kit.deps, JSON.stringify({
      askId: kit.askId, chosen: "A", note: "因为便宜",
    })), { ok: true });

    const one = kit.asks.list(CHANGE)[0]!;
    assert.equal(one.chosen, "A");
    assert.equal(one.note, "因为便宜");
    assert.notEqual(one.answeredAt, null);

    // 一条答过的提问在正本里占两行：问一行、答一行。**原行不许动。**
    const lines = readFileSync(kit.asksPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).chosen, undefined);
    assert.equal(JSON.parse(lines[1]!).chosen, "A");
  });

  it("重答要拒 —— 正本只追加，两个答案就是悄悄改写已经落地的账", () => {
    const kit = asked();
    answerAsk(kit.deps, JSON.stringify({ askId: kit.askId, chosen: "A" }));
    const again = answerAsk(kit.deps, JSON.stringify({ askId: kit.askId, chosen: "B" }));
    assert.equal(again.ok, false);
    assert.equal(again.error, "already_answered");
    // 拒了就真的没写进去
    assert.equal(readFileSync(kit.asksPath, "utf8").trim().split("\n").length, 2);
    assert.equal(kit.asks.list(CHANGE)[0]!.chosen, "A");
  });

  it("不在选项里的值当场拒，并把允许值原样回给调用方", () => {
    const kit = asked();
    const out = answerAsk(kit.deps, JSON.stringify({ askId: kit.askId, chosen: "C" }));
    assert.equal(out.error, "bad_choice");
    assert.match(out.reason!, /「A」/);
    assert.match(out.reason!, /「B」/);
  });

  it("找不到那条提问就照直说，不新建一条", () => {
    const kit = asked();
    const out = answerAsk(kit.deps, JSON.stringify({ askId: "ASK-9999", chosen: "A" }));
    assert.equal(out.error, "no_such_ask");
    assert.equal(kit.asks.list(CHANGE).length, 1);
  });

  it("没选就别回填 —— 让它留着当未答", () => {
    const kit = asked();
    assert.equal(answerAsk(kit.deps, JSON.stringify({ askId: kit.askId })).error, "no_choice");
    assert.equal(kit.asks.list(CHANGE)[0]!.chosen, null);
  });
});

/*
 * **别的项目里那条没结算的旧轮，不许把这一问接走。**
 *
 * 2026-08-19 真机：工作台起在 A，而 B 里躺着一条 waiting，一次冒烟就把 ask 落到了
 * B 的 Change 上、正本写进了 B 的仓库。`allWaiting()` 少一个 WHERE，
 * 「工作台绑一个项目」那条规矩就从后门失效了。
 */
describe("L4 · 只认绑着的那个项目", () => {
  it("旧轮在别的项目里就当没有 —— 落到本项目的默认 Change，一条都不许落到那边", () => {
    const kit = setup();
    const other = "PRJ-OTHER";
    new ProjectStore(kit.database).ensure(other, "别的项目", tmpDir());
    new ChangeStore(kit.database, { now: () => new Date(AT) })
      .create("CHG-ELSE", { projectId: other });
    saveRubric(kit.rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(kit.handoffs, { changeId: "CHG-ELSE", rubricId: "K1" });

    const out = askFromModel(kit.deps, body({ ordinal: null }));
    assert.equal(out.ok, true);
    // 别的项目那条轮**完全没被用上**：既没挂到它的 Change，也没借走它的判据单
    assert.equal(kit.asks.list("CHG-ELSE").length, 0);
    const one = kit.asks.list(CHANGE)[0]!;
    assert.equal(one.changeId, CHANGE);
    assert.equal(one.round, 0);
  });

  it("绑着的项目里那条照常接得住", () => {
    const kit = setup();
    saveRubric(kit.rubrics, CRITERIA_AT_PREPARE_TIME);
    prepare(kit.handoffs, { rubricId: "K1" });
    assert.equal(askFromModel(kit.deps, body()).ok, true);
  });
});

/*
 * **别的项目的会话不许把这一问拿走。**
 *
 * 2026-08-19 真机：用户在「海战小游戏」的会话里问了一句，而工作台绑的是 stagepass。
 * 那一问记进了 stagepass 的 Change、正本写进了 stagepass 的仓库，而屏幕上什么异常
 * 都看不出来。**记错地方比记不上更坏** —— 后者一眼看得出缺。
 */
describe("L4 · 只收绑着那个项目里的会话", () => {
  it("会话在别的目录就拒，并说得出两边分别在哪", () => {
    const kit = setup();
    const out = askFromModel(kit.deps, body({ cwd: "/Users/somebody/别的项目", ordinal: null }));
    assert.equal(out.ok, false);
    assert.equal(out.error, "wrong_project");
    assert.match(out.reason!, /别的项目/);
    assert.match(out.reason!, /我不替你挑一个项目/);
    assert.equal(kit.asks.list(CHANGE).length, 0, "拒了就一条都不许落");
  });

  it("没报目录也拒 —— 不知道在哪就是不知道，不许当成「在这儿」", () => {
    const kit = setup();
    const out = askFromModel(kit.deps, JSON.stringify({
      ordinal: null, question: "？", options: ["A", "B"],
    }));
    assert.equal(out.error, "wrong_project");
  });

  it("会话开在项目的子目录里算数 —— 判的是在不在它之下，不是字符串相等", () => {
    const kit = setup();
    const out = askFromModel(kit.deps, body({ cwd: `${kit.projectRoot}/src/web`, ordinal: null }));
    assert.equal(out.ok, true);
  });
});

/*
 * **符号链接两边都要解析**（2026-08-19）。macOS 上 `/var` 是 `/private/var` 的链接，
 * 而 `git rev-parse --show-toplevel` 吐的是解析过的那一份。只要有一边没解析，两个
 * 指着同一个地方的字符串就永远对不上 —— 人明明在项目里却被判成「别的项目」而拒掉。
 * 这条在 `/tmp` 下的夹具上是真实发生的（`project-home.test.ts` 先撞到的）。
 */
describe("L4 · 符号链接不该让人被误拒", () => {
  it("cwd 走 /tmp、项目路径是 /private/tmp，仍然算同一个项目", () => {
    const kit = setup();
    // kit.projectRoot 是 mkdtemp 给的（未解析）；构造一条解析过的等价路径
    const viaPrivate = kit.projectRoot.startsWith("/var/")
      ? `/private${kit.projectRoot}`
      : kit.projectRoot;
    const out = askFromModel(kit.deps, body({ cwd: viaPrivate, ordinal: null }));
    assert.equal(out.ok, true, "同一个目录的两种写法被判成了两个项目");
  });
});
