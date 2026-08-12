import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { selectCode } from "./code-selection";
import { layout, type SceneModel } from "./graph-layout";
import {
  ingredientsFor, ModuleNotInGraphError, type IngredientList,
} from "./ingredients";
import { parseModuleGraph, type ModuleFile } from "./module-graph";

/**
 * 图谱这条路上**唯一碰文件系统的地方**。
 *
 * 下面全是纯函数（selectCode → parseModuleGraph → layout → ingredientsFor），
 * 这里只做三件脏事：问 git 要清单、按清单读正文、把路径钉死在项目目录里。
 * git 是注入的（`trackedFiles`），和 `work/repo.ts` 一个理由：测试里必须能换掉。
 *
 * ## 不缓存，故意的
 *
 * 全程 194ms（demo 118 模块实测：ls-files 20 + 读盘 23 + 解析 148 + 半径 3）。
 * 不缓存 = 没有「图和真树不一致」这一整类失效 bug —— 和面板 ASSETS 那条
 * `no-store` 同一个理由：缓存会静默显示上一版，读起来就像「改动没生效」。
 */

export type WorkspaceGraph =
  | { readonly ok: true; readonly scene: SceneModel }
  | { readonly ok: false; readonly reason: "not-a-repo" };

/**
 * 读不到的文件跳过而不抛：一个 tracked 但已从工作树删掉（还没 commit）的文件
 * 不该挡住整张图 —— 它的缺席会以 `dangling` 边的形式**在图上现形**，这比一个
 * 500 诚实：图自己说「这里缺了」，而不是整张图说不出话。
 */
const readOrSkip = (absolute: string): string | null => {
  try {
    return readFileSync(absolute, "utf-8");
  } catch {
    return null;
  }
};

function codeFiles(input: {
  root: string;
  code: readonly string[];
  readFile: (absolute: string) => string | null;
}): ModuleFile[] {
  const files: ModuleFile[] = [];
  for (const path of input.code) {
    const text = input.readFile(join(input.root, path));
    if (text !== null) files.push({ path, text });
  }
  return files;
}

export function readWorkspaceGraph(input: {
  root: string;
  excluded: readonly string[];
  trackedFiles: (cwd: string) => readonly string[] | null;
  readFile?: (absolute: string) => string | null;
}): WorkspaceGraph {
  const tracked = input.trackedFiles(input.root);
  if (tracked === null) return { ok: false, reason: "not-a-repo" };
  const selection = selectCode(tracked, input.excluded);
  const files = codeFiles({
    root: input.root, code: selection.code,
    readFile: input.readFile ?? readOrSkip,
  });
  return { ok: true, scene: layout(parseModuleGraph(files), selection) };
}

export type FileReading =
  | { readonly ok: true; readonly ingredients: IngredientList }
  | {
    readonly ok: false;
    readonly reason: "not-a-repo" | "path-outside" | "path-untracked" | "not-a-module";
  };

/**
 * 近景那一档要的东西：一个文件的配料单 —— 完整正文 + 依赖的签名 + 谁依赖它。
 * `ingredientsFor` 原样返回，**一个字不加工**：飞近看到的就是 AI 被喂的那份。
 *
 * ## 这是新开的读盘面，两道闸都 fail-closed
 *
 * 1. realpath 之后必须还在项目目录里 —— 摊平软链和 `../`
 * 2. 必须出现在 `git ls-files` 里 —— 白名单，不是黑名单
 *
 * 第 2 条比第 1 条严：它同时挡掉指向目录外的软链、`.git/` 内部、和任何没被
 * 跟踪的文件。没有这两条，`?path=../../.ssh/id_rsa` 就通了。
 */
export function readFileIngredients(input: {
  root: string;
  path: string;
  excluded: readonly string[];
  trackedFiles: (cwd: string) => readonly string[] | null;
  readFile?: (absolute: string) => string | null;
}): FileReading {
  const tracked = input.trackedFiles(input.root);
  if (tracked === null) return { ok: false, reason: "not-a-repo" };
  if (isAbsolute(input.path) || !tracked.includes(input.path)) {
    return { ok: false, reason: "path-untracked" };
  }
  try {
    const realRoot = realpathSync(input.root);
    const real = realpathSync(join(realRoot, input.path));
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { ok: false, reason: "path-outside" };
    }
  } catch {
    // tracked 但读不出 realpath = 已从工作树删掉 —— 对读文件来说就是不在。
    return { ok: false, reason: "path-untracked" };
  }

  const selection = selectCode(tracked, input.excluded);
  const files = codeFiles({
    root: input.root, code: selection.code,
    readFile: input.readFile ?? readOrSkip,
  });
  try {
    return {
      ok: true,
      ingredients: ingredientsFor({
        graph: parseModuleGraph(files), files, group: [input.path],
      }),
    };
  } catch (error: unknown) {
    // 点的是 README.md 这种 tracked 但不是代码的 —— 图上没有它这个节点。
    if (error instanceof ModuleNotInGraphError) {
      return { ok: false, reason: "not-a-module" };
    }
    throw error;
  }
}
