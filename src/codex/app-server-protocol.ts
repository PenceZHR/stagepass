/** The small part of Codex App Server's JSONL wire contract StagePass owns. */

export type RpcId = number | string;

export interface AppServerNotification {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AppServerRequest extends AppServerNotification {
  readonly id: RpcId;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

export function parseJsonObject(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("app-server message is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}
