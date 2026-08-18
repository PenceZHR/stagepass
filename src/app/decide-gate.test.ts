import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import {
  APPROVE_AS_RECOMMENDED, decisionLabel, DECISION_FIELD,
  gateDecisionQuestion, RESPONSE_AGREE, RESPONSE_DISMISS,
} from "../domain/question";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { RubricStore } from "../store/rubric-store";
import { TurnStore } from "../store/turn-store";
import { JobStore } from "../work/job-store";
import { decideGate } from "./decide-gate";

/**
 * 裁决这个用例，**不经过 HTTP**。
 *
 * 这一条最值得单独验：它同时做四件事（组题、把题摆出去、落表态、推闸门），而
 * **顺序是承重的**。原来要看这个顺序对不对，只能起一个真服务器再从响应的 JSON
 * 倒推；现在直接把库的前后状态摆出来。
 *
 * ## 测试怎么「答题」
 *
 * 和真系统同一个节拍：`decideGate` 起草完立刻返回 `asked`，答案由 `/api/answer`
 * 落库后**再走一遍**这个用例消费。`drive` 就是那个循环 —— 问出来就按 `content`
 * 答掉、再喊一遍，直到出终局。没有定时器、没有等待。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });
  return database;
}

/** 走到一个 settled 的 PRD，手里有两条 open 的 P1 —— 也就是一轮跑完的样子。 */
function settledWithGaps(database: Database.Database): void {
  const changes = new ChangeStore(database);
  new GapStore(database).replace(CHANGE, "PRD", [
    {
      id: "SPEC-1", kind: "finding", severity: "P1", title: "验收标准不可测",
      status: "open", openedRound: 1, resolution: null,
    },
    {
      id: "SPEC-2", kind: "finding", severity: "P1", title: "范围与 PRD 冲突",
      status: "open", openedRound: 1, resolution: null,
    },
  ] as never);
  new EvidenceStore(database).put(CHANGE, "PRD", {
    artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
  });
  changes.apply(CHANGE, "start");
  changes.apply(CHANGE, "settle");
}

/** 什么都不做的注入件 —— 这几样是 `web/` 的活，用例只该调它们。 */
const inert = {
  sessions: {},
  cannotAskNow: () => null,
  rerun: async () => "跑了一轮",
  onApproved: () => {},
  roundBudget: 5,
};

type Overrides = Partial<Parameters<typeof decideGate>[0]>;

/**
 * `/api/answer` 那个循环的镜像：问出来就答掉、再喊一遍用例，直到出终局。
 * 只答这道题真的有的格子 —— 多答一格会被 `readAnswer` 当成答错了题。
 */
async function drive(
  database: Database.Database,
  content: Record<string, string>,
  overrides: Overrides = {},
): Promise<Awaited<ReturnType<typeof decideGate>>> {
  const questions = new QuestionStore(database);
  for (let round = 0; round < 5; round += 1) {
    const result = await decideGate({
      database, changeId: CHANGE, ...inert, ...overrides,
    } as Parameters<typeof decideGate>[0]);
    if (result.outcome.kind !== "asked") return result;
    const open = questions.open(CHANGE);
    assert.ok(open, "说了 asked 却没有 open 的题");
    const mine: Record<string, string> = {};
    for (const field of Object.keys(open.question.requestedSchema.properties)) {
      if (field in content) mine[field] = content[field]!;
    }
    questions.answer(open.id, { action: "accept", content: mine });
  }
  throw new Error("驱动 5 次还没到终局");
}

