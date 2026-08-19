/*
 * 装在面板前面的一层 —— Codex widget 沙箱和浏览器差在三件事上，这里把差的补上。
 *
 *   1. **没有网络**：外部源全被 CSP 挡死（`fetch https` / `img https` /
 *      `fetch localhost` 实测全 ✗）。所以 `fetch("/api/…")` 改道走
 *      `window.openai.callTool("sp_api")`，由插件进程直接读库回答。
 *   2. **全屏要手势**：`requestDisplayMode` 的 shim 源码（实测读回来的）是
 *      `(...s)=>Gr()?pn(o,n,s):console.warn("… without synchronous user event")`。
 *      必须在真点击的处理器里**同步**调，onload 调必然无效。
 *   3. **没人看得见**：widget 里出了错，屏幕上是白的，控制台在宿主进程里。
 *      所以自检结果自己 `callTool("sp_report")` 发回插件，落进 `report.log`。
 *
 * ## 为什么写成「黑匣子」
 *
 * 2026-08-18 有一版一条报告都发不出来 —— 那版改写了 `window.setTimeout`，而沙箱的
 * 全局是只读的，整个脚本第一行就抛。当时的结构是「攒齐了再发」，死在半路等于什么
 * 都不知道。现在：**第一件事就发一次**，之后每步各自 try，炸了就地再发并带上是哪步。
 */
(function () {
  var R = {
    at: new Date().toISOString(),
    stage: "start",
    done: [],
    errors: [],
    apiCalls: [],
  };
  window.__SP_REPORT__ = R;

  var bridge = null;
  try { bridge = window.openai || null; } catch (e) { R.errors.push({ step: "bridge", msg: String(e) }); }
  var realFetch = window.fetch.bind(window);

  /** 发报告。**它自己绝对不许抛** —— 它是唯一的出口。 */
  function post(tag) {
    try {
      R.viewport = window.innerWidth + "x" + window.innerHeight;
      R.mode = bridge ? bridge.displayMode : null;
      if (bridge && typeof bridge.callTool === "function") {
        bridge.callTool("sp_report", { tag: tag, report: R });
      }
    } catch (e) { /* 报告发不出去也不能拖垮面板 */ }
  }

  /** 一步一步走，谁炸了就地报，不连坐。 */
  function step(name, fn) {
    R.stage = name;
    try { fn(); R.done.push(name); }
    catch (e) {
      R.errors.push({ step: name, msg: String((e && e.message) || e).slice(0, 200) });
      post("err:" + name);
    }
  }

  post("boot");                       /* ← 第一件事。后面全炸也知道到过这儿 */

  /* ---- 起始状态：项目和 Change 由插件按 Codex 的工作目录定 ------------------ */
  step("handoff", function () {
    var out = (bridge && bridge.toolOutput) || {};
    if (out.change) window.__SP_CHANGE__ = out.change;
    if (out.project) window.__SP_PROJECT__ = out.project;
    window.__SP_COLLAPSED__ = true;   // ~700px 的框里，大环独占才看得清
    R.change = out.change || null;
    R.project = out.project || null;
    R.projectName = out.projectName || null;
  });

  /* ---- 数据：预取优先，其余走 callTool ------------------------------------- */
  step("fetch", function () {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      if (url.indexOf("/api/") < 0) return realFetch(input, init);
      var method = (init && init.method) || "GET";
      var body = (init && typeof init.body === "string") ? init.body : "";
      var record = { url: url.slice(0, 100), method: method, via: "?" };
      R.apiCalls.push(record);
      if (R.apiCalls.length > 25) R.apiCalls.shift();

      /*
       * **只有 GET 能吃预取。** POST 是动作，拿一份预先算好的答案回去等于
       * 「点了但什么都没发生，界面却显示成功了」—— 比报错坏得多。
       */
      var ready = method === "GET" ? prefetched(url) : undefined;
      if (ready !== undefined) {
        record.via = "预取"; record.bytes = ready.length;
        return Promise.resolve(reply(ready));
      }
      if (!bridge || typeof bridge.callTool !== "function") {
        record.via = "无桥";
        return Promise.resolve(new Response("{}", { status: 503 }));
      }
      return Promise.resolve(
        bridge.callTool("sp_api", { path: url, method: method, body: body })
      ).then(function (result) {
        record.via = "callTool";
        var text = textOf(result);
        record.bytes = text.length;
        return reply(text);
      }, function (error) {
        record.via = "callTool✗ " + String(error).slice(0, 40);
        return new Response("{}", { status: 503 });
      });
    };
  });

  /**
   * **只认完全相同的 URL。**
   *
   * 原来这里会退一步去掉 query 再匹配 —— 于是
   * `/api/panel?change=CHG-002&project=PRJ-001` 被预取里那条不带参数的
   * `/api/panel` 顶掉，人点了项目却拿到「全部项目」那份：界面变了、内容是错的。
   * 宁可回落到 callTool 去问插件，也不许发一份形似的。
   */
  function prefetched(url) {
    try {
      var api = bridge && bridge.toolOutput && bridge.toolOutput.api;
      return api ? api[url] : undefined;
    } catch (e) { return undefined; }
  }
  function textOf(result) {
    try {
      if (typeof result === "string") return result;
      if (result && result.content && result.content[0]) return result.content[0].text || "{}";
      return JSON.stringify(result);
    } catch (e) { return "{}"; }
  }
  function reply(text) {
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }

  /* ---- 全屏 ---------------------------------------------------------------
   * Codex 的「全屏」是把 widget 提升成右侧面板的一个标签页（实测 ~657×644，可拖宽），
   * 不是铺满整窗。但那正是它从对话流里独立出来、能长期摆着的形态。 */
  function requestFullscreen() {
    if (!bridge || typeof bridge.requestDisplayMode !== "function") return;
    try {
      var got = bridge.requestDisplayMode({ mode: "fullscreen" });
      if (got && typeof got.then === "function") got.then(paint, paint);
    } catch (e) {
      R.errors.push({ step: "fullscreen", msg: String(e && e.message) });
    }
    paint();
  }

  /* ---- 那颗按钮 ------------------------------------------------------------ */
  var pill = null;
  function paint() {
    try {
      if (pill === null || !pill.isConnected) {
        pill = document.createElement("button");
        pill.textContent = "⤢ 独立打开";
        pill.setAttribute("style", "position:fixed;top:10px;right:12px;z-index:2147483647;"
          + "font:600 12px/1 ui-monospace,Menlo,monospace;background:#f0c674;color:#241f16;"
          + "border:0;border-radius:999px;padding:8px 14px;cursor:pointer;box-shadow:0 2px 10px #0008");
        pill.onclick = function (event) { event.stopPropagation(); requestFullscreen(); };
        document.body.appendChild(pill);
      }
      var mode = bridge ? bridge.displayMode : null;
      pill.style.display = mode === "fullscreen" ? "none" : "";
      document.documentElement.classList.toggle("sp-fullscreen", mode === "fullscreen");
    } catch (e) { /* 画不出按钮不该拖垮面板 */ }
  }

  step("chrome", function () {
    paint();
    window.addEventListener("openai:set_globals", paint);
    window.addEventListener("error", function (event) {
      R.errors.push({ kind: "error", msg: String(event.message).slice(0, 200), line: event.lineno });
      post("error");
    }, true);
  });

  step("report", function () {
    setTimeout(function () {
      R.canvases = document.querySelectorAll("canvas").length;
      R.domNodes = document.querySelectorAll("*").length;
      post("ready");
    }, 1200);
  });

  });

  R.stage = "ready";
})();
