import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { join } from "node:path";

describe("panel production entry", () => {
  it("loads under tsx CommonJS before validating arguments", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "scripts", "panel.ts"), "--effort", "invalid"],
      { encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--effort 只能是/);
    assert.doesNotMatch(result.stderr, /Top-level await|Transform failed/);
  });
});
