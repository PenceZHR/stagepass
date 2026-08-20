import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 一个项目的家：`<git 根>/.stagepass/`。
 *
 * ## 为什么绑定必须落在文件夹上
 *
 * 2026-08-19 之前有**四个互相不知道对方的绑定面**：一个全局库
 * （`~/.stagepass/panel.db`）装着四个项目的 Change、工作台按 cwd 绑项目但读那个全局
 * 库、端口写死 4399（一台机器只能开一个工作台）、MCP 打死地址 `127.0.0.1:4399`
 * 而不管自己在哪个项目里。
 *
 * 结果是用户在「海战小游戏」的会话里问的一句话，记进了 stagepass 的 Change，正本写
 * 进了 stagepass 的仓库 —— 屏幕上什么异常都看不出来。用户的原话：「chg 和 MCP 全都
 * 是乱的，这些必须统一管理」。
 *
 * ## 判据：项目 = 本地文件夹，状态写在该文件夹下
 *
 * 于是「哪个工作台 / 哪个库 / 哪个 CHG」三个问题一起消失 —— 不是被修好，是**在结构
 * 上不存在**：你在哪个文件夹里，就是哪个项目。
 *
 * ## Codex 没有项目级配置，靠的是 cwd
 *
 * `codex 0.147.0` 只读 `~/.codex/config.toml`（`--help` 明写）。但 MCP server 是
 * **按会话起**的，进程的 cwd 就是会话所在目录 —— 所以全局注册一条、进程自己往上找
 * git 根，同一条注册在哪个项目里就是哪个项目的。**比项目级注册还省事：注册一次，
 * 之后永远不用改。**
 */
export interface ProjectHome {
  /** git 仓库根 —— 项目本身。 */
  readonly root: string;
  /** `<root>/.stagepass`。 */
  readonly dir: string;
  /** 这个项目的库。 */
  readonly db: string;
  /** 工作台的端口。 */
  readonly port: number;
}

interface ProjectConfig {
  port?: number;
  db?: string;
}

export const DEFAULT_PORT = 4399;
const CONFIG = "config.json";
const DEFAULT_DB = "stagepass.db";

/**
 * 从任意目录往上找 git 根。
 *
 * **判据是 git 根，不是 cwd** —— 会话可能开在 `src/web/` 里，而那和开在仓库根上说的
 * 是同一个项目。这条判据和 Codex 认 project 的判据一致（`isGitRepository`），所以
 * 「StagePass 眼里的项目」和「Codex 眼里的项目」永远是同一个东西。
 *
 * 不是 git 仓库就是 null：那种目录在 Codex 那儿根本不是项目，硬给它一个家，只会让
 * 人后面对着一条无处显示的会话找四十七分钟。
 *
 * ## 一律解析符号链接
 *
 * macOS 上 `/var` 是 `/private/var` 的链接，`/tmp` 同理 —— 而 `git rev-parse` 吐的是
 * 解析过的那一份。一边解析一边不解析，两个字符串就永远对不上，表现是「明明在这个
 * 项目里却被判成别的项目」。所以**这里出去的路径永远是 realpath**，比它的人不用记
 * 这条规矩。
 */
export function gitRootOf(from: string): string | null {
  try {
    const root = execFileSync("git", ["-C", from, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root === "" ? null : realpathSync(root);
  } catch {
    return null;
  }
}

/**
 * 读这个项目的家。**只读，不创建** —— MCP 那一侧用它：它不该在人的项目里
 * 凭空造一个目录出来（「看状态不该有副作用」）。没有就是 null，照直说。
 */
export function readProjectHome(from: string): ProjectHome | null {
  const root = gitRootOf(from);
  if (root === null) return null;
  const dir = join(root, ".stagepass");
  const path = join(dir, CONFIG);
  if (!existsSync(path)) return null;
  let config: ProjectConfig;
  try {
    config = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
  } catch {
    return null;
  }
  return {
    root, dir,
    db: join(dir, config.db ?? DEFAULT_DB),
    port: typeof config.port === "number" ? config.port : DEFAULT_PORT,
  };
}

/**
 * 读，没有就建。**工作台那一侧用它** —— 起工作台是人明确的动作，那一刻建目录
 * 是他要的；`readProjectHome` 的只读版给不该有副作用的那些调用方。
 */
export function ensureProjectHome(from: string, port?: number): ProjectHome | null {
  const root = gitRootOf(from);
  if (root === null) return null;
  const dir = join(root, ".stagepass");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CONFIG);

  const existing = existsSync(path) ? readProjectHome(from) : null;
  const chosen = port ?? existing?.port ?? DEFAULT_PORT;
  const db = existing === null ? DEFAULT_DB : existing.db.slice(dir.length + 1);

  /*
   * 端口变了才重写。**不是每次启动都写一遍** —— 这份文件是人可以手改的（他要固定
   * 端口就自己改），每次启动无条件覆盖会把他的手改抹掉。
   */
  if (existing === null || existing.port !== chosen) {
    writeFileSync(path, `${JSON.stringify({ port: chosen, db }, null, 2)}\n`, "utf8");
  }
  return { root, dir, db: join(dir, db), port: chosen };
}
