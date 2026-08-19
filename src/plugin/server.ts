import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { prepareSchema } from "../db/schema";
import { createRepoOps } from "../work/repo";
import { handleAction, type ActionDeps } from "./actions";
import { PluginRuntime } from "./runtime";
import { handleApi, type ApiDeps } from "./api";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { openDatabase } from "./sqlite-handle";
import { projectForWorkspace, workspacePaths } from "./workspace";

/**
 * StagePass 的 Codex 插件 —— 一个 stdio 上的 MCP server。
 *
 * ## 它是什么
 *
 * 2026-08-18 定案：StagePass 以插件形式存在，网页端退休。**这个文件就是那个产品的
 * 进程边界** —— Codex 拉起它，它把整套面板作为一个 widget 资源交出去，并回答那个
 * widget 的所有数据请求。
 *
 * ## 它刻意不做的事
 *
 * **不起 HTTP 服务、不连任何端口。** 上一版是把 widget 的 `fetch("/api/…")` 代理到
 * `127.0.0.1:4173` 的面板进程上；那条链整条拆了，现在直接读库。所以插件是自给自足
 * 的：用户机器上不需要任何东西在后台跑着。
 *
 * ## 这里几乎没有逻辑
 *
 * 认项目在 `workspace.ts`、答数据在 `api.ts`、装配那一屏在 `panel-data.ts`，
 * 三个都有测试。**这个文件只剩管道**：拆帧、分发、回帧。它难测（是个 stdio 循环），
 * 所以它不该拿主意 —— 拿主意的都搬走了。
 */

const HERE = new URL(".", import.meta.url).pathname;
const LOG = join(HERE, "plugin.log");
const PANEL_URI = "ui://stagepass/panel";
const DB_PATH = process.env["STAGEPASS_DB"] ?? join(homedir(), ".stagepass", "panel.db");
/**
 * brief 的草稿和工作稿。人要**在编辑器里**改工作稿，所以它得是磁盘上一个说得出
 * 路径的文件 —— 「改没改过」那条机械判据比的就是这两份。
 */
const BRIEFS_DIR = process.env["STAGEPASS_BRIEFS"] ?? join(homedir(), ".stagepass", "briefs");

/** 排障用。写不进去也不能让 server 倒下 —— 日志不是功能。 */
function log(direction: string, message: unknown): void {
  try {
    appendFileSync(LOG, `${direction} ${JSON.stringify(message).slice(0, 4000)}\n`);
  } catch { /* 日志写不了就算了 */ }
}

