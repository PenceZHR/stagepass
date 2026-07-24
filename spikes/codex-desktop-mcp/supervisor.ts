import {
  execFileSync,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Duplex, Readable, Writable } from "node:stream";

export interface Phase0MintRequest {
  sourceThreadId: string;
  requestedThreadId: string;
  verificationRunId?: string;
}

export interface Phase0SubmitRequest extends Phase0MintRequest {
  caller: "model" | "app";
  nonceId: string;
  nonce: string;
  wakeupJobId?: string;
  wakeupAttemptId?: string;
}

export interface Phase0Nonce {
  threadId: string;
  nonceId: string;
  nonce: string;
  verificationRunId?: string;
}

export interface Phase0RevokeRequest extends Phase0MintRequest {
  nonceId: string;
  nonce: string;
}

export interface Phase0AuthorizedHostDispatch {
  threadId: string;
  nonceId: string;
  verificationRunId?: string;
  wakeupJobId: string;
  wakeupAttemptId: string;
  markerMessage: string;
  expiresAt: number;
  authorizationTag: string;
}

export interface Phase0DispatchAckRequest
  extends Phase0AuthorizedHostDispatch {
  caller: "app";
  sourceThreadId: string;
}

export interface Phase0AuthorizationChannel {
  mint(request: Phase0MintRequest): Promise<Phase0Nonce>;
  revoke(request: Phase0RevokeRequest): Promise<{
    ok: true;
    nonceId: string;
  }>;
  submit(request: Phase0SubmitRequest): Promise<{
    ok: true;
    threadId: string;
    nonceId: string;
    hostDispatch: Phase0AuthorizedHostDispatch;
  }>;
  ack(request: Phase0DispatchAckRequest): Promise<{
    ok: true;
    wakeupJobId: string;
    duplicate: boolean;
  }>;
}

export class Phase0SupervisorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "Phase0SupervisorError";
  }
}

const TRUSTED_CODEX_TEAM_ID = "2DC432GLL2";
const TRUSTED_MAIN_IDENTIFIER = "com.openai.codex";
const verifiedLaunchBrand = Symbol("phase0-verified-codex-launch");

export interface Phase0ProcessIdentity {
  pid: number;
  parentPid: number;
  startTime: string;
  executablePath: string;
  device: number;
  inode: number;
}

export interface Phase0CodeSignature {
  teamIdentifier: string;
  identifier: string;
}

export interface Phase0LaunchAttestationProbe {
  platform: NodeJS.Platform;
  currentParentPid(): number;
  processIdentity(pid: number): Phase0ProcessIdentity;
  codeSignature(executablePath: string): Phase0CodeSignature;
}

export interface Phase0VerifiedLaunch {
  readonly directParent: Phase0ProcessIdentity;
  readonly bundleRoot: string;
  readonly [verifiedLaunchBrand]: true;
}

function processField(pid: number, field: "ppid" | "lstart" | "comm"): string {
  return execFileSync(
    "/bin/ps",
    ["-ww", "-p", String(pid), "-o", `${field}=`],
    { encoding: "utf8", timeout: 5_000 },
  ).trim();
}

function bundleRootForExecutable(executablePath: string): string | null {
  const match = executablePath.match(
    /^(\/Applications\/(?:ChatGPT|Codex)\.app)(?:\/|$)/,
  );
  return match?.[1] ?? null;
}

