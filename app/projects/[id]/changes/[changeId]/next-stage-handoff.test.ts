import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const hook = fs.readFileSync(
  path.join(root, "app", "projects", "[id]", "changes", "[changeId]", "use-change-commands.ts"),
  "utf8",
);
const orchestration = fs.readFileSync(
  path.join(root, "server", "services", "pipeline-command-orchestration.ts"),
  "utf8",
);

describe("Server-owned command hand-off", () => {
  it("keeps the Web hook limited to explicit operational commands", () => {
    assert.match(hook, /run_spec/);
    assert.match(hook, /retry_spec/);
    assert.doesNotMatch(hook, /approve|reject|waive|adopt|stop_change/);
  });

  it("leaves follow-up orchestration on the Server", () => {
    assert.match(orchestration, /export/);
    assert.doesNotMatch(hook, /setTimeout|sleep|next stage/i);
  });
});
