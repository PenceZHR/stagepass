import type Database from "better-sqlite3";

import {
  archiveFinished,
  type ArchiveOps,
} from "../codex/archive";
import {
  AppServerSessionError,
  type AppServerSession,
  type AppServerSessionOptions,
  type CompletedTurn,
} from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import type { PromptFile, PromptFiles } from "../codex/prompt-file";
import {
  CodexTurnError,
  CodexUnavailableError,
  type CodexTransport,
  type TurnDelivery,
} from "../codex/transport";
import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import {
  BindingStore,
  type BoundThread,
} from "../store/binding-store";
import { ProjectStore } from "../store/project-store";
import {
  terminalMarker,
  TerminalAppError,
  type TerminalAppOps,
  type TerminalTarget,
} from "../system/terminal-app";
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
  readonly terminal: "closed" | "open" | "stale" | "unavailable";
  readonly action: "open" | "focus" | "resume";
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
  archiveAndEnd(changeId: string, seat: NativeSeat): Promise<void>;
  releaseObserver(changeId: string, seat: NativeSeat): void;
  forget(changeId: string): Promise<void>;
  closeControlConnection(): void;
}

export interface NativeRuntimeSessions extends NativeSessionsPort {
  has(changeId: string, seat: NativeSeat): boolean;
  active(changeId: string, seat: NativeSeat): boolean;
  quietForMs(changeId: string, seat: NativeSeat): number | null;
  interrupt(changeId: string, seat: NativeSeat): Promise<boolean>;
  startTurn(
    changeId: string,
    seat: NativeSeat,
    prompt: string,
    config: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<string>;
  runTurn(
    changeId: string,
    seat: NativeSeat,
    prompt: string,
    config: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<string>;
  transportFor(
    changeId: string,
    seat: NativeSeat,
    config: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): CodexTransport;
}

type NativeSessionsErrorCode =
  | "binding_failed"
  | "no_such_change"
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
  readonly terminal: TerminalAppOps;
  readonly promptFiles: PromptFiles;
  readonly cwdFor?: (changeId: string) => string | null;
  readonly closeControlConnection?: () => void;
}

function keyOf(changeId: string, seat: NativeSeat): string {
  return `${changeId}\0${seat}`;
}

function targetOf(
  changeId: string,
  seat: string,
  threadId: string,
  cwd: string,
): TerminalTarget {
  return { marker: terminalMarker(changeId, seat), threadId, cwd };
}

interface ActiveNativeTurn {
  readonly turnId: string;
  readonly threadId: string;
  readonly completion: Promise<TurnDelivery>;
}

const DEFAULT_TURN_TIMEOUT_MS = 180 * 60_000;

/** Durable seat lifecycle reconstructed from binding + App Server + Terminal marker. */
export class NativeSessions implements NativeRuntimeSessions {
  private readonly bindings: BindingStore;
  private readonly opening = new Map<string, Promise<NativeSessionStatus>>();
  private readonly inputLeases = new Set<string>();
  private readonly releaseWhenIdle = new Set<string>();
  private readonly activeTurns = new Map<string, ActiveNativeTurn>();
  private readonly lastActivity = new Map<string, number>();

  constructor(private readonly options: NativeSessionsOptions) {
    this.bindings = new BindingStore(options.database);
  }

  async status(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus> {
    this.assertChange(changeId);
    const binding = this.bound(changeId, seat);
    const terminal = binding === null
      ? "closed" as const
      : await this.options.terminal.status(targetOf(
        changeId,
        seat,
        binding.threadId,
        this.cwd(changeId),
      )).catch(() => "unavailable" as const);

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
      terminal,
      action: terminal === "open"
        ? "focus"
        : binding === null
          ? "open"
          : "resume",
    };
  }

  has(changeId: string, seat: NativeSeat): boolean {
    const binding = this.bound(changeId, seat);
    return binding !== null && this.options.host.session(binding.threadId) !== null;
  }

