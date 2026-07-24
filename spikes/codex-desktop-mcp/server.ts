import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createCodexPhase0SqliteJournal,
} from "../../server/services/codex-phase0-sqlite-journal";
import type {
  Phase0AuthorizationChannel,
  Phase0DispatchAckRequest,
  Phase0MintRequest,
  Phase0Nonce,
  Phase0RevokeRequest,
  Phase0SubmitRequest,
} from "./supervisor.ts";

declare const __PHASE0_UI_BUNDLE__: string | undefined;

export const PHASE0_RESOURCE_URI = "ui://stagepass/phase0-card.html";

interface Phase0ServerOptions {
  authorization: Phase0AuthorizationChannel;
}

interface HostAttestation {
  caller: "model" | "app";
  sourceThreadId: string;
}

const VERIFICATION_DATABASE_NAME =
  /^codex-desktop-bridge-phase0-([0-9a-f-]{36})\.sqlite$/i;

function verificationRoot(): string {
  return path.resolve(process.cwd(), ".stagepass", "verification");
}

function openExactVerificationJournal(databasePath: string): ReturnType<
  typeof createCodexPhase0SqliteJournal
> {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(databasePath);
  } catch {
    throw new Error("phase0_verification_journal_missing");
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || fs.realpathSync(databasePath) !== databasePath
  ) {
    throw new Error("phase0_verification_journal_invalid");
  }
  const journal = createCodexPhase0SqliteJournal({ databasePath });
  try {
    const after = fs.lstatSync(databasePath);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || fs.realpathSync(databasePath) !== databasePath
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      throw new Error("phase0_verification_journal_replaced");
    }
    return journal;
  } catch (error) {
    journal.close();
    throw error;
  }
}

function resolveVerificationJournal(
  verificationRunId: string | undefined,
  nonceId: string,
): {
  databasePath: string;
  journal: ReturnType<typeof createCodexPhase0SqliteJournal>;
  verification: ReturnType<
    ReturnType<typeof createCodexPhase0SqliteJournal>["readVerificationWakeup"]
  >;
} | undefined {
  if (!verificationRunId) return undefined;
  const databasePath = path.join(
    verificationRoot(),
    `codex-desktop-bridge-phase0-${verificationRunId}.sqlite`,
  );
  const journal = openExactVerificationJournal(databasePath);
  try {
    const verification = journal.readVerificationWakeup(nonceId);
    if (verification.runId !== verificationRunId) {
      throw new Error("phase0_verification_run_mismatch");
    }
    return { databasePath, journal, verification };
  } catch (error) {
    journal.close();
    throw error;
  }
}

function assertVerificationCanonical(
  resolved: NonNullable<
    ReturnType<typeof resolveVerificationJournal>
  >,
  sourceThreadId: string,
  requestedThreadId: string,
): void {
  const canonical = resolved.journal.inspectInteractionBinding(
    resolved.verification.interactionId,
  );
  const filenameRunId = path.basename(resolved.databasePath)
    .match(VERIFICATION_DATABASE_NAME)?.[1];
  if (
    !filenameRunId
    || filenameRunId !== resolved.verification.runId
    || canonical.logicalTurnId !== resolved.verification.logicalTurnId
    || canonical.bindingId !== resolved.verification.bindingId
    || canonical.threadId !== resolved.verification.threadId
    || canonical.threadId !== requestedThreadId
    || canonical.threadId !== sourceThreadId
  ) {
    throw new Error("source_thread_mismatch");
  }
}

function attestationFromExtra(extra: unknown): HostAttestation {
  const meta = (
    typeof extra === "object"
    && extra !== null
    && "_meta" in extra
    && typeof extra._meta === "object"
    && extra._meta !== null
  )
    ? extra._meta as Record<string, unknown>
    : {};
  const sourceThreadId = meta["stagepass/source-thread-attestation"];
  const caller = meta["stagepass/caller"];
  if (typeof sourceThreadId !== "string" || sourceThreadId.length === 0) {
    throw new Error("source_thread_mismatch");
  }
  if (caller !== "model" && caller !== "app") {
    throw new Error("caller_attestation_missing");
  }
  return { caller, sourceThreadId };
}

