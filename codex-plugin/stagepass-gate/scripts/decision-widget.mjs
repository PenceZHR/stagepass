/**
 * The gate decision card's UI.
 *
 * `present_stagepass_interaction` used to return JSON and tell the model to
 * "show these options to the human". The model reported 「决策卡已展示」 and the
 * human saw nothing clickable, because there was no card -- the authenticated
 * path had no UI and the path with a UI (`stagepass-card`) had no
 * authentication. This closes that: the decision the server opened is the
 * decision the human clicks.
 *
 * Kept as a template string rather than a file the plugin reads at runtime, for
 * the reason this plugin exists at all -- an asset that can drift from the
 * server it speaks for will.
 */
export const GATE_DECISION_UI_URI = "ui://stagepass/gate-decision-v1";
export const GATE_DECISION_UI_MIME = "text/html;profile=mcp-app";

export const gateDecisionWidgetHtml = `<!doctype html>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 14px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  .summary { margin: 0 0 12px; opacity: .75; font-size: 13px; }
  .blockers { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px;
    background: color-mix(in srgb, currentColor 8%, transparent); font-size: 13px; }
  .blockers ul { margin: 6px 0 0; padding-left: 18px; }
  .options { display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
    background: color-mix(in srgb, currentColor 6%, transparent); color: inherit;
  }
  button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 14%, transparent); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .why { display: block; font-size: 11px; opacity: .7; margin-top: 2px; }
  #status { margin-top: 12px; font-size: 13px; min-height: 1.4em; }
  #status[data-state="error"] { color: #d33; }
  #status[data-state="success"] { color: #197f4a; }
</style>
<h1 id="title">StagePass 决策</h1>
<p class="summary" id="summary"></p>
<div class="blockers" id="blockers" hidden></div>
<div class="options" id="options"></div>
<p id="status"></p>
<script>
(function () {
  var decision = null;
  var busy = false;
  var nextRequestId = 1;
  var pending = new Map();

  function request(method, params) {
    var id = nextRequestId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error(method + "_timeout"));
      }, 15000);
      pending.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      });
      window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    });
  }

  function callTool(name, args) {
    if (window.openai && typeof window.openai.callTool === "function") {
      return Promise.resolve(window.openai.callTool(name, args));
    }
    return request("tools/call", { name: name, arguments: args });
  }

  function setStatus(text, state) {
    var el = document.getElementById("status");
    el.textContent = text;
    el.dataset.state = state || "";
  }

  function persist(state) {
    if (!window.openai || typeof window.openai.setWidgetState !== "function") return;
    window.openai.setWidgetState({
      modelContent: state === "recorded"
        ? "The human recorded a StagePass gate decision."
        : "The StagePass gate decision is still open.",
      privateContent: { interactionId: decision && decision.interactionId, status: state }
    });
  }

  function render(payload) {
    if (!payload) return;
    decision = payload;
    document.getElementById("title").textContent = payload.title || "StagePass 决策";
    document.getElementById("summary").textContent = payload.summary || "";

    var blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
    var blockerBox = document.getElementById("blockers");
    if (blockers.length > 0) {
      blockerBox.hidden = false;
      blockerBox.innerHTML = "<strong>阻断项 " + blockers.length + " 条</strong><ul>"
        + blockers.map(function (b) {
            var t = (b && (b.title || b.id)) || "";
            return "<li>" + String(t).replace(/[<>&]/g, "") + "</li>";
          }).join("")
        + "</ul>";
    } else {
      blockerBox.hidden = true;
    }

    var options = Array.isArray(payload.options) ? payload.options : [];
    var box = document.getElementById("options");
    box.textContent = "";
    if (options.length === 0) {
      setStatus("这个决定当前没有可选项。", "error");
      return;
    }
    options.forEach(function (option) {
      var button = document.createElement("button");
      button.textContent = option.label || option.actionId;
      button.disabled = option.available === false || busy;
      button.dataset.actionId = option.actionId;
      if (option.available === false) {
        var why = document.createElement("span");
        why.className = "why";
        why.textContent = option.unavailableBecause || "当前不可用";
        button.appendChild(why);
      }
      button.addEventListener("click", function () { submit(option.actionId); });
      box.appendChild(button);
    });
    setStatus("请选择。", "");
  }

  function setBusy(value) {
    busy = value;
    [].forEach.call(document.querySelectorAll("#options button"), function (b) {
      b.disabled = value || b.dataset.disabledByContract === "1";
    });
  }

  async function submit(actionId) {
    if (!decision || busy) return;
    setBusy(true);
    setStatus("正在提交…", "");
    try {
      var result = await callTool("record_stagepass_gate_decision", {
        interactionId: decision.interactionId,
        actionId: actionId
      });
      // Carry the tool's own reason. A generic failure here is indistinguishable
      // from every other one, and the reason is usually the contract refusing --
      // which retrying cannot change.
      if (result && result.isError) {
        var content = Array.isArray(result.content) ? result.content : [];
        var detail = "";
        for (var i = 0; i < content.length; i += 1) {
          if (content[i] && typeof content[i].text === "string") { detail = content[i].text; break; }
        }
        throw new Error(detail || "record_failed");
      }
      persist("recorded");
      setStatus("已生效：决定已记录。", "success");
    } catch (error) {
      persist("open");
      setStatus("提交失败：" + ((error && error.message) || "unknown"), "error");
      setBusy(false);
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      var entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      render(message.params && message.params.structuredContent);
    }
  });

  if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
})();
</script>`;
