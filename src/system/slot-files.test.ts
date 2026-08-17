import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { join } from "node:path";

import { BLOCKER_SHAPE, QUESTION_SHAPE } from "../domain/round-slots";

const OPTIONS = ["同意", "不同意", "先接受风险", "我自己说"];
import { createSlotFiles, DEFAULT_SLOT_ROOT } from "./slot-files";

const HEAD = {
  changeId: "CHG-002", phase: "PRD" as const, round: 7, role: "blue" as const,
  artifacts: ["docs/stagepass/CHG-002/PRD-r7.md"], shape: BLOCKER_SHAPE,
};

const withRoot = (body: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "stagepass-slot-files-"));
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

describe("Slot files on disk", () => {
  it("lays a sheet the model can open and reads it back", () => {
    withRoot((root) => {
      const files = createSlotFiles({ root });
      const path = files.lay(HEAD);
      assert.equal(existsSync(path), true);

      const doc = JSON.parse(readFileSync(path, "utf8"));
      doc.slots[0].severity = "P1";
      doc.slots[0].title = "验收标准不可测";
      writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");

      const result = files.collect(HEAD);
      assert.equal(result.ok, true);
      assert.equal(result.filled.length, 1);
      assert.equal(result.filled[0]!.title, "验收标准不可测");
    });
  });

  it("keeps every seat, round and side in its own file", () => {
    withRoot((root) => {
      const files = createSlotFiles({ root });
      const seen = new Set([
        files.pathOf(HEAD),
        files.pathOf({ ...HEAD, role: "red" }),
        files.pathOf({ ...HEAD, round: 8 }),
        files.pathOf({ ...HEAD, phase: "Spec" }),
        files.pathOf({ ...HEAD, changeId: "CHG-001" }),
      ]);
      assert.equal(seen.size, 5, "任何一维不同都必须是不同的文件");
    });
  });

  it("says the sheet is missing rather than reporting an empty round", () => {
    // 「模型没填」和「文件被清了」在账本上必须分得开。
    withRoot((root) => {
      const result = createSlotFiles({ root }).collect(HEAD);
      assert.equal(result.ok, false);
      assert.match(result.reason, /没有/);
    });
  });

  it("survives being laid twice, because a replay must be idempotent", () => {
    withRoot((root) => {
      const files = createSlotFiles({ root });
      const first = files.lay(HEAD);
      const before = readFileSync(first, "utf8");
      const second = files.lay(HEAD);
      assert.equal(second, first);
      assert.equal(readFileSync(second, "utf8"), before);
    });
  });

  it("does not put the sheet anywhere the system will clean up", () => {
    // 默认落点必须是持久的。临时目录被清掉之后，「模型没填」和「文件被清了」
    // 在账本上长得一模一样，而这两件事人要做的完全不同。
    assert.doesNotMatch(DEFAULT_SLOT_ROOT, /\/var\/folders|^\/tmp\//);
    assert.match(DEFAULT_SLOT_ROOT, /\.stagepass\/rounds$/);
    withRoot((root) => {
      assert.match(createSlotFiles({ root }).pathOf(HEAD), /CHG-002\/PRD\/r7-blue\.json$/);
    });
  });

  it("discards a sheet only when the round is finished with it", () => {
    withRoot((root) => {
      const files = createSlotFiles({ root });
      const path = files.lay(HEAD);
      files.discard(HEAD);
      assert.equal(existsSync(path), false);
      assert.doesNotThrow(() => { files.discard(HEAD); }, "清两次不该炸");
    });
  });

  it("carries the question shape onto disk too", () => {
    withRoot((root) => {
      const files = createSlotFiles({ root });
      const head = { ...HEAD, shape: QUESTION_SHAPE, options: OPTIONS };
      const doc = JSON.parse(readFileSync(files.lay(head), "utf8"));
      assert.deepEqual({ ...doc.slots[0] }, { id: "G-01", question: null, why: null });
      assert.equal(Array.isArray(doc.options), true);
    });
  });
});
