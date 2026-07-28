import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isCodexManagedScopeEnabled,
  readCodexNativeFlags,
} from "./codex-native-flags";

describe("Codex-native flags", () => {
  it("keeps every migration surface disabled by default", () => {
    assert.deepEqual(readCodexNativeFlags({}), {
      desktopBridge: false,
      mcpInteractions: false,
      // The delegated Spec round (judge + sub-agents) is the newer of two live
      // forms, so it ships off like every other migration surface here.
      specJudgeSubAgents: false,
      codexDecisionSurfaceMaster: false,
      codexDecisionPhases: [],
      codexDecisionRolloutError: null,
    });
  });

  it("accepts only the literal on value", () => {
    const enabled = readCodexNativeFlags({
      STAGEPASS_CODEX_DESKTOP_BRIDGE: "on",
      STAGEPASS_MCP_INTERACTIONS: "on",
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
    });
    assert.equal(enabled.desktopBridge, true);
    assert.equal(enabled.mcpInteractions, true);
    assert.equal(enabled.codexDecisionSurfaceMaster, true);

    for (const value of ["true", "ON", "1", "yes", " on "]) {
      const flags = readCodexNativeFlags({
        STAGEPASS_CODEX_DESKTOP_BRIDGE: value,
        STAGEPASS_MCP_INTERACTIONS: value,
        STAGEPASS_CODEX_DECISION_SURFACE: value,
      });
      assert.equal(flags.desktopBridge, false);
      assert.equal(flags.mcpInteractions, false);
      assert.equal(flags.codexDecisionSurfaceMaster, false);
    }
  });

  it("uses the desktop bridge flag for every managed scope", () => {
    const on = readCodexNativeFlags({
      STAGEPASS_CODEX_DESKTOP_BRIDGE: "on",
    });
    for (const scopeKind of [
      "change",
      "project_prd",
      "project_context",
    ] as const) {
      assert.equal(isCodexManagedScopeEnabled(scopeKind, on), true);
    }

    const off = readCodexNativeFlags({});
    assert.equal(isCodexManagedScopeEnabled("change", off), false);
    assert.equal(isCodexManagedScopeEnabled("project_prd", off), false);
    assert.equal(isCodexManagedScopeEnabled("project_context", off), false);
  });
});
