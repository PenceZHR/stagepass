/*
 * StagePass 的工作台 —— **一个本地 http server，在浏览器里开。**
 *
 *     pnpm stagepass          # 然后把 http://127.0.0.1:4399 开在任意浏览器里
 *
 * ## 开在哪都行，这是重点
 *
 *   - **Codex 的 in-app browser**（它自带的浏览器面板，官方说明就是「给本地开发
 *     页面用」）—— 跟 Codex 说一次「打开 http://127.0.0.1:4399」，之后它一直在
 *   - **Claude Code 的 Browser pane**
 *   - 普通浏览器
 *
 * 三处是同一份界面、同一个后端。而且**只有第一次开需要经过模型**，之后它就是一个
 * 真网页：宿主重画不影响它、F5 能恢复、有 DevTools、没有 CSP 沙箱。
 *
 * ## 它替掉了什么
 *
 * 2026-08-18 夜里插件连着六种失败，根子全在 widget 那层实验性的壳（生命周期不归
 * 我们、沙箱是草案、卡片不是窗口）。2026-08-19 定案：状态流转回浏览器，MCP 插件
 * 缩到只剩模型侧接口（给题面、收结果）。
 *
 * ## 和 08-18 退休的那个 panel-server 不是一回事
 *
 * 那个 2177 行、`handle()` 484 行、还管着终端座位。这个文件只做三件事：拆请求、
 * 交给 `web/serve.ts`、把 JSON 写回去。**判据一条都不在这儿。**
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { prepareSchema } from "../src/db/schema";
import type { ActionDeps } from "../src/web/actions";
import { PluginRuntime } from "../src/web/runtime";
import { openDatabase } from "../src/web/sqlite-handle";
import { ChangeStore } from "../src/store/change-store";
import { ProjectStore } from "../src/store/project-store";
import { createRepoOps } from "../src/work/repo";
import { bindProject } from "../src/web/bind-project";
import { serveRequest } from "../src/web/serve";

const PORT = Number(process.env["STAGEPASS_PORT"] ?? 4399);
const DB = process.env["STAGEPASS_DB"] ?? join(homedir(), ".stagepass", "panel.db");
const BRIEFS = process.env["STAGEPASS_BRIEFS"] ?? join(homedir(), ".stagepass", "briefs");
const WEB = join(new URL(".", import.meta.url).pathname, "..", "src", "web");

const repo = createRepoOps();

/** 只读句柄。**看一眼在物理上就不可能写坏什么。** */
const readable = openDatabase(DB, { readOnly: true });


/**
 * 会写的那个 —— 第一次要写时才开，**那时才跑迁移**。
 *
 * 只看不改的会话一次都不碰 schema。这条纪律是从插件那边搬过来的，理由一模一样：
 * 靠「同一个句柄小心点用」迟早会在某次改动里失效。
 */
