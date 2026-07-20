import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

import {
  CODEX_BIN_ENV,
  resolveCodexBin,
  buildCodexArgs,
  createCodexOutputSchemaFile,
} from "./codex-cli-engine";

describe("resolveCodexBin", () => {
  it("returns STAGEPASS_CODEX_BIN when set", () => {
    assert.equal(resolveCodexBin({ [CODEX_BIN_ENV]: "/custom/codex" }), "/custom/codex");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(resolveCodexBin({ [CODEX_BIN_ENV]: "  /custom/codex  " }), "/custom/codex");
  });

  it("falls back to bare `codex` when unset", () => {
    assert.equal(resolveCodexBin({}), "codex");
  });

  it("falls back to bare `codex` when blank", () => {
    assert.equal(resolveCodexBin({ [CODEX_BIN_ENV]: "   " }), "codex");
  });
});

describe("buildCodexArgs", () => {
  it("builds a minimal fresh-run argv with the default sandbox", () => {
    assert.deepEqual(buildCodexArgs({ repoPath: "/repo" }), [
      "exec", "--json",
      "--sandbox", "workspace-write",
      "--cd", "/repo",
      "--skip-git-repo-check",
    ]);
  });

  it("honours an explicit sandbox mode", () => {
    const args = buildCodexArgs({ repoPath: "/repo", sandboxMode: "read-only" });
    assert.deepEqual(args.slice(2, 4), ["--sandbox", "read-only"]);
  });

  it("appends --output-schema when a schema file is given", () => {
    const args = buildCodexArgs({ repoPath: "/repo", outputSchemaFile: "/tmp/s/schema.json" });
    const i = args.indexOf("--output-schema");
    assert.notEqual(i, -1);
    assert.equal(args[i + 1], "/tmp/s/schema.json");
  });

  it("uses `exec resume` with the session id as a trailing positional", () => {
    const args = buildCodexArgs({ repoPath: "/repo", sandboxMode: "read-only", threadId: "th_123" });
    assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
    assert.equal(args[args.length - 1], "th_123");
  });

  it("never resumes a workspace-write run — resume inherits the original session's sandbox, which read-only document stages created", () => {
    const args = buildCodexArgs({ repoPath: "/ws/build-1", sandboxMode: "workspace-write", threadId: "th_docs" });
    assert.deepEqual(args.slice(0, 2), ["exec", "--json"], `expected fresh exec, got: ${JSON.stringify(args)}`);
    assert.deepEqual(args.slice(2, 4), ["--sandbox", "workspace-write"]);
    assert.deepEqual(args.slice(4, 6), ["--cd", "/ws/build-1"]);
    assert.ok(!args.includes("th_docs"), `expected no session id, got: ${JSON.stringify(args)}`);
  });

  it("treats the workspace-write default the same way when a threadId is offered", () => {
    const args = buildCodexArgs({ repoPath: "/ws/build-2", threadId: "th_docs" });
    assert.equal(args[1], "--json");
    assert.ok(!args.includes("resume"));
    assert.ok(!args.includes("th_docs"));
  });

  it("builds a full resume argv for codex 0.144 (exec resume ... <sessionId>)", () => {
    const args = buildCodexArgs({
      repoPath: "/repo",
      sandboxMode: "danger-full-access",
      outputSchemaFile: "/tmp/s/schema.json",
      threadId: "th_9",
    });
    assert.deepEqual(args, [
      "exec", "resume",
      "--json",
      "--skip-git-repo-check",
      "--output-schema", "/tmp/s/schema.json",
      "th_9",
    ]);
  });

  it("never sends --sandbox or --cd on resume — codex 0.144.4's `exec resume --help` has neither, and passing either exits 2 (\"unexpected argument\")", () => {
    const args = buildCodexArgs({
      repoPath: "/repo",
      sandboxMode: "read-only",
      threadId: "th_1",
    });
    assert.ok(!args.includes("--sandbox"), `expected no --sandbox, got: ${JSON.stringify(args)}`);
    assert.ok(!args.includes("--cd"), `expected no --cd, got: ${JSON.stringify(args)}`);
  });

  it("still sends --sandbox and --cd on a fresh (non-resume) run", () => {
    const args = buildCodexArgs({ repoPath: "/repo", sandboxMode: "read-only" });
    assert.deepEqual(args.slice(2, 4), ["--sandbox", "read-only"]);
    assert.deepEqual(args.slice(4, 6), ["--cd", "/repo"]);
  });

  it("never includes the prompt (prompt is written to stdin)", () => {
    const args = buildCodexArgs({ repoPath: "/repo" });
    assert.ok(!args.includes("--prompt"));
  });
});

describe("createCodexOutputSchemaFile", () => {
  it("returns no path and a no-op cleanup for an undefined schema", () => {
    const result = createCodexOutputSchemaFile(undefined);
    assert.equal(result.schemaPath, undefined);
    result.cleanup(); // must not throw
  });

  it("writes the schema JSON and removes it on cleanup", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const result = createCodexOutputSchemaFile(schema);
    const schemaPath = result.schemaPath;
    assert.ok(schemaPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(schemaPath, "utf8")), schema);
    result.cleanup();
    assert.equal(fs.existsSync(schemaPath), false);
  });

  it("rejects non-object schemas", () => {
    assert.throws(() => createCodexOutputSchemaFile([1, 2, 3]));
    assert.throws(() => createCodexOutputSchemaFile("nope"));
    assert.throws(() => createCodexOutputSchemaFile(null));
  });
});
