import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectHumanDecisionAudit } from "./human-decision-audit-projection";

describe("projectHumanDecisionAudit", () => {
  it("preserves a recorded surface", () => {
    assert.deepEqual(projectHumanDecisionAudit({ actorSurface: "codex_mcp_app" }), {
      actorSurface: "codex_mcp_app",
      provenance: "recorded",
    });
  });

  it("labels a historical NULL without mutating it", () => {
    const row = { actorSurface: null };
    assert.deepEqual(projectHumanDecisionAudit(row), {
      actorSurface: "legacy",
      provenance: "historical_null",
    });
    assert.equal(row.actorSurface, null);
  });
});
