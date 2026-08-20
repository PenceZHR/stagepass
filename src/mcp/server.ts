/**
 * StagePass 的 MCP 面：**一根电话线，没有业务。**
 *
 * ## 为什么它必须是薄的
 *
 * MCP server 按会话起 —— 一台机器上同时开三条 Codex 会话，就有三个这个进程。
 * 2026-08-18 夜里它们各锁着不同版本的代码，于是「改好的东西怎么点都不生效」。
 * 那次的解药写在 TechSpec §四：**状态全在工作台那一个进程里**，这里只负责
 * 把工具调用转成一次 HTTP，再把表单弹出来。
 *
 * 所以这个文件**不 import `src/` 下的任何东西**（有架构测试钉着）。它一旦碰业务，
 * 就不再是电话线，那个坑当场回来。
 *
 * ## 它做的三件事
 *
 *   1. 收 `stagepass_ask` → POST /api/ask-from-model（工作台校验、落档）
 *   2. 校验过了 → elicitation 弹表单给人
 *   3. 人选完 → POST /api/answer-ask 回填 → 把选择还给模型
 *
 * 每一步失败都**把原话还给模型**，不抛异常：抛出去在模型那边只剩一句
 * 「工具调用失败」，它据此改不了任何东西。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readProjectHome } from "../system/project-home";

/**
 * 这条会话对应的工作台在哪。
 *
 * ## 地址来自**项目文件夹**，不是写死的 4399
 *
 * Codex 按会话起这个进程，进程的 cwd 就是会话所在目录。所以它自己往上找 git 根、
 * 读 `<根>/.stagepass/config.json` 的端口 —— **同一条全局注册，在哪个项目里就连
 * 哪个项目的工作台**。
 *
 * 在这之前它打死 `127.0.0.1:4399`，于是用户在「海战小游戏」的会话里问的一句话，
 * 记进了 stagepass 的 Change（2026-08-19 真机）。他的原话：「chg 和 MCP 全都是乱的，
 * 这些必须统一管理」。
 *
 * ## 每次调用现读，不在 import 时定死
 *
 * 两个理由，都真的踩过：这个进程**可能早于工作台启动**（那时配置还没写出来）；
 * 而定死之后测试改 `process.env` 不生效，那条「连不上会怎样」的测试会走真网络 ——
 * 4399 上没人时绿、有人时红。**一条绿得靠环境的测试等于没有。**
 *
 * `STAGEPASS_URL` 仍然认，那是排查用的后门；人正常用的时候一个变量都不用设。
 */
const workbench = (): string | null => {
  const override = process.env["STAGEPASS_URL"];
  if (override !== undefined && override !== "") return override;
  const home = readProjectHome(process.cwd());
  return home === null ? null : `http://127.0.0.1:${home.port}`;
};

const NO_PROJECT = "这条会话所在的目录**还没有 StagePass 项目**"
  + "（找不到 <git 根>/.stagepass/config.json）。\n"
  + "请人在这个项目目录里跑一次 `npm --prefix <stagepass 仓库> start -- $(pwd)` ——"
  + "它会建好配置、挑好端口，之后这条线自己就找得到。\n"
  + "**别替他跑** —— 那是他的机器，也是他的项目。";

/** 工作台答的形状。**只列这里用得到的几格** —— 多写一格就是多一处会漂的拷贝。 */
interface WorkbenchAnswer {
  readonly ok: boolean;
  /** 这一批真的落进账本的那几条，按送去的顺序。 */
  readonly asked?: readonly {
    readonly askId: string;
    readonly question: string;
    readonly rubricText?: string;
  }[];
  readonly error?: string;
  readonly reason?: string;
}

const NOT_RUNNING = "连不上 StagePass 工作台。请人在项目目录里跑 `npm start`，"
  + "起来之后再试一次。**别替他起** —— 那是他的机器。";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/**
 * 打一次工作台。
 *
 * **连不上不自己去起它** —— 「看状态不该有副作用」那条的对偶：问一句话也不该
 * 顺手在人的机器上拉起一个进程。把起它的命令念给模型，让它转告人。
 */
