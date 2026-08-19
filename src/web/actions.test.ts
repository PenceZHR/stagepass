import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { JobStore } from "../work/job-store";
import { ProjectStore } from "../store/project-store";
import { handleAction, type ActionDeps } from "./actions";
import { openDatabase } from "./sqlite-handle";

const AT = "2026-07-28T00:00:00.000Z";

/** 动作这一层不碰 git，除了旁路记 HEAD 那一处 —— 给一个说得出话的桩。 */
const repo = { head: () => "sha-1" } as unknown as ActionDeps["repo"];

/**
 * 这一组测的都是**不派轮**的路，所以执行通道给一个会当场炸的桩 ——
 * 万一哪条路悄悄开始派轮，测试要红，而不是安静地起一个 codex 子进程。
 */
const runtime = {
  runRound: () => { throw new Error("这一组不该派轮"); },
  roundBudget: 5,
  archiveOps: () => null,
  // 放座位是同步的、而且没起过连接时什么都不用做 —— 这里就是那种情况。
  releaseSeat: () => {},
} as unknown as ActionDeps["runtime"];

/**
 * brief 的两份文件。**注进来而不是让它写真磁盘** —— 生产在 `~/.stagepass/briefs/`，
 * 测试要是也写那儿，跑一次单测就污染了用户真实的草稿。
 */
const files = new Map<string, string>();
const briefFiles = {
  write: (name: string, content: string): string => {
    files.set(name, content);
    return `/fake/briefs/${name}`;
  },
  read: (name: string): string | null => files.get(name) ?? null,
};

function open(): ActionDeps {
  files.clear();
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
  new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
  return { database, repo, runtime, briefFiles, workspaceFor: () => "/tmp/repo" };
}

const call = (path: string, deps: ActionDeps, body = ""): ReturnType<typeof handleAction> => {
  const [pathname = "", query = ""] = path.split("?");
  return handleAction(pathname, new URLSearchParams(query), body, deps);
};

