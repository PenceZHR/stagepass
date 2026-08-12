import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseExcludes, selectCode } from "./code-selection";

/**
 * L0 · 「哪些文件算关键代码」的判据（图谱 spec 2026-08-12）。
 *
 * 判据只有一处实现，所以测试只打这一处 —— 每一条都是真项目上量出来的形状：
 * demo 555 个跟踪文件里代码只占 21%，`.meta` 150 个、`archive/` 149 个。
 */
describe("L0 · 判据：什么算代码", () => {
  it("脚本后缀进场景，其余归门", () => {
    const picked = selectCode([
      "src/a.ts", "src/b.tsx", "tools/c.mjs", "web/d.js",
      "README.md", "assets/art/e.png",
    ], []);
    assert.deepEqual(picked.code,
      ["src/a.ts", "src/b.tsx", "tools/c.mjs", "web/d.js"]);
  });

  it("**`.d.ts` 不是代码** —— 声明没有实现，图上没它的事", () => {
    const picked = selectCode(["src/a.ts", "src/globals.d.ts"], []);
    assert.deepEqual(picked.code, ["src/a.ts"]);
  });

  it("勾掉的目录整个不进场景 —— 连它下面的代码一起", () => {
    const picked = selectCode(
      ["src/a.ts", "archive/old/b.ts", "archive/c.ts"],
      ["archive"],
    );
    assert.deepEqual(picked.code, ["src/a.ts"]);
  });

  it("**勾掉 ≠ 消失** —— 被勾掉的代码归到门里，门还在", () => {
    const picked = selectCode(
      ["src/a.ts", "archive/old/b.ts", "archive/old/c.ts"],
      ["archive/"],   // 尾斜杠要吃得下 —— 人手勾出来的东西两种写法都有
    );
    assert.deepEqual(picked.assetDirs, [{ dir: "archive/old", files: 2 }]);
    assert.deepEqual(picked.excluded, ["archive"]);
  });

  it("**前缀不是目录** —— 勾掉 `archive` 不该吃掉 `archive-notes/`", () => {
    const picked = selectCode(
      ["archive/a.ts", "archive-notes/b.ts"],
      ["archive"],
    );
    assert.deepEqual(picked.code, ["archive-notes/b.ts"]);
  });
});

describe("L0 · 门：按前两段聚，不按直接父目录", () => {
  /**
   * 直接父目录在 demo 上聚出 50 个目录（`assets/scripts/core` 里 28 个
   * `.meta` 也各占一行）；前两段是 17 扇门。门是拿来点开文件管理器的。
   */
  it("深路径收编进前两段的那扇门", () => {
    const picked = selectCode([
      "assets/resources/art/x.png",
      "assets/resources/art/deep/y.png",
      "assets/resources/audio/z.wav",
    ], []);
    assert.deepEqual(picked.assetDirs, [{ dir: "assets/resources", files: 3 }]);
  });

  it("一层深的文件门就是那一层；根下的散文件归 `.`", () => {
    const picked = selectCode(["docs/a.md", "README.md", ".gitignore"], []);
    assert.deepEqual(picked.assetDirs, [
      { dir: ".", files: 2 },
      { dir: "docs", files: 1 },
    ]);
  });

  it("大门在前，一样大的按名字 —— 结果确定", () => {
    const picked = selectCode(
      ["b/x/1.md", "b/x/2.md", "a/y/1.md", "c/z/1.md"], []);
    assert.deepEqual(picked.assetDirs.map((door) => door.dir),
      ["b/x", "a/y", "c/z"]);
  });
});

describe("L0 · POST body 的解析 —— fail-closed", () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("字符串数组进，规范化出", () => {
    assert.deepEqual(parseExcludes(bytes('["archive/", "temp"]')),
      ["archive", "temp"]);
  });

  it("形状不对一律 null —— 不猜、不修剪成「差不多」", () => {
    assert.equal(parseExcludes(bytes("not json")), null);
    assert.equal(parseExcludes(bytes('{"dirs": []}')), null);
    assert.equal(parseExcludes(bytes("[1, 2]")), null);
  });

  it("空字符串的目录被丢掉 —— 空串当前缀会吃掉整棵树", () => {
    assert.deepEqual(parseExcludes(bytes('["", "a"]')), ["a"]);
  });
});