  active(changeId: string, seat: NativeSeat): boolean {
    return this.activeTurns.has(keyOf(changeId, seat));
  }

  quietForMs(changeId: string, seat: NativeSeat): number | null {
    const at = this.lastActivity.get(keyOf(changeId, seat));
    return at === undefined ? null : Math.max(0, Date.now() - at);
  }

  async interrupt(changeId: string, seat: NativeSeat): Promise<boolean> {
    this.assertChange(changeId);
    const binding = this.bound(changeId, seat);
    if (binding === null) return false;
    const session = this.options.host.session(binding.threadId);
    if (session === null) return false;
    const turnId = session.snapshot().activeTurnId;
    if (turnId === null) return false;
    await session.interrupt(turnId);
    return true;
  }

  async startTurn(
    changeId: string,
    seat: NativeSeat,
    prompt: string,
    config: Readonly<Record<string, unknown>>,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  ): Promise<string> {
    const active = await this.dispatchTurn(changeId, seat, prompt, config, timeoutMs);
    void active.completion.catch(() => {});
    return active.turnId;
  }

  async runTurn(
    changeId: string,
    seat: NativeSeat,
    prompt: string,
    config: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<string> {
    const active = await this.dispatchTurn(changeId, seat, prompt, config, timeoutMs);
    return (await active.completion).text;
  }

  open(
    changeId: string,
    seat: NativeSeat,
    config: Readonly<Record<string, unknown>>,
    options: { readonly showTerminal: boolean },
  ): Promise<NativeSessionStatus> {
    this.assertChange(changeId);
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
    this.assertChange(changeId);
    const binding = this.bound(changeId, seat);
    if (binding === null) {
      throw new NativeSessionsError("thread_unavailable", `${changeId}/${seat} is not bound`);
    }
    await this.options.terminal.focus(targetOf(
      changeId,
      seat,
      binding.threadId,
      this.cwd(changeId),
    ));
    return this.status(changeId, seat);
  }

  async closeWindow(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus> {
    this.assertChange(changeId);
    const binding = this.bound(changeId, seat);
    if (binding !== null) {
      await this.options.terminal.close(targetOf(
        changeId,
        seat,
        binding.threadId,
        this.cwd(changeId),
      ));
    }
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
        const active = await this.dispatchTurn(
          changeId,
          seat,
          dispatch.prompt,
          config,
          timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          dispatch.onThread,
        );
        return active.completion;
      },
    };
  }

  private async dispatchTurn(
    changeId: string,
    seat: NativeSeat,
    prompt: string,
    config: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    onThread?: (threadId: string) => void,
  ): Promise<ActiveNativeTurn> {
    const key = keyOf(changeId, seat);
    if (this.inputLeases.has(key)) {
      throw new NativeSessionsError("turn_busy", `${changeId}/${seat} already owns an input`);
    }
    this.inputLeases.add(key);
    let promptFile: PromptFile | null = null;
    try {
      const opened = await this.open(changeId, seat, config, { showTerminal: false });
      if (opened.threadId === null) {
        throw new NativeSessionsError("binding_failed", "native seat has no bound thread");
      }
      onThread?.(opened.threadId);
      const session = this.options.host.session(opened.threadId);
      if (session === null) {
        throw new NativeSessionsError("thread_unavailable", "native observer is unavailable");
      }
      const baseline = session.snapshot();
      if (baseline.activeTurnId !== null) {
        throw new NativeSessionsError("turn_busy", `${changeId}/${seat} already has a turn`);
      }
      promptFile = this.options.promptFiles.create(prompt);
      const target = targetOf(
        changeId,
        seat,
        opened.threadId,
        this.cwd(changeId),
      );
      const terminal = await this.options.terminal.status(target);
      if (terminal === "open") {
        try {
          await this.options.terminal.submit(target, promptFile.envelope);
        } catch (error) {
          if (
            !(error instanceof TerminalAppError)
            || error.code !== "terminal_window_missing"
          ) throw error;
          await this.options.terminal.open(target, promptFile.envelope);
        }
      } else {
        await this.options.terminal.open(target, promptFile.envelope);
      }
      const turnId = await this.withDisconnect(session.awaitNextTurn(
        baseline.lastTurnId,
        timeoutMs,
      ));
      this.lastActivity.set(key, Date.now());
      const completion = this.completeTurn(
        key,
        session,
        turnId,
        opened.threadId,
        promptFile,
        timeoutMs,
      );
      const active = { turnId, threadId: opened.threadId, completion };
      this.activeTurns.set(key, active);
      void completion.catch(() => {});
      return active;
    } catch (error) {
      promptFile?.release();
      this.inputLeases.delete(key);
      throw this.normalizeTurnError(error);
    }
  }

