/*
 * 把 StagePass 打成一个 Codex 插件，并装到 Codex 找得到的地方。
 *
 *     pnpm plugin
 *
 * ## 产物两块
 *
 *   server.mjs                 插件进程（`src/plugin/server.ts` 打包，零依赖）
 *   widget/panel-widget.html   整套面板压成一个自包含 HTML（CSS / JS / 背景图全内联）
 *
 * ## 为什么必须自包含
 *
 * Codex 的 widget 沙箱把外部源全挡死了（2026-08-18 实测：`fetch https`、`img https`、
 * `fetch localhost` 全 ✗），所以页面里不许有任何一条外链 —— 连背景图都得是 data URI。
 *
 * ## 为什么直接装到 codex 的插件目录
 *
 * 现阶段以迭代速度为准（用户 2026-08-18 定）：改完立刻装上、开一条新会话就能验。
 * **产物可见/可 review 是下一步的事** —— 到时候改成先输出到仓库里的 `dist/plugin/`，
 * 再由一条单独的命令安装。在那之前，装到哪里、装了什么，这个文件就是唯一的答案。
 *
 * ## 装完必须开新会话
 *
 * MCP server 是**按会话起**的。覆盖 `server.mjs` 之后，已经开着的那条 Codex 会话
 * 继续跑老进程 —— 卡还活着、还回传，但连的是老代码，看起来就像「改了没生效」。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const WEB = join(ROOT, "src", "web");
const WIDGET = join(ROOT, "src", "plugin", "widget");
const OUT = join(homedir(), ".codex", "plugins", "cache", "stagepass-local", "stagepass", "0.0.1");

/** `</script>` 出现在 JS 或 CSS 里会提前关掉标签 —— 这是内联唯一的雷。 */
function inlineSafe(text: string): string {
  return text.replaceAll(/<\/(script|style)/gi, "<\\/$1");
}

/**
 * 面板的三个 ES module 打成一个 IIFE。
 *
 * 浏览器版靠 importmap 把裸名 `three` 指到 `/three.module.js`；widget 里没有服务器
 * 喂文件，所以 three 必须一起打进来。`three/addons/*` 是 `three/examples/jsm/*` 的
 * 别名，esbuild 不认，这里显式告诉它。
 */
async function bundlePanelScript(): Promise<string> {
  const entry = join(WIDGET, "entry.generated.js");
  writeFileSync(entry, [
    `import ${JSON.stringify(join(WEB, "panel.js"))};`,
    `import ${JSON.stringify(join(WEB, "stage-artifact-view.js"))};`,
    `import ${JSON.stringify(join(WEB, "graph-view.js"))};`,
    `import ${JSON.stringify(join(WIDGET, "three-smoke.js"))};`,
    "",
  ].join("\n"));
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true, write: false, minify: true,
      format: "iife", target: "es2022", logLevel: "warning",
      alias: { "three/addons": "three/examples/jsm" },
    });
    return result.outputFiles[0]?.text ?? "";
  } finally {
    rmSync(entry, { force: true });
  }
}

/** 面板的 HTML + CSS + JS + 背景图 → 一个文件。 */
async function buildWidget(): Promise<string> {
  let html = readFileSync(join(WEB, "panel.html"), "utf-8");

  const open = '<html lang="zh">';
  if (!html.includes(open)) throw new Error("panel.html 的 <html> 开标签变了");
  html = html.replace(open, '<html lang="zh" class="sp-widget">');

  const link = '<link rel="stylesheet" href="/stage-artifact.css">';
  if (!html.includes(link)) throw new Error("panel.html 的 CSS link 标签变了");
  html = html.replace(link, `<style>\n${inlineSafe(readFileSync(join(WEB, "stage-artifact.css"), "utf-8"))}\n</style>`);

  const background = 'url("/assets/abstract-cloud-sea.png")';
  if (!html.includes(background)) throw new Error("panel.html 的背景图引用变了");
  html = html.replace(background, `url("data:image/jpeg;base64,${readFileSync(join(WIDGET, "background.jpg")).toString("base64")}")`);

  // widget 版式排在面板全部样式之后 —— 它要覆盖 @media(max-width:820px) 那段手机版式。
  const headEnd = html.indexOf("</head>");
  if (headEnd < 0) throw new Error("panel.html 没有 </head>");
  html = `${html.slice(0, headEnd)}<style>\n${inlineSafe(readFileSync(join(WIDGET, "widget.css"), "utf-8"))}\n</style>\n${html.slice(headEnd)}`;

  // importmap + 三个 module script → 序言 + 一个 IIFE
  const tail = html.indexOf('<script type="importmap">');
  if (tail < 0) throw new Error("panel.html 的 importmap 不见了");
  const bodyEnd = html.indexOf("</body>", tail);
  const prelude = `<script id="sp-prelude">\n${inlineSafe(readFileSync(join(WIDGET, "prelude.js"), "utf-8"))}\n</script>`;
  const script = `<script>\n${inlineSafe(await bundlePanelScript())}\n</script>`;
  return `${html.slice(0, tail)}${prelude}\n${script}\n${html.slice(bodyEnd)}`;
}

