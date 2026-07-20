import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, shouldPersistProvider } from "./ai-provider-service.ts";

describe("ai-provider-service", () => {
  it("defaults to codex when neither explicit nor stored provider is available", () => {
    assert.equal(resolveProvider(undefined, undefined), "codex");
    assert.equal(resolveProvider(undefined, null), "codex");
  });

  it("uses stored provider when explicit provider is omitted", () => {
    assert.equal(resolveProvider(undefined, "claude"), "claude");
  });

  it("uses explicit provider over stored provider", () => {
    assert.equal(resolveProvider("codex", "claude"), "codex");
  });

  it("persists only when an explicit provider is supplied and saveAsDefault is true", () => {
    assert.equal(shouldPersistProvider("claude", true), true);
    assert.equal(shouldPersistProvider("claude", false), false);
    assert.equal(shouldPersistProvider(undefined, true), false);
  });
});
