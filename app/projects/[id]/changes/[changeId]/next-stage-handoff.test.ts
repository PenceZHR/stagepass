import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startNextStage } from "./use-change-commands";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsSource = readFileSync(resolve(__dirname, "use-change-commands.ts"), "utf-8");

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const originalFetch = globalThis.fetch;

function stubFetch(handlers: Array<(url: string) => { ok: boolean; json: unknown }>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const handler = handlers[Math.min(index++, handlers.length - 1)];
    const { ok, json } = handler(url);
    return { ok, json: async () => json } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

function gateResponse(action: Record<string, unknown>) {
  return { ok: true, json: { status: "PLAN_APPROVED", actions: [action] } };
}

function buildAction(overrides: Record<string, unknown> = {}) {
  return {
    actionId: "run_build",
    phase: "Build",
    label: "开始 Build",
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    warnings: [],
    gateVersion: "7",
    sourceDbHash: "hash-7",
    requiresIdempotencyKey: true,
    requiresProvider: true,
    providerSelectable: true,
    defaultProvider: "codex",
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("approval hand-off to the next stage", () => {
  it("re-reads the contract after the approval and posts the next stage with it", async () => {
    const calls = stubFetch([
      () => gateResponse(buildAction()),
      () => ({ ok: true, json: { success: true, accepted: true } }),
    ]);

    await startNextStage({
      projectId: "PRJ-001",
      changeId: "CHG-001",
      actionId: "run_build",
      endpoint: "implement",
      selectedProvider: "claude",
      setGateStatus: () => {},
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/projects\/PRJ-001\/changes\/CHG-001\/gate$/);
    assert.match(calls[1].url, /\/api\/projects\/PRJ-001\/changes\/CHG-001\/implement$/);
    assert.equal(calls[1].method, "POST");
    // The contract it posts is the one issued after the approval, not the stale
    // pre-approval one -- that drift is what makes a first POST 409.
    assert.equal(calls[1].body?.actionId, "run_build");
    assert.equal(calls[1].body?.expectedGateVersion, "7");
    assert.equal(calls[1].body?.expectedSourceDbHash, "hash-7");
    assert.equal(calls[1].body?.provider, "claude");
  });

  it("surfaces the backend reason instead of leaving the approval to go nowhere", async () => {
    const calls = stubFetch([
      () => gateResponse(buildAction({
        enabled: false,
        reasonCode: "build_base_camp_blocked",
        reason: "Build workspace base camp blocked: Path is not a git repository.",
      })),
    ]);

    await assert.rejects(
      startNextStage({
        projectId: "PRJ-001",
        changeId: "CHG-001",
        actionId: "run_build",
        endpoint: "implement",
        setGateStatus: () => {},
      }),
      /Path is not a git repository/,
    );
    // It must stop before posting: an approval that cannot start Build should say
    // why, not fire a request the backend will refuse.
    assert.equal(calls.length, 1);
  });

  it("leaves the provider off when the action does not take one", async () => {
    const calls = stubFetch([
      () => gateResponse(buildAction({ requiresProvider: false, providerSelectable: false })),
      () => ({ ok: true, json: { success: true } }),
    ]);

    await startNextStage({
      projectId: "PRJ-001",
      changeId: "CHG-001",
      actionId: "run_build",
      endpoint: "implement",
      selectedProvider: "claude",
      setGateStatus: () => {},
    });

    assert.equal(calls[1].body?.provider, undefined);
  });

  it("publishes the refreshed gate so the page stops rendering the stale contract", async () => {
    stubFetch([
      () => gateResponse(buildAction()),
      () => ({ ok: true, json: { success: true } }),
    ]);
    let published: unknown = null;

    await startNextStage({
      projectId: "PRJ-001",
      changeId: "CHG-001",
      actionId: "run_build",
      endpoint: "implement",
      setGateStatus: (next) => { published = next; },
    });

    assert.equal((published as { status?: string })?.status, "PLAN_APPROVED");
  });
});

describe("which approvals hand off", () => {
  // approve_plan serves both the plan approval and the test-plan confirmation,
  // and both land on PLAN_APPROVED. Only the second one continues on its own:
  // approving the plan is followed by a test plan the human asks for.
  it("chains to Build only when the change is leaving TESTPLAN_DONE", () => {
    assert.match(commandsSource, /const chainToBuild = gateStatus\?\.status === "TESTPLAN_DONE";/);
    assert.match(
      commandsSource,
      /if \(chainToBuild\) \{[\s\S]*?actionId: "run_build",[\s\S]*?endpoint: "implement",/,
    );
    // The Spec gate deliberately does not chain; that exclusion must survive.
    assert.match(commandsSource, /if \(gateStatus\.gate !== "spec"\)/);
  });
});
