/*
 * 在浏览器里看一眼插件的 widget。**开发工具，不是产品的一部分。**
 *
 *     pnpm plugin && pnpm preview        # 然后开 http://127.0.0.1:4399
 *
 * ## 为什么需要它
 *
 * widget 只有在 Codex App 里才会被渲染，而那需要人发一句话。改一次版式就占用人一次
 * 点击是不可持续的（2026-08-18 连烧三次的教训）。这个命令把**同一份构建产物**和
 * **同一个数据口**（`handleApi`）摆在浏览器里，改完先自己撞过再拿去占用人的一次点击。
 *
 * ## 它和真 Codex 差在哪 —— 别把这里的绿灯当成那边的绿灯
 *
 *   - 这里没有 widget 沙箱的 CSP：真沙箱把外部源全挡死，这里不挡。
 *   - 这里的 `window.openai` 是个替身：`callTool` 直接落到本进程的 `handleApi`，
 *     真的那个走 MessageChannel 到宿主。
 *   - 真沙箱的全局是**只读**的（改 `window.setTimeout` 会当场抛），这里是可写的。
 *
 * 所以它能证的是「版式对不对、数据通不通、有没有 JS 报错」，证不了「沙箱收不收」。
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { createRepoOps } from "../src/work/repo";
import { handleApi } from "../src/plugin/api";
import { openDatabase } from "../src/plugin/sqlite-handle";

const PORT = 4399;
const PLUGIN = join(homedir(), ".codex", "plugins", "cache", "stagepass-local", "stagepass", "0.0.1");
const DB = process.env["STAGEPASS_DB"] ?? join(homedir(), ".stagepass", "panel.db");

const database = openDatabase(DB, { readOnly: true });
const deps = { database, repo: createRepoOps() };

/**
 * 桥替身。形状照着 2026-08-18 从真沙箱里读回来的那份写 ——
 * **很多键存在但值是 undefined**，那正是真桥的样子，照抄能让「键在不在」的判断
 * 在这里就撞出来。
 */
async function bridge(change: string, project: string | null): Promise<string> {
  const api: Record<string, string> = {};
  const wanted = ["/api/panel", `/api/panel?change=${change}`
    + (project === null ? "" : `&project=${project}`)];
  for (const path of wanted) {
    const answer = await handleApi(path, deps);
    if (answer.status === 200) api[path] = JSON.stringify(answer.body);
  }
  return `<script>(function(){
  var mode = "inline";
  var b = {
    callMcp: undefined, notifyIntrinsicHeight: undefined, updateWidgetState: undefined,
    notifyIntrinsicWidth: function(){}, openExternal: function(){}, setWidgetState: function(){},
    sendFollowUpMessage: function(){}, theme: "dark", locale: "zh-CN",
    maxHeight: 720, maxWidth: 736, safeArea: {insets:{top:0,right:0,bottom:0,left:0}},
    toolInput: {}, toolOutput: ${JSON.stringify({ change, project, api })},
    toolResponseMetadata: {}, widgetState: null,
    callTool: function (name, args) {
      if (name === "sp_report") return Promise.resolve({content:[{type:"text",text:"收到"}]});
      if (name === "sp_api") {
        return fetch("/preview-api?path=" + encodeURIComponent(args.path))
          .then(function (r) { return r.text(); })
          .then(function (t) { return {content:[{type:"text",text:t}]}; });
      }
      return Promise.resolve({});
    },
    requestDisplayMode: function (arg) {
      if (!(navigator.userActivation && navigator.userActivation.isActive)) {
        console.warn("Method \`requestDisplayMode\` called without synchronous user event");
        return undefined;
      }
      mode = arg && arg.mode === "fullscreen" ? "fullscreen" : "inline";
      window.dispatchEvent(new CustomEvent("openai:set_globals", {detail:{globals:{displayMode:mode}}}));
      return Promise.resolve({mode: mode});
    },
  };
  Object.defineProperty(b, "displayMode", {get: function(){return mode;}, enumerable:true});
  window.openai = b; window.webplus = b; window.oai = b;
})();` + "</" + "script>";
}

createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? "/", "http://preview.invalid");

  if (url.pathname === "/preview-api") {
    const answer = await handleApi(url.searchParams.get("path") ?? "", deps);
    response.writeHead(answer.status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(answer.body));
    return;
  }

  try {
    const html = readFileSync(join(PLUGIN, "widget", "panel-widget.html"), "utf-8");
    const change = url.searchParams.get("change") ?? "CHG-002";
    const project = url.searchParams.get("project");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html.replace("<head>", `<head>${await bridge(change, project)}`));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`读不到构建产物 —— 先跑 pnpm plugin。\n${String(error)}`);
  }
})(); }).listen(PORT, "127.0.0.1", () => {
  console.log(`预览  http://127.0.0.1:${PORT}/?change=CHG-002&project=PRJ-002`);
  console.log(`产物  ${PLUGIN.replace(homedir(), "~")}/widget/panel-widget.html`);
  console.log("这里的绿灯 ≠ Codex 沙箱的绿灯 —— 没有 CSP、全局可写、桥是替身。");
});
