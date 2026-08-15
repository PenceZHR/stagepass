import type Database from "better-sqlite3";

import {
  archiveFinished,
  type ArchiveOps,
} from "../codex/archive";
import type { AppServerSessionOptions } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import {
  NativeTuiCodexTransport,
  type NativeTuiTurnPort,
} from "../codex/native-tui-session";
import type { PromptFiles } from "../codex/prompt-file";
import {
  tmuxSessionName,
  type TmuxIdentity,
  type TmuxOps,
} from "../codex/tmux";
import type { CodexTransport } from "../codex/transport";
import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import {
  BindingStore,
  type BoundThread,
} from "../store/binding-store";
import { ProjectStore } from "../store/project-store";
import type { TerminalAppOps, TerminalTarget } from "../system/terminal-app";
import {
  inspectBoundThread,
  prepareBoundThread,
} from "./session-recovery";

export type NativeSeat = Exclude<Phase, "Done"> | "aside";

export interface NativeSessionStatus {
  readonly changeId: string;
  readonly seat: NativeSeat;
  readonly threadId: string | null;
  readonly thread: "none" | "idle" | "running" | "archived" | "missing" | "unavailable";
  readonly tmuxSession: string;
  readonly tmux: "absent" | "detached" | "attached" | "unavailable";
  readonly terminal: "closed" | "open" | "unavailable";
  readonly action: "open" | "focus" | "reopen";
}

