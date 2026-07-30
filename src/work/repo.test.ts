import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepoOps, looksLikeSha } from "./repo";

/**
 * git 那一层，在**一次性的临时仓库**上证。
 *
 * 用真 git 而不是假的：这一层的全部内容就是「git 到底怎么回话」——
 * `--quiet` 的退出码、`--porcelain` 的那两位状态码、改名那一行的形状。
 * 拿一个我自己写的假 git 去证，证的是我对 git 的想象。
 *
 * **一次性目录**：绝不在这棵树上跑（`git add -A` 会把整个工作树卷进去）。
 */

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "stagepass-repo-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return cwd;
}

describe("repo · 干净还是脏", () => {
  it("刚提交完 —— 干净", () => {
    assert.deepEqual(createRepoOps().dirtyPaths(repo()), []);
  });

  it("改过一个跟踪中的文件 —— 报出来", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "seed.txt"), "changed\n");
    assert.deepEqual(createRepoOps().dirtyPaths(cwd), ["seed.txt"]);
  });

  it("**未跟踪的文件也算脏** —— 它会被 add -A 卷进 commit", () => {
    // 人自己丢在那儿的一个草稿和红方新建的文件，在 git 眼里一模一样。
    // 挡不住它，这一次 commit 就会把人没提交的活儿一起提交掉。
    const cwd = repo();
    writeFileSync(join(cwd, "scratch.md"), "我自己写了一半的东西\n");
    assert.deepEqual(createRepoOps().dirtyPaths(cwd), ["scratch.md"]);
  });

  it("不是 git 仓库 —— 当成干净，不是当成脏", () => {
    // 反过来会让一个没用 git 的项目永远跑不了 Build。
    assert.deepEqual(
      createRepoOps().dirtyPaths(mkdtempSync(join(tmpdir(), "stagepass-bare-"))),
      [],
    );
  });
});

describe("repo · 提交这一轮", () => {
  it("提交之后树是干净的，而且拿得到 sha", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "built.ts"), "export const x = 1;\n");
    const ops = createRepoOps();

    const sha = ops.commitAll(cwd, "StagePass CHG-1 Build 第 1 轮");
    assert.ok(sha && looksLikeSha(sha), `不像 sha：${sha}`);
    assert.deepEqual(ops.dirtyPaths(cwd), []);
  });

  it("**什么都没改 —— 返回 null，不造空 commit**", () => {
    // 「红方这一轮什么都没写」是人需要知道的事，空 commit 会把它伪装成有产出。
    const cwd = repo();
    const ops = createRepoOps();
    assert.equal(ops.commitAll(cwd, "空的一轮"), null);
  });

  it("提交信息里带引号和换行也不会变成另一条命令", () => {
    // 不过 shell 就是为了这个。过一次 shell，这条信息会把命令拆开。
    const cwd = repo();
    writeFileSync(join(cwd, "built.ts"), "export const x = 1;\n");
    const ops = createRepoOps();
    const nasty = `他说 "别 rm -rf /"\n第二行 $(echo 危险) \`whoami\``;

    const sha = ops.commitAll(cwd, nasty);
    assert.ok(sha);
    assert.match(ops.show(cwd, sha)!, /别 rm -rf \//);
  });
});

describe("repo · 一个 commit 长什么样", () => {
  it("给得出 diff，而不只是标题", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "built.ts"), "export const x = 1;\n");
    const ops = createRepoOps();
    const sha = ops.commitAll(cwd, "加了 x")!;

    const shown = ops.show(cwd, sha)!;
    assert.match(shown, /加了 x/, "没有提交信息");
    assert.match(shown, /built\.ts/, "没有文件名");
    assert.match(shown, /\+export const x = 1;/, "没有 diff 正文");
  });

  it("没有这个 commit —— 返回 null，不回落到别的东西", () => {
    assert.equal(createRepoOps().show(repo(), "0000000"), null);
  });
});

describe("repo · 产出是路径还是 commit", () => {
  it("分得开", () => {
    assert.ok(looksLikeSha("a1b2c3d"));
    assert.ok(looksLikeSha("9f2c1a4b5d6e7f8091a2b3c4d5e6f708192a3b4c"));
    assert.ok(!looksLikeSha("docs/prd.md"), "路径被当成了 sha");
    assert.ok(!looksLikeSha("spec.md"));
    assert.ok(!looksLikeSha("abc"), "太短的不算");
  });
});