function readCodeSignature(executablePath: string): Phase0CodeSignature {
  let output = "";
  try {
    output = execFileSync(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", executablePath],
      {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string };
    output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  }
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  if (!teamIdentifier || !identifier) {
    throw new Phase0SupervisorError(
      "phase0_host_launch_untrusted",
      "Codex launcher code signature is unavailable",
    );
  }
  return { teamIdentifier, identifier };
}

export function defaultPhase0LaunchAttestationProbe():
Phase0LaunchAttestationProbe {
  return {
    platform: process.platform,
    currentParentPid: () => process.ppid,
    processIdentity(pid) {
      const executablePath = fs.realpathSync(processField(pid, "comm"));
      const stat = fs.statSync(executablePath);
      return {
        pid,
        parentPid: Number.parseInt(processField(pid, "ppid"), 10),
        startTime: processField(pid, "lstart"),
        executablePath,
        device: stat.dev,
        inode: stat.ino,
      };
    },
    codeSignature: readCodeSignature,
  };
}

function sameProcessIdentity(
  left: Phase0ProcessIdentity,
  right: Phase0ProcessIdentity,
): boolean {
  return (
    left.pid === right.pid
    && left.parentPid === right.parentPid
    && left.startTime === right.startTime
    && left.executablePath === right.executablePath
    && left.device === right.device
    && left.inode === right.inode
  );
}

export function attestPhase0CodexLaunch(
  probe: Phase0LaunchAttestationProbe =
    defaultPhase0LaunchAttestationProbe(),
): Phase0VerifiedLaunch {
  if (probe.platform !== "darwin") {
    throw new Phase0SupervisorError(
      "phase0_host_launch_attestation_unsupported",
      "Phase 0 Host launch attestation is supported only on macOS",
    );
  }
  const parentPid = probe.currentParentPid();
  const directBefore = probe.processIdentity(parentPid);
  const bundleRoot = bundleRootForExecutable(directBefore.executablePath);
  const directSignature = probe.codeSignature(directBefore.executablePath);
  if (
    !bundleRoot
    || directSignature.teamIdentifier !== TRUSTED_CODEX_TEAM_ID
    || (
      directSignature.identifier !== "codex"
      && directSignature.identifier !== TRUSTED_MAIN_IDENTIFIER
    )
  ) {
    throw new Phase0SupervisorError(
      "phase0_host_launch_untrusted",
      "Phase 0 supervisor was not launched by signed Codex Desktop",
    );
  }

  let cursor = directBefore;
  let mainFound = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      cursor.executablePath === path.join(
        bundleRoot,
        "Contents",
        "MacOS",
        path.basename(bundleRoot, ".app"),
      )
      || cursor.executablePath === path.join(
        bundleRoot,
        "Contents",
        "MacOS",
        "ChatGPT",
      )
    ) {
      const signature = probe.codeSignature(cursor.executablePath);
      mainFound = (
        signature.teamIdentifier === TRUSTED_CODEX_TEAM_ID
        && signature.identifier === TRUSTED_MAIN_IDENTIFIER
      );
      break;
    }
    if (cursor.parentPid <= 1) break;
    const ancestor = probe.processIdentity(cursor.parentPid);
    if (bundleRootForExecutable(ancestor.executablePath) !== bundleRoot) break;
    const signature = probe.codeSignature(ancestor.executablePath);
    if (signature.teamIdentifier !== TRUSTED_CODEX_TEAM_ID) break;
    cursor = ancestor;
  }
  const directAfter = probe.processIdentity(parentPid);
  if (!mainFound || !sameProcessIdentity(directBefore, directAfter)) {
    throw new Phase0SupervisorError(
      "phase0_host_launch_untrusted",
      "Codex launcher ancestry or process identity could not be pinned",
    );
  }
  return {
    directParent: directBefore,
    bundleRoot,
    [verifiedLaunchBrand]: true,
  };
}

interface StoredNonce extends Phase0Nonce {
  wakeupJobId: string;
  wakeupAttemptId: string;
  expiresAt: number;
  used: boolean;
  dispatchAcked: boolean;
}

interface SettledNonceTombstone {
  threadId: string;
  nonceId: string;
  verificationRunId?: string;
  wakeupJobId: string;
  wakeupAttemptId: string;
  expiresAt: number;
  settledAt: number;
}

function supervisorError(code: string, message: string): never {
  throw new Phase0SupervisorError(code, `${code}: ${message}`);
}

export class Phase0AuthorizationBroker {
  readonly #secret = randomBytes(32);
  readonly #protectedChannels = new Set<symbol>();
  readonly #nonces = new Map<string, StoredNonce>();
  readonly #settled = new Map<string, SettledNonceTombstone>();
  readonly #mintHistory = new Map<string, number[]>();
  readonly #now: () => number;
  readonly #nonceTtlMs: number;
  readonly #verifiedLaunch: Phase0VerifiedLaunch;
  readonly #maxNonces: number;
  readonly #maxNoncesPerRun: number;
  readonly #maxNoncesPerThread: number;
  readonly #maxMintsPerMinute: number;
  readonly #maxTombstones: number;
  #channelCreated = false;