export interface NativeSessionsPort {
  status(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  open(
    changeId: string,
    seat: NativeSeat,
    config: Readonly<Record<string, unknown>>,
    options: { readonly showTerminal: boolean },
  ): Promise<NativeSessionStatus>;
  focus(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  closeWindow(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  endSession(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  archiveAndEnd(changeId: string, seat: NativeSeat): Promise<void>;
  releaseObserver(changeId: string, seat: NativeSeat): void;
  forget(changeId: string): Promise<void>;
  closeControlConnection(): void;
}

type NativeSessionsErrorCode =
  | "binding_failed"
  | "thread_unavailable"
  | "turn_busy"
  | "project_path_missing"
  | "session_cleanup_failed";

export class NativeSessionsError extends Error {
  constructor(readonly code: NativeSessionsErrorCode, message: string) {
    super(message);
    this.name = "NativeSessionsError";
  }
}

interface NativeSessionsOptions extends Pick<
  AppServerSessionOptions,
  "sandbox" | "approvalPolicy" | "effort" | "model"
> {
  readonly database: Database.Database;
  readonly host: AppServerSessionHost;
  readonly history: ArchiveOps;
  readonly tmux: TmuxOps;
  readonly terminal: TerminalAppOps;
  readonly promptFiles: PromptFiles;
  readonly cwdFor?: (changeId: string) => string | null;
  readonly closeControlConnection?: () => void;
}

function keyOf(changeId: string, seat: NativeSeat): string {
  return `${changeId}\0${seat}`;
}

function identityOf(changeId: string, seat: string): TmuxIdentity {
  return { changeId, seat };
}

function targetOf(changeId: string, seat: string): TerminalTarget {
  const sessionName = tmuxSessionName(changeId, seat);
  return { sessionName, marker: `STAGEPASS:${sessionName}` };
}

/** Durable seat lifecycle reconstructed from binding + App Server + tmux + marker. */
export class NativeSessions implements NativeSessionsPort {
  private readonly bindings: BindingStore;
  private readonly opening = new Map<string, Promise<NativeSessionStatus>>();
  private readonly inputLeases = new Set<string>();
  private readonly releaseWhenIdle = new Set<string>();

  constructor(private readonly options: NativeSessionsOptions) {
    this.bindings = new BindingStore(options.database);
  }

  async status(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus> {
    const identity = identityOf(changeId, seat);
    const target = targetOf(changeId, seat);
    const binding = this.bound(changeId, seat);
    const [tmux, terminal] = await Promise.all([
      this.options.tmux.status(identity).catch(() => "unavailable" as const),
      this.options.terminal.status(target).catch(() => "unavailable" as const),
    ]);

    let thread: NativeSessionStatus["thread"] = "none";
    if (binding !== null) {
      const inspected = await inspectBoundThread(binding, this.options.history);
      if (inspected.kind === "unavailable") thread = "unavailable";
      else if (inspected.kind === "missing") thread = "missing";
      else if (inspected.kind === "archived") thread = "archived";
      else {
        thread = this.options.host.session(binding.threadId)?.snapshot().activeTurnId === null
          ? "idle"
          : this.options.host.session(binding.threadId) === null
            ? "idle"
            : "running";
      }
    }
    return {
      changeId,
      seat,
      threadId: binding?.threadId ?? null,
      thread,
      tmuxSession: target.sessionName,
      tmux,
      terminal,
      action: terminal === "open"
        ? "focus"
        : tmux === "detached" || tmux === "attached"
          ? "reopen"
          : "open",
    };
  }

  open(
    changeId: string,
    seat: NativeSeat,
    config: Readonly<Record<string, unknown>>,
    options: { readonly showTerminal: boolean },
  ): Promise<NativeSessionStatus> {
    const key = keyOf(changeId, seat);
    const existing = this.opening.get(key);
    if (existing !== undefined) return existing;
    const opening = this.openOnce(changeId, seat, config, options.showTerminal);
    this.opening.set(key, opening);
    void opening.finally(() => {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }).catch(() => {});
    return opening;
  }

  async focus(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus> {
    await this.options.terminal.focus(targetOf(changeId, seat));
    return this.status(changeId, seat);
  }

  async closeWindow(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus> {
    const identity = identityOf(changeId, seat);
    const target = targetOf(changeId, seat);
    const tmux = await this.options.tmux.status(identity);
    if (tmux === "attached") await this.options.tmux.detach(target.sessionName);
    await this.options.terminal.close(target);
    return this.status(changeId, seat);
  }

  async endSession(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus> {
    const identity = identityOf(changeId, seat);
    const target = targetOf(changeId, seat);
    const tmux = await this.options.tmux.status(identity);
    if (tmux === "attached") await this.options.tmux.detach(target.sessionName);
    await this.options.terminal.close(target);
    if (tmux !== "absent") await this.options.tmux.endSession(target.sessionName);
    const binding = this.bound(changeId, seat);
    if (binding !== null) this.options.host.close(binding.threadId);
    return this.status(changeId, seat);
  }

  async archiveAndEnd(changeId: string, seat: NativeSeat): Promise<void> {
    const binding = this.bound(changeId, seat);
    if (binding === null) return;
    await this.cleanupBound(binding, seat);
  }

  releaseObserver(changeId: string, seat: NativeSeat): void {
    const key = keyOf(changeId, seat);
    if (this.inputLeases.has(key)) {
      this.releaseWhenIdle.add(key);
      return;
    }
    const binding = this.bound(changeId, seat);
    if (binding !== null) this.options.host.close(binding.threadId);
  }

  async forget(changeId: string): Promise<void> {
    const bindings = this.bindings.listBound()
      .filter((binding) => binding.changeId === changeId);
    const failures: unknown[] = [];
    for (const binding of bindings) {
      const seat = binding.kind === "aside" ? "aside" : binding.phase;
      try {
        await this.cleanupBound(binding, seat);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const key of [...this.releaseWhenIdle]) {
      if (key.startsWith(`${changeId}\0`)) this.releaseWhenIdle.delete(key);
    }
    if (failures.length > 0) {
      throw new NativeSessionsError(
        "session_cleanup_failed",
        `could not clean ${failures.length} native session(s) for ${changeId}`,
      );
    }
  }

  closeControlConnection(): void {
    this.options.host.closeAll();
    this.options.closeControlConnection?.();
  }

  transportFor(
    changeId: string,
    seat: NativeSeat,
    config: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): CodexTransport {
    return {
      runTurn: async (dispatch) => {
        const key = keyOf(changeId, seat);
        if (this.inputLeases.has(key)) {
          throw new NativeSessionsError("turn_busy", `${changeId}/${seat} already owns an input`);
        }
        this.inputLeases.add(key);
        try {
          const opened = await this.open(changeId, seat, config, { showTerminal: true });
          if (opened.threadId === null) {
            throw new NativeSessionsError("binding_failed", "native seat has no bound thread");
          }
          const native = new NativeTuiCodexTransport(
            this.options.host,
            this.turnPort(),
            this.options.promptFiles,
            {
              identity: identityOf(changeId, seat),
              cwd: this.cwd(changeId),
              sandbox: this.options.sandbox,
              approvalPolicy: this.options.approvalPolicy,
              effort: this.options.effort,
              config,
              ...(this.options.model === undefined ? {} : { model: this.options.model }),
              ...(timeoutMs === undefined ? {} : {
                timeoutMs,
                turnStartTimeoutMs: timeoutMs,
              }),
            },
          );
          return await native.runTurn({ ...dispatch, threadId: opened.threadId });
        } finally {
          this.inputLeases.delete(key);
          if (this.releaseWhenIdle.delete(key)) {
            const binding = this.bound(changeId, seat);
            if (binding !== null) this.options.host.close(binding.threadId);
          }
        }
      },
    };
  }

  private async openOnce(
    changeId: string,
    seat: NativeSeat,
    config: Readonly<Record<string, unknown>>,
    showTerminal: boolean,
  ): Promise<NativeSessionStatus> {
    let binding = this.bound(changeId, seat);
    let threadId: string | null = null;
    if (binding !== null) {
      const prepared = await prepareBoundThread({
        binding,
        archive: this.options.history,
        detach: (missing) => { this.detach(missing); },
      });
      if (prepared.kind === "refused") {
        throw new NativeSessionsError("thread_unavailable", prepared.reason);
      }
      if (prepared.kind === "resume") threadId = prepared.threadId;
      else {
        this.options.host.close(prepared.replacedThreadId);
        binding = null;
      }
    }

    const session = await this.options.host.open(
      threadId,
      this.sessionOptions(changeId, config),
    );
    if (binding === null) {
      try {
        this.bind(changeId, seat, session.threadId);
      } catch (error) {
        this.options.host.close(session.threadId);
        throw new NativeSessionsError(
          "binding_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const tmux = await this.options.tmux.ensureSession(
      identityOf(changeId, seat),
      session.threadId,
      this.cwd(changeId),
    );
    if (showTerminal) {
      await this.options.terminal.open({ sessionName: tmux.name, marker: tmux.marker });
    }
    return this.status(changeId, seat);
  }

  private sessionOptions(
    changeId: string,
    config: Readonly<Record<string, unknown>>,
  ): AppServerSessionOptions {
    return {
      cwd: this.cwd(changeId),
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
      effort: this.options.effort,
      config,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    };
  }

  private cwd(changeId: string): string {
    const injected = this.options.cwdFor?.(changeId);
    if (injected !== undefined) {
      if (injected !== null) return injected;
      throw new NativeSessionsError("project_path_missing", `${changeId} has no project path`);
    }
    try {
      const projectId = new ChangeStore(this.options.database).read(changeId).projectId;
      if (projectId === null) throw new Error("change has no project");
      const path = new ProjectStore(this.options.database).read(projectId).path;
      if (path !== null) return path;
    } catch {
      // The named error below is the public boundary.
    }
    throw new NativeSessionsError("project_path_missing", `${changeId} has no project path`);
  }

  private bound(changeId: string, seat: NativeSeat): BoundThread | null {
    if (seat === "aside") {
      const found = this.bindings.findAside(changeId);
      return found?.status === "bound"
        ? { changeId, kind: "aside", phase: null, threadId: found.threadId }
        : null;
    }
    const found = this.bindings.find(changeId, seat);
    return found?.status === "bound"
      ? { changeId, kind: "round", phase: seat, threadId: found.threadId }
      : null;
  }

  private bind(changeId: string, seat: NativeSeat, threadId: string): void {
    if (seat === "aside") this.bindings.bindAside(changeId, threadId);
    else this.bindings.bind(changeId, seat, threadId);
  }

  private detach(binding: BoundThread): void {
    if (binding.kind === "aside") this.bindings.detachAside(binding.changeId);
    else this.bindings.detach(binding.changeId, binding.phase);
  }

  private turnPort(): NativeTuiTurnPort {
    return {
      ensure: (identity, threadId, cwd) =>
        this.options.tmux.ensureSession(identity, threadId, cwd),
      submit: (sessionName, envelope) => this.options.tmux.submit(sessionName, envelope),
    };
  }

  private async cleanupBound(binding: BoundThread, seat: string): Promise<void> {
    const outcome = await archiveFinished(binding.threadId, this.options.history);
    const archiveFailed = outcome === "still_open" || outcome === "unknown";
    const identity = identityOf(binding.changeId, seat);
    const target = targetOf(binding.changeId, seat);
    const tmux = await this.options.tmux.status(identity);
    if (tmux === "attached") await this.options.tmux.detach(target.sessionName);
    await this.options.terminal.close(target);
    if (tmux !== "absent") await this.options.tmux.endSession(target.sessionName);
    this.options.host.close(binding.threadId);
    if (archiveFailed) {
      throw new NativeSessionsError(
        "session_cleanup_failed",
        `could not archive ${binding.changeId}/${seat} before ending its native session`,
      );
    }
  }
}
