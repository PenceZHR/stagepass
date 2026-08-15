import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createPromptFiles } from "./prompt-file";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "stagepass-prompt-file-test-"));
}

describe("prompt files", () => {
  it("keeps the complete prompt in a private file and sends only a short envelope", () => {
    const root = temporaryRoot();
    try {
      const prompt = [
        "# 完整任务",
        "先读取 StagePass rubric，再逐项执行并校验。",
        "这个标记只能存在于文件：PROMPT_BODY_SECRET_7f31",
      ].join("\n");
      const file = createPromptFiles({ root }).create(prompt);

      assert.equal(readFileSync(file.path, "utf8"), prompt);
      assert.equal(statSync(file.path).mode & 0o777, 0o600);
      assert.ok(file.envelope.includes(file.path), "信封必须告诉 TUI 从哪里读完整题面");
      assert.match(file.envelope, /完整读取/);
      assert.ok(!file.envelope.includes("PROMPT_BODY_SECRET_7f31"), "正文泄漏进了信封");
      assert.ok(file.envelope.length < 300, "信封应该是短指令，不是第二份提示词");

      file.release();
      assert.equal(existsSync(file.path), false);
      file.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects blank prompts before creating a file", () => {
    const root = temporaryRoot();
    try {
      assert.throws(() => createPromptFiles({ root }).create(" \n\t"), /blank/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects NUL bytes before creating a file", () => {
    const root = temporaryRoot();
    try {
      assert.throws(() => createPromptFiles({ root }).create("before\0after"), /NUL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
