import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createProcessOps } from "./process";

describe("system process boundary", () => {
  it("passes arguments literally without invoking a shell", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stagepass-process-test-"));
    const marker = join(directory, "shell-ran");
    const literal = `$(touch ${marker})`;
    try {
      const result = await createProcessOps().run({
        command: "/usr/bin/printf",
        args: ["%s", literal],
      });

      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, literal);
      assert.equal(result.stderr, "");
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes optional stdin and returns a nonzero exit without hiding stderr", async () => {
    const result = await createProcessOps().run({
      command: "/bin/sh",
      args: ["-c", "read value; printf '%s' \"$value\"; printf 'bad' >&2; exit 7"],
      input: "from-stdin\n",
    });

    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "from-stdin");
    assert.equal(result.stderr, "bad");
  });
});
