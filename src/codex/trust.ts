import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex 的目录信任：一个没被信任过的目录，跑一轮会**停在提问上等人**。
 *
 * ## 为什么这一层必须存在
 *
 * 2026-07-30 实测撞到的：给一个新工作区派 Build，30 分钟之后拿到
 * `codex_unavailable: no new Codex session appeared`。真实情况是 Codex 起来了，
 * 停在这一屏上：
 *
 * ```
 * You are in …/workspace
 * Do you trust the contents of this directory?
 * › 1. Yes, continue   2. No, quit
 * ```
 *
 * 没人按，所以没有线程文件，所以这一侧看见的是「TUI 好像没起来」。
 * **界面上它和「在跑」一模一样** —— 正是这个产品从头到尾在防的那一类。
 * 而它不是边角情况：**每加一个新项目都会撞上一次**。
 *
 * ## 判据是 git 根，用排除法定的
 *
 * 同一天两个工作区，祖先目录完全一样（都在受信任的 `stagepass` 和 `/Users/zhanghr`
 * 底下），结果一个跑得动、一个撞上提问。差别只有一个：后者我 `git init` 过。
 *
 *   没有自己的 .git  ->  git 根是外面那个受信任的仓库  ->  不提问
 *   有自己的 .git    ->  git 根是它自己、不在名单里    ->  提问
 *
 * 「逐级往上找祖先」解释不了这个差别（两者的祖先一样），所以是**按 git 根精确匹配**。
 *
 * ## 只读，永远不写
 *
 * 替人答那个提问会往 `~/.codex/config.toml` 里写一条信任 —— 我 2026-07-30 就这么
 * 干过一次，后来用户要我清理掉。**信任是人对一个目录的授权，不是 StagePass 的决定。**
 * 这一层只负责查出来、说清楚，然后让人自己去答。
 */

export interface TrustOps {
  /**
   * 这个目录 Codex 信任过吗。
   *
   * `null` = **查不出来**（配置读不到、格式变了），和 `false` 是两件事：只有明确的
   * `false` 才拦得住派发。读不到就拦，等于一个把配置换了地方的人从此什么都跑不了。
   */
  isTrusted(cwd: string): boolean | null;
}

const DEFAULT_CONFIG = join(homedir(), ".codex", "config.toml");

export function createTrustOps(options: {
  configPath?: string;
  /** 这个目录的 git 根，不是仓库就返回 null。注入是为了离线证。 */
  gitRoot?: (cwd: string) => string | null;
} = {}): TrustOps {
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const gitRoot = options.gitRoot ?? ((cwd: string): string | null => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null; // 不是 git 仓库，或者没有 git
    }
  });

  return {
    isTrusted(cwd) {
      let config: string;
      try {
        config = readFileSync(configPath, "utf-8");
      } catch {
        return null; // 读不到就说不知道
      }

      const project = gitRoot(cwd) ?? cwd;
      // macOS 上 /var 是 /private/var 的软链，而 Codex 按真实路径记。存两个不同的
      // 字符串指同一个目录，只会埋一个查不出来的坑（新建项目那边同一个理由）。
      const real = (() => {
        try { return realpathSync(project); } catch { return project; }
      })();

      /*
       * 按行扫段落：`[projects."<路径>"]` 开一段，下一个 `[` 关一段，**只在这一段里**
       * 找 trust_level。
       *
       * ## 为什么不把路径拼进一个正则
       *
       * 第一版就是那么写的，两个问题。一个是路径里的 `.` `+` `(` 不转义会匹配到别的
       * 目录 —— 而错的方向是「把没信任的目录报成信任」，也就是这一层白加了。另一个更
       * 阴：我用了 `\z` 收尾，而**JavaScript 的正则没有 `\z`**（那是 Perl 那边的），
       * 它被当成字母 z，于是整个 lookahead 失效、连信任的目录也报成没信任。
       *
       * 按行扫用的是**字符串相等**，两个问题一起没有了。
       */
      const wanted = `projects."${real}"`;
      let inside = false;
      for (const line of config.split("\n")) {
        const header = /^\s*\[(.+)\]\s*$/.exec(line);
        if (header) {
          inside = header[1] === wanted;
          continue;
        }
        if (inside && /^\s*trust_level\s*=\s*"trusted"\s*$/.test(line)) return true;
      }
      // 走到这儿有两种：名单里没有这个目录，或者有但没写 trusted。对派发来说是同一件
      // 事 —— 它会停在那个提问上。
      return false;
    },
  };
}
