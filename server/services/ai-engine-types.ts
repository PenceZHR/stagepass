import type {
  AiOutputMode,
  SchemaDelivery,
  StructuredOutputSource,
} from "./stage-ai-output-contract";
import type { ProcessIdentity } from "./process-identity-service";

export type AiProvider = "codex" | "claude";

export type AiSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type AiRunPhase =
  | "refine"
  | "plan"
  | "generate_plan"
  | "implement"
  | "fix"
  | "fix_findings"
  | "review"
  | "local_check"
  | "intake"
  | "spec"
  | "spec_critic"
  // The Spec round's verdict-rubric judge: a third provider call inside the one
  // `spec` business run, made after red and blue have both produced.
  | "spec_verdict"
  | "tech_spec"
  | "test_plan"
  | "release"
  | "retro"
  // The Done stage's delivery note.
  | "delivery";

export interface AiRunLifecycleProcessStarted {
  provider: AiProvider;
  pid: number | null;
  ppid: number;
  externalRef?: string | null;
  identity?: ProcessIdentity | null;
  startedAt: string;
}

export interface AiRunLifecycleTerminal {
  provider: AiProvider;
  pid: number | null;
  exitCode?: number | null;
  signal?: string | null;
  status: "completed" | "failed" | "stopped";
  summary: string;
  endedAt: string;
}

export interface AiRunLifecycleHeartbeat {
  provider: AiProvider;
  pid: number | null;
  externalRef?: string | null;
  observedAt: string;
}

export interface AiRunLifecycleSink {
  onProcessStarted(event: AiRunLifecycleProcessStarted): void | Promise<void>;
  onHeartbeat(event: AiRunLifecycleHeartbeat): void | Promise<void>;
  onTerminal(event: AiRunLifecycleTerminal): void | Promise<void>;
}

export interface AiRunInput {
  changeId: string;
  repoPath: string;
  phase: AiRunPhase;
  threadId?: string;
  prompt: string;
  outputSchema?: unknown;
  outputMode?: AiOutputMode;
  rawCapture?: AiRunRawCaptureInput;
  sandboxMode?: AiSandboxMode;
  timeoutMs?: number;
  lifecycle?: AiRunLifecycleSink;
}

export interface AiRunRawCaptureInput {
  enabled: boolean;
  artifactType: string;
  fileName: string;
}

export type AiRunItem =
  | ({
      type: "reasoning";
      text?: string;
    } & Record<string, unknown>)
  | ({
      type: "agent_message";
      text?: string;
    } & Record<string, unknown>)
  | ({
      type: "command_execution";
      command?: string;
      exitCode?: number;
    } & Record<string, unknown>)
  | ({
      type: "file_change";
      changes?: Array<{ path: string } & Record<string, unknown>>;
      paths?: string[];
    } & Record<string, unknown>)
  | ({
      type: string;
    } & Record<string, unknown>);

export type AiStreamEvent =
  | ({
      type: "thread.started";
      threadId?: string;
    } & Record<string, unknown>)
  | ({
      type: "item.started" | "item.updated" | "item.completed";
      item?: AiRunItem;
    } & Record<string, unknown>)
  | ({
      type: "turn.completed";
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      } & Record<string, unknown>;
    } & Record<string, unknown>)
  | ({
      type: string;
      item?: AiRunItem;
    } & Record<string, unknown>);

export interface AiRunResult {
  threadId: string;
  runId: string;
  summary: string;
  success: boolean;
  changedFiles: string[];
  structuredOutput?: unknown;
  structuredOutputSource?: StructuredOutputSource;
  schemaDelivery?: SchemaDelivery;
  schemaCapabilityInvoked?: boolean;
  rawProviderResult?: unknown;
  providerErrorCode?: string | null;
  providerErrorDetail?: string;
  /**
   * How the provider process actually ended. Both engines compute these; both
   * used to drop them on the floor for the non-streaming result, which is why
   * every codex row in provider_run_processes carried exit_code NULL and a
   * killed run was indistinguishable from a quiet one. Ingestion forwards them
   * into the raw-capture envelope so the next failure is diagnosable from the
   * artifact alone.
   */
  exitCode?: number | null;
  signal?: string | null;
  /** Tail of the provider's stderr, truncated and secret-redacted. */
  stderrTail?: string;
  items: AiRunItem[];
}

export interface AiEngineAdapter {
  run(input: AiRunInput): Promise<AiRunResult>;
  runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent>;
}