describe("app · 裁决这个用例（不经过 HTTP）", () => {
  it("没有这个 Change —— 说 no_such_change", async () => {
    const database = freshDatabase();
    const result = await decideGate({
      database, changeId: "CHG-不存在", ...inert,
    });
    assert.deepEqual(result.outcome, { kind: "no_such_change" });
    database.close();
  });

  /**
   * **一道做不了的决定比不问更糟。** 阶段还没跑完（没有证据、没 settle），
   * 闸门一个动作都放不出来 —— 那就不该弹一张空表给人。
   */
  it("组不出一道他做得了的题就不问", async () => {
    const database = freshDatabase();
    const result = await decideGate({ database, changeId: CHANGE, ...inert });
    assert.equal(result.outcome.kind, "no_decision");
    assert.equal(new QuestionStore(database).open(CHANGE), null, "连题都不该落");
    database.close();
  });

  /**
   * **没人答就让题挂着 —— 那不是失败。** 旧形状是 15 分钟死线 + 收题 +
   * `no_answer_in_time`（2026-08-18 真机：三道闸门题全死在这上面，人答了也
   * 白答）。现在题没有截止；再问一遍也不另起 —— 另起会 supersede 掉人正对着
   * 的那张表。
   */
  it("没人答：题挂着、不收、不重复起草", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    const first = await decideGate({ database, changeId: CHANGE, ...inert });
    assert.equal(first.outcome.kind, "asked");
    assert.equal(first.closeSession, false);

    const open = new QuestionStore(database).open(CHANGE);
    assert.ok(open, "题该摆着等人");

    const second = await decideGate({ database, changeId: CHANGE, ...inert });
    assert.equal(second.outcome.kind, "asked");
    assert.equal(
      second.outcome.kind === "asked" && second.outcome.questionId, open.id,
      "同一道题 —— 不许 supersede 人正对着的表",
    );
    database.close();
  });

  it("服务重启后消费已经落库的裁决，不再弹第二张决定表", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    const gaps = new GapStore(database).all(CHANGE, "PRD");
    const gate = new CommandStore(database).gateFor(CHANGE);
    const question = gateDecisionQuestion({
      phase: "PRD",
      gate,
      summary: "第 1 轮已完成",
      openGaps: gaps,
      round: 1,
      sendBackTargets: [],
      approveAlternatives: [],
    });
    assert.ok(question);
    const questionId = `Q-${CHANGE}-PRD-interrupted`;
    const questions = new QuestionStore(database);
    questions.ask({
      id: questionId,
      changeId: CHANGE,
      phase: "PRD",
      kind: "gate_decision",
      question,
      expectedSnapshot: gate.snapshot,
    });
    questions.answer(questionId, {
      action: "accept",
      content: {
        R01: RESPONSE_AGREE,
        R02: RESPONSE_AGREE,
        [DECISION_FIELD]: decisionLabel("reject"),
      },
    });

    const result = await decideGate({ database, changeId: CHANGE, ...inert });

    assert.equal(result.outcome.kind, "decided");
    assert.equal(new ChangeStore(database).read(CHANGE).state.status, "pending");
    assert.equal(questions.read(questionId).status, "applied");
    database.close();
  });

  /**
   * **三步的顺序是承重的**（fence → 表态 → 闸门）。
   *
   * 人把两条 P1 都驳回了，然后选「批准」。第 2 步先把两条 blocker 从名单里拿掉，
   * 第 3 步的闸门才算得出「可以放行」。顺序反过来就是拿着旧名单裁决 —— 人刚说的
   * 话对这一次没有任何影响，而界面上看不出差别。
   */
  it("**表态先落地，闸门再算** —— 驳回两条之后批准才走得通", async () => {
    const database = freshDatabase();
    settledWithGaps(database);

    const before = new CommandStore(database).gateFor(CHANGE);
    assert.equal(
      before.permitted.includes("approve"), false,
      "两条 P1 开着的时候闸门不该放行 approve —— 这一条是下面那个断言的前提",
    );

    const result = await drive(database, {
      // 两条都驳回（`RESPONSE_DISMISS` 要理由，理由在第二趟那几格）。
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "这条说的是别的阶段的事", R02x: "范围是我改的，不是它写错",
      [DECISION_FIELD]: decisionLabel("approve"),
    });

    assert.equal(result.outcome.kind, "decided");
    const gaps = new GapStore(database).all(CHANGE, "PRD");
    assert.deepEqual(
      gaps.map((gap) => [gap.status, gap.closedBy]),
      [["closed", "human"], ["closed", "human"]],
      "表态必须在闸门之前落地，否则闸门算的是旧名单",
    );
    // 理由是硬要求：一次没有理由的关闭和「这一轮忘了提」在库里长得一模一样。
    assert.ok(gaps.every((gap) => (gap.resolution ?? "").trim() !== ""));
    assert.equal(
      new ChangeStore(database).read(CHANGE).state.phase, "Spec",
      "批准之后该进下一个阶段",
    );
    database.close();
  });

  /**
   * **表态本身不推动闸门。** 全同意 = 两条 blocker 还挡着，这时选「批准」闸门该
   * 拒，而且要说出来 —— 默默当成没发生，人会以为批准了。
   */
  it("同意了两条还挡着的问题，再选批准 —— 闸门拒，而且说得出来", async () => {
    const database = freshDatabase();
    settledWithGaps(database);

    const result = await drive(database, {
      R01: RESPONSE_AGREE, R02: RESPONSE_AGREE,
      [DECISION_FIELD]: decisionLabel("approve"),
    });

    assert.equal(result.outcome.kind, "decided");
    const outcome = result.outcome.kind === "decided" ? result.outcome.outcome : null;
    assert.equal((outcome as { kind?: string }).kind, "refused");
    assert.equal(
      new ChangeStore(database).read(CHANGE).state.phase, "PRD", "没被批准就不许动");
    // 下场必须留得住（§3.2·5），不能只活在这一次响应里。
    assert.ok(new QuestionStore(database).latestOutcomeFor(CHANGE, "PRD") !== null);
    database.close();
  });

  /**
   * §8.10 的端到端：**人选了一条系统没推荐的路，Change 真的去了那儿。**
   *
   * 这一条穿过整条链子 —— 题面那一格、答案、`approveTargetFrom`、
   * `questions.apply`、command 层、状态机。链子上任何一环没接上，它都会红。
   */
  it("**批准时选一条非推荐的路** —— 中间的阶段真的被跳过了", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    // 推荐是 Spec（主线下一步）。人选 TestPlan —— 这次改动不需要重写技术方案。
    const result = await drive(database, {
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "不成立", R02x: "不成立",
      U: "TestPlan",
      [DECISION_FIELD]: decisionLabel("approve"),
    });

    assert.equal(result.outcome.kind, "decided");
    assert.equal(
      new ChangeStore(database).read(CHANGE).state.phase, "TestPlan",
      "人选的是 TestPlan，不是推荐的 Spec",
    );
  });

  it("不选就走推荐那条 —— 这一格的存在不该改变默认", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    await drive(database, {
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "不成立", R02x: "不成立",
      U: APPROVE_AS_RECOMMENDED,
      [DECISION_FIELD]: decisionLabel("approve"),
    });
    assert.equal(new ChangeStore(database).read(CHANGE).state.phase, "Spec");
  });

  /**
   * 选了「再来一轮」就**直接续跑** —— 用户 2026-07-30：「把现在的两步合成一步。」
   * 中间那一步看不出来还需要它，人会以为下一轮已经在跑了。
   */
  it("选「再来一轮」就续跑；选批准不续", async () => {
    for (const [action, expected] of [
      ["reject", "跑了一轮"],
      ["approve", null],
    ] as const) {
      const database = freshDatabase();
      settledWithGaps(database);
      const result = await drive(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
        R01x: "不成立", R02x: "不成立",
        [DECISION_FIELD]: decisionLabel(action),
      });
      assert.equal(result.outcome.kind, "decided");
      assert.equal(
        result.outcome.kind === "decided" ? result.outcome.continued : "?",
        expected, `${action} 的续跑行为`);
      database.close();
    }
  });

  /**
   * §5.5.1：裁决把 Change 送出了这个阶段，这个阶段的 Codex 会话就该跟着收掉。
   *
   * 真机 2026-08-06：批准之后那个 `codex resume` 进程活了 22 分钟（父进程就是
   * 面板），下一阶段起轮时 `awaitNewThread` 在一堆新会话里认不出自己的，整轮作废
   * （`codex_unavailable: … another Codex is probably running`）。
   *
   * 反面同样承重：「再来一轮」刚在同一个 (Change, 阶段) 上派出了新会话，这时
   * 关会话就是杀掉刚派出去的那一轮。
   */
  it("裁决送走了 Change 就关会话；留在本阶段的裁决不关", async () => {
    for (const [action, closed] of [
      ["approve", true],  // PRD -> Spec：换了阶段，旧会话再没人要它了
      ["reject", false],  // 续跑同一阶段：续跑那条路自己管会话，这里关就是杀新轮
    ] as const) {
      const database = freshDatabase();
      settledWithGaps(database);
      const result = await drive(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
        R01x: "不成立", R02x: "不成立",
        [DECISION_FIELD]: decisionLabel(action),
      });
      assert.equal(result.outcome.kind, "decided");
      assert.equal(result.closeSession, closed, `${action} 之后关不关会话`);
      database.close();
    }
  });

  /**
   * **裁决落不了地的时候，人要看得见为什么** —— 2026-08-07 真机那一次。
   *
   * `questions.apply` 抛了 SqliteError（老库的账本记不下 `sendBack`），而当时
   * 只接得住 `GateRefusedError`：异常穿到 HTTP 层变成 500，题永远停在 `answered`
   * （既没落地也没被收掉），人在界面上只看到「点了没反应」。**他已经答完走了，
   * 一次静默失败等于他的话被扔了。**
   */
  it("**闸门那一步炸了 —— 说出来，别 500**，题要收掉、原因要留住", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    // 摆出那天的形状：账本记不下这次转移（老库的 CHECK 名单落后了）。
    database.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON change_events"
      + " WHEN NEW.action = 'approve'"
      + " BEGIN SELECT RAISE(ABORT, 'action_not_allowed_in_this_database'); END",
    );

    const result = await drive(database, {
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "不成立", R02x: "不成立",
      [DECISION_FIELD]: decisionLabel("approve"),
    });

    assert.equal(result.outcome.kind, "decided", "异常穿出去了 —— 那就是一个 500");
    const outcome = result.outcome.kind === "decided"
      ? result.outcome.outcome as { kind?: string; error?: string } : null;
    assert.equal(outcome?.kind, "failed");
    assert.match(outcome?.error ?? "", /action_not_allowed_in_this_database/,
      "没把真实原因交出来 —— 人还是不知道为什么没落地");
    // 题不许停在 answered：那是「答了但没人收」，屏幕上一个字都没有。
    assert.equal(new QuestionStore(database).open(CHANGE), null);
    // 下场要留得住（§3.2·5）：刷新之后卡片上还看得见。
    assert.ok(new QuestionStore(database).latestOutcomeFor(CHANGE, "PRD") !== null);
    database.close();
  });

  /**
   * **批准了才归档这个阶段的线程**（用户 2026-07-30 拍板的那一半）。别的地方一概
   * 不许调 —— 一个还没批准的阶段的线程被归档，下一次 resume 就会一起来就死。
   */
  it("只有批准会触发归档", async () => {
    for (const [action, archived] of [["approve", 1], ["reject", 0]] as const) {
      const database = freshDatabase();
      settledWithGaps(database);
      // 归档要有线程可归 —— 没绑定就一次都不该调。
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-PRD");

      const calls: string[] = [];
      await drive(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
        R01x: "不成立", R02x: "不成立",
        [DECISION_FIELD]: decisionLabel(action),
      }, {
        onApproved: ({ threadId }) => { calls.push(threadId); },
      });
      assert.equal(calls.length, archived, `${action} 触发归档的次数`);
      database.close();
    }
  });
});