  constructor(verifiedLaunch: Phase0VerifiedLaunch, options: {
    now?: () => number;
    nonceTtlMs?: number;
    maxNonces?: number;
    maxNoncesPerRun?: number;
    maxNoncesPerThread?: number;
    maxMintsPerMinute?: number;
    maxTombstones?: number;
  } = {}) {
    if (verifiedLaunch[verifiedLaunchBrand] !== true) {
      throw new Phase0SupervisorError(
        "phase0_host_launch_untrusted",
        "protected authorization requires verified Codex launch",
      );
    }
    this.#verifiedLaunch = verifiedLaunch;
    this.#now = options.now ?? Date.now;
    this.#nonceTtlMs = options.nonceTtlMs ?? 2 * 60_000;
    this.#maxNonces = options.maxNonces ?? 1_024;
    this.#maxNoncesPerRun = options.maxNoncesPerRun ?? 128;
    this.#maxNoncesPerThread = options.maxNoncesPerThread ?? 128;
    this.#maxMintsPerMinute = options.maxMintsPerMinute ?? 60;
    this.#maxTombstones = options.maxTombstones ?? 1_024;
  }

  createProtectedChannel(): Phase0AuthorizationChannel {
    if (
      this.#verifiedLaunch[verifiedLaunchBrand] !== true
      || this.#channelCreated
    ) {
      return supervisorError(
        "submit_auth_channel_unavailable",
        "protected authorization channel is one-time",
      );
    }
    this.#channelCreated = true;
    const identity = Symbol("inherited-protected-submit-channel");
    this.#protectedChannels.add(identity);
    return {
      mint: (request) => this.#mint(identity, request),
      revoke: (request) => this.#revoke(identity, request),
      submit: (request) => this.#submit(identity, request),
      ack: (request) => this.#ack(identity, request),
    };
  }

