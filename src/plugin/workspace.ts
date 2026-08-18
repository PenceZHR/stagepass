import type Database from "better-sqlite3";

import { ProjectStore } from "../store/project-store";

/**
 * 「Codex 现在开着哪个目录」→「那是哪个项目」。
 *
 * 插件化之后项目不再由人挑（用户 2026-08-18 定）：人在 Codex 里选好文件夹，
 * StagePass 跟着走。这一层就是那个跟随。
 */

/**
 * 从 `tools/call` 的 `_meta` 里捞出工作目录。
 *
 * 2026-08-18 实测到的真实形状 —— **以绝对路径为键的对象**，不是数组：
 *
 * ```json
 * "x-codex-turn-metadata": {
 *   "workspaces": {
 *     "/Users/zhanghr/Desktop/stagepass": {
 *       "associated_remote_urls": { "origin": "git@github.com:…" },
 *       "latest_git_commit_hash": "e21d007…",
 *       "has_changes": true
 *     }
 *   }
 * }
 * ```
 *
 * 第一版我写了个「递归找绝对路径」的兜底，**但只走了值没走键**，于是一条都没找到。
 * 现在按实物精确读；扫描那段留着当兜底（键和值都走），Codex 换形状时还能顶一阵。
 */
export function workspacePaths(meta: unknown): readonly string[] {
  const turn = asRecord(asRecord(meta)["x-codex-turn-metadata"]);
  const exact = turn["workspaces"];
  if (isPlainObject(exact)) {
    const keys = Object.keys(exact).filter(looksAbsolute);
    if (keys.length > 0) return keys;
  }

  const found: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (looksAbsolute(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((each) => { walk(each, depth + 1); });
      return;
    }
    if (isPlainObject(node)) {
      Object.keys(node).forEach((key) => { if (looksAbsolute(key)) found.push(key); });
      Object.values(node).forEach((each) => { walk(each, depth + 1); });
    }
  };
  walk(meta, 0);
  return found;
}

export interface ResolvedProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/**
 * 哪个项目就是「Codex 现在开着的那个目录」。
 *
 * **取最长匹配**：工作目录可能是项目里的子目录（在 `src/` 下开的会话），项目路径也
 * 可能是工作目录的前缀。两边都认，谁更具体谁赢 —— 否则一个浅路径的项目会把深路径
 * 的抢走。
 *
 * 认不出来就返回 null，**不猜**。猜错的项目会让人看着别人的阶段环做决定。
 */
export function projectForWorkspace(
  database: Database.Database,
  paths: readonly string[],
): ResolvedProject | null {
  let best: ResolvedProject | null = null;
  for (const project of new ProjectStore(database).list()) {
    const home = project.path;
    if (home === null || home === "") continue;
    const hit = paths.some((each) =>
      each === home || each.startsWith(`${home}/`) || home.startsWith(`${each}/`));
    if (!hit) continue;
    if (best === null || home.length > best.path.length) {
      best = { id: project.id, name: project.name, path: home };
    }
  }
  return best;
}

function looksAbsolute(value: string): boolean {
  return value.startsWith("/") && value.length > 1 && !value.includes("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
