import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProcessIdentity } from "./process-identity-service";
import { ActiveProviderRegistry } from "./active-provider-registry";

function identity(pid: number, nonce = `nonce-${pid}`): ProcessIdentity {
  return {
    pid,
    ppid: process.pid,
    pgid: process.pid,
    nonce,
    processStartTime: "2026-07-10T00:00:00.000Z",
    cwd: process.cwd(),
    command: ["provider", String(pid)],
  };
}

describe("active provider registry", () => {
  it("registers and unregisters the same entry idempotently", () => {
    const registry = new ActiveProviderRegistry();
    const entry = {
      registrationId: "run-1",
      ownerPid: process.pid,
      identity: identity(4101),
      onStopped() {},
    };

    registry.register(entry);
    registry.register(entry);
    assert.equal(registry.size, 1);

    registry.unregister(entry.registrationId);
    registry.unregister(entry.registrationId);
    assert.equal(registry.size, 0);
  });

  it("signals only local entries whose process identity still matches", async () => {
    const signaled: string[] = [];
    const stopped: string[] = [];
    const registry = new ActiveProviderRegistry({
      currentPid: 7000,
      async validateIdentity(expected) {
        return expected.nonce === "stale"
          ? { ok: false as const, reason: "pid_reused" as const }
          : { ok: true as const, observed: expected };
      },
      signalProvider(pid, signal) {
        signaled.push(`${pid}:${signal}`);
      },
    });

    registry.register({
      registrationId: "local-valid",
      ownerPid: 7000,
      identity: identity(4102),
      onStopped(signal) {
        stopped.push(`local-valid:${signal}`);
      },
    });
    registry.register({
      registrationId: "foreign-valid",
      ownerPid: 7001,
      identity: identity(4103),
      onStopped(signal) {
        stopped.push(`foreign-valid:${signal}`);
      },
    });
    registry.register({
      registrationId: "local-stale",
      ownerPid: 7000,
      identity: identity(4104, "stale"),
      onStopped(signal) {
        stopped.push(`local-stale:${signal}`);
      },
    });

    const handled = await registry.handleSignal("SIGTERM");

    assert.equal(handled, 1);
    assert.deepEqual(signaled, ["4102:SIGTERM"]);
    assert.deepEqual(stopped, ["local-valid:SIGTERM"]);
    assert.equal(registry.size, 2);
  });

  it("treats signal and stopped persistence failures as best effort", async () => {
    const attempts: string[] = [];
    const registry = new ActiveProviderRegistry({
      async validateIdentity(expected) {
        return { ok: true as const, observed: expected };
      },
      signalProvider(pid) {
        attempts.push(`signal:${pid}`);
        if (pid === 4105) throw new Error("already exited");
      },
    });

    registry.register({
      registrationId: "signal-fails",
      ownerPid: process.pid,
      identity: identity(4105),
      async onStopped() {
        attempts.push("stopped:4105");
        throw new Error("database unavailable");
      },
    });
    registry.register({
      registrationId: "next-entry",
      ownerPid: process.pid,
      identity: identity(4106),
      onStopped() {
        attempts.push("stopped:4106");
      },
    });

    const handled = await registry.handleSignal("SIGINT");

    assert.equal(handled, 2);
    assert.deepEqual(attempts, [
      "signal:4105",
      "stopped:4105",
      "signal:4106",
      "stopped:4106",
    ]);
    assert.equal(registry.size, 0);
  });
});
