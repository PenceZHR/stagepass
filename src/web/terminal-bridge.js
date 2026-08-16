/**
 * Browser controller for a native Terminal.app view of one StagePass seat.
 * It exchanges lifecycle state only: terminal bytes, keyboard input, approval,
 * and MCP interaction remain entirely inside the official Codex TUI.
 */

const ERROR_WORDS = {
  terminal_automation_denied:
    "终端自动化权限尚未允许。请在系统设置中允许 StagePass 控制 Terminal。",
  terminal_window_ambiguous:
    "没有安全定位到唯一的 StagePass 终端窗口；未执行任何关闭操作。",
  thread_unavailable: "Codex 会话暂不可用，绑定已保留；恢复连接后可以继续。",
  project_path_missing: "这个 Change 没有可运行的项目路径。",
  turn_busy: "原生 Codex 正在处理上一条输入，请在 Terminal 中查看。",
  terminal_operation_failed: "系统终端操作失败，请稍后重试。",
};

const wordsForError = (code) => ERROR_WORDS[code] ?? `系统终端操作失败：${code}`;

function body(changeId, seat) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changeId, seat }),
  };
}

async function statusFrom(response) {
  const result = await response.json();
  if (!response.ok) {
    const code = typeof result?.code === "string"
      ? result.code
      : "terminal_operation_failed";
    throw new Error(code);
  }
  return result;
}

/**
 * @param {{
 *   changeId: string;
 *   seat: string;
 *   primary: HTMLButtonElement;
 *   closeWindow: HTMLButtonElement;
 *   summary: HTMLElement;
 *   fetchImpl?: typeof fetch;
 *   pollMs?: number;
 *   setIntervalImpl?: typeof setInterval;
 *   clearIntervalImpl?: typeof clearInterval;
 * }} options
 */
export function createTerminalBridge(options) {
  const {
    changeId,
    seat,
    primary,
    closeWindow,
    summary,
    fetchImpl = fetch,
    pollMs = 2_000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = options;
  let current = null;
  let poll = null;
  let closed = false;
  let busy = false;
  let unavailable = false;

  const setBusy = (value) => {
    busy = value;
    primary.setAttribute("aria-busy", String(value));
    primary.disabled = value || unavailable;
    closeWindow.disabled = value || unavailable;
  };

  const render = (status) => {
    current = status;
    unavailable = status.terminal === "unavailable" || status.thread === "unavailable";
    closeWindow.hidden = status.terminal !== "open";
    if (unavailable) {
      primary.textContent = "原生终端暂不可用";
      primary.disabled = true;
      summary.textContent = status.thread === "unavailable"
        ? ERROR_WORDS.thread_unavailable
        : ERROR_WORDS.terminal_automation_denied;
      summary.setAttribute("data-state", "unavailable");
      return;
    }
    closeWindow.disabled = busy;
    primary.disabled = busy;
    summary.setAttribute("data-state", status.thread === "running" ? "running" : "ready");
    if (status.action === "focus") {
      primary.textContent = "聚焦系统终端";
      summary.textContent = status.thread === "running"
        ? "官方 Codex TUI 正在系统终端中运行。输入、审批、MCP 与 Ctrl+C 都在那里完成。"
        : "官方 Codex TUI 已在系统终端中打开；这里仅负责定位窗口。";
    } else if (status.action === "resume") {
      primary.textContent = "恢复系统终端";
      summary.textContent = "终端客户端已关闭或退出；恢复后会回到同一个 Codex 线程。";
    } else {
      primary.textContent = "打开系统终端";
      summary.textContent = "将在 macOS Terminal 中打开官方 Codex TUI；浏览器不会接收或重绘终端内容。";
    }
  };

  const showError = (error) => {
    const code = error instanceof Error ? error.message : "terminal_operation_failed";
    summary.textContent = wordsForError(code);
    summary.setAttribute("data-state", "error");
  };

  const ensurePolling = () => {
    if (poll !== null || closed) return;
    poll = setIntervalImpl(() => { void refresh(); }, pollMs);
  };

  const refresh = async () => {
    if (closed) return;
    try {
      const query = new URLSearchParams({ change: changeId, seat });
      render(await statusFrom(await fetchImpl(`/api/terminal/status?${query}`)));
    } catch (error) {
      showError(error);
    } finally {
      ensurePolling();
    }
  };

  const act = async (action) => {
    if (closed || busy) return;
    setBusy(true);
    try {
      render(await statusFrom(await fetchImpl(
        `/api/terminal/${action}`,
        body(changeId, seat),
      )));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const openOrFocus = async () => {
    if (current === null) await refresh();
    if (current === null) return;
    await act(current.action === "focus" ? "focus" : "open");
  };
  const closeNativeWindow = () => { void act("close-window"); };

  primary.addEventListener("click", openOrFocus);
  closeWindow.addEventListener("click", closeNativeWindow);

  return {
    refresh,
    openOrFocus,
    close() {
      if (closed) return;
      closed = true;
      if (poll !== null) clearIntervalImpl(poll);
      poll = null;
      primary.removeEventListener("click", openOrFocus);
      closeWindow.removeEventListener("click", closeNativeWindow);
    },
  };
}
