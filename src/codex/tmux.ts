import { createHash } from "node:crypto";

import {
  createProcessOps,
  type ProcessOps,
  type ProcessResult,
} from "../system/process";

export interface TmuxIdentity {
  readonly changeId: string;
  readonly seat: string;
}

export interface TmuxSession {
  readonly name: string;
  readonly marker: string;
}

export interface TmuxOps {
  version(): Promise<string>;
  status(identity: TmuxIdentity): Promise<"absent" | "detached" | "attached">;
  ensureSession(identity: TmuxIdentity, threadId: string, cwd: string): Promise<TmuxSession>;
  submit(sessionName: string, envelope: string): Promise<void>;
  detach(sessionName: string): Promise<void>;
  endSession(sessionName: string): Promise<void>;
}

interface TmuxOptions {
  readonly process?: ProcessOps;
  readonly command?: string;
}

type TmuxErrorCode =
  | "tmux_unavailable"
  | "tmux_command_failed"
  | "invalid_thread_id";

export class TmuxError extends Error {
  constructor(readonly code: TmuxErrorCode, message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

const SESSION_NAME = /^sp_[0-9a-f]{20}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tmuxSessionName(changeId: string, seat: string): string {
  const suffix = createHash("sha256")
    .update(changeId)
    .update("\0")
    .update(seat)
    .digest("hex")
    .slice(0, 20);
  return `sp_${suffix}`;
}

export function posixShellArg(value: string): string {
  if (value.includes("\0")) throw new Error("shell argument must not contain NUL bytes");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

class ConcreteTmuxOps implements TmuxOps {
  readonly #process: ProcessOps;
  readonly #command: string;
  readonly #creating = new Map<string, Promise<TmuxSession>>();

  constructor(options: TmuxOptions) {
    this.#process = options.process ?? createProcessOps();
    this.#command = options.command ?? "tmux";
  }

  async version(): Promise<string> {
    const response = await this.#invoke(["-V"]);
    if (response.code !== 0) {
      throw new TmuxError("tmux_unavailable", "tmux is installed but did not report its version");
    }
    return response.stdout.trim();
  }

  async status(identity: TmuxIdentity): Promise<"absent" | "detached" | "attached"> {
    return this.#statusByName(tmuxSessionName(identity.changeId, identity.seat));
  }

  async ensureSession(
    identity: TmuxIdentity,
    threadId: string,
    cwd: string,
  ): Promise<TmuxSession> {
    if (!THREAD_ID.test(threadId)) {
      throw new TmuxError("invalid_thread_id", "Codex thread id must be a UUID");
    }
    const name = tmuxSessionName(identity.changeId, identity.seat);
    const inFlight = this.#creating.get(name);
    if (inFlight !== undefined) return inFlight;

    const creation = this.#createIfMissing(name, threadId, cwd);
    this.#creating.set(name, creation);
    try {
      return await creation;
    } finally {
      if (this.#creating.get(name) === creation) this.#creating.delete(name);
    }
  }

  async submit(sessionName: string, envelope: string): Promise<void> {
    this.#validateSessionName(sessionName);
    await this.#expectSuccess(
      ["load-buffer", "-b", "sp_input", "-"],
      envelope,
    );
    await this.#expectSuccess([
      "paste-buffer", "-d", "-b", "sp_input", "-t", sessionName,
    ]);
    await this.#expectSuccess(["send-keys", "-t", sessionName, "Enter"]);
  }

  async detach(sessionName: string): Promise<void> {
    this.#validateSessionName(sessionName);
    await this.#expectSuccess(["detach-client", "-s", sessionName]);
  }

  async endSession(sessionName: string): Promise<void> {
    this.#validateSessionName(sessionName);
    await this.#expectSuccess(["kill-session", "-t", sessionName]);
  }

  async #createIfMissing(name: string, threadId: string, cwd: string): Promise<TmuxSession> {
    if (await this.#statusByName(name) === "absent") {
      // tmux documents that new-session accepts cwd as its own argv and a
      // shell-command separately. Only the UUID enters that shell command.
      // Source: local tmux(1), new-session and shell-command sections.
      const shellCommand = [
        "exec codex resume --remote unix://",
        posixShellArg(threadId),
      ].join(" ");
      await this.#expectSuccess([
        "new-session", "-d", "-s", name, "-c", cwd, shellCommand,
      ]);
    }
    return { name, marker: `STAGEPASS:${name}` };
  }

  async #statusByName(name: string): Promise<"absent" | "detached" | "attached"> {
    this.#validateSessionName(name);
    const present = await this.#invoke(["has-session", "-t", name]);
    if (present.code === 1) return "absent";
    if (present.code !== 0) this.#commandFailed("has-session");

    const clients = await this.#invoke([
      "list-clients", "-t", name, "-F", "#{client_name}",
    ]);
    if (clients.code !== 0) this.#commandFailed("list-clients");
    return clients.stdout.trim() === "" ? "detached" : "attached";
  }

  async #expectSuccess(args: readonly string[], input?: string): Promise<void> {
    const response = await this.#invoke(args, input);
    if (response.code !== 0) this.#commandFailed(args[0] ?? "unknown");
  }

  async #invoke(args: readonly string[], input?: string): Promise<ProcessResult> {
    try {
      return await this.#process.run({
        command: this.#command,
        args,
        ...(input === undefined ? {} : { input }),
      });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        throw new TmuxError("tmux_unavailable", "tmux executable is unavailable");
      }
      throw new TmuxError("tmux_command_failed", "tmux command could not be started");
    }
  }

  #validateSessionName(sessionName: string): void {
    if (!SESSION_NAME.test(sessionName)) this.#commandFailed("invalid-session-name");
  }

  #commandFailed(action: string): never {
    throw new TmuxError("tmux_command_failed", `tmux ${action} failed`);
  }
}

export function createTmuxOps(options: TmuxOptions = {}): TmuxOps {
  return new ConcreteTmuxOps(options);
}