describe("plugin · 会改库的那些路", () => {
  it("建 Change 落库，并且说得出它落在哪个阶段", async () => {
    const deps = open();
    try {
      const answer = await call("/api/change?project=PRJ-1&title=新的一件事", deps);

      assert.equal(answer.status, 200);
      const body = answer.body as { created: boolean; id: string; phase: string };
      assert.equal(body.created, true);
      assert.equal(body.phase, "PRD");
      assert.equal(new ChangeStore(deps.database).read(body.id).title, "新的一件事");
    } finally {
      deps.database.close();
    }
  });

  /*
   * 打的是真实症状：**建了一个没有名字的 Change，列表里认不出它是哪个。**
   * 拒绝要带着能显示的理由回去，不是静默创建一个空标题。
   */
  it("没有标题就不建，并说出是哪一条不满足", async () => {
    const deps = open();
    try {
      const answer = await call("/api/change?project=PRJ-1&title=", deps);

      assert.equal(answer.status, 400);
      assert.deepEqual(answer.body, { error: "title_required" });
    } finally {
      deps.database.close();
    }
  });

  it("项目不在库里时是 404，不是把 Change 建在空气上", async () => {
    const deps = open();
    try {
      assert.equal((await call("/api/change?project=PRJ-NOPE&title=x", deps)).status, 404);
    } finally {
      deps.database.close();
    }
  });

  /*
   * 打的是真实症状：**一次迟到的点击落到了另一道题上。**
   * 人看到的那道题和此刻在等的必须是同一道 —— 界面可能停在旧状态上。
   */
  it("没有在等的题时不落任何答案", async () => {
    const deps = open();
    try {
      const answer = await call("/api/answer?change=CHG-1&question=Q-旧的", deps);

      assert.equal(answer.status, 409);
      assert.deepEqual(answer.body, { error: "nothing_to_answer" });
    } finally {
      deps.database.close();
    }
  });

  it("豁免：一条可接受的都没有时说清楚，不摆一道没有选项的题", async () => {
    const deps = open();
    try {
      const answer = await call("/api/waive?change=CHG-1", deps);

      assert.equal(answer.status, 200);
      const body = answer.body as { asked: boolean; reason?: string };
      assert.equal(body.asked, false);
      assert.equal(body.reason, "nothing_waivable");
    } finally {
      deps.database.close();
    }
  });

  it("进旁路记一趟账，再进不重记", async () => {
    const deps = open();
    try {
      const first = await call("/api/aside?change=CHG-1", deps);
      const again = await call("/api/aside?change=CHG-1", deps);

      assert.equal(first.status, 200);
      assert.deepEqual(again.body, first.body);
    } finally {
      deps.database.close();
    }
  });

  it("判据表：阶段或角色不合法就拒，不写一份挂在错地方的标准", async () => {
    const deps = open();
    try {
      assert.equal((await call("/api/rubric?change=CHG-1&phase=乱写&role=producer", deps)).status, 400);
      assert.equal((await call("/api/rubric?change=CHG-1&phase=PRD&role=乱写", deps)).status, 400);
    } finally {
      deps.database.close();
    }
  });

  /*
   * 界面会 POST 的路已经全部接上，所以这条打的是**最后那种**失败：路径不认识。
   * 它照样得说人话 —— 一个空 body 的 501 在屏幕上是「没问成：undefined」，
   * 和「坏了」一模一样，人报的会是「没反应」。
   */
  it("不认识的路照样说人话，不空着回一个状态码", async () => {
    const deps = open();
    try {
      const answer = await call("/api/nope?change=CHG-1", deps);

      assert.equal(answer.status, 501);
      const body = answer.body as { reason?: string };
      assert.equal(typeof body.reason, "string");
      assert.equal(body.reason !== undefined && body.reason.length > 8, true);
    } finally {
      deps.database.close();
    }
  });

  /*
   * 派轮的判据全在 `runtime.runRound` 里，这里只守**路由到没到**。
   * 用一个会记账的桩：真调到了才记，于是「点了没反应」和「派出去了」分得开。
   */
  it("派轮走执行通道，带着这个阶段过去", async () => {
    const database = openDatabase(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(SCHEMA_SQL);
    new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
    new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
    const seen: { changeId: string; phase: string }[] = [];
    const deps = {
      database, repo, workspaceFor: () => "/tmp/repo",
      runtime: {
        runRound: (changeId: string, phase: string) => {
          seen.push({ changeId, phase });
          return Promise.resolve({ ran: true, phase, jobId: "JOB-1" });
        },
        roundBudget: 5,
        archiveOps: () => null,
      },
    } as unknown as ActionDeps;
    try {
      const answer = await call("/api/run?change=CHG-1", deps);

      assert.deepEqual(seen, [{ changeId: "CHG-1", phase: "PRD" }]);
      assert.deepEqual(answer.body, { ran: true, phase: "PRD", jobId: "JOB-1" });
    } finally {
      database.close();
    }
  });
});

/**
 * brief 那三条：起草（旁路谈完整理成草稿）、定稿（人改过的那份落库）、
 * 录需求（模型提问题、人答、答案落成 brief）。
 *
 * 三条都**只做翻译** —— 判据全在 `app/converge-brief.ts` 和 `app/record-brief.ts` 里。
 * 这一组要证的是「翻译到位了」：每一种下场都有一句人看得懂的话，没有一种是 501。
 */
describe("plugin · 需求那三条", () => {
  /*
   * 打的是真实症状：**旁路里聊完，按「起草」，屏幕上一句「没问成：undefined」。**
   * 没谈过是一个正常结局，它必须说得出「先去哪儿做什么」，而不是一个未接的路。
   */
  it("没有旁路对话时说去哪儿谈，不是 501", async () => {
    const deps = open();
    try {
      const answer = await call("/api/brief-draft?change=CHG-1", deps);

      assert.equal(answer.status, 200);
      assert.equal((answer.body as { kind: string }).kind, "no_aside_conversation");
    } finally {
      deps.database.close();
    }
  });

  /*
   * **机械判据**：终稿和草稿逐字相同 = 没人编辑过 = 不算 brief。
   * 这一条是「不许凭空造需求」的最后一道，翻译错了它就等于不存在。
   */
  it("工作稿一个字没改就不收，说得出是这条判据挡的", async () => {
    const deps = open();
    try {
      files.set("CHG-1-draft.md", "四节草稿");
      files.set("CHG-1.md", "四节草稿");

      const answer = await call("/api/brief-confirm?change=CHG-1", deps);

      assert.equal(answer.status, 200);
      assert.equal((answer.body as { kind: string }).kind, "draft_unedited");
    } finally {
      deps.database.close();
    }
  });

  it("人改过的那份落进库里", async () => {
    const deps = open();
    try {
      files.set("CHG-1-draft.md", "四节草稿");
      files.set("CHG-1.md", "四节草稿 —— 人补的边界");

      const answer = await call("/api/brief-confirm?change=CHG-1", deps);

      assert.equal((answer.body as { kind: string }).kind, "recorded");
      assert.equal(new ChangeStore(deps.database).read("CHG-1").brief, "四节草稿 —— 人补的边界");
    } finally {
      deps.database.close();
    }
  });

  /*
   * 录需求要模型先提问题。它跑在**当前阶段的座位**上 —— 跑错座位的代价不是报错，
   * 是这一问占掉了另一个阶段的线程，而「同一阶段只许一轮」从此挡住那边。
   */
  it("录需求把题问在当前阶段的座位上，并把题摆到页面上", async () => {
    const deps = open();
    const asked: Array<{ phase: string; prompt: string }> = [];
    try {
      const answer = await call("/api/brief?change=CHG-1", {
        ...deps,
        runtime: {
          ...deps.runtime,
          askInPhase: async (_id: string, phase: string, prompt: string) => {
            asked.push({ phase, prompt });
            /* 提案的形状是「问题 | 选项 | 选项 | 选项」（`domain/brief.ts`），不是散文。 */
            return "这次改动要解决什么问题？ | 现在打不开 | 太慢 | 数据会丢\n"
              + "什么算做完？ | 能打开 | 一秒内出图 | 有回归测试";
          },
        } as unknown as ActionDeps["runtime"],
      });

      assert.equal(answer.status, 200);
      assert.equal(asked[0]?.phase, "PRD");
      assert.equal((answer.body as { asked: boolean }).asked, true);
    } finally {
      deps.database.close();
    }
  });

  it("没有这个 Change 就是 404 —— 三条都一样", async () => {
    const deps = open();
    try {
      for (const path of ["/api/brief", "/api/brief-draft", "/api/brief-confirm"]) {
        assert.equal((await call(`${path}?change=CHG-404`, deps)).status, 404, path);
      }
    } finally {
      deps.database.close();
    }
  });
});

/**
 * `/api/close` —— 人当场把一个座位收掉。
 *
 * ## 光放掉会话不算出口
 *
 * 「这个 (Change,阶段) 上有没有活儿」有两个来源：手上那条会话，和账本里 queued /
 * running 的 job。只收前者的话，账本上那一轮照旧挂着、Change 停在 `running` 等满
 * 三小时超时，而这段时间里人**一个能按的都没有**。所以两个都收。
 *
 * 这仍然不是裁决入口：中止一轮不推闸门、不对任何产物下判断，只陈述「人把这一轮停了」。
 */
describe("plugin · 收掉一个座位", () => {
  it("账本上那一轮当场记成人中止的，Change 从 running 里出来", async () => {
    const deps = open();
    try {
      new ChangeStore(deps.database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      new JobStore(deps.database).enqueue({
        id: "JOB-1", changeId: "CHG-1", kind: "turn",
        deadlineAt: Date.now() + 1000, maxAttempts: 1, phase: "PRD",
      });

      const answer = await call("/api/close?change=CHG-1&phase=PRD", deps);

      assert.equal(answer.status, 200);
      assert.equal((answer.body as { aborted?: string }).aborted, "JOB-1");
      const job = new JobStore(deps.database).read("JOB-1");
      // 中止落在账本上的形状是「失败 + 说得出是谁停的」，不是一个单独的状态。
      assert.equal(job.status, "failed");
      assert.equal(job.error, "aborted_by_human");
      assert.notEqual(new ChangeStore(deps.database).read("CHG-1").state.status, "running");
    } finally {
      deps.database.close();
    }
  });

  /*
   * 只收**这个阶段**的账。人关一个历史阶段的闲座位，不该顺手把正在跑的那一轮打掉
   * —— 那是「点了一下关闭，另一个阶段的三小时白跑了」。
   */
  it("关一个没有活儿的阶段，不动别的阶段那一轮", async () => {
    const deps = open();
    try {
      new ChangeStore(deps.database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      new JobStore(deps.database).enqueue({
        id: "JOB-1", changeId: "CHG-1", kind: "turn",
        deadlineAt: Date.now() + 1000, maxAttempts: 1, phase: "PRD",
      });

      const answer = await call("/api/close?change=CHG-1&phase=Spec", deps);

      assert.equal(answer.status, 200);
      assert.equal((answer.body as { aborted?: string }).aborted, undefined);
      assert.equal(new JobStore(deps.database).read("JOB-1").status, "queued");
    } finally {
      deps.database.close();
    }
  });

  /*
   * 出旁路要**结账**：比一次 HEAD。前后不同 = 这一趟动过手，`needsNote` 为真，
   * 界面据此向人要一句「这次旁路做了什么」—— 那是下游唯一能知道环外发生过什么的地方。
   */
  it("出旁路时结账，并说得出要不要问那句话", async () => {
    const deps = open();
    try {
      await call("/api/aside?change=CHG-1", deps);

      const answer = await call("/api/close?change=CHG-1&phase=aside", deps);

      assert.equal(answer.status, 200);
      const body = answer.body as { phase: string; visit?: number; needsNote?: boolean };
      assert.equal(body.phase, "aside");
      assert.equal(body.visit, 1);
      assert.equal(body.needsNote, false);
    } finally {
      deps.database.close();
    }
  });

  it("阶段名不认识就说清楚，不当成「关掉了」", async () => {
    const deps = open();
    try {
      const answer = await call("/api/close?change=CHG-1&phase=Nope", deps);

      assert.equal(answer.status, 400);
      assert.equal((answer.body as { error: string }).error, "no_such_phase");
    } finally {
      deps.database.close();
    }
  });
});

describe("plugin · 答完就把用例喊回来", () => {
  /*
   * 打的是真机症状（2026-08-19）：裁决题答完了，`/api/answer` 回 `{answered:true}`，
   * 然后**什么都没发生** —— 没派轮、闸门没动、屏幕上只有「已记下」。
   *
   * 界面本来就是照「答完自动落地，不用再按别的」写的（`panel.js` 的 `pendingWords`），
   * 它等的是回包里那个 `driven`。而**服务端从来没实现过那半边** —— 前端照着一个
   * 不存在的契约写的（08-18 那次迁移留下的）。
   *
   * 「答」和「消费答案」拆成两次点击，是这套东西最不该有的形状：人答完一道裁决题，
   * 他做的就是那个决定本身，不该还要再找一个按钮把它「提交」一次。
   */
  it("裁决题答完，用例当场跑一遍，下场原样回给界面", async () => {
    const deps = open();
    try {
      new ChangeStore(deps.database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      new ChangeStore(deps.database, { now: () => new Date(AT) }).apply("CHG-1", "fail");
      // 先问出一道真的裁决题（走的就是界面那条路）。
      const asked = await call("/api/ask?change=CHG-1", deps);
      const questionId = (asked.body as { questionId?: string }).questionId;
      assert.notEqual(questionId, undefined, "先得有一道题可答");

      /* 这道题的裁决就是「重跑一次」—— 它必然要派轮，给一个记账的桩。 */
      const dispatched: string[] = [];
      const answered = await call(
        `/api/answer?change=CHG-1&question=${questionId}&decision=0`,
        {
          ...deps,
          runtime: {
            ...deps.runtime,
            runRound: async (_id: string, phase: string) => {
              dispatched.push(phase);
              return { ran: true, phase, jobId: "JOB-X" };
            },
          } as unknown as ActionDeps["runtime"],
        },
      );

      assert.deepEqual(dispatched, ["PRD"], "答完就该把这一轮派出去");

      const body = answered.body as { answered: boolean; kind?: string; driven?: unknown };
      assert.equal(body.answered, true);
      assert.equal(body.kind, "gate_decision", "界面靠它分辨这是哪种题");
      assert.notEqual(body.driven, undefined, "下场要回去 —— 界面等的就是它");
    } finally {
      deps.database.close();
    }
  });
});
