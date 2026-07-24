import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildManagedAiCallerInventory } from "./codex-managed-ai-caller-inventory";

describe("Codex managed AI caller inventory", () => {
  it("classifies every production caller through a logical resolver or guarded rollback", () => {
    const inventory = buildManagedAiCallerInventory(process.cwd());
    assert.deepEqual(inventory.unclassified, []);
    for (const caller of inventory.callers) {
      assert.equal(
        caller.mode === "logical_resolver"
          || (caller.mode === "rollback_adapter" && caller.guard === "desktopBridge=off"),
        true,
        caller.file,
      );
    }
    assert.equal(inventory.byFile["server/services/prd-service.ts"]?.mode, "logical_resolver");
    assert.equal(inventory.byFile["server/services/context-init-service.ts"]?.mode, "logical_resolver");
    assert.equal(inventory.byFile["server/services/crash-resilience-harness.ts"]?.mode, "logical_resolver");
  });
});