describe("裁决题面的两条真机注记（2026-08-09）", () => {
  /**
   * **上一轮死而复生。** 被判 `codex_unavailable` 的那条线程后来把整轮跑完了
   * （Arch r5：晚 77 分钟，产出落盘无人认领）—— 人选重跑之前必须知道磁盘上
   * 已经有东西。只知情，不自动收编。
   */
  it("上一轮判了失败而线程后来跑完了 —— 题面要说", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    new JobStore(database).enqueue({
      id: "JOB-1", changeId: CHANGE, kind: "phase_turn",
      deadlineAt: Date.now() + 60_000, maxAttempts: 1, phase: "PRD",
    });
    const turns = new TurnStore(database);
    turns.allocate({
      id: "TURN-1", jobId: "JOB-1",
      request: { changeId: CHANGE, phase: "PRD", prompt: "第 1 轮的提示词" },
    });
    turns.markDispatched("TURN-1", "THREAD-9");
    turns.markFailed("TURN-1", "codex_unavailable: turn did not complete");

    const probed: { threadId: string; prompt: string }[] = [];
    const result = await decideGate({
      database, changeId: CHANGE, ...inert,
      sessions: {
        threadTurnEnded: (threadId, _from, prompt) => {
          probed.push({ threadId, prompt });
          return true;
        },
      },
    });
    assert.equal(result.outcome.kind, "asked");
    // 探的是那条 turn 自己的线程和提示词，不是阶段现在绑着的。
    assert.deepEqual(probed, [{ threadId: "THREAD-9", prompt: "第 1 轮的提示词" }]);
    const { message } = database.prepare(
      "SELECT message FROM questions WHERE change_id = ? ORDER BY asked_at DESC LIMIT 1",
    ).get(CHANGE) as { message: string };
    assert.match(message, /后来把整轮跑完了/);
    assert.match(message, /codex_unavailable/);
    database.close();
  });

  it("线程没跑完（探测说 false）就一个字都不多说", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    new JobStore(database).enqueue({
      id: "JOB-1", changeId: CHANGE, kind: "phase_turn",
      deadlineAt: Date.now() + 60_000, maxAttempts: 1, phase: "PRD",
    });
    const turns = new TurnStore(database);
    turns.allocate({
      id: "TURN-1", jobId: "JOB-1",
      request: { changeId: CHANGE, phase: "PRD", prompt: "第 1 轮的提示词" },
    });
    turns.markDispatched("TURN-1", "THREAD-9");
    turns.markFailed("TURN-1", "codex_unavailable: turn did not complete");

    const result = await decideGate({
      database, changeId: CHANGE, ...inert,
      sessions: { threadTurnEnded: () => false },
    });
    assert.equal(result.outcome.kind, "asked");
    const { message } = database.prepare(
      "SELECT message FROM questions WHERE change_id = ? ORDER BY asked_at DESC LIMIT 1",
    ).get(CHANGE) as { message: string };
    assert.doesNotMatch(message, /后来把整轮跑完了/);
    database.close();
  });

  /**
   * **判定是旧的。** Plan 的题面写着「9 条全部满足，裁判：可以了」，其实是三天前
   * 旧轮落库的 —— 上游 Arch 在那之后整个重写过。题面必须自己说出这个时间差。
   */
  it("判定落库之后上游又结算过 —— 题面要标出来", async () => {
    const database = freshDatabase();
    const changes = new ChangeStore(database);
    const evidence = new EvidenceStore(database);

    // 判定先落库（旧日期）——「三天前的旧轮」。
    const rubrics = new RubricStore(database, {
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    rubrics.installDefaults(PROJECT);
    const rubric = rubrics.effective(PROJECT, CHANGE, "Spec", "producer");
    assert.ok(rubric);
    rubrics.record(CHANGE, "Spec", "producer", 1, rubric, [{
      criterionKey: rubric.criteria[0]!.key, verdict: "yes", evidence: "看过了",
    }]);

    // 上游 PRD 在那之后（真实 now）结算过新产出，然后批到 Spec、跑完一轮。
    evidence.put(CHANGE, "PRD", {
      artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
    });
    changes.apply(CHANGE, "start");
    changes.apply(CHANGE, "settle");
    changes.apply(CHANGE, "approve");
    evidence.put(CHANGE, "Spec", {
      artifactIds: ["spec.md"], blockers: [], waivedBlockerIds: [],
    });
    changes.apply(CHANGE, "start");
    changes.apply(CHANGE, "settle");

    const result = await decideGate({ database, changeId: CHANGE, ...inert });
    assert.equal(result.outcome.kind, "asked");
    const { message } = database.prepare(
      "SELECT message FROM questions WHERE change_id = ? ORDER BY asked_at DESC LIMIT 1",
    ).get(CHANGE) as { message: string };
    assert.match(message, /上游 PRD 又结算过新产出/);
    assert.match(message, /上游变动\*\*之前\*\*/);
    database.close();
  });
});