  inspectResourceUsage(): {
    activeNonces: number;
    settledTombstones: number;
    retainedNonceSecrets: number;
  } {
    this.#cleanup();
    return {
      activeNonces: this.#nonces.size,
      settledTombstones: this.#settled.size,
      retainedNonceSecrets: [...this.#nonces.values()]
        .filter(({ nonce }) => nonce.length > 0).length,
    };
  }

  async submitWithoutProtectedChannel(
    request: Phase0SubmitRequest & { mac: string },
  ): Promise<never> {
    const body = JSON.stringify({
      caller: request.caller,
      sourceThreadId: request.sourceThreadId,
      requestedThreadId: request.requestedThreadId,
      nonceId: request.nonceId,
      nonce: request.nonce,
      verificationRunId: request.verificationRunId,
    });
    const expected = createHmac("sha256", this.#secret)
      .update(body)
      .digest();
    const supplied = /^[0-9a-f]{64}$/i.test(request.mac)
      ? Buffer.from(request.mac, "hex")
      : Buffer.alloc(expected.length);
    if (supplied.length === expected.length) {
      timingSafeEqual(expected, supplied);
    }
    return supervisorError(
      "submit_auth_channel_unavailable",
      "submit requires the inherited protected authorization channel",
    );
  }

  async #mint(
    identity: symbol,
    request: Phase0MintRequest,
  ): Promise<Phase0Nonce> {
    this.#assertChannel(identity);
    this.#assertThreadBinding(request);
    this.#cleanup();
    const active = [...this.#nonces.values()];
    const runCount = active.filter(
      ({ verificationRunId }) =>
        verificationRunId === request.verificationRunId,
    ).length;
    const threadCount = active.filter(
      ({ threadId }) => threadId === request.sourceThreadId,
    ).length;
    if (
      active.length >= this.#maxNonces
      || runCount >= this.#maxNoncesPerRun
      || threadCount >= this.#maxNoncesPerThread
    ) {
      return supervisorError(
        "nonce_capacity_exceeded",
        "protected nonce capacity was reached",
      );
    }
    const history = this.#mintHistory.get(request.sourceThreadId) ?? [];
    if (history.length >= this.#maxMintsPerMinute) {
      return supervisorError(
        "nonce_rate_limited",
        "protected nonce mint rate was exceeded",
      );
    }
    history.push(this.#now());
    this.#mintHistory.set(request.sourceThreadId, history);
    const nonce: StoredNonce = {
      threadId: request.sourceThreadId,
      nonceId: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      ...(request.verificationRunId
        ? { verificationRunId: request.verificationRunId }
        : {}),
      wakeupJobId: randomUUID(),
      wakeupAttemptId: randomUUID(),
      expiresAt: this.#now() + this.#nonceTtlMs,
      used: false,
      dispatchAcked: false,
    };
    this.#nonces.set(nonce.nonceId, nonce);
    return {
      threadId: nonce.threadId,
      nonceId: nonce.nonceId,
      nonce: nonce.nonce,
      ...(nonce.verificationRunId
        ? { verificationRunId: nonce.verificationRunId }
        : {}),
    };
  }

  async #submit(
    identity: symbol,
    request: Phase0SubmitRequest,
  ): Promise<{
    ok: true;
    threadId: string;
    nonceId: string;
    hostDispatch: Phase0AuthorizedHostDispatch;
  }> {
    this.#assertChannel(identity);
    this.#assertThreadBinding(request);
    if (request.caller !== "app") {
      return supervisorError(
        "model_invocation_forbidden",
        "private submit is callable only by the MCP App",
      );
    }
    const settled = this.#settled.get(request.nonceId);
    if (settled) {
      if (
        settled.threadId !== request.sourceThreadId
        || settled.verificationRunId !== request.verificationRunId
      ) {
        return supervisorError(
          "source_thread_mismatch",
          "settled nonce belongs to another binding",
        );
      }
      return supervisorError(
        "dispatch_settled",
        "acknowledged Host dispatch is settled and cannot be sent again",
      );
    }
    const nonce = this.#nonces.get(request.nonceId);
    if (!nonce || nonce.nonce !== request.nonce) {
      return supervisorError("nonce_invalid", "nonce is unknown or invalid");
    }
    if (nonce.threadId !== request.sourceThreadId) {
      return supervisorError(
        "source_thread_mismatch",
        "nonce belongs to another source thread",
      );
    }
    if (nonce.verificationRunId !== request.verificationRunId) {
      return supervisorError(
        "verification_run_mismatch",
        "nonce belongs to another verification run",
      );
    }
    if (this.#now() > nonce.expiresAt) {
      nonce.nonce = "";
      this.#nonces.delete(nonce.nonceId);
      return supervisorError("nonce_expired", "nonce has expired");
    }
    if (
      (request.wakeupJobId === undefined)
        !== (request.wakeupAttemptId === undefined)
      || (
        nonce.verificationRunId !== undefined
        && request.wakeupJobId === undefined
      )
      || (
        request.wakeupJobId !== undefined
        && (
          !/^[0-9a-f-]{36}$/i.test(request.wakeupJobId)
          || !/^[0-9a-f-]{36}$/i.test(request.wakeupAttemptId!)
        )
      )
    ) {
      return supervisorError(
        "durable_wakeup_identity_invalid",
        "durable wakeup job and attempt identities must be paired UUIDs",
      );
    }
    if (nonce.used) {
      if (nonce.dispatchAcked) {
        return supervisorError(
          "dispatch_settled",
          "acknowledged Host dispatch is settled and cannot be sent again",
        );
      }
      if (
        nonce.verificationRunId
        && request.wakeupJobId === nonce.wakeupJobId
        && request.wakeupAttemptId === nonce.wakeupAttemptId
      ) {
        const hostDispatch = this.#signedDispatch(nonce);
        return {
          ok: true,
          threadId: nonce.threadId,
          nonceId: nonce.nonceId,
          hostDispatch,
        };
      }
      return supervisorError(
        nonce.verificationRunId
          ? "nonce_replay_mismatch"
          : "nonce_reused",
        "consumed nonce replay does not match its canonical durable dispatch",
      );
    }
    if (request.wakeupJobId && request.wakeupAttemptId) {
      nonce.wakeupJobId = request.wakeupJobId;
      nonce.wakeupAttemptId = request.wakeupAttemptId;
    }
    nonce.used = true;
    const dispatch = this.#signedDispatch(nonce);
    return {
      ok: true,
      threadId: nonce.threadId,
      nonceId: nonce.nonceId,
      hostDispatch: dispatch,
    };
  }

  async #revoke(
    identity: symbol,
    request: Phase0RevokeRequest,
  ): Promise<{ ok: true; nonceId: string }> {
    this.#assertChannel(identity);
    this.#assertThreadBinding(request);
    const nonce = this.#nonces.get(request.nonceId);
    if (
      !nonce
      || nonce.nonce !== request.nonce
      || nonce.threadId !== request.sourceThreadId
      || nonce.verificationRunId !== request.verificationRunId
      || nonce.used
    ) {
      return supervisorError(
        "nonce_revoke_invalid",
        "only an unused nonce may be revoked by its original binding",
      );
    }
    nonce.nonce = "";
    this.#nonces.delete(nonce.nonceId);
    return { ok: true, nonceId: nonce.nonceId };
  }

  async #ack(
    identity: symbol,
    request: Phase0DispatchAckRequest,
  ): Promise<{ ok: true; wakeupJobId: string; duplicate: boolean }> {
    this.#assertChannel(identity);
    const nonce = this.#nonces.get(request.nonceId);
    const tombstone = this.#settled.get(request.nonceId);
    if (tombstone) {
      if (
        request.caller !== "app"
        || tombstone.threadId !== request.sourceThreadId
        || tombstone.threadId !== request.threadId
        || tombstone.wakeupJobId !== request.wakeupJobId
        || tombstone.wakeupAttemptId !== request.wakeupAttemptId
        || tombstone.verificationRunId !== request.verificationRunId
      ) {
        return supervisorError(
          "dispatch_ack_invalid",
          "settled Host acknowledgement binding is invalid",
        );
      }
      const expected = this.#signedDispatch(tombstone);
      if (
        this.#now() > expected.expiresAt
        || request.expiresAt !== expected.expiresAt
        || request.markerMessage !== expected.markerMessage
        || request.authorizationTag.length !== expected.authorizationTag.length
        || !timingSafeEqual(
          Buffer.from(request.authorizationTag),
          Buffer.from(expected.authorizationTag),
        )
      ) {
        return supervisorError(
          "dispatch_ack_stale",
          "settled Host acknowledgement is stale or forged",
        );
      }
      return {
        ok: true,
        wakeupJobId: tombstone.wakeupJobId,
        duplicate: true,
      };
    }
    if (
      request.caller !== "app"
      || !nonce
      || !nonce.used
      || nonce.threadId !== request.sourceThreadId
      || nonce.threadId !== request.threadId
      || nonce.wakeupJobId !== request.wakeupJobId
      || nonce.wakeupAttemptId !== request.wakeupAttemptId
      || nonce.verificationRunId !== request.verificationRunId
    ) {
      return supervisorError(
        "dispatch_ack_invalid",
        "Host dispatch acknowledgement is not bound to the consumed submit",
      );
    }
    const expected = this.#signedDispatch(nonce);
    if (
      this.#now() > expected.expiresAt
      || request.expiresAt !== expected.expiresAt
      || request.markerMessage !== expected.markerMessage
      || request.authorizationTag.length !== expected.authorizationTag.length
      || !timingSafeEqual(
        Buffer.from(request.authorizationTag),
        Buffer.from(expected.authorizationTag),
      )
    ) {
      return supervisorError(
        "dispatch_ack_stale",
        "Host dispatch acknowledgement is stale or forged",
      );
    }
    const duplicate = nonce.dispatchAcked;
    nonce.dispatchAcked = true;
    const tombstoneValue: SettledNonceTombstone = {
      threadId: nonce.threadId,
      nonceId: nonce.nonceId,
      ...(nonce.verificationRunId
        ? { verificationRunId: nonce.verificationRunId }
        : {}),
      wakeupJobId: nonce.wakeupJobId,
      wakeupAttemptId: nonce.wakeupAttemptId,
      expiresAt: nonce.expiresAt,
      settledAt: this.#now(),
    };
    nonce.nonce = "";
    this.#nonces.delete(nonce.nonceId);
    this.#settled.set(nonce.nonceId, tombstoneValue);
    while (this.#settled.size > this.#maxTombstones) {
      const oldest = this.#settled.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#settled.delete(oldest);
    }
    return {
      ok: true,
      wakeupJobId: nonce.wakeupJobId,
      duplicate,
    };
  }

