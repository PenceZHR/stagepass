import {
  createProcessOps,
  type ProcessOps,
} from "./process";

export type TerminalWindowState = "closed" | "open";

export interface TerminalTarget {
  readonly marker: string;
  readonly sessionName: string;
}

export interface TerminalAppOps {
  status(target: TerminalTarget): Promise<TerminalWindowState>;
  open(target: TerminalTarget): Promise<"opened" | "focused">;
  focus(target: TerminalTarget): Promise<void>;
  close(target: TerminalTarget): Promise<"closed" | "already_closed">;
}

interface TerminalAppOptions {
  readonly process?: ProcessOps;
  readonly command?: string;
}

type TerminalAppErrorCode =
  | "terminal_automation_denied"
  | "terminal_window_ambiguous"
  | "terminal_window_missing"
  | "terminal_command_failed"
  | "invalid_terminal_target";

export class TerminalAppError extends Error {
  constructor(readonly code: TerminalAppErrorCode, message: string) {
    super(message);
    this.name = "TerminalAppError";
  }
}

const SESSION_NAME = /^sp_[0-9a-f]{20}$/;
const MARKER = /^STAGEPASS:sp_[0-9a-f]{20}$/;

/*
 * This source is fixed. Values enter only through `on run argv`; no project
 * text is interpolated into AppleScript. Each action discovers the exact
 * custom-title marker afresh, so a stale/reused macOS window id cannot be
 * acted upon. A duplicate marker returns before any mutation.
 */
const TERMINAL_SCRIPT = String.raw`
on jsonResult(actionName, matchCount, resultName)
  return "{\"action\":\"" & actionName & "\",\"matches\":" & (matchCount as string) & ",\"result\":\"" & resultName & "\"}"
end jsonResult

on run argv
  set actionName to item 1 of argv
  set markerValue to item 2 of argv
  set attachCommand to item 3 of argv

  if application "Terminal" is not running then
    if actionName is "status" then return my jsonResult(actionName, 0, "closed")
    if actionName is "close" then return my jsonResult(actionName, 0, "already_closed")
    if actionName is "focus" then return my jsonResult(actionName, 0, "missing")
  end if

  tell application "Terminal"
    set matchCount to 0
    set markedTab to missing value
    set markedWindow to missing value

    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        if custom title of candidateTab is markerValue then
          set matchCount to matchCount + 1
          set markedTab to candidateTab
          set markedWindow to candidateWindow
        end if
      end repeat
    end repeat

    if matchCount > 1 then return my jsonResult(actionName, matchCount, "ambiguous")

    if actionName is "status" then
      if matchCount is 0 then return my jsonResult(actionName, 0, "closed")
      return my jsonResult(actionName, 1, "open")
    end if

    if actionName is "open" then
      if matchCount is 0 then
        set markedTab to do script attachCommand
        set custom title of markedTab to markerValue
        set selected of markedTab to true
        activate
        return my jsonResult(actionName, 1, "opened")
      end if
      set selected of markedTab to true
      set frontmost of markedWindow to true
      activate
      return my jsonResult(actionName, 1, "focused")
    end if

    if actionName is "focus" then
      if matchCount is 0 then return my jsonResult(actionName, 0, "missing")
      set selected of markedTab to true
      set frontmost of markedWindow to true
      activate
      return my jsonResult(actionName, 1, "focused")
    end if

    if actionName is "close" then
      if matchCount is 0 then return my jsonResult(actionName, 0, "already_closed")
      if (count tabs of markedWindow) is not 1 then return my jsonResult(actionName, 1, "ambiguous")
      close markedWindow
      return my jsonResult(actionName, 1, "closed")
    end if

    return my jsonResult(actionName, matchCount, "invalid_action")
  end tell
end run
`;

interface TerminalScriptResponse {
  readonly action: string;
  readonly matches: number;
  readonly result: string;
}

function parseResponse(stdout: string, action: string): TerminalScriptResponse {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (
      typeof value !== "object"
      || value === null
      || !("action" in value)
      || value.action !== action
      || !("matches" in value)
      || !Number.isInteger(value.matches)
      || !("result" in value)
      || typeof value.result !== "string"
    ) throw new Error("invalid response shape");
    return value as TerminalScriptResponse;
  } catch {
    throw new TerminalAppError(
      "terminal_command_failed",
      "Terminal automation returned an invalid response",
    );
  }
}

class ConcreteTerminalAppOps implements TerminalAppOps {
  readonly #process: ProcessOps;
  readonly #command: string;

  constructor(options: TerminalAppOptions) {
    this.#process = options.process ?? createProcessOps();
    this.#command = options.command ?? "/usr/bin/osascript";
  }

  async status(target: TerminalTarget): Promise<TerminalWindowState> {
    const response = await this.#perform("status", target);
    if (response.result === "open" || response.result === "closed") return response.result;
    this.#unexpected("status", response.result);
  }

  async open(target: TerminalTarget): Promise<"opened" | "focused"> {
    const response = await this.#perform("open", target);
    if (response.result === "opened" || response.result === "focused") return response.result;
    this.#unexpected("open", response.result);
  }

  async focus(target: TerminalTarget): Promise<void> {
    const response = await this.#perform("focus", target);
    if (response.result === "focused") return;
    if (response.result === "missing") {
      throw new TerminalAppError("terminal_window_missing", "marked Terminal window is closed");
    }
    this.#unexpected("focus", response.result);
  }

  async close(target: TerminalTarget): Promise<"closed" | "already_closed"> {
    const response = await this.#perform("close", target);
    if (response.result === "closed" || response.result === "already_closed") {
      return response.result;
    }
    this.#unexpected("close", response.result);
  }

  async #perform(action: string, target: TerminalTarget): Promise<TerminalScriptResponse> {
    this.#validate(target);
    const attachCommand = `exec tmux attach-session -t ${target.sessionName}`;
    let response;
    try {
      response = await this.#process.run({
        command: this.#command,
        args: ["-e", TERMINAL_SCRIPT, action, target.marker, attachCommand],
      });
    } catch {
      throw new TerminalAppError(
        "terminal_command_failed",
        "Terminal automation could not be started",
      );
    }
    if (response.code !== 0) {
      if (/(?:-1743|not authorized to send apple events)/i.test(response.stderr)) {
        throw new TerminalAppError(
          "terminal_automation_denied",
          "macOS denied automation access to Terminal.app",
        );
      }
      throw new TerminalAppError("terminal_command_failed", "Terminal automation failed");
    }

    const parsed = parseResponse(response.stdout, action);
    if (parsed.matches > 1 || parsed.result === "ambiguous") {
      throw new TerminalAppError(
        "terminal_window_ambiguous",
        "more than one Terminal tab has the StagePass marker",
      );
    }
    return parsed;
  }

  #validate(target: TerminalTarget): void {
    if (
      !SESSION_NAME.test(target.sessionName)
      || !MARKER.test(target.marker)
      || target.marker !== `STAGEPASS:${target.sessionName}`
    ) {
      throw new TerminalAppError(
        "invalid_terminal_target",
        "Terminal target is not a managed StagePass session",
      );
    }
  }

  #unexpected(action: string, result: string): never {
    throw new TerminalAppError(
      "terminal_command_failed",
      `Terminal ${action} returned ${result}`,
    );
  }
}

export function createTerminalAppOps(options: TerminalAppOptions = {}): TerminalAppOps {
  return new ConcreteTerminalAppOps(options);
}
