/**
 * 「哪些文件算关键代码」的判据，**只在这一处**（图谱 spec 2026-08-12）。
 *
 * ## 判据
 *
 * ```
 * 是代码  ⇔  后缀 ∈ {.ts,.tsx,.js,.jsx,.mjs,.cjs}
 *         ∧  不以 .d.ts 结尾（声明没有实现，图上没它的事）
 *         ∧  路径不在任何一个被勾掉的目录下
 * ```
 *
 * ## 为什么是扩展名白名单，不是读 tsconfig
 *
 * demo 的 `tsconfig.json` 写着 `extends: "./temp/tsconfig.cocos.json"`，
 * 而 `temp/` 在 `.gitignore` 里 —— 那是 Cocos 生成的、不在版本控制里的文件。
 * **tsconfig 靠不住**，换台机器它根本不存在。
 *
 * ## 不是代码的给一扇门，不是一张树
 *
 * 素材/生成类按**路径前两段**聚合。按直接父目录聚在真项目上量过：50 个目录，
 * `assets/scripts/core` 里 28 个 `.meta` 也各占一行；按前两段是 17 扇门、
 * 前 8 扇盖住 95%。门是拿来点开文件管理器的，不是拿来浏览的。
 *
 * 被勾掉目录下的**代码**文件也归到门里 —— 勾掉 ≠ 消失，门还在，只是不进场景。
 *
 * 进来的只是路径清单（`git ls-files` 的产物），不碰文件系统 —— 判据可以完全
 * 离线证明。
 */

const CODE_SUFFIX = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

export interface Selection {
  /** 进 3D 场景的那些，仓库相对路径。 */
  readonly code: readonly string[];
  /** 不进场景的按前两段聚成门。`dir` 为 `"."` = 仓库根下的散文件。 */
  readonly assetDirs: readonly { dir: string; files: number }[];
  /** 勾掉的目录，规范化后原样带回 —— 前端要拿它画勾选状态。 */
  readonly excluded: readonly string[];
}

/** `a/b/c/d.png` → `a/b`；`a/x.png` → `a`；`x.png` → `.`。 */
function doorOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return ".";
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

const normalizeDir = (dir: string): string => dir.replace(/\/+$/, "");

export function selectCode(
  tracked: readonly string[],
  excluded: readonly string[],
): Selection {
  const dirs = excluded.map(normalizeDir).filter((dir) => dir !== "");
  const isExcluded = (path: string): boolean =>
    dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));

  const code: string[] = [];
  const doors = new Map<string, number>();
  for (const path of tracked) {
    if (CODE_SUFFIX.test(path) && !path.endsWith(".d.ts") && !isExcluded(path)) {
      code.push(path);
      continue;
    }
    const door = doorOf(path);
    doors.set(door, (doors.get(door) ?? 0) + 1);
  }
  return {
    code,
    assetDirs: [...doors.entries()]
      .map(([dir, files]) => ({ dir, files }))
      // 大门在前；一样大的按名字，结果确定。
      .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir)),
    excluded: dirs,
  };
}

/**
 * `POST /api/graph-excludes` 的 body。**解析放这层不放 `web/`** ——
 * Web 边界的常驻护栏禁止任意解析未验证 JSON，而这本来就是判据的一部分：
 * 什么样的勾选算数，和勾选怎么作用于清单，是同一件事的两半。
 *
 * 形状不对返回 null（fail-closed，调用方答 400），不猜、不修剪成「差不多」。
 */
export function parseExcludes(body: Uint8Array): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((entry): entry is string => typeof entry === "string")) return null;
  return parsed.map(normalizeDir).filter((dir) => dir !== "");
}