let writable: ReturnType<typeof openDatabase> | null = null;
let runtime: PluginRuntime | null = null;
function writeDeps(): ActionDeps {
  if (writable === null) {
    writable = openDatabase(DB);
    prepareSchema(writable);
  }
  runtime ??= new PluginRuntime({ database: writable, repo });
  return {
    database: writable,
    repo,
    runtime,
    briefFiles: {
      write: (name, content) => {
        mkdirSync(BRIEFS, { recursive: true });
        const path = join(BRIEFS, name);
        writeFileSync(path, content, "utf-8");
        return path;
      },
      read: (name) => {
        try { return readFileSync(join(BRIEFS, name), "utf-8"); } catch { return null; }
      },
    },
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

/**
 * **工作台绑在它自己所在的那个仓库上**（用户 2026-08-19 定案：依附在一个项目下，
 * 不再自己管理项目）。
 *
 * 绑定要写库（可能得建这个项目），所以走可写那个句柄 —— 这是唯一一次「还没有人
 * 点任何东西就写库」，而它是启动的前提，不是某个人的动作。
 *
 * 绑不上就**不起**：一个不知道自己在哪个项目的工作台，屏幕上说的每句话都可疑
 * （今晚那个「面包屑写着库里不存在的 CHG-1」就是这么来的）。
 */
/*
 * 工作台服务哪个项目：**命令行给的那个，不给就是当前目录**。
 *
 *     pnpm stagepass                      # 当前仓库
 *     pnpm stagepass ~/Desktop/某项目      # 另一个仓库
 *
 * 参数这条是必需的，不是方便：工作台的代码住在 StagePass 自己的仓库里，而人要看的
 * 往往是**别的**仓库 —— 只认 cwd 的话，他得先 cd 过去再用绝对路径调起这个脚本。
 */
const TARGET = process.argv[2] ?? process.cwd();
const bound = bindProject(writeDeps().database, TARGET);
if (bound.kind !== "bound") {
  console.error(`起不来：${bound.path} 不是 git 仓库。`);
  console.error("Codex 按仓库认项目 —— 不是仓库的目录在它那儿根本不是一个项目，");
  console.error("StagePass 开出来的会话你在 Codex 里看不到。先 git init，再起工作台。");
  process.exit(1);
}

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const THREE = join(ROOT, "node_modules", "three");

/**
 * 静态文件。**白名单** —— 这个 server 只在本机上，但「只在本机」不是不做检查的理由。
 *
 * three 那三条走 node_modules：浏览器里 `import "three"` 解析不了裸说明符，所以
 * `graph-scene.js` 引的是相对路径，这里按名字喂它们。插件那边是全部内联进 1MB 的
 * HTML，这边不用 —— 真浏览器有缓存，也有 DevTools 能看清是哪一份。
 */
const ASSETS: Readonly<Record<string, string>> = {
  "/": "panel.html",
  "/panel.js": "panel.js",
  "/graph-view.js": "graph-view.js",
  "/graph-scene.js": "graph-scene.js",
  "/stage-artifact-view.js": "stage-artifact-view.js",
  "/stage-artifact-scene.js": "stage-artifact-scene.js",
  "/stage-artifact.css": "stage-artifact.css",
  "/assets/abstract-cloud-sea.png": "assets/abstract-cloud-sea.png",
};

/** three 的三件套。放在 node_modules 里，和上面那张表不同根。 */
const VENDOR: Readonly<Record<string, string>> = {
  "/three.module.js": join(THREE, "build", "three.module.js"),
  /*
   * `three.core.js` —— **必踩的坑**：`three.module.js` 自己 `import "./three.core.js"`，
   * 少了它整个图谱静默不出来，而 404 只出现在网络面板里。
   */
  "/three.core.js": join(THREE, "build", "three.core.js"),
  "/OrbitControls.js": join(THREE, "examples", "jsm", "controls", "OrbitControls.js"),
  "/CSS2DRenderer.js": join(THREE, "examples", "jsm", "renderers", "CSS2DRenderer.js"),
};

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
};

function readBody(request: { on: (event: string, fn: (chunk?: Buffer) => void) => void }): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => { if (chunk !== undefined) chunks.push(chunk); });
    request.on("end", () => { resolve(Buffer.concat(chunks).toString("utf-8")); });
  });
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? "/", "http://stagepass.invalid");

  if (url.pathname.startsWith("/api/")) {
    /*
     * **每条请求都带上绑定的那个项目。** 工作台只服务一个项目，「看哪个」不再是
     * 一个要人回答的问题 —— 界面传来的 `?project=` 一律以绑定的为准。
     */
    url.searchParams.set("project", bound.id);
    const answer = await serveRequest(
      request.method ?? "GET",
      `${url.pathname}?${url.searchParams.toString()}`,
      request.method === "POST" ? await readBody(request) : "",
      { read: { database: readable, repo }, write: writeDeps },
    );
    response.writeHead(answer.status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(answer.body));
    return;
  }

  const vendor = VENDOR[url.pathname];
  if (vendor !== undefined) {
    try {
      const text = readFileSync(vendor, "utf-8");
      response.writeHead(200, { "content-type": TYPES.js!, "cache-control": "no-store" });
      response.end(text);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`读不到 ${vendor}：${String(error)} —— 先跑 pnpm install。`);
    }
    return;
  }

  const file = ASSETS[url.pathname];
  if (file === undefined) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(`没有这条路：${url.pathname}`);
    return;
  }
  try {
    const bytes = readFileSync(join(WEB, file));
    response.writeHead(200, {
      "content-type": TYPES[file.split(".").pop() ?? "html"] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(bytes);
  } catch (error) {
    // 读不到就把原因写在屏幕上 —— 白屏什么都不说，人只能来问。
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`读不到 ${file}：${String(error)}`);
  }
})(); });

/*
 * **起不来要说人话。**
 *
 * 端口被占是最常见的一种（上一个工作台还开着、或者别的东西占了 4399），而 node
 * 默认吐的是一段 `EADDRINUSE` 加十几行栈 —— 人从里面读不出「关掉那个再起」这句话。
 */
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`起不来：${PORT} 端口已经被占了。`);
    console.error("多半是上一个工作台还开着 —— 关掉它，或者换个端口：");
    console.error(`  STAGEPASS_PORT=4400 pnpm start ${TARGET === process.cwd() ? "" : TARGET}`.trimEnd());
  } else {
    console.error(`起不来：${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`工作台  http://127.0.0.1:${PORT}/`);
  console.log(`项目    ${bound.name}（${bound.path.replace(homedir(), "~")}）`);
  console.log(`库      ${DB.replace(homedir(), "~")}`);
  console.log("\n开在哪都行：Codex 的 in-app browser、Claude Code 的 Browser pane、普通浏览器。");
});
