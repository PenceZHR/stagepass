import type { IncomingMessage, ServerResponse } from "node:http";

import { AppServerSessionError } from "../codex/app-server-session";
import type { StreamEvent, StreamSnapshot } from "../codex/stream-state";
import { isPhase, type Phase } from "../domain/phase";

const BODY_LIMIT = 64 * 1024;

export type CodexStreamSeat = Exclude<Phase, "Done"> | "aside";

/** The App Server accepted the turn, but StagePass could not make its seat durable. */
class ThreadBindingAfterTurnStartError extends Error {
  readonly code = "thread_binding_failed_after_turn_start" as const;

  constructor(
    readonly changeId: string,
    readonly seat: string,
    readonly threadId: string,
    readonly turnId: string,
  ) {
    super(
      `turn ${turnId} started on thread ${threadId} for ${changeId}/${seat}, `
      + "but StagePass could not persist its binding",
    );
    this.name = "ThreadBindingAfterTurnStartError";
  }
}

export interface CodexStreamPort {
  open(
    changeId: string,
    seat: CodexStreamSeat,
    options?: { readonly config?: Readonly<Record<string, unknown>> },
  ): Promise<{ snapshot(): StreamSnapshot }>;
  snapshot(changeId: string, seat: CodexStreamSeat): StreamSnapshot;
  eventsAfter(
    changeId: string,
    seat: CodexStreamSeat,
    seq: number,
  ): readonly StreamEvent[] | null;
  subscribe(
    changeId: string,
    seat: CodexStreamSeat,
    listener: (event: StreamEvent) => void,
  ): () => void;
  startTurn(changeId: string, seat: CodexStreamSeat, prompt: string): Promise<string>;
  steer(
    changeId: string,
    seat: CodexStreamSeat,
    direction: string,
    expectedTurnId: string,
  ): Promise<void>;
  interrupt(changeId: string, seat: CodexStreamSeat, turnId: string): Promise<void>;
  respond(
    changeId: string,
    seat: CodexStreamSeat,
    interactionId: string,
    response: unknown,
  ): Promise<void>;
}

interface CodexStreamApiOptions {
  readonly streams: CodexStreamPort;
  readonly configFor: (
    changeId: string,
    seat: CodexStreamSeat,
  ) => Readonly<Record<string, unknown>>;
}

class StreamApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StreamApiError";
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function errorStatus(error: unknown): number {
  if (error instanceof StreamApiError) return error.status;
  const streamCode = streamSessionCode(error);
  if (streamCode !== null) {
    if (streamCode === "no_such_change") return 404;
    if (streamCode === "project_path_missing") return 409;
    if (streamCode === "session_not_open") return 409;
    return 400;
  }
  if (error instanceof AppServerSessionError) {
    if (
      error.code === "turn_busy"
      || error.code === "stale_turn"
      || error.code === "no_active_turn"
      || error.code === "interaction_already_resolved"
    ) return 409;
    if (error.code === "interaction_missing") return 404;
    return 400;
  }
  return 500;
}

function errorCode(error: unknown): string {
  if (
    error instanceof StreamApiError
    || error instanceof AppServerSessionError
    || error instanceof ThreadBindingAfterTurnStartError
  ) {
    return error.code;
  }
  const streamCode = streamSessionCode(error);
  if (streamCode !== null) return streamCode;
  return "codex_stream_failed";
}

function streamSessionCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "StreamSessionError") return null;
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Codex stream request failed";
}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Readonly<Record<string, unknown>>> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    throw new StreamApiError("body_too_large", 413, "request body is too large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) {
      throw new StreamApiError("body_too_large", 413, "request body is too large");
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StreamApiError("invalid_json", 400, "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StreamApiError("invalid_json", 400, "request body must be a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requiredString(
  body: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new StreamApiError("invalid_request", 400, `${key} is required`);
  }
  return value;
}

function seatFrom(value: unknown): CodexStreamSeat {
  if (
    typeof value !== "string"
    || (value !== "aside" && (!isPhase(value) || value === "Done"))
  ) {
    throw new StreamApiError("invalid_seat", 400, "seat is not a streamable phase or aside");
  }
  return value;
}

function queryIdentity(url: URL): { changeId: string; seat: CodexStreamSeat } {
  const changeId = url.searchParams.get("change") ?? "";
  if (changeId === "") {
    throw new StreamApiError("invalid_request", 400, "change is required");
  }
  return { changeId, seat: seatFrom(url.searchParams.get("seat")) };
}

function bodyIdentity(body: Readonly<Record<string, unknown>>): {
  changeId: string;
  seat: CodexStreamSeat;
} {
  return {
    changeId: requiredString(body, "changeId"),
    seat: seatFrom(body.seat),
  };
}

function sseFrame(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function serveEvents(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: CodexStreamApiOptions,
): void {
  const { changeId, seat } = queryIdentity(url);
  const rawAfter = request.headers["last-event-id"]
    ?? url.searchParams.get("after")
    ?? "0";
  const after = Number(rawAfter);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StreamApiError("invalid_event_id", 400, "Last-Event-ID must be a non-negative integer");
  }
  const replay = options.streams.eventsAfter(changeId, seat, after);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  if (replay === null) {
    response.end(
      "event: snapshot.required\n"
      + `data: ${JSON.stringify({ reason: "replay_gap" })}\n\n`,
    );
    return;
  }
  for (const event of replay) response.write(sseFrame(event));
  const unsubscribe = options.streams.subscribe(
    changeId,
    seat,
    (event) => response.write(sseFrame(event)),
  );
  response.once("close", unsubscribe);
}

async function serveWrite(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: CodexStreamApiOptions,
): Promise<void> {
  const body = await readJsonObject(request);
  const { changeId, seat } = bodyIdentity(body);
  if (path === "/api/codex/open") {
    const session = await options.streams.open(changeId, seat, {
      config: options.configFor(changeId, seat),
    });
    sendJson(response, 200, session.snapshot());
    return;
  }
  if (path === "/api/codex/turn") {
    const turnId = await options.streams.startTurn(
      changeId,
      seat,
      requiredString(body, "prompt"),
    );
    sendJson(response, 200, { turnId });
    return;
  }
  if (path === "/api/codex/steer") {
    await options.streams.steer(
      changeId,
      seat,
      requiredString(body, "direction"),
      requiredString(body, "expectedTurnId"),
    );
    sendJson(response, 200, { steered: true });
    return;
  }
  if (path === "/api/codex/interrupt") {
    await options.streams.interrupt(
      changeId,
      seat,
      requiredString(body, "turnId"),
    );
    sendJson(response, 200, { interrupted: true });
    return;
  }
  if (path === "/api/codex/respond") {
    if (!("response" in body)) {
      throw new StreamApiError("invalid_request", 400, "response is required");
    }
    await options.streams.respond(
      changeId,
      seat,
      requiredString(body, "interactionId"),
      body.response,
    );
    sendJson(response, 200, { responded: true });
  }
}

/** Handle only `/api/codex/*`; false means this module does not own the path. */
export async function serveCodexStreamApi(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: CodexStreamApiOptions,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/codex/")) return false;
  try {
    if (url.pathname === "/api/codex/snapshot" && request.method === "GET") {
      const { changeId, seat } = queryIdentity(url);
      sendJson(response, 200, options.streams.snapshot(changeId, seat));
      return true;
    }
    if (url.pathname === "/api/codex/events" && request.method === "GET") {
      serveEvents(request, response, url, options);
      return true;
    }
    if (request.method === "POST" && [
      "/api/codex/open",
      "/api/codex/turn",
      "/api/codex/steer",
      "/api/codex/interrupt",
      "/api/codex/respond",
    ].includes(url.pathname)) {
      await serveWrite(url.pathname, request, response, options);
      return true;
    }
    sendJson(response, 404, { code: "not_found", message: "unknown Codex stream endpoint" });
    return true;
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return true;
    }
    sendJson(response, errorStatus(error), {
      code: errorCode(error),
      message: publicMessage(error),
    });
    return true;
  }
}
