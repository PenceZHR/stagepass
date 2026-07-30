import { execFileSync } from "node:child_process";

/**
 * 一个 Build 轮次在仓库里留下了什么。
 *
 * ## 为什么 Build 的产出是 commit，不是文件列表
 *
 * 用户 2026-07-30 拍板。理由是三个候选里只有它说得全：**文件列表说不出「改了什么」**
 * （同一个路径，改之前改之后都是它）；**diff 说不出「基于哪一版」**，而下一轮的蓝方
 * 正需要这个；commit 两样都有，还多了稳定 id、能 revert、能进 fence。
 *
 * 设计阶段不走这条路 —— 它们的产出天然是一份文档，一个路径就说全了。
 *
 * ## 干净树是这条路的前提，不是洁癖
 *
 * StagePass 提交的是「工作树里所有的改动」，因为它无法区分哪一行是红方写的、哪一行
 * 是人自己写了一半的。所以派发之前必须确认树是干净的 —— 否则这一次 commit 会把
 * **人没提交的活儿一起卷进去**，而那是我不该替他做的事。
 *
 * 干净之后，「这一轮改了什么」就有了唯一定义：commit 边界严格等于轮次边界。
 *
 * ## 为什么整层可注入
 *
 * 和 `codex/archive.ts` 同一个路子：它要往**用户真实的仓库**里写东西，所以测试里
 * 必须能换掉。默认实现直接 exec `git`，不过 shell —— 提交信息里带引号或换行时，
 * 过一次 shell 就会变成另一条命令。
 */

export interface RepoOps {
  /**
   * 工作树里还没提交的东西，路径原样。空数组 = 干净。
   *
   * **未跟踪的文件也算。** 红方新建一个文件、StagePass 把它提交进去是正常路径；
   * 而人自己丢在那儿的一个草稿被顺手卷进 commit，正是这一层要防的事 —— 两者在
   * `git status` 里长得一模一样，所以只能一起挡。
   */
  dirtyPaths(cwd: string): readonly string[];
  /**
   * 把工作树里所有改动提交成一个 commit，返回它的 sha。
   *
   * **没有任何改动时返回 null，不造一个空 commit。** 「红方这一轮什么都没写」是一件
   * 人需要知道的事，而一个空 commit 会把它伪装成「产出了东西」。
   */
  commitAll(cwd: string, message: string): string | null;
  /** 一个 commit 的正文（带 diff）。读不到就返回 null —— 不猜、不回落到别的东西。 */
  show(cwd: string, sha: string): string | null;
}

/** 看着像不像一个 commit sha。产出是路径还是 commit，靠它分。 */
export const looksLikeSha = (value: string): boolean =>
  /^[0-9a-f]{7,40}$/.test(value);

export function createRepoOps(options: {
  run?: (cwd: string, args: readonly string[]) => string;
} = {}): RepoOps {
  const run = options.run
    ?? ((cwd: string, args: readonly string[]): string =>
      execFileSync("git", [...args], {
        cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      }));

  return {
    dirtyPaths(cwd) {
      try {
        /*
         * **`-z`，不是裸的 `--porcelain`。**
         *
         * 裸的那个会把非 ASCII 的文件名**转义成八进制并加上引号** —— 2026-07-30 在真
         * 面板上撞到的样子是 `"\350\215\211\347\250\277.md"`。而列出这些文件的全部
         * 意义就是让人知道是哪一个，那串东西没人认得出来。它还会对名字里的空格加引号。
         *
         * `-z` 用 NUL 分隔、路径原样不转义。代价是格式变了：每条记录是 `XY 路径`，
         * 而改名会**多出一条**只有旧路径、没有状态码的记录 —— 对「哪些东西没提交」
         * 这个问题来说，把新旧两个名字都列出来正好是人要看的。
         */
        return run(cwd, ["status", "--porcelain", "-z"])
          .split("\0")
          .filter((record) => record !== "")
          .map((record) =>
            record.length > 3 && record[2] === " " ? record.slice(3) : record);
      } catch {
        /*
         * 不是个 git 仓库，或者 git 不在。**当成「没有未提交的东西」往下走。**
         *
         * 反过来（当成脏树、拒绝派发）会让一个压根没用 git 的项目永远跑不了 Build，
         * 而那是个比「commit 边界可能不准」严重得多的后果。真正的 commit 那一步
         * 会自己失败并说出来。
         */
        return [];
      }
    },

    commitAll(cwd, message) {
      try {
        run(cwd, ["add", "-A"]);
        // 有没有东西可提交，问 git，不自己数：`--quiet` 时有差异退出码为 1。
        try {
          run(cwd, ["diff", "--cached", "--quiet"]);
          return null; // 退出码 0 = 暂存区和 HEAD 一样，没东西可提交
        } catch {
          // 有差异，继续提交
        }
        run(cwd, ["commit", "-m", message]);
        return run(cwd, ["rev-parse", "HEAD"]).trim();
      } catch {
        return null;
      }
    },

    show(cwd, sha) {
      try {
        return run(cwd, ["show", "--stat", "--patch", sha]);
      } catch {
        return null;
      }
    },
  };
}
