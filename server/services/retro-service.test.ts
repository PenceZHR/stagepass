import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  appendRetroDebtsToBacklog,
  extractRetroDebtItems,
} from "./retro-service.ts";

describe("retro-service", () => {
  it("extracts bullet items from the retro debt section", () => {
    const items = extractRetroDebtItems(`# Retro

## 本次结果
- shipped

## 技术债务
- 补齐发布前端验收
1. 把 Review 报告结构化

## 其他
- ignored
`);

    assert.deepEqual(items, ["补齐发布前端验收", "把 Review 报告结构化"]);
  });

  it("appends retro debt items to baseline backlog", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "retro-service-"));
    const changeId = "CHG-T34";
    const retroPath = path.join(repoPath, ".ship", "changes", changeId, "retro.md");
    fs.mkdirSync(path.dirname(retroPath), { recursive: true });
    fs.writeFileSync(retroPath, `# Retro

## 后续 backlog 建议
- 增加 release gate 的失败恢复测试
- 记录 merge gate 的人工确认人
`);

    try {
      const result = appendRetroDebtsToBacklog(repoPath, changeId);
      const backlogPath = path.join(repoPath, ".ship", "baseline", "backlog.md");
      const retroContent = fs.readFileSync(retroPath, "utf-8");

      assert.equal(result.appended, 2);
      assert.equal(result.backlogPath, backlogPath);
      assert.equal(retroContent.startsWith("{"), false);
      assert.match(retroContent, /^#/);
      assert.match(fs.readFileSync(backlogPath, "utf-8"), /CHG-T34/);
      assert.match(fs.readFileSync(backlogPath, "utf-8"), /增加 release gate 的失败恢复测试/);
      assert.match(fs.readFileSync(backlogPath, "utf-8"), /记录 merge gate 的人工确认人/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