function phase0Html(): string {
  const bundle = typeof __PHASE0_UI_BUNDLE__ === "string"
    ? __PHASE0_UI_BUNDLE__
    : "document.querySelector('#phase0-status').textContent='UI bundle not built';";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 16px; }
    main { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 12px; padding: 16px; }
    button { border: 0; border-radius: 8px; padding: 10px 14px; font: inherit; font-weight: 650; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    p { opacity: .75; }
  </style>
</head>
<body>
  <main>
    <h2>StagePass Phase 0</h2>
    <p id="phase0-status">Waiting for Host-attested private state…</p>
    <button id="phase0-ui-message" disabled>MCP ui/message</button>
  </main>
  <script>${bundle}</script>
</body>
</html>`;
}

export function createPhase0McpServer(
  options: Phase0ServerOptions,
): McpServer {
  const server = new McpServer({
    name: "stagepass-phase0-mcp-server",
    version: "1.0.0",
  });

  registerAppResource(
    server,
    "StagePass Phase 0 card",
    PHASE0_RESOURCE_URI,
    {
      description: "Disposable UI for Codex Desktop bridge verification.",
    },
    async () => ({
      contents: [{
        uri: PHASE0_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: phase0Html(),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
        },
      }],
    }),
  );

  registerAppTool(
    server,
    "present_phase0_card",
    {
      title: "Present StagePass Phase 0 card",
      description: "Present the disposable Phase 0 verification card.",
      inputSchema: {
        action: z.enum(["present", "status"]).optional(),
        verificationCaseId: z.enum([
          "cross_source_present",
          "cross_source_status",
          "cross_binding_present",
        ]).optional(),
        threadId: z.string().min(1),
        verificationJournalPath: z.string().min(1).optional(),
        verificationRunId: z.string().uuid().optional(),
        interactionId: z.string().min(1).optional(),
        cardVersion: z.number().int().positive().optional(),
      },
      _meta: {
        ui: {
          resourceUri: PHASE0_RESOURCE_URI,
          visibility: ["model", "app"],
        },
        "openai/widgetAccessible": true,
      },
    },
    async ({
      action,
      threadId,
      verificationJournalPath,
      verificationRunId,
      interactionId,
      cardVersion,
    }, extra) => {
      const attestation = attestationFromExtra(extra);
      if (attestation.sourceThreadId !== threadId) {
        throw new Error("source_thread_mismatch");
      }
      let verification:
        | {
          journal: ReturnType<typeof createCodexPhase0SqliteJournal>;
          runId: string;
          interactionId: string;
          cardVersion: number;
          canonical: ReturnType<
            ReturnType<
              typeof createCodexPhase0SqliteJournal
            >["inspectInteractionBinding"]
          >;
        }
        | undefined;
      if (
        verificationJournalPath !== undefined
        || verificationRunId !== undefined
        || interactionId !== undefined
        || cardVersion !== undefined
      ) {
        const root = verificationRoot();
        const resolvedJournalPath = verificationJournalPath
          ? path.resolve(verificationJournalPath)
          : "";
        const expectedPath = verificationRunId
          ? path.join(
              root,
              `codex-desktop-bridge-phase0-${verificationRunId}.sqlite`,
            )
          : "";
        if (
          !verificationJournalPath
          || !verificationRunId
          || !interactionId
          || !cardVersion
          || !path.isAbsolute(verificationJournalPath)
          || resolvedJournalPath !== expectedPath
        ) {
          throw new Error("phase0_verification_wakeup_invalid");
        }
        const journal = openExactVerificationJournal(resolvedJournalPath);
        try {
          const canonical = journal.inspectInteractionBinding(interactionId);
          if (
            canonical.threadId !== threadId
            || canonical.threadId !== attestation.sourceThreadId
            || canonical.state !== "pending"
          ) {
            throw new Error("source_thread_mismatch");
          }
          verification = {
            journal,
            runId: verificationRunId,
            interactionId,
            cardVersion,
            canonical,
          };
        } catch (error) {
          journal.close();
          throw error;
        }
      }
      if (action === "status") {
        verification?.journal.close();
        return {
          content: [{
            type: "text",
            text: "StagePass Phase 0 interaction is ready.",
          }],
          structuredContent: { ready: true },
        };
      }
      let privateNonce: Phase0Nonce | undefined;
      let handedOff = false;
      try {
        const mintedNonce = await options.authorization.mint({
          sourceThreadId: attestation.sourceThreadId,
          requestedThreadId: threadId,
          verificationRunId,
        });
        privateNonce = mintedNonce;
        let modelSubmitRejected = false;
        try {
          await options.authorization.submit({
            caller: "model",
            sourceThreadId: attestation.sourceThreadId,
            requestedThreadId: threadId,
            nonceId: mintedNonce.nonceId,
            nonce: mintedNonce.nonce,
          });
        } catch (error) {
          const code = (
            typeof error === "object"
            && error !== null
            && "code" in error
            && typeof error.code === "string"
          )
            ? error.code
            : error instanceof Error
              ? error.message
              : "";
          modelSubmitRejected = code === "model_invocation_forbidden";
        }
        if (!modelSubmitRejected) {
          throw new Error("model_submit_rejection_unproven");
        }
        const sourceNegativeMatrix = {
          presentMissing: false,
          statusCrossThread: false,
          submitMissing: false,
          submitCrossThread: false,
        };
        const rejectedAsSourceMismatch = async (
          operation: () => Promise<unknown>,
        ): Promise<boolean> => {
          try {
            await operation();
            return false;
          } catch (error) {
            return (
              typeof error === "object"
              && error !== null
              && "code" in error
              && error.code === "source_thread_mismatch"
            ) || /source_thread_mismatch/.test(String(error));
          }
        };
        sourceNegativeMatrix.presentMissing = await rejectedAsSourceMismatch(
          () => options.authorization.mint({
            sourceThreadId: "",
            requestedThreadId: threadId,
          }),
        );
        sourceNegativeMatrix.statusCrossThread = await rejectedAsSourceMismatch(
          () => options.authorization.mint({
            sourceThreadId: `${threadId}-cross-thread`,
            requestedThreadId: threadId,
          }),
        );
        sourceNegativeMatrix.submitMissing = await rejectedAsSourceMismatch(
          () => options.authorization.submit({
            caller: "app",
            sourceThreadId: "",
            requestedThreadId: threadId,
            nonceId: mintedNonce.nonceId,
            nonce: mintedNonce.nonce,
          }),
        );
        sourceNegativeMatrix.submitCrossThread =
          await rejectedAsSourceMismatch(
            () => options.authorization.submit({
              caller: "app",
              sourceThreadId: `${threadId}-cross-thread`,
              requestedThreadId: threadId,
              nonceId: mintedNonce.nonceId,
              nonce: mintedNonce.nonce,
            }),
          );
        if (!Object.values(sourceNegativeMatrix).every(Boolean)) {
          throw new Error("source_negative_matrix_unproven");
        }
        if (verification) {
          await verification.journal.registerVerificationWakeup({
            runId: verification.runId,
            nonceId: mintedNonce.nonceId,
            interactionId: verification.interactionId,
            logicalTurnId: verification.canonical.logicalTurnId,
            bindingId: verification.canonical.bindingId,
            threadId: verification.canonical.threadId,
            cardVersion: verification.cardVersion,
          });
        }
        handedOff = true;
        return {
          content: [{
            type: "text",
            text: "StagePass Phase 0 card is ready for a user click.",
          }],
          structuredContent: {
            ready: true,
            modelSubmitRejected,
            sourceNegativeMatrix,
          },
          _meta: {
            stagepassPhase0: mintedNonce,
          },
        };
      } finally {
        try {
          verification?.journal.close();
        } finally {
          if (privateNonce && !handedOff) {
            try {
              await options.authorization.revoke({
                sourceThreadId: attestation.sourceThreadId,
                requestedThreadId: threadId,
                nonceId: privateNonce.nonceId,
                nonce: privateNonce.nonce,
                verificationRunId,
              } satisfies Phase0RevokeRequest);
            } catch {
              // The original presentation failure is authoritative.
            }
          }
        }
      }
    },
  );

  registerAppTool(
    server,
    "submit_phase0_card",
    {
      title: "Submit StagePass Phase 0 card",
      description: "Privately authorize a user click from the Phase 0 App.",
      inputSchema: {
        action: z.enum(["submit", "ack"]).optional(),
        threadId: z.string().min(1),
        nonceId: z.string().uuid(),
        nonce: z.string().min(32).optional(),
        verificationRunId: z.string().uuid().optional(),
        wakeupJobId: z.string().uuid().optional(),
        wakeupAttemptId: z.string().uuid().optional(),
        markerMessage: z.string().min(1).optional(),
        expiresAt: z.number().int().positive().optional(),
        authorizationTag: z.string().min(32).optional(),
      },
      _meta: {
        ui: {
          resourceUri: PHASE0_RESOURCE_URI,
          visibility: ["app"],
        },
        "openai/visibility": "private",
      },
    },
    async (input, extra) => {
      const attestation = attestationFromExtra(extra);
      if (input.action === "ack") {
        if (
          !input.wakeupJobId
          || !input.wakeupAttemptId
          || !input.markerMessage
          || !input.expiresAt
          || !input.authorizationTag
        ) {
          throw new Error("dispatch_ack_invalid");
        }
        const resolved = resolveVerificationJournal(
          input.verificationRunId,
          input.nonceId,
        );
        try {
          if (resolved) {
            assertVerificationCanonical(
              resolved,
              attestation.sourceThreadId,
              input.threadId,
            );
            const verification = resolved.journal.readVerificationWakeup(
              input.nonceId,
            );
            if (
              verification.state === "minted"
              || !verification.jobId
              || !verification.attemptId
              || !verification.workerId
              || !verification.leaseToken
              || !verification.leaseExpiresAt
              || verification.markerMessage !== input.markerMessage
              || verification.jobId !== input.wakeupJobId
              || verification.attemptId !== input.wakeupAttemptId
            ) {
              throw new Error("phase0_verification_ack_binding_invalid");
            }
          }
          const result = await options.authorization.ack({
            threadId: input.threadId,
            nonceId: input.nonceId,
            verificationRunId: input.verificationRunId,
            wakeupJobId: input.wakeupJobId,
            wakeupAttemptId: input.wakeupAttemptId,
            markerMessage: input.markerMessage,
            expiresAt: input.expiresAt,
            authorizationTag: input.authorizationTag,
            caller: "app",
            sourceThreadId: attestation.sourceThreadId,
          } satisfies Phase0DispatchAckRequest);
          if (resolved) {
            const verification = resolved.journal.readVerificationWakeup(
              input.nonceId,
            );
            await resolved.journal.recordInteractionWakeupAck({
              jobId: verification.jobId!,
              source: "host",
              workerId: verification.workerId!,
              leaseToken: verification.leaseToken!,
              leaseExpiresAt: verification.leaseExpiresAt!,
              receiptId: `phase0-host-receipt:${input.authorizationTag}`,
              markerMessage: input.markerMessage,
            });
          }
          return {
            content: [{
              type: "text",
              text: result.duplicate
                ? "Protected Host dispatch acknowledgement already settled."
                : "Protected Host dispatch acknowledgement accepted.",
            }],
            structuredContent: result,
          };
        } finally {
          resolved?.journal.close();
        }
      }
      if (!input.nonce) throw new Error("nonce_invalid");
      const resolved = resolveVerificationJournal(
        input.verificationRunId,
        input.nonceId,
      );
      try {
        if (resolved) {
          assertVerificationCanonical(
            resolved,
            attestation.sourceThreadId,
            input.threadId,
          );
          let verification = resolved.journal.readVerificationWakeup(
            input.nonceId,
          );
          if (verification.state === "acked") {
            throw new Error("dispatch_settled");
          }
          if (verification.state === "minted") {
            const decision = await resolved.journal.submitInteractionDecision({
              interactionId: verification.interactionId,
              cardVersion: verification.cardVersion,
              clickId: input.nonceId,
              selectedOption: "continue",
            });
            if (
              (decision.status !== "accepted"
                && decision.status !== "duplicate")
              || !decision.jobId
              || !decision.attemptId
            ) {
              throw new Error("phase0_verification_decision_not_accepted");
            }
            const workerId = randomUUID();
            const leaseToken = randomUUID();
            const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
            await resolved.journal.authorizeInteractionWakeup({
              jobId: decision.jobId,
              verificationNonceId: input.nonceId,
              markerNonceId: input.nonceId,
              workerId,
              leaseToken,
              leaseExpiresAt,
            });
            verification = resolved.journal.readVerificationWakeup(
              input.nonceId,
            );
          }
          assertVerificationCanonical(
            resolved,
            attestation.sourceThreadId,
            input.threadId,
          );
          const result = await options.authorization.submit({
            caller: attestation.caller,
            sourceThreadId: attestation.sourceThreadId,
            requestedThreadId: input.threadId,
            nonceId: input.nonceId,
            nonce: input.nonce,
            verificationRunId: input.verificationRunId,
            wakeupJobId: verification.jobId,
            wakeupAttemptId: verification.attemptId,
          });
          return {
            content: [{
              type: "text",
              text: "Protected Phase 0 submit accepted.",
            }],
            structuredContent: result,
          };
        }
        const result = await options.authorization.submit({
          caller: attestation.caller,
          sourceThreadId: attestation.sourceThreadId,
          requestedThreadId: input.threadId,
          nonceId: input.nonceId,
          nonce: input.nonce,
          verificationRunId: input.verificationRunId,
        });
        return {
          content: [{
            type: "text",
            text: "Protected Phase 0 submit accepted.",
          }],
          structuredContent: result,
        };
      } finally {
        resolved?.journal.close();
      }
    },
  );

  return server;
}

interface FdResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string };
}

const FD_AUTH_MAX_FRAME_BYTES = 64 * 1024;
const FD_AUTH_MAX_BUFFER_BYTES = 128 * 1024;
const FD_AUTH_MAX_INFLIGHT = 64;
const FD_AUTH_REQUEST_TIMEOUT_MS = 5_000;

export function createFdAuthorizationChannel(
  fd = 3,
  streams?: { input: Readable; output: Writable },
): Phase0AuthorizationChannel {
  const stream = streams?.input
    ?? fs.createReadStream("", { fd, autoClose: false });
  const output = streams?.output
    ?? fs.createWriteStream("", { fd, autoClose: false });
  let buffer = "";
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  let closed = false;
  const rejectAll = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const closeMalformed = (code: string) => {
    rejectAll(new Error(code));
    stream.destroy();
    output.destroy();
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    if (closed) return;
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer, "utf8") > FD_AUTH_MAX_BUFFER_BYTES) {
      closeMalformed("protected_fd_buffer_limit");
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > FD_AUTH_MAX_FRAME_BYTES) {
        closeMalformed("protected_fd_frame_limit");
        return;
      }
      let response: FdResponse;
      try {
        response = JSON.parse(line) as FdResponse;
      } catch {
        closeMalformed("protected_fd_frame_invalid");
        return;
      }
      if (
        typeof response.id !== "string"
        || typeof response.ok !== "boolean"
      ) {
        closeMalformed("protected_fd_frame_invalid");
        return;
      }
      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response.result);
      else request.reject(
        new Error(response.error?.code ?? "protected submit failed"),
      );
    }
  });
  stream.once("end", () =>
    rejectAll(new Error("protected authorization FD ended")));
  stream.once("close", () =>
    rejectAll(new Error("protected authorization FD closed")));
  stream.once("error", (error: Error) => rejectAll(error));
  output.once("error", (error: Error) => rejectAll(error));
  output.once("close", () =>
    rejectAll(new Error("protected authorization FD output closed")));
  function request(
    op: "mint" | "revoke" | "submit" | "ack",
    body: unknown,
  ): Promise<unknown> {
    if (closed) {
      return Promise.reject(new Error("protected authorization FD closed"));
    }
    if (pending.size >= FD_AUTH_MAX_INFLIGHT) {
      return Promise.reject(
        new Error("protected authorization FD inflight limit"),
      );
    }
    const id = randomUUID();
    const frame = `${JSON.stringify({ id, op, body })}\n`;
    if (Buffer.byteLength(frame, "utf8") > FD_AUTH_MAX_FRAME_BYTES) {
      return Promise.reject(
        new Error("protected authorization FD frame limit"),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("protected authorization FD request timed out"));
      }, FD_AUTH_REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      output.write(frame, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }
  return {
    mint(body: Phase0MintRequest) {
      return request("mint", body) as Promise<Phase0Nonce>;
    },
    revoke(body: Phase0RevokeRequest) {
      return request("revoke", body) as ReturnType<
        Phase0AuthorizationChannel["revoke"]
      >;
    },
    submit(body: Phase0SubmitRequest) {
      return request("submit", body) as ReturnType<
        Phase0AuthorizationChannel["submit"]
      >;
    },
    ack(body: Phase0DispatchAckRequest) {
      return request("ack", body) as ReturnType<
        Phase0AuthorizationChannel["ack"]
      >;
    },
  };
}

export async function runPhase0McpServer(): Promise<void> {
  const server = createPhase0McpServer({
    authorization: createFdAuthorizationChannel(),
  });
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void runPhase0McpServer();
}
