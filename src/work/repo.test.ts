import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  it("**中文文件名要原样报出来** —— git 默认会把它转义成八进制", () => {
    /*
     * 2026-07-30 在真面板上撞到的：界面收到的是 `"\350\215\211\347\250\277.md"`。
     * 列文件的**全部意义**就是让人知道是哪一个，而这串东西没人认得出来。
     *
     * 单元测试第一版漏掉了它，因为那一版用的是假 git 的返回值 —— 转义发生在真 git
     * 那一侧。这条必须跑在真 git 上。
     */
    const cwd = repo();
    writeFileSync(join(cwd, "草稿.md"), "我自己写了一半的东西\n");
    assert.deepEqual(createRepoOps().dirtyPaths(cwd), ["草稿.md"]);
  });

  it("名字里有空格也不许被截断", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "my notes.md"), "x\n");
    assert.deepEqual(createRepoOps().dirtyPaths(cwd), ["my notes.md"]);
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

describe("repo · 窄提交：只提交点名的路径", () => {
  /**
   * E 的执行端。设计阶段每轮把 `docs/stagepass/<change>/` 提交掉，让树保持干净 ——
   * 而**目录外一个字节都不碰**：那里可能躺着人写了一半的活儿。
   *
   * `commitAll` 做不了这件事（`git add -A` 是整棵树），所以这是第二个动词，
   * 不是第一个的参数 —— 两件事的安全前提不同：commitAll 以「树已验干净」为前提，
   * commitPaths 以「树很可能是脏的」为前提。
   */
  const ops = createRepoOps();
  const HOME = "docs/stagepass/CHG-1";

  const seedHome = (cwd: string): void => {
    mkdirSync(join(cwd, HOME), { recursive: true });
    writeFileSync(join(cwd, HOME, "Spec-r1.md"), "# Spec\n");
  };

  it("**目录里的进 commit，目录外的原地不动**", () => {
    const cwd = repo();
    seedHome(cwd);
    writeFileSync(join(cwd, "人写了一半.md"), "别动我\n");

    const sha = ops.commitPaths(cwd, [HOME], "StagePass CHG-1 Spec 第 1 轮");
    assert.ok(sha, "该有 commit 而没有");
    assert.deepEqual(ops.dirtyPaths(cwd), ["人写了一半.md"],
      "目录外的文件被卷走了，或者目录里的没提干净");
    assert.match(ops.show(cwd, sha!)!, /Spec-r1\.md/);
  });

  it("**人已经 stage 了的东西不许被顺手提交**", () => {
    /*
     * 这是窄提交独有的一道险：`git commit -m`（不带 pathspec）提交的是**整个暂存区**。
     * 人手里 stage 了一半的活儿，会被一轮设计文档的 commit 静默卷进历史 ——
     * 正是「不替人 commit 他自己的活儿」要防的事，而且比脏树更隐蔽。
     */
    const cwd = repo();
    seedHome(cwd);
    writeFileSync(join(cwd, "他自己stage的.ts"), "const wip = 1;\n");
    execFileSync("git", ["add", "他自己stage的.ts"], { cwd, stdio: "ignore" });

    const sha = ops.commitPaths(cwd, [HOME], "StagePass CHG-1 Spec 第 1 轮");
    assert.ok(sha);
    assert.doesNotMatch(ops.show(cwd, sha!)!, /他自己stage的/,
      "人 stage 的文件被卷进了 StagePass 的 commit");
    // 而且它还stage着 —— 不许动人的暂存区。
    // `-z` 是必须的：裸的 --name-only 会把非 ASCII 文件名转义成八进制
    // （`"\344\273\226…"`），正则永远配不上 —— dirtyPaths 的注释里那课，别再挂科。
    const staged = execFileSync("git", ["diff", "--cached", "--name-only", "-z"],
      { cwd, encoding: "utf-8" });
    assert.match(staged, /他自己stage的/, "人的暂存区被清掉了");
  });

  it("目录里没有任何改动 —— null，不造空 commit", () => {
    const cwd = repo();
    seedHome(cwd);
    ops.commitPaths(cwd, [HOME], "第一轮");
    assert.equal(ops.commitPaths(cwd, [HOME], "第二轮"), null);
  });

  it("目录根本不存在 —— null，不抛", () => {
    // 红方违规写到了别处、目录从没被建出来 —— 这一轮就是没有产物可提，
    // 不是 StagePass 出了故障。
    assert.equal(ops.commitPaths(repo(), [HOME], "空"), null);
  });
});