  #signedDispatch(
    nonce: Pick<
      StoredNonce,
      | "threadId"
      | "nonceId"
      | "verificationRunId"
      | "wakeupJobId"
      | "wakeupAttemptId"
      | "expiresAt"
    >,
  ): Phase0AuthorizedHostDispatch {
    const expiresAt = nonce.expiresAt;
    const markerMessage = [
      "STAGEPASS_PHASE0_WAKEUP",
      nonce.threadId,
      nonce.nonceId,
      nonce.wakeupJobId,
      nonce.wakeupAttemptId,
    ].join(" ");
    const body = JSON.stringify({
      threadId: nonce.threadId,
      nonceId: nonce.nonceId,
      verificationRunId: nonce.verificationRunId,
      wakeupJobId: nonce.wakeupJobId,
      wakeupAttemptId: nonce.wakeupAttemptId,
      markerMessage,
      expiresAt,
    });
    return {
      threadId: nonce.threadId,
      nonceId: nonce.nonceId,
      ...(nonce.verificationRunId
        ? { verificationRunId: nonce.verificationRunId }
        : {}),
      wakeupJobId: nonce.wakeupJobId,
      wakeupAttemptId: nonce.wakeupAttemptId,
      markerMessage,
      expiresAt,
      authorizationTag: createHmac("sha256", this.#secret)
        .update(body)
        .digest("base64url"),
    };
  }

  #assertChannel(identity: symbol): void {
    if (!this.#protectedChannels.has(identity)) {
      supervisorError(
        "submit_auth_channel_unavailable",
        "caller lacks the inherited protected authorization channel",
      );
    }
  }

  #cleanup(): void {
    const now = this.#now();
    for (const [nonceId, nonce] of this.#nonces) {
      if (now > nonce.expiresAt) {
        nonce.nonce = "";
        this.#nonces.delete(nonceId);
      }
    }
    for (const [nonceId, tombstone] of this.#settled) {
      if (now > tombstone.expiresAt) this.#settled.delete(nonceId);
    }
    for (const [threadId, history] of this.#mintHistory) {
      const retained = history.filter((at) => now - at < 60_000);
      if (retained.length > 0) this.#mintHistory.set(threadId, retained);
      else this.#mintHistory.delete(threadId);
    }
  }

  #assertThreadBinding(request: Phase0MintRequest): void {
    if (!request.sourceThreadId) {
      supervisorError(
        "source_thread_mismatch",
        "Host source-thread attestation is required",
      );
    }
    if (request.sourceThreadId !== request.requestedThreadId) {
      supervisorError(
        "source_thread_mismatch",
        "requested thread does not match Host source-thread attestation",
      );
    }
  }
}