/** 只读的那一边。连不上和 post 同一个说法。 */
async function get(path: string): Promise<WorkbenchAnswer> {
  const base = workbench();
  if (base === null) return { ok: false, error: "no_project", reason: NO_PROJECT };
  try {
    const response = await fetch(`${base}${path}`);
    if (!response.ok) {
      return { ok: false, error: "workbench_error", reason: `工作台回了 ${response.status}。` };
    }
    return await response.json() as WorkbenchAnswer;
  } catch {
    return { ok: false, error: "workbench_not_running", reason: NOT_RUNNING };
  }
}

/**
 * 这条会话在哪个目录。
 *
 * **每次请求都带上，工作台对不上就拒。** 2026-08-19 真机：用户在「海战小游戏」的
 * 会话里问了一句，而工作台绑的是 stagepass —— 那一问记进了 stagepass 的 CHG-004，
 * 正本也写进了 stagepass 的仓库。**一台机器一个工作台，而任何一条会话都打得到它**，
 * 少了这一格，「工作台绑一个项目」那条规矩就从后门失效了。
 *
 * Codex 按会话起这个进程，所以 `process.cwd()` 就是那条会话所在的目录。
 */
const sessionCwd = (): string => process.cwd();

async function post(path: string, payload: unknown): Promise<WorkbenchAnswer> {
  const base = workbench();
  if (base === null) return { ok: false, error: "no_project", reason: NO_PROJECT };
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      error: "workbench_not_running",
      reason: NOT_RUNNING,
    };
  }
  if (!response.ok) {
    return { ok: false, error: "workbench_error", reason: `工作台回了 ${response.status}。` };
  }
  return await response.json() as WorkbenchAnswer;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "stagepass", version: "0.1.0" });

  server.registerTool("stagepass_ask", {
    title: "问人（一次可以攒几个）",
    description:
      "需要人替你做决定时调这个，**不要用文字问**。会弹一张表单给他，一次可以问 "
      + "1 到 5 条 —— **攒几个一起问**，别一条一条地打断他。他答完你就拿得到结果，"
      + "而且这一问一答会进 StagePass 的账本。\n"
      + "每条的 `ordinal` 是判据单上的序号（题面里那份文件，`1.` `2.` `3.`）—— "
      + "问的是哪一条就填哪个号。判据单为空的轮次填 null。\n"
      + "**他可以只答其中几条**：没答的留在账本里当未答，你继续往下走。",
    inputSchema: {
      questions: z.array(z.object({
        question: z.string().min(1).describe("问句本身"),
        options: z.array(z.string()).min(2).max(6).describe("给他挑的选项，2 到 6 条"),
        why: z.string().nullable().optional().describe("为什么要问他 —— 会一起摆给他看"),
        ordinal: z.number().int().nullable().optional()
          .describe("判据单上的序号；这一轮没有判据单就填 null"),
      })).min(1).max(5).describe("这一批要问的，按你希望他看到的顺序"),
    },
  }, async ({ questions }) => {
    const recorded = await post("/api/ask-from-model", {
      cwd: sessionCwd(),
      questions: questions.map((one) => ({
        question: one.question, options: one.options,
        why: one.why ?? null, ordinal: one.ordinal ?? null,
      })),
    });
    if (!recorded.ok) return text(`${recorded.error}：${recorded.reason}`);
    const asked = recorded.asked ?? [];

    /*
     * **字段名是 `q1`…`q5`，因为表单按字段名排序**（2026-08-04 实测）。
     * 排出来的顺序就是模型送来的顺序，也就是人在屏幕上看到的顺序。
     * 超过 9 条会排乱（`q10` 挤到 `q1` 和 `q2` 中间），所以上限钉在 5。
     *
     * **一格都不设 `required`。** required 是硬闸门：有一条他答不上，整张表就交不了。
     * 攒着问的前提正是「他可以只答他有把握的那几条」—— 没答的留在账本里当未答。
     *
     * 全是选择题，所以那条「空文本格吃掉回车」的坑不成立（它只在有自由文本格时出现）。
     */
    type Field = { type: "string"; title: string; description?: string; enum: string[] };
    const properties: Record<string, Field> = {};
    asked.forEach((one, index) => {
      properties[`q${index + 1}`] = {
        type: "string",
        title: one.question,
        ...(one.rubricText === undefined ? {} : { description: `判据：${one.rubricText}` }),
        enum: [...(questions[index]?.options ?? [])],
      };
    });

    const answered = await server.server.elicitInput({
      message: asked.length === 1
        ? asked[0]!.question
        : `有 ${asked.length} 件事要你定（可以只答你有把握的）`,
      requestedSchema: { type: "object", properties, required: [] },
    });

    if (answered.action !== "accept") {
      return text(
        `他没有答（${answered.action}）。这 ${asked.length} 条留在账本里当未答。`
        + "**继续往下走**，别停在这儿。",
      );
    }

    const lines: string[] = [];
    for (const [index, one] of asked.entries()) {
      const chosen = answered.content?.[`q${index + 1}`];
      if (typeof chosen !== "string" || chosen === "") {
        lines.push(`· ${one.question} —— 他跳过了`);
        continue;
      }
      const filed = await post("/api/answer-ask", { askId: one.askId, chosen });
      // 他已经选了，落账失败不能把他的选择吞掉 —— 先说选择，再说账没记上。
      lines.push(filed.ok
        ? `· ${one.question} —— 「${chosen}」`
        : `· ${one.question} —— 「${chosen}」（**这条没能落进账本**：${filed.reason}）`);
    }
    return text(lines.join("\n"));
  });

  server.registerTool("stagepass_brief", {
    title: "拿这一阶段的题面",
    description:
      "**动手写产物之前先调它。** 一次给全：现在是哪个阶段、产物写到哪个文件、"
      + "每一节要回答什么、已经写了什么、还缺哪几节、这一阶段的标准、"
      + "以及**人留下的、你还没给下文的意见**。\n"
      + "`role=\"blue\"` 是反方那份：只给正文和标准，**不给意见** —— "
      + "你要挑的是他俩一起没想到的，看了意见就只会顺着他们的思路说。",
    inputSchema: {
      role: z.enum(["producer", "blue"]).nullable()
        .describe("默认 producer（写产物的那一方）；人说你是反方/蓝方时填 blue"),
    },
  }, async ({ role }) => {
    const brief = await get(`/api/phase-brief?role=${role === "blue" ? "blue" : "producer"}`
      + `&cwd=${encodeURIComponent(sessionCwd())}`);
    // 原样念给它 —— 这一层不解释、不排序、不挑重点，那是模型的活，它比这里知道得多。
    return text(JSON.stringify(brief, null, 2));
  });

  server.registerTool("stagepass_respond", {
    title: "回应人留的一条意见",
    description:
      "改完之后逐条交代。**明说不改也算交代**（写清为什么），空着才算没下文 —— "
      + "而「每条意见都有下文」是这个阶段能不能往前走的硬判据之一。\n"
      + "`ordinal` 是 stagepass_brief 给你那份清单里的序号，**别自己编 id**。",
    inputSchema: {
      changeId: z.string().describe("stagepass_brief 里的 changeId，原样带回来"),
      phase: z.string().describe("stagepass_brief 里的 phase，原样带回来"),
      ordinal: z.number().int().describe("那条意见的序号"),
      how: z.string().min(1).describe("改了什么，或者为什么不改"),
    },
  }, async ({ changeId, phase, ordinal, how }) => {
    const done = await post("/api/respond", { cwd: sessionCwd(), changeId, phase, ordinal, how });
    return text(done.ok ? `第 ${ordinal} 条已记下。` : `${done.error}：${done.reason}`);
  });

  return server;
}

/**
 * 进程入口。
 *
 * **不用顶层 `await`** —— 测试跑在 tsx 的 CJS 转译下，顶层 await 在那边直接转不出来
 * （`Top-level await is currently not supported with the "cjs" output format`）。
 * 这个文件既要能当进程跑，也要能被测试 import，所以入口收进一个函数里。
 */
export function main(): Promise<void> {
  return buildServer().connect(new StdioServerTransport());
}

const invokedDirectly = process.argv[1]?.endsWith("server.ts") === true
  || process.argv[1]?.endsWith("server.js") === true;
if (invokedDirectly) void main();
