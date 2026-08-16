import type { IncomingMessage, ServerResponse } from "node:http";

import { isPhase } from "../domain/phase";
import type {
  NativeSeat,
  NativeSessionsPort,
} from "./native-sessions";

const BODY_LIMIT = 16 * 1024;
const ACTIONS = new Set(["open", "focus", "close-window", "end-session"]);

interface TerminalApiOptions {
  readonly sessions: NativeSessionsPort;
  readonly configFor: (
    changeId: string,
    seat: NativeSeat,
  ) => Readonly<Record<string, unknown>>;
}

class TerminalApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "TerminalApiRequestError";
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function seatOf(value: string | null): NativeSeat | null {
  if (value === "aside") return value;
  if (value === null || value === "Done" || !isPhase(value)) return null;
  return value as NativeSeat;
}

function identity(changeId: unknown, seat: unknown): {
  readonly changeId: string;
  readonly seat: NativeSeat;
} {
  if (
    typeof changeId !== "string"
    || changeId.trim() === ""
    || changeId.length > 256
    || typeof seat !== "string"
  ) throw new TerminalApiRequestError(400, "invalid_terminal_identity");
  const normalizedSeat = seatOf(seat);
  if (normalizedSeat === null) {
    throw new TerminalApiRequestError(400, "invalid_terminal_identity");
  }
  return { changeId, seat: normalizedSeat };
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > BODY_LIMIT) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    request.once("error", reject);
    request.once("end", () => {
      if (tooLarge) {
        reject(new TerminalApiRequestError(413, "terminal_request_too_large"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new TerminalApiRequestError(400, "invalid_terminal_request"));
      }
    });
  });
}

function requestIdentity(value: unknown): {
  readonly changeId: string;
  readonly seat: NativeSeat;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TerminalApiRequestError(400, "invalid_terminal_request");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "changeId" || keys[1] !== "seat") {
    throw new TerminalApiRequestError(400, "invalid_terminal_request");
  }
  return identity(record.changeId, record.seat);
}

function runtimeStatus(code: string): number {
  if (code === "tmux_unavailable" || code === "terminal_automation_denied") return 503;
  if (
    code === "terminal_window_ambiguous"
    || code === "turn_busy"
    || code === "thread_unavailable"
    || code === "project_path_missing"
  ) return 409;
  if (code === "no_such_change") return 404;
  if (code.startsWith("invalid_")) return 400;
  return 500;
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "terminal_operation_failed";
  }
  return typeof error.code === "string" ? error.code : "terminal_operation_failed";
}

/** Own only normalized native-terminal lifecycle routes; no terminal bytes cross here. */
export async function serveTerminalApi(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: TerminalApiOptions,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/terminal/")) return false;
  try {
    if (url.pathname === "/api/terminal/status") {
      if (request.method !== "GET") {
        json(response, 405, { code: "method_not_allowed" });
        return true;
      }
      const target = identity(
        url.searchParams.get("change"),
        url.searchParams.get("seat"),
      );
      json(response, 200, await options.sessions.status(target.changeId, target.seat));
      return true;
    }

    const action = url.pathname.slice("/api/terminal/".length);
    if (!ACTIONS.has(action)) {
      json(response, 404, { code: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      json(response, 405, { code: "method_not_allowed" });
      return true;
    }
    const target = requestIdentity(await readBody(request));
    if (action === "open") {
      const config = options.configFor(target.changeId, target.seat);
      json(response, 200, await options.sessions.open(
        target.changeId,
        target.seat,
        config,
        { showTerminal: true },
      ));
    } else if (action === "focus") {
      json(response, 200, await options.sessions.focus(target.changeId, target.seat));
    } else if (action === "close-window") {
      json(response, 200, await options.sessions.closeWindow(target.changeId, target.seat));
    } else {
      json(response, 200, await options.sessions.endSession(target.changeId, target.seat));
    }
    return true;
  } catch (error) {
    if (error instanceof TerminalApiRequestError) {
      json(response, error.status, { code: error.code });
      return true;
    }
    const code = errorCode(error);
    json(response, runtimeStatus(code), { code });
    return true;
  }
}
