import { createHash } from "node:crypto";

import {
  createProcessOps,
  type ProcessOps,
} from "./process";

export type TerminalWindowState = "closed" | "open" | "stale";

export interface TerminalTarget {
  readonly marker: string;
  readonly threadId: string;
  readonly cwd: string;
}

export interface TerminalAppOps {
  status(target: TerminalTarget): Promise<TerminalWindowState>;
  open(target: TerminalTarget, prompt?: string): Promise<"opened" | "focused" | "resumed">;
  focus(target: TerminalTarget): Promise<void>;
  submit(target: TerminalTarget, envelope: string): Promise<"submitted">;
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

const MARKER = /^STAGEPASS:sp_[0-9a-f]{20}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function terminalMarker(changeId: string, seat: string): string {
  const suffix = createHash("sha256")
    .update(changeId)
    .update("\0")
    .update(seat)
    .digest("hex")
    .slice(0, 20);
  return `STAGEPASS:sp_${suffix}`;
}

function posixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resumeCommand(target: TerminalTarget, prompt?: string): string {
  return [
    "exec codex resume -c 'tui.terminal_title=[]' --remote unix:// --cd",
    posixShellArg(target.cwd),
    posixShellArg(target.threadId),
    ...(prompt === undefined ? [] : [posixShellArg(prompt)]),
  ].join(" ");
}

/*
 * This AppleScript is fixed source. Data enters only through `on run argv`.
 * Every action discovers the opaque marker on a dedicated tab and rejects
 * duplicates before mutation. The resume command disables Codex terminal-title
 * management so its OSC output cannot overwrite the marker.
 */
const TERMINAL_SCRIPT = String.raw`
on jsonResult(actionName, matchCount, resultName)
  return "{\"action\":\"" & actionName & "\",\"matches\":" & (matchCount as string) & ",\"result\":\"" & resultName & "\"}"
end jsonResult

on run argv
  set actionName to item 1 of argv
  set markerValue to item 2 of argv
  set payloadValue to item 3 of argv

  if application "Terminal" is not running then
    if actionName is "status" then return my jsonResult(actionName, 0, "closed")
    if actionName is "close" then return my jsonResult(actionName, 0, "already_closed")
    if actionName is "focus" or actionName is "submit" then return my jsonResult(actionName, 0, "missing")
  end if

  tell application "Terminal"
    set matchCount to 0
    set markedTab to missing value
    set markedWindow to missing value

    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        if custom title of candidateTab is markerValue then
          set matchCount to matchCount + 1
          set markedWindow to candidateWindow
          set markedTab to candidateTab
        end if
      end repeat
    end repeat

    if matchCount > 1 then return my jsonResult(actionName, matchCount, "ambiguous")
    if matchCount is 1 and (count tabs of markedWindow) is not 1 then return my jsonResult(actionName, 1, "ambiguous")

    if actionName is "status" then
      if matchCount is 0 then return my jsonResult(actionName, 0, "closed")
      if (processes of markedTab) contains "codex" then return my jsonResult(actionName, 1, "open")
      return my jsonResult(actionName, 1, "stale")
    end if

    if actionName is "open" then
      if matchCount is 0 then
        set markedTab to do script payloadValue
        set custom title of markedTab to markerValue
        repeat 50 times
          if (processes of markedTab) contains "codex" then exit repeat
          delay 0.1
        end repeat
        set custom title of markedTab to markerValue
        set selected of markedTab to true
        activate
        return my jsonResult(actionName, 1, "opened")
      end if
      set selected of markedTab to true
      set frontmost of markedWindow to true
      activate
      if (processes of markedTab) contains "codex" then return my jsonResult(actionName, 1, "focused")
      close markedWindow
      set markedTab to do script payloadValue
      set custom title of markedTab to markerValue
      repeat 50 times
        if (processes of markedTab) contains "codex" then exit repeat
        delay 0.1
      end repeat
      set custom title of markedTab to markerValue
      set selected of markedTab to true
      activate
      return my jsonResult(actionName, 1, "resumed")
    end if

    if actionName is "focus" then
      if matchCount is 0 then return my jsonResult(actionName, 0, "missing")
      set selected of markedTab to true
      set frontmost of markedWindow to true
      activate
      return my jsonResult(actionName, 1, "focused")
    end if

    if actionName is "submit" then
      if matchCount is 0 then return my jsonResult(actionName, 0, "missing")
      if not ((processes of markedTab) contains "codex") then return my jsonResult(actionName, 1, "stale")
      do script payloadValue in markedTab
      delay 0.2
      do script "" in markedTab
      return my jsonResult(actionName, 1, "submitted")
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
    const response = await this.#perform("status", target, "");
    if (
      response.result === "open"
      || response.result === "closed"
      || response.result === "stale"
    ) return response.result;
    return this.#unexpected("status", response.result);
  }

  async open(
    target: TerminalTarget,
    prompt?: string,
  ): Promise<"opened" | "focused" | "resumed"> {
    this.#validateEnvelope(prompt);
    const response = await this.#perform("open", target, resumeCommand(target, prompt));
    if (
      response.result === "opened"
      || response.result === "focused"
      || response.result === "resumed"
    ) return response.result;
    return this.#unexpected("open", response.result);
  }

  async focus(target: TerminalTarget): Promise<void> {
    const response = await this.#perform("focus", target, "");
    if (response.result === "focused") return;
    if (response.result === "missing") {
      throw new TerminalAppError("terminal_window_missing", "marked Terminal window is closed");
    }
    this.#unexpected("focus", response.result);
  }

  async submit(target: TerminalTarget, envelope: string): Promise<"submitted"> {
    this.#validateEnvelope(envelope);
    const response = await this.#perform("submit", target, envelope);
    if (response.result === "submitted") return "submitted";
    if (response.result === "missing" || response.result === "stale") {
      throw new TerminalAppError(
        "terminal_window_missing",
        "marked Terminal client is not running",
      );
    }
    return this.#unexpected("submit", response.result);
  }

  async close(target: TerminalTarget): Promise<"closed" | "already_closed"> {
    const response = await this.#perform("close", target, "");
    if (response.result === "closed" || response.result === "already_closed") {
      return response.result;
    }
    return this.#unexpected("close", response.result);
  }

  async #perform(
    action: string,
    target: TerminalTarget,
    payload: string,
  ): Promise<TerminalScriptResponse> {
    this.#validate(target);
    let response;
    try {
      response = await this.#process.run({
        command: this.#command,
        args: ["-e", TERMINAL_SCRIPT, action, target.marker, payload],
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
      !MARKER.test(target.marker)
      || !THREAD_ID.test(target.threadId)
      || !target.cwd.startsWith("/")
      || /[\0\r\n]/.test(target.cwd)
    ) {
      throw new TerminalAppError(
        "invalid_terminal_target",
        "Terminal target is not a managed StagePass client",
      );
    }
  }

  #validateEnvelope(envelope: string | undefined): void {
    if (envelope !== undefined && (envelope.length === 0 || /[\0\r\n]/.test(envelope))) {
      throw new TerminalAppError(
        "invalid_terminal_target",
        "Terminal prompt envelope must be one non-empty line",
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
