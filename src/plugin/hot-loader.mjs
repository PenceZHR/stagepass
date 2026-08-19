/**
 * 插件的进程入口 —— **一个会热重载的壳，本身几乎没有逻辑。**
 *
 * ## 它解决的是什么
 *
 * MCP server 按会话起。于是同一台机器上会同时躺着好几个插件进程，**每个锁着它启动
 * 那一刻的代码**：2026-08-18 用户机器上一次就有三个（21:09 / 22:46 / 22:56），而他
 * 按按钮的那个不是最新的 —— 同一个已经修好的 bug 又报了两次，两次都是真的，因为
 * 跑的是旧代码。
 *
 * 「装完要开一条新会话」这条纪律**每次都会被忘掉**，而忘掉的代价是一次误导性的失败。
 * 所以别再靠纪律：每条消息进来之前比一次实现文件的 mtime，变了就换。
 *
 * ## 为什么这个文件不打包
 *
 * 它必须**动态** import 实现，而打包器会把动态 import 变成一个名字带哈希的 chunk ——
 * 那样就没有一个稳定的路径可以去 stat。所以构建把这个文件原样拷过去，
 * 实现单独打成 `impl.mjs`。
 *
 * ## 在飞的那一轮不会被打断
 *
 * 换的只是「下一条消息交给谁」。旧实例的 promise 还挂着，模块就不会被回收 ——
 * 那一轮继续跑、继续写它的账。**不去关它**：关掉等于把人正在跑的一轮打死，
 * 而那正是热重载最容易犯的错。
 */
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const IMPL = join(HERE, "impl.mjs");
const LOG = process.env["STAGEPASS_LOG"] ?? join(HERE, "plugin.log");

/** 和实现写同一个日志：排障时「换了代码」和「跑了什么」要在一条时间线上。 */
function note(what) {
  try {
    appendFileSync(LOG, `!! ${JSON.stringify(what)}\n`);
  } catch { /* 日志不是功能 */ }
}

let loaded = null;
let stamp = 0;

/** 拿到当前该用的实现。文件变了就换一份，**换不成就继续用旧的**。 */
async function impl() {
  let now = 0;
  try {
    now = statSync(IMPL).mtimeMs;
  } catch {
    // 实现文件读不到（构建正写到一半？）—— 手上有旧的就接着用。
    if (loaded !== null) return loaded;
    throw new Error(`插件的实现文件不在：${IMPL}`);
  }
  if (loaded !== null && now === stamp) return loaded;

  try {
    // 查询串是给 ESM 缓存看的：同一个路径带不同的串就是另一个模块。
    const fresh = await import(`${new URL("impl.mjs", import.meta.url).href}?v=${now}`);
    loaded = fresh;
    stamp = now;
    note({ hotReload: new Date(now).toISOString() });
  } catch (error) {
    /*
     * **换不成就继续用旧的。** 半个构建、语法错、依赖缺失都会走到这里 ——
     * 而那时把整个 server 拖垮，比「还在跑上一版」糟得多。
     */
    note({ hotReloadFailed: String(error).slice(0, 300) });
    if (loaded === null) throw error;
  }
  return loaded;
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let cut = buffer.indexOf("\n");
  while (cut >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line !== "") {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch (error) {
        note({ parse: String(error).slice(0, 200) });
      }
      if (message !== null) {
        void impl()
          .then((module) => { module.handle(message); })
          .catch((error) => { note({ handle: String(error).slice(0, 300) }); });
      }
    }
    cut = buffer.indexOf("\n");
  }
});