function send(message: unknown): void {
  log("<<", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 库**只读**打开。
 *
 * 看状态不该有副作用（用户的界面原则）。而且插件可能和别的进程同时开着这个库，
 * 只读打开让「看一眼」永远不可能写坏什么。要写的时候单独开，届时再说谁持有写锁。
 */
let cached: Database.Database | null = null;
function database(): Database.Database {
  if (cached === null) cached = openDatabase(DB_PATH, { readOnly: true });
  return cached;
}

/** 图谱那两条路要问 git。整层可注入，这里是唯一的真实现。 */
const repo = createRepoOps();
function deps(): ApiDeps {
  return {
    database: database(),
    repo,
    /*
     * 进度那一屏问「现在有没有活着的座位」。**只问已经建好的那个 runtime，
     * 不建新的** —— `writeDeps()` 会开可写句柄并跑迁移，而看一眼进度不该做这些。
     * 一轮都没派过时这里就是 null，进度照实报「进程没了」。
     */
    live: () => {
      const live = runtime?.liveProgress() ?? null;
      return live === null ? null : { sessions: live.seats, history: live.history };
    },
  };
}

/**
 * **可写**的那个句柄 —— 只给会改库的路（答题、豁免、建 Change…）。
 *
 * 和上面那个只读的是两个句柄，不是一个句柄两种用法：后者要靠纪律，而纪律会在某次
 * 改动里悄悄失效。这样「看一眼」在物理上就不可能写坏什么。
 *
 * 第一次要写时才打开，并且**那时才跑迁移** —— 只看不改的会话一次都不碰 schema。
 */
let writable: Database.Database | null = null;
let runtime: PluginRuntime | null = null;
function writeDeps(): ActionDeps {
  if (writable === null) {
    writable = openDatabase(DB_PATH);
    prepareSchema(writable);
  }
  /*
   * 执行通道也是懒建的，而且它自己**还要更懒一层** —— 建这个对象不起任何进程，
   * `codex app-server daemon` 要到第一次真派轮时才拉起来（见 `runtime.ts`）。
   */
  runtime ??= new PluginRuntime({ database: writable, repo });
  return {
    runtime,
    briefFiles: {
      write: (name, content) => {
        mkdirSync(BRIEFS_DIR, { recursive: true });
        const path = join(BRIEFS_DIR, name);
        writeFileSync(path, content, "utf-8");
        return path;
      },
      // 不在就是 null —— 「还没起草」是一个正常状态，不是读取失败。
      read: (name) => {
        try { return readFileSync(join(BRIEFS_DIR, name), "utf-8"); } catch { return null; }
      },
    },
    database: writable,
    repo,
    workspaceFor: (changeId) => {
      try {
        const change = new ChangeStore(writable!).read(changeId);
        if (change.projectId === null) return null;
        const path = new ProjectStore(writable!).read(change.projectId).path;
        return path === "" ? null : path;
      } catch {
        return null;
      }
    },
  };
}

function widgetHtml(): string {
  try {
    return readFileSync(join(HERE, "widget", "panel-widget.html"), "utf-8");
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    log("!!", { widget: why });
    // 读不到就把原因画在屏幕上 —— 白屏什么都不说，人只能来问。
    return `<!doctype html><body style="font:13px ui-monospace,monospace;color:#e0736f;`
      + `background:#1b1723;padding:20px">widget 读不出来：${why}`;
  }
}

interface ToolCallMeta {
  readonly change: string | null;
  readonly project: string | null;
  readonly projectName: string | null;
  readonly workspacePaths: readonly string[];
}

/**
 * 这次调用要看哪个 Change、哪个项目。
 *
 * 项目跟着 Codex 当前打开的目录走（人不再挑）。Change 没指定就取这个项目下的第一条
 * —— 一个项目通常只有一条在办的 Change，让人为此再点一下没有意义。
 */
async function resolve(argsChange: unknown, meta: unknown): Promise<ToolCallMeta> {
  const paths = workspacePaths(meta);
  const project = projectForWorkspace(database(), paths);
  let change = typeof argsChange === "string" && argsChange !== "" ? argsChange : null;
  if (change === null && project !== null) {
    const roster = (await handleApi("/api/panel", deps())).body as {
      changes?: readonly { id: string; projectId: string }[];
    };
    change = (roster.changes ?? []).find((each) => each.projectId === project.id)?.id ?? null;
  }
  return {
    change,
    project: project?.id ?? null,
    projectName: project?.name ?? null,
    workspacePaths: paths.slice(0, 6),
  };
}

/** 工具调用时先把那一屏要的数据取好，widget 一起来就有内容，不用再往返一次。 */
async function prefetch(picked: ToolCallMeta): Promise<Record<string, string>> {
  const wanted = ["/api/panel"];
  if (picked.change !== null) {
    const suffix = picked.project === null ? "" : `&project=${encodeURIComponent(picked.project)}`;
    wanted.push(`/api/panel?change=${encodeURIComponent(picked.change)}${suffix}`);
    wanted.push(`/api/parallel?change=${encodeURIComponent(picked.change)}`);
  }
  const api: Record<string, string> = {};
  for (const path of wanted) {
    const answer = await handleApi(path, deps());
    if (answer.status === 200) api[path] = JSON.stringify(answer.body);
  }
  return api;
}

const TOOLS = [
  {
    name: "stagepass_panel",
    description: "打开 StagePass 面板：阶段环、判据、产物。项目自动取 Codex 当前打开的目录。",
    inputSchema: {
      type: "object",
      properties: { change: { type: "string", description: "要看的 Change，如 CHG-002" } },
    },
    /*
     * `openai/widgetAccessible` —— widget 换 Change 时自己调这个工具让宿主重渲染，
     * 没这个标记调不动。
     */
    _meta: { "openai/outputTemplate": PANEL_URI, "openai/widgetAccessible": true },
  },
  {
    name: "sp_api",
    description: "内部：widget 的数据口。人不要调。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    _meta: { "openai/widgetAccessible": true },
  },
  {
    name: "sp_report",
    description: "内部：widget 把自检结果回传到这里。人不要调。",
    inputSchema: { type: "object", properties: { tag: { type: "string" } } },
    _meta: { "openai/widgetAccessible": true },
  },
];

/**
 * 插件自带的命令（MCP `prompts/*`）。
 *
 * ## 它想解决什么
 *
 * 打开面板今天靠**跟模型说一句话**，而模型可能不去调那个工具 —— 用户 2026-08-18：
 * 「提示词很不稳定」。插件 manifest 里没有 `commands` 这一类（把已装的 15 个插件的
 * 键全列过一遍，只有 `mcpServers` / `skills` / `apps`），所以协议这一层的 `prompts`
 * 是唯一可能通向「插件自带一条斜杠命令」的路。
 *
 * ## 这是一个实验，判据在日志里
 *
 * **Codex 会不会把 server 的 prompts 显示成命令，没有验证过。** 之前它一次都没问过
 * `prompts/list` —— 但那说明不了什么，因为我们从来没在 `initialize` 里声明过这个能力，
 * 客户端不问是对的。声明 + 实现之后再看：
 *
 *   grep 'prompts/list' plugin.log
 *
 * 有，这条路通；没有，这条路排除掉，别再猜。
 */
const PROMPTS = [
  {
    name: "stagepass",
    title: "打开 StagePass 面板",
    description: "打开 StagePass：阶段环、判据、产物。项目自动取 Codex 当前打开的目录。",
    arguments: [
      { name: "change", description: "要看的 Change，如 CHG-002。不给就取这个项目下第一条。", required: false },
    ],
  },
];

/**
 * 命令展开成的那句话。
 *
 * **写成一条指令而不是一句请求** —— 这条路的全部意义是把「模型要不要调那个工具」
 * 从一次判断变成一次执行。它仍然经过模型（协议里没有「直接挂 widget」这回事），
 * 但至少措辞不再每次都不一样。
 */
function promptMessages(args: Record<string, unknown>): unknown[] {
  const change = typeof args["change"] === "string" && args["change"] !== ""
    ? args["change"] : null;
  return [{
    role: "user",
    content: {
      type: "text",
      text: "调用 stagepass_panel 工具打开 StagePass 面板"
        + (change === null ? "" : `，change=${change}`)
        + "。除此之外不要做别的，也不要解释。",
    },
  }];
}

function handle(message: Record<string, unknown>): void {
  log(">>", message);
  const id = message["id"];
  const ok = (result: unknown): void => { send({ jsonrpc: "2.0", id, result }); };
  const method = message["method"];
  const params = (message["params"] ?? {}) as Record<string, unknown>;

  if (method === "initialize") {
    ok({
      protocolVersion: params["protocolVersion"] ?? "2025-06-18",
      // `prompts` 是 2026-08-18 加的实验，见 `PROMPTS` 上面那段。
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "stagepass", version: "0.1.0" },
    });
    return;
  }
  if (method === "tools/list") { ok({ tools: TOOLS }); return; }
  if (method === "prompts/list") { ok({ prompts: PROMPTS }); return; }
  if (method === "prompts/get") {
    const name = params["name"];
    if (!PROMPTS.some((prompt) => prompt.name === name)) {
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown prompt: ${String(name)}` } });
      }
      return;
    }
    ok({
      description: PROMPTS[0]!.description,
      messages: promptMessages((params["arguments"] ?? {}) as Record<string, unknown>),
    });
    return;
  }
  if (method === "resources/list") {
    ok({ resources: [{ uri: PANEL_URI, name: "StagePass 面板", mimeType: "text/html+skybridge" }] });
    return;
  }
  if (method === "resources/templates/list") { ok({ resourceTemplates: [] }); return; }
  if (method === "resources/read") {
    const text = widgetHtml();
    log("!!", { read: params["uri"], bytes: text.length });
    ok({ contents: [{ uri: params["uri"], mimeType: "text/html+skybridge", text }] });
    return;
  }

  if (method === "tools/call") {
    const name = params["name"];
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;

    if (name === "sp_report") {
      log("!!", { report: args["tag"] });
      try {
        appendFileSync(join(HERE, "report.log"),
          `\n===== ${new Date().toISOString()} tag=${String(args["tag"])} =====\n`
          + `${JSON.stringify(args["report"], null, 1)}\n`);
      } catch { /* 同上 */ }
      ok({ content: [{ type: "text", text: "收到" }] });
      return;
    }

    if (name === "sp_api") {
      /*
       * **按方法分岔。** GET 走只读那半边，POST 走会写的那半边 —— 两个句柄的
       * 分工就在这一行落地。方法是 widget 送上来的（`prelude.js` 的 fetch 改道），
       * 不是从路径猜的：同一条 `/api/rubric` 既能读也能写。
       */
      const path = String(args["path"] ?? "");
      const method = String(args["method"] ?? "GET").toUpperCase();
      const [pathname = "", query = ""] = path.split("?");
      const answering = method === "POST"
        ? handleAction(pathname, new URLSearchParams(query), String(args["body"] ?? ""), writeDeps())
        : handleApi(path, deps());
      void answering.then((answer) => {
        ok({ content: [{ type: "text", text: JSON.stringify(answer.body) }] });
      });
      return;
    }

    void (async () => {
      const picked = await resolve(args["change"], params["_meta"]);
      log("!!", { picked });
      const where = picked.projectName ?? (picked.workspacePaths[0] ?? "（Codex 没给工作目录）");
      ok({
        content: [{
          type: "text",
          text: `StagePass 面板已渲染 ${where}${picked.change === null ? "" : ` · ${picked.change}`}。`,
        }],
        structuredContent: { ...picked, api: await prefetch(picked) },
        _meta: { "openai/outputTemplate": PANEL_URI },
      });
    })();
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown: ${String(method)}` } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") {
      try {
        handle(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        log("!!", { parse: error instanceof Error ? error.message : String(error) });
      }
    }
    index = buffer.indexOf("\n");
  }
});
