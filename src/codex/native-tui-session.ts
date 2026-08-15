import type { AppServerRequest } from "./app-server-protocol";
import {
  AppServerSessionError,
  type AppServerSessionOptions,
} from "./app-server-session";
import {
  AppServerSessionHost,
  CodexTurnError,
} from "./app-server-transport";
import type { PromptFiles } from "./prompt-file";
import type {
  TmuxIdentity,
  TmuxSession,
} from "./tmux";
import {
  CodexUnavailableError,
  type CodexTransport,
  type TurnDelivery,
  type TurnDispatch,
} from "./transport";

export interface NativeTuiTurnPort {
  ensure(identity: TmuxIdentity, threadId: string, cwd: string): Promise<TmuxSession>;
  submit(sessionName: string, envelope: string): Promise<void>;
}

export interface NativeTuiTransportOptions extends AppServerSessionOptions {
  readonly identity: TmuxIdentity;
  readonly timeoutMs?: number;
  readonly turnStartTimeoutMs?: number;
}

/**
 * The control connection is observational. Reverse requests belong to the
 * official native client that started the turn and must never become browser
 * approval or elicitation state.
 */
export function nativeTuiServerRequest(_request: AppServerRequest): Promise<never> {
  return Promise.reject(new AppServerSessionError(
    "interaction_owner_is_native_tui",
    "approval and MCP interaction ownership belongs to the native Codex client",
  ));
}

/** Runs StagePass work through the official native client and observes App Server state. */
export class NativeTuiCodexTransport implements CodexTransport {
  constructor(
    private readonly host: AppServerSessionHost,
    private readonly tui: NativeTuiTurnPort,
    private readonly promptFiles: PromptFiles,
    private readonly options: NativeTuiTransportOptions,
  ) {}

  async runTurn(dispatch: TurnDispatch): Promise<TurnDelivery> {
    const session = await this.host.open(dispatch.threadId, this.sessionOptions());
    dispatch.onThread?.(session.threadId);
    const baseline = session.snapshot();
    if (baseline.activeTurnId !== null) {
      throw new AppServerSessionError("turn_busy", "this thread already has an active turn");
    }

    const promptFile = this.promptFiles.create(dispatch.prompt);
    try {
      const tmux = await this.tui.ensure(
        this.options.identity,
        session.threadId,
        this.options.cwd,
      );
      await this.tui.submit(tmux.name, promptFile.envelope);

      const turnId = await this.withDisconnect(session.awaitNextTurn(
        baseline.lastTurnId,
        this.options.turnStartTimeoutMs ?? this.options.timeoutMs ?? 0,
      ));
      const outcome = await this.withDisconnect(session.awaitTurn(
        turnId,
        this.options.timeoutMs ?? 0,
      ));
      if (outcome.status === "failed") {
        throw new CodexTurnError("codex_turn_failed", `codex turn ${turnId} failed`);
      }
      if (outcome.status === "interrupted") {
        throw new CodexTurnError(
          "codex_turn_interrupted",
          `codex turn ${turnId} was interrupted`,
        );
      }
      return { threadId: session.threadId, text: outcome.text };
    } catch (error) {
      if (
        error instanceof AppServerSessionError
        && (error.code === "turn_start_timeout" || error.code === "turn_timeout")
      ) {
        throw new CodexTurnError(
          "codex_turn_timeout",
          "native Codex turn did not finish before the deadline",
        );
      }
      if (error instanceof AppServerSessionError && error.code === "app_server_disconnected") {
        throw new CodexUnavailableError("app_server_disconnected");
      }
      throw error;
    } finally {
      promptFile.release();
    }
  }

  private async withDisconnect<T>(pending: Promise<T>): Promise<T> {
    let unsubscribe = (): void => {};
    const disconnected = new Promise<never>((_resolve, reject) => {
      unsubscribe = this.host.subscribeDisconnect(reject);
    });
    try {
      return await Promise.race([pending, disconnected]);
    } finally {
      unsubscribe();
    }
  }

  private sessionOptions(): AppServerSessionOptions {
    const {
      identity: _identity,
      timeoutMs: _timeoutMs,
      turnStartTimeoutMs: _turnStartTimeoutMs,
      ...sessionOptions
    } = this.options;
    return sessionOptions;
  }
}
