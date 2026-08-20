import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DEFAULT_PORT, ensureProjectHome, gitRootOf, readProjectHome } from "./project-home";

const made: string[] = [];
after(() => { for (const one of made) rmSync(one, { recursive: true, force: true }); });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ph-"));
  made.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  // **realpath** —— macOS 上 `/var` 是 `/private/var` 的链接，而 `gitRootOf` 吐的是
  // 解析过的那一份。夹具不解析，断言就会拿两个指同一个地方的不同字符串去比。
  return realpathSync(dir);
}

describe("L0 · 项目的家", () => {
  it("从子目录也认得出同一个项目 —— 判据是 git 根，不是 cwd", () => {
    const root = repo();
    const deep = join(root, "src", "web");
    mkdirSync(deep, { recursive: true });
    ensureProjectHome(root);
    const fromDeep = readProjectHome(deep);
    assert.notEqual(fromDeep, null);
    // 会话开在 src/web 里，说的仍然是同一个项目
    assert.equal(fromDeep!.root, gitRootOf(root));
  });

  it("不是 git 仓库就是 null，**不硬给它一个家**", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    made.push(plain);
    assert.equal(gitRootOf(plain), null);
    assert.equal(ensureProjectHome(plain), null);
    assert.equal(existsSync(join(plain, ".stagepass")), false);
  });

  it("**只读那一版一个目录都不建** —— 看状态不该有副作用", () => {
    const root = repo();
    assert.equal(readProjectHome(root), null);
    assert.equal(existsSync(join(root, ".stagepass")), false);
  });

  it("库和端口都落在项目文件夹里，别的项目看不见", () => {
    const a = repo(), b = repo();
    ensureProjectHome(a);
    ensureProjectHome(b, 4500);
    assert.equal(readProjectHome(a)!.port, DEFAULT_PORT);
    assert.equal(readProjectHome(b)!.port, 4500);
    assert.notEqual(readProjectHome(a)!.db, readProjectHome(b)!.db);
    assert.ok(readProjectHome(a)!.db.startsWith(a));
  });

  it("**人手改过的端口不许被启动覆盖**", () => {
    const root = repo();
    ensureProjectHome(root);
    // 人自己把端口钉死
    writeFileSync(join(root, ".stagepass", "config.json"),
      JSON.stringify({ port: 4777, db: "stagepass.db" }), "utf8");
    ensureProjectHome(root);   // 再起一次，不传端口
    assert.equal(readProjectHome(root)!.port, 4777);
  });

  it("配置文件坏了就是 null，不猜一个默认值出来", () => {
    const root = repo();
    ensureProjectHome(root);
    writeFileSync(join(root, ".stagepass", "config.json"), "{ 这不是 json", "utf8");
    // 猜一个默认端口出来，人会对着一个连不上的地址找半天
    assert.equal(readProjectHome(root), null);
  });

  it("写出来的是人读得懂、改得动的 JSON", () => {
    const root = repo();
    ensureProjectHome(root, 4600);
    const text = readFileSync(join(root, ".stagepass", "config.json"), "utf8");
    assert.match(text, /"port": 4600/);
    assert.match(text, /\n$/, "文件要以换行收尾 —— 不然 diff 每次都多一行噪音");
  });
});