  private async completeTurn(
    key: string,
    session: AppServerSession,
    turnId: string,
    threadId: string,
    promptFile: PromptFile,
    timeoutMs: number,
  ): Promise<TurnDelivery> {
    try {
      const outcome = await this.withDisconnect(session.awaitTurn(turnId, timeoutMs));
      this.assertCompleted(outcome);
      return { threadId, text: outcome.text };
    } catch (error) {
      throw this.normalizeTurnError(error);
    } finally {
      promptFile.release();
      this.inputLeases.delete(key);
      if (this.activeTurns.get(key)?.turnId === turnId) this.activeTurns.delete(key);
      this.lastActivity.set(key, Date.now());
      if (this.releaseWhenIdle.delete(key)) this.options.host.close(threadId);
    }
  }

  private assertCompleted(outcome: CompletedTurn): void {
    if (outcome.status === "failed") {
      throw new CodexTurnError("codex_turn_failed", `codex turn ${outcome.turnId} failed`);
    }
    if (outcome.status === "interrupted") {
      throw new CodexTurnError(
        "codex_turn_interrupted",
        `codex turn ${outcome.turnId} was interrupted`,
      );
    }
  }

  private async withDisconnect<T>(pending: Promise<T>): Promise<T> {
    let unsubscribe = (): void => {};
    const disconnected = new Promise<never>((_resolve, reject) => {
      unsubscribe = this.options.host.subscribeDisconnect(reject);
    });
    try {
      return await Promise.race([pending, disconnected]);
    } finally {
      unsubscribe();
    }
  }

  private normalizeTurnError(error: unknown): unknown {
    if (
      error instanceof AppServerSessionError
      && (error.code === "turn_start_timeout" || error.code === "turn_timeout")
    ) {
      return new CodexTurnError(
        "codex_turn_timeout",
        "native Codex turn did not finish before the deadline",
      );
    }
    if (error instanceof AppServerSessionError && error.code === "app_server_disconnected") {
      return new CodexUnavailableError("app_server_disconnected");
    }
    return error;
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
    if (showTerminal) {
      await this.options.terminal.open(targetOf(
        changeId,
        seat,
        session.threadId,
        this.cwd(changeId),
      ));
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

  private assertChange(changeId: string): void {
    try {
      new ChangeStore(this.options.database).read(changeId);
    } catch {
      throw new NativeSessionsError("no_such_change", `no such Change: ${changeId}`);
    }
  }

  private async cleanupBound(binding: BoundThread, seat: string): Promise<void> {
    const outcome = await archiveFinished(binding.threadId, this.options.history);
    const archiveFailed = outcome === "still_open" || outcome === "unknown";
    await this.options.terminal.close(targetOf(
      binding.changeId,
      seat,
      binding.threadId,
      this.cwd(binding.changeId),
    ));
    this.options.host.close(binding.threadId);
    if (archiveFailed) {
      throw new NativeSessionsError(
        "session_cleanup_failed",
        `could not archive ${binding.changeId}/${seat} before ending its native session`,
      );
    }
  }
}