interface ChannelRequest {
  id: string;
  op: "mint" | "revoke" | "submit" | "ack";
  body:
    | Phase0MintRequest
    | Phase0RevokeRequest
    | Phase0SubmitRequest
    | Phase0DispatchAckRequest;
}

const AUTH_MAX_FRAME_BYTES = 64 * 1024;
const AUTH_MAX_BUFFER_BYTES = 128 * 1024;
const AUTH_MAX_INFLIGHT = 64;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;

export function bindAuthorizationChannel(
  stream: Duplex,
  channel: Phase0AuthorizationChannel,
): void {
  let buffer = "";
  let inflight = 0;
  let closed = false;
  const closeMalformed = (code: string) => {
    if (closed) return;
    closed = true;
    stream.destroy(new Error(code));
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > AUTH_MAX_BUFFER_BYTES) {
      closeMalformed("authorization_buffer_limit");
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > AUTH_MAX_FRAME_BYTES) {
        closeMalformed("authorization_frame_limit");
        return;
      }
      if (inflight >= AUTH_MAX_INFLIGHT) {
        closeMalformed("authorization_inflight_limit");
        return;
      }
      inflight += 1;
      void (async () => {
        let request: ChannelRequest | undefined;
        try {
          request = JSON.parse(line) as ChannelRequest;
          if (
            !request
            || typeof request.id !== "string"
            || !["mint", "revoke", "submit", "ack"].includes(request.op)
          ) {
            closeMalformed("authorization_frame_invalid");
            return;
          }
          const operation = request.op === "mint"
            ? channel.mint(request.body as Phase0MintRequest)
            : request.op === "revoke"
              ? channel.revoke(request.body as Phase0RevokeRequest)
              : request.op === "submit"
                ? channel.submit(request.body as Phase0SubmitRequest)
                : channel.ack(request.body as Phase0DispatchAckRequest);
          let timeout: NodeJS.Timeout | undefined;
          const result = await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("authorization_request_timeout")),
                AUTH_REQUEST_TIMEOUT_MS,
              );
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          if (closed) return;
          stream.write(`${JSON.stringify({
            id: request.id,
            ok: true,
            result,
          })}\n`);
        } catch (error) {
          if (error instanceof SyntaxError) {
            closeMalformed("authorization_frame_invalid");
            return;
          }
          const code = error instanceof Phase0SupervisorError
            ? error.code
            : error instanceof Error
                && error.message === "authorization_request_timeout"
              ? "authorization_request_timeout"
              : "desktop_protocol_invalid";
          if (closed) return;
          stream.write(`${JSON.stringify({
            id: request?.id ?? "",
            ok: false,
            error: { code },
          })}\n`);
        } finally {
          inflight -= 1;
        }
      })();
    }
  });
  stream.once("end", () => {
    closed = true;
  });
  stream.once("close", () => {
    closed = true;
  });
  stream.once("error", () => {
    closed = true;
  });
}