async function main(): Promise<void> {
  mkdirSync(join(OUT, "widget"), { recursive: true });
  mkdirSync(join(OUT, ".codex-plugin"), { recursive: true });

  const widget = await buildWidget();
  writeFileSync(join(OUT, "widget", "panel-widget.html"), widget);

  /*
   * `splitting` 不是为了体积，是为了**懒加载真的成立**。
   *
   * 产物和图谱那四条路要 TypeScript 编译器（实测急切加载让启动 110ms → ~200ms、
   * 堆多 21MB，而绝大多数会话根本不看那两屏）。`api.ts` 里那句 `await import(
   * "./repo-routes")` 只有在**分出 chunk** 时才真的推迟加载 —— 打成一个文件的话，
   * 顶层的 `import ts from "typescript"` 照样在启动时就跑。
   *
   * `typescript` 走 external：它内部用动态 `require("fs")`，打进 ESM 会直接抛
   * `Dynamic require of "fs" is not supported`（2026-08-18 实测）。所以它必须以
   * 真 node_modules 的形式躺在插件目录里，见下面那次拷贝。
   */
  await build({
    entryPoints: [join(ROOT, "src", "plugin", "server.ts")],
    outdir: OUT,
    outExtension: { ".js": ".mjs" },
    splitting: true,
    external: ["typescript"],
    bundle: true, minify: false, platform: "node", format: "esm",
    target: "node22", logLevel: "warning",
  });

  /*
   * 编译器本体。**它是产品的一部分，不是开发依赖** —— 少了它，产物和图谱那两屏
   * 在用户机器上会以「模块找不到」的形式碎掉，而那两屏正是「点进阶段环之后」的内容。
   */
  cpSync(join(ROOT, "node_modules", "typescript"), join(OUT, "node_modules", "typescript"),
    { recursive: true, dereference: true });

  writeFileSync(join(OUT, ".mcp.json"), `${JSON.stringify({
    mcpServers: { stagepass: { command: "node", args: ["./server.mjs"], cwd: "." } },
  }, null, 2)}\n`);

  writeFileSync(join(OUT, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: "stagepass",
    version: "0.0.1",
    description: "StagePass 阶段环工作台。",
    author: { name: "ZhangHR" },
    license: "MIT",
    keywords: ["stagepass", "workbench"],
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "StagePass",
      shortDescription: "阶段环工作台",
      longDescription: "在 Codex 里打开 StagePass：阶段环、判据、产物、历史。",
      developerName: "ZhangHR",
      category: "Productivity",
      defaultPrompt: ["打开 StagePass 面板"],
      brandColor: "#1B1723",
      screenshots: [],
      logo: "./assets/app-icon.png",
    },
  }, null, 2)}\n`);

  /*
   * 提示词模板要跟着一起装。
   *
   * `domain/phase-template.ts` 在**模块加载时**就去读 `join(HERE, "..", "prompts")`
   * （用户 2026-08-13 拍板：提示词模块化、markdown 是源头，代码只装配）。打包之后
   * `HERE` 是 `server.mjs` 所在的插件目录，于是那个 `..` 落在版本目录的上一级 ——
   * 少了它，插件进程**在第一条消息之前就抛 ENOENT**，Codex 那边只看到 server 起不来。
   *
   * 放在上一级是当下的事实，不是设计。等 `phase-template` 能被注入基准路径时，
   * 这段就该改成装进版本目录里。
   */
  cpSync(join(ROOT, "src", "prompts"), join(OUT, "..", "prompts"), { recursive: true });

  const icon = join(ROOT, "src", "plugin", "widget", "app-icon.png");
  try {
    mkdirSync(join(OUT, "assets"), { recursive: true });
    cpSync(icon, join(OUT, "assets", "app-icon.png"));
  } catch { /* 图标可选 —— 缺了不该让构建失败 */ }

  const kb = (text: string): string => `${Math.round(text.length / 1024)} KB`;
  console.log(`widget   ${kb(widget)}`);
  console.log(`server   ${kb(readFileSync(join(OUT, "server.mjs"), "utf-8"))}`);
  console.log(`装到     ${OUT.replace(homedir(), "~")}`);
  console.log("\n**装完要开一条新的 Codex 会话** —— MCP server 按会话起，旧会话还跑着老代码。");
}

/*
 * 不用顶层 await —— tsx 把这个脚本转成 CJS 跑，那里不允许。
 * 顺便把失败处理写明：构建炸了要有非零退出码，否则 CI 会当它成功。
 */
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
