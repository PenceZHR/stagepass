import { realpathSync } from "node:fs";

import type Database from "better-sqlite3";

import { ProjectStore } from "../store/project-store";

/**
 * 这条会话是不是在工作台绑着的那个项目里。
 *
 * ## 为什么这一格必须存在
 *
 * **一台机器一个工作台，绑一个项目，而任何一条会话都打得到它。** 2026-08-19 真机：
 * 用户在「海战小游戏」的会话里问了一句，工作台绑的是 stagepass —— 那一问记进了
 * stagepass 的 Change、正本写进了 stagepass 的仓库，而屏幕上什么异常都看不出来。
 *
 * **记错地方比记不上更坏**：后者一眼看得出缺，前者半年后没人分辨得出来。
 * 少了这一格，「工作台绑一个项目，于是『认不出来就编一个』在结构上不存在」那条
 * 规矩就从后门失效了。
 *
 * ## 为什么单独一个模块
 *
 * 它只 import `ProjectStore`。放在 `ask-route` 里的时候，`brief-route` 为了用它
 * 把整条 handoff 链拖进了自己的依赖闭包 —— 闭包护栏当场从 73% 涨到 74%。
 * **判据是「谁都够得着，而它谁都不拖」，所以它得自己一个文件。**
 */
/**
 * 解析符号链接。
 *
 * **两边都必须解析。** macOS 上 `/var` 是 `/private/var` 的链接（`/tmp` 同理），而
 * `git rev-parse --show-toplevel` 吐的是解析过的那一份。只要有一边没解析，两个指着
 * 同一个地方的字符串就永远对不上 —— 表现是**人明明在这个项目里，却被判成「别的
 * 项目」而拒掉**。
 *
 * 解析失败就用原样：路径可能已经不存在了（项目被删被搬），那时字符串比较仍然是
 * 能给出答案的那一半，比抛异常强。
 */
const resolved = (one: string): string => {
  try { return realpathSync(one); } catch { return one; }
};

export function sameProject(root: string | null, cwd: unknown): boolean {
  if (root === null || root === "") return false;
  if (typeof cwd !== "string" || cwd === "") return false;

  const trim = (one: string) => one.replace(/\/+$/, "");
  const under = (here: string, home: string) =>
    here === home || here.startsWith(`${home}/`);

  /*
   * **解析过的和原样的，对上一种就算数。**
   *
   * 只比解析过的那一份不行：`realpathSync` 对**还不存在的路径**会抛（会话开在一个
   * 尚未创建的子目录里），那时 cwd 退回原样、而根已经解析过了 —— 两个指着同一个
   * 地方的字符串对不上，人就被误拒。
   *
   * 只比原样的也不行：那正是 `/var` 和 `/private/var` 对不上的那个坑。
   * 所以两组都比，任一组成立就是同一个项目。**宁可多认一种写法，不可误拒。**
   */
  return under(trim(resolved(cwd)), trim(resolved(root)))
    || under(trim(cwd), trim(root));
}

export function projectRootOf(database: Database.Database, projectId: string): string | null {
  try {
    return new ProjectStore(database).read(projectId).path;
  } catch {
    return null;
  }
}

/** 对不上时说给模型听的那句。**说清两边分别在哪，而且不替它挑一个。** */
export function wrongProjectReason(root: string | null, cwd: unknown): string {
  return `这条会话在 ${typeof cwd === "string" && cwd !== "" ? cwd : "（没报目录）"}，`
    + `而 StagePass 工作台绑的是 ${root ?? "（没填路径）"}。**我不替你挑一个项目。**\n`
    + "请人在这条会话所在的项目目录里另起一个工作台（`npm start` + 换个端口，"
    + "并把 `STAGEPASS_URL` 指过去），或者把现在这个工作台重起在这个目录里。";
}
