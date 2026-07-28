import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES } from "./codex-desktop-bridge-types";
import { createGatewayFollowerTransport } from "./codex-gateway-follower-transport";
import {
  CodexSessionGatewayError,
  type CodexSessionGateway,
} from "./codex-session-gateway";

type StartCall = Parameters<CodexSessionGateway["startTurn"]>[0];

function fakeGateway(overrides: Partial<{
  connect: () => Promise<void>;
  startTurn: (input: StartCall) => Promise<{ turnId?: string }>;
  interruptTurn: (threadId: string) => Promise<unknown>;
}> = {}) {
  const startCalls: StartCall[] = [];
  const interrupted: string[] = [];
  const gateway = {
    connect: overrides.connect ?? (async () => {}),
    startTurn: overrides.startTurn
      ?? (async (input: StartCall) => {
        startCalls.push(input);
        return { turnId: "turn-1" };
      }),
    interruptTurn: overrides.interruptTurn
      ?? (async (threadId: string) => {
        interrupted.push(threadId);
        return {};
      }),
  } as unknown as CodexSessionGateway;
  return { gateway, startCalls, interrupted };
}

const REQUEST = {
  threadId: "thread-1",
  cwd: "/tmp/workspace",
  prompt: "do the thing",
  approvalPolicy: "never" as const,
  sandboxMode: "workspace-write" as const,
};

describe("gateway follower transport", () => {
  it("reports the capabilities the bridge gates on", async () => {
    const { gateway } = fakeGateway();
    const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });

    const probe = await transport.probe();

    for (const capability of REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES) {
      assert.ok(
        probe.protocolCapabilities.includes(capability),
        `missing ${capability}`,
      );
    }
    // The fingerprint must NOT impersonate a Desktop bundle: callers that key
    // off it are entitled to know a turn did not come from Desktop.
    assert.doesNotMatch(probe.protocolFingerprint, /com\.openai\.codex/);
  });

  it("refuses to report capabilities when app-server will not start", async () => {
    const { gateway } = fakeGateway({
      connect: async () => {
        throw new CodexSessionGatewayError("APP_SERVER_UNAVAILABLE", "no binary");
      },
    });
    const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });

    await assert.rejects(() => transport.probe(), /no binary/);
  });

  it("forwards the schema and sandbox the caller asked for", async () => {
    const { gateway, startCalls } = fakeGateway();
    const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });
    const outputSchema = { type: "object", required: ["verdict"] };

    await transport.startFollowerTurn({
      ...REQUEST,
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
      outputSchema,
    });

    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0].outputSchema, outputSchema);
    assert.equal(startCalls[0].sandboxMode, "workspace-write");
    assert.equal(startCalls[0].cwd, "/tmp/workspace");
    assert.equal(startCalls[0].model, "gpt-5.2-codex");
    assert.equal(startCalls[0].effort, "high");
  });

  it("reports no-client-found rather than throwing when Codex is absent", async () => {
    for (const code of ["APP_SERVER_UNAVAILABLE", "APP_SERVER_DISCONNECTED"] as const) {
      const { gateway } = fakeGateway({
        startTurn: async () => {
          throw new CodexSessionGatewayError(code, code);
        },
      });
      const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });

      // The pipeline retries this condition, so it is a value; everything else
      // must stay an exception rather than being flattened into it.
      assert.deepEqual(await transport.startFollowerTurn(REQUEST), {
        status: "no-client-found",
      });
    }
  });

  it("lets an unrelated failure surface instead of masking it as no-client", async () => {
    const { gateway } = fakeGateway({
      startTurn: async () => {
        throw new CodexSessionGatewayError("REQUEST_TIMEOUT", "took too long");
      },
    });
    const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });

    await assert.rejects(
      () => transport.startFollowerTurn(REQUEST),
      /took too long/,
    );
  });

  it("treats a missing turn id as a protocol failure", async () => {
    const { gateway } = fakeGateway({ startTurn: async () => ({}) });
    const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });

    // Without an id the caller can neither journal nor interrupt the turn, so
    // inventing one would hide a real break.
    await assert.rejects(
      () => transport.startFollowerTurn(REQUEST),
      /no turn id/,
    );
  });

  it("opens the deep link it is handed without shelling out in tests", async () => {
    const { gateway } = fakeGateway();
    const opened: string[] = [];
    const transport = createGatewayFollowerTransport({
      gatewayFor: () => gateway,
      openUrl: async (url) => {
        opened.push(url);
      },
    });

    await transport.openThreadDeepLink({ url: "codex://threads/thread-1" });

    assert.deepEqual(opened, ["codex://threads/thread-1"]);
  });

  it("routes each turn to the gateway for its declared tool surface", async () => {
    const full = fakeGateway();
    const isolated = fakeGateway();
    const asked: string[] = [];
    const transport = createGatewayFollowerTransport({
      gatewayFor: (surface) => {
        asked.push(surface);
        return surface === "full" ? full.gateway : isolated.gateway;
      },
    });

    await transport.startFollowerTurn({
      ...REQUEST,
      toolSurface: "no-stagepass-plugins",
    });
    await transport.startFollowerTurn({ ...REQUEST, toolSurface: "full" });
    // Absent means the surface that existed before contracts did.
    await transport.startFollowerTurn(REQUEST);

    assert.equal(isolated.startCalls.length, 1);
    assert.equal(full.startCalls.length, 2);
    assert.deepEqual(asked.slice(1), ["no-stagepass-plugins", "full", "full"]);
  });

  it("interrupts by thread id", async () => {
    const { gateway, interrupted } = fakeGateway();
    const transport = createGatewayFollowerTransport({ gatewayFor: () => gateway });

    await transport.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });

    assert.deepEqual(interrupted, ["thread-1"]);
  });
});