function isDuplexStream(value: unknown): value is Duplex {
  return (
    typeof value === "object"
    && value !== null
    && "write" in value
    && typeof value.write === "function"
    && "on" in value
    && typeof value.on === "function"
  );
}

export function runPhase0Supervisor(
  probe: Phase0LaunchAttestationProbe =
    defaultPhase0LaunchAttestationProbe(),
): void {
  const verifiedLaunch = attestPhase0CodexLaunch(probe);
  const serverPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "server.mjs",
  );
  const supervisor = new Phase0ServerChildSupervisor(verifiedLaunch, {
    command: process.execPath,
    args: [serverPath],
  });
  supervisor.onTerminal = (code) => {
    process.exitCode = code;
  };
  supervisor.start();
  process.once("SIGTERM", () => {
    void supervisor.stop("SIGTERM");
  });
  process.once("SIGINT", () => {
    void supervisor.stop("SIGINT");
  });
}

export interface Phase0ServerChildSupervisorOptions {
  command: string;
  args: string[];
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  maxRestarts?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
}

/**
 * Long-lived, launch-attested owner of the protected broker. Server children
 * are disposable: every abnormal exit gets a fresh process and FD 3, while
 * the already-attested supervisor retains the signing secret and nonce state.
 */
export class Phase0ServerChildSupervisor {
  readonly #channel: Phase0AuthorizationChannel;
  readonly #options: Required<
    Pick<
      Phase0ServerChildSupervisorOptions,
      "maxRestarts" | "restartBackoffMs" | "maxRestartBackoffMs"
    >
  > & Phase0ServerChildSupervisorOptions;
  #child: ReturnType<typeof spawn> | null = null;
  #generation = 0;
  #restartCount = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #started = false;
  #stopPromise: Promise<void> | null = null;
  #terminalReported = false;
  #hostListenersAttached = false;
  readonly #hostInput: Readable;
  readonly #onHostEnd = () => {
    void this.#requestStop(0, "SIGTERM", 1_000);
  };
  readonly #onHostFinish = () => {
    void this.#requestStop(0, "SIGTERM", 1_000);
  };
  readonly #onHostClose = () => {
    void this.#requestStop(0, "SIGTERM", 1_000);
  };
  readonly #onHostError = () => {
    void this.#requestStop(1, "SIGTERM", 1_000);
  };
  readonly #generationWaiters = new Set<{
    target: number;
    resolve: (pid: number) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  onTerminal: ((code: number) => void) | null = null;

  constructor(
    verifiedLaunch: Phase0VerifiedLaunch,
    options: Phase0ServerChildSupervisorOptions,
  ) {
    const broker = new Phase0AuthorizationBroker(verifiedLaunch);
    this.#channel = broker.createProtectedChannel();
    this.#options = {
      ...options,
      maxRestarts: options.maxRestarts ?? 3,
      restartBackoffMs: options.restartBackoffMs ?? 50,
      maxRestartBackoffMs: options.maxRestartBackoffMs ?? 1_000,
    };
    this.#hostInput = options.input ?? process.stdin;
  }

  get generation(): number {
    return this.#generation;
  }

  get childPid(): number | null {
    return this.#child?.pid ?? null;
  }

  get hasPendingRestart(): boolean {
    return this.#restartTimer !== null;
  }

  start(): void {
    if (this.#started) {
      throw new Error("Phase 0 Server child supervisor already started");
    }
    this.#started = true;
    this.#attachHostLifecycle();
    this.#spawnChild();
  }

  waitForGeneration(target: number, timeoutMs = 5_000): Promise<number> {
    if (this.#generation >= target && this.childPid) {
      return Promise.resolve(this.childPid);
    }
    return new Promise<number>((resolve, reject) => {
      const waiter = {
        target,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#generationWaiters.delete(waiter);
          reject(new Error(`Phase 0 Server generation ${target} timed out`));
        }, timeoutMs),
      };
      this.#generationWaiters.add(waiter);
    });
  }

  stop(signal: NodeJS.Signals = "SIGTERM", graceMs = 1_000): Promise<void> {
    return this.#requestStop(0, signal, graceMs);
  }

  #requestStop(
    terminalCode: number,
    signal: NodeJS.Signals,
    graceMs: number,
  ): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    this.#stopPromise = this.#stopCurrentChild(signal, graceMs)
      .finally(() => {
        this.#detachHostLifecycle();
        this.#rejectWaiters("Phase 0 Server supervisor stopped");
        this.#reportTerminal(terminalCode);
      });
    return this.#stopPromise;
  }

  async #stopCurrentChild(
    signal: NodeJS.Signals,
    graceMs: number,
  ): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      this.#hostInput.unpipe(child.stdin!);
      child.stdin?.end();
      child.kill(signal);
    });
  }

  #spawnChild(): void {
    if (this.#stopping) return;
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^STAGEPASS_PHASE0_(?:AUTH|SECRET|TOKEN)/.test(key)) {
        delete childEnv[key];
      }
    }
    const child = spawn(this.#options.command, this.#options.args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: childEnv,
    } as SpawnOptions);
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("failed to create MCP stdio pipes");
    }
    this.#child = child;
    this.#generation += 1;
    const input = this.#hostInput;
    const output = this.#options.output ?? process.stdout;
    const errorOutput = this.#options.errorOutput ?? process.stderr;
    input.pipe(child.stdin, { end: false });
    child.stdout.pipe(output, { end: false });
    child.stderr?.pipe(errorOutput, { end: false });
    const protectedStream = child.stdio[3];
    if (!isDuplexStream(protectedStream)) {
      child.kill();
      throw new Error("failed to create inherited protected channel");
    }
    bindAuthorizationChannel(protectedStream, this.#channel);
    for (const waiter of this.#generationWaiters) {
      if (waiter.target <= this.#generation && child.pid) {
        clearTimeout(waiter.timer);
        this.#generationWaiters.delete(waiter);
        waiter.resolve(child.pid);
      }
    }
    child.once("exit", (code, signal) => {
      input.unpipe(child.stdin!);
      child.stdout?.unpipe(output);
      child.stderr?.unpipe(errorOutput);
      if (this.#child === child) this.#child = null;
      if (this.#stopping) return;
      const abnormal = code !== 0 || signal !== null;
      if (!abnormal) {
        this.#stopping = true;
        this.#detachHostLifecycle();
        this.#reportTerminal(0);
        this.#rejectWaiters("Phase 0 Server exited normally");
        return;
      }
      if (this.#restartCount >= this.#options.maxRestarts) {
        this.#stopping = true;
        this.#detachHostLifecycle();
        this.#reportTerminal(code ?? 1);
        this.#rejectWaiters("Phase 0 Server crash-loop limit reached");
        return;
      }
      const delay = Math.min(
        this.#options.restartBackoffMs * (2 ** this.#restartCount),
        this.#options.maxRestartBackoffMs,
      );
      this.#restartCount += 1;
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        this.#spawnChild();
      }, delay);
    });
  }

  #attachHostLifecycle(): void {
    if (this.#hostListenersAttached) return;
    this.#hostListenersAttached = true;
    this.#hostInput.once("end", this.#onHostEnd);
    this.#hostInput.once("finish", this.#onHostFinish);
    this.#hostInput.once("close", this.#onHostClose);
    this.#hostInput.once("error", this.#onHostError);
  }

  #detachHostLifecycle(): void {
    if (!this.#hostListenersAttached) return;
    this.#hostListenersAttached = false;
    this.#hostInput.off("end", this.#onHostEnd);
    this.#hostInput.off("finish", this.#onHostFinish);
    this.#hostInput.off("close", this.#onHostClose);
    this.#hostInput.off("error", this.#onHostError);
  }

  #reportTerminal(code: number): void {
    if (this.#terminalReported) return;
    this.#terminalReported = true;
    this.onTerminal?.(code);
  }

  #rejectWaiters(message: string): void {
    for (const waiter of this.#generationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.#generationWaiters.clear();
  }
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runPhase0Supervisor();
}
