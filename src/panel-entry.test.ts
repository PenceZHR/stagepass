import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
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

  it("does not create or migrate a database when the port is already owned", async () => {
    const owner = createServer((_request, response) => response.end());
    await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
    const port = (owner.address() as AddressInfo).port;
    const dbPath = join(mkdtempSync(join(tmpdir(), "stagepass-port-guard-")), "never.db");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "scripts", "panel.ts"),
          "--port",
          String(port),
          "--db",
          dbPath,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EADDRINUSE|already in use/);
      assert.equal(existsSync(dbPath), false);
    } finally {
      owner.closeAllConnections();
      await new Promise<void>((resolve) => owner.close(() => resolve()));
    }
  });
});
