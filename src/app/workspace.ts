import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";

/**
 * **新建和删除 Project / Change** —— 从 `handle()` 里搬出来（BACKLOG §4.1·J）。
 *
 * ## 为什么这些可以在网页上
 *
 * PRD §1.1 那条线是「Web 可以改标准，永远不可以对这一次的产物下判断」。新建和
 * 删除两者都不是：它们不推动任何闸门、不对任何产物下任何判断，和「选中一个
 * Change」是同一类动作。
 *
 * ## 两条硬规矩，都是撞出来的
 *
 * - **项目的路径必填，而且当场校验。** 一个 Project 就是一个仓库（用户
 *   2026-07-30 拍板），Codex 就跑在那个目录里。建一个没有路径的项目等于建一个
 *   「不知道在哪」的项目 —— 那正是用户撞上的洞。
 * - **有活儿在跑就不许删。** 不是出于谨慎：删掉一个正在跑的 Change 会留下一个
 *   没人认领的 codex 进程，而它会继续往一个已经不存在的账本上写。
 */

/** 现在有没有活儿在跑。判据在 `web/`（它要看账本和活进程），这里只消费结论。 */
export type BusyCheck = (changeId: string) =>
  { reason: string; busy: string; jobId?: string } | null;

export type CreateProjectOutcome =
  | { readonly kind: "name_required" }
  | { readonly kind: "path_required" }
  | { readonly kind: "path_must_be_absolute" }
  | { readonly kind: "path_is_not_a_directory" }
  | { readonly kind: "path_does_not_exist" }
  | {
    readonly kind: "created";
    readonly id: string;
    readonly name: string;
    readonly path: string;
  };

export function createProject(input: {
  database: Database.Database;
  name: string;
  path: string;
}): CreateProjectOutcome {
  const name = input.name.trim();
  if (name === "") return { kind: "name_required" };

  /*
   * 三条都查，因为错在这里发现比在 pty 里发现便宜得多：必须是绝对路径（相对路径
   * 相对谁？服务端的 cwd 吗 —— 那就又回到那个洞了）、必须存在、必须是目录。
   */
  const rawPath = input.path.trim();
  if (rawPath === "") return { kind: "path_required" };
  if (!isAbsolute(rawPath)) return { kind: "path_must_be_absolute" };
  let path: string;
  try {
    // realpath：macOS 上 /var 是 /private/var 的软链，而 Codex 按真实路径记目录
    // 信任（2026-08-05 实测过）。存两个不同的字符串指同一个目录，只会埋下一个坑。
    path = realpathSync(rawPath);
  } catch {
    return { kind: "path_does_not_exist" };
  }
  if (!statSync(path).isDirectory()) return { kind: "path_is_not_a_directory" };

  const projects = new ProjectStore(input.database);
  const id = mintId("PRJ", projects.list().map((entry) => entry.id));
  const created = projects.ensure(id, name, path);
  // 新项目一建出来就带上出厂标准 —— 全部不阻断，见 `domain/rubric-defaults.ts`。
  // 不装的话，这个项目的每个阶段都是空 rubric，人得逐个手写才能开始用。
  new RubricStore(input.database).installDefaults(created.id);
  /*
   * 把路径回给界面：人得看得见「它建在哪」—— 那正是用户撞上的洞。
   *
   * 回**刚校验过的那个** `path`，不回 `created.path`：`ensure` 是 upsert，撞上
   * 一个已存在的 id 时它保留旧路径（`COALESCE`），而那时回给人的就不是他刚填的
   * 那个了。这里 id 是新铸的，两者必然相同 —— 但依赖「必然相同」是下一个洞。
   */
  return { kind: "created", id: created.id, name: created.name, path };
}

export type CreateChangeOutcome =
  | { readonly kind: "title_required" }
  | { readonly kind: "no_such_project" }
  | { readonly kind: "created"; readonly id: string; readonly phase: Phase };

export function createChange(input: {
  database: Database.Database;
  projectId: string;
  title: string;
}): CreateChangeOutcome {
  const title = input.title.trim();
  if (title === "") return { kind: "title_required" };
  if (!hasProject(input.database, input.projectId)) return { kind: "no_such_project" };

  const changes = new ChangeStore(input.database);
  const id = mintId("CHG", changes.list().map((entry) => entry.id));
  const created = changes.create(id, { projectId: input.projectId, title });
  // 新的 Change 停在第一个阶段、pending —— 状态机的起点，这里不替它走一步。
  return { kind: "created", id: created.id, phase: created.state.phase };
}

export type DeleteChangeOutcome =
  | { readonly kind: "no_such_change" }
  | {
    readonly kind: "busy";
    readonly busy: { reason: string; busy: string; jobId?: string };
  }
  | { readonly kind: "deleted"; readonly changeId: string };

export function deleteChange(input: {
  database: Database.Database;
  changeId: string;
  isBusy: BusyCheck;
  /**
   * 收掉这个 Change 的终端。**`forget` 而不是 `close`** —— 连尸体一起收，否则
   * 下一个重名的 Change 会继承这一个的最后一屏（见 `PanelSessions.forget`）。
   */
  forget: (changeId: string) => void;
}): DeleteChangeOutcome {
  const changes = new ChangeStore(input.database);
  try {
    // 读它就是在问「有没有这条」—— `forget` 枚举所有阶段，不再需要当前那个。
    changes.read(input.changeId);
  } catch {
    return { kind: "no_such_change" };
  }
  const busy = input.isBusy(input.changeId);
  if (busy) return { kind: "busy", busy };

  input.forget(input.changeId);
  changes.delete(input.changeId);
  return { kind: "deleted", changeId: input.changeId };
}

export type DeleteProjectOutcome =
  | { readonly kind: "no_such_project" }
  | {
    readonly kind: "busy";
    readonly changeId: string;
    readonly busy: { reason: string; busy: string; jobId?: string };
  }
  | {
    readonly kind: "deleted";
    readonly projectId: string;
    readonly changes: number;
  };

export function deleteProject(input: {
  database: Database.Database;
  projectId: string;
  isBusy: BusyCheck;
  forget: (changeId: string) => void;
}): DeleteProjectOutcome {
  if (!hasProject(input.database, input.projectId)) return { kind: "no_such_project" };

  const changes = new ChangeStore(input.database);
  const mine = changes.list(input.projectId);
  // 一个都不能在跑 —— 理由和删 Change 一样，而且这里一次要停好几个。
  for (const each of mine) {
    const busy = input.isBusy(each.id);
    if (busy) return { kind: "busy", changeId: each.id, busy };
  }
  // 删项目就是把它底下每条 Change 都删掉，尸体一样要跟着走。
  for (const each of mine) input.forget(each.id);
  new ProjectStore(input.database).delete(input.projectId, changes);
  return { kind: "deleted", projectId: input.projectId, changes: mine.length };
}

function hasProject(database: Database.Database, projectId: string): boolean {
  return new ProjectStore(database).list().some((entry) => entry.id === projectId);
}

/** 下一个空号：`PRJ-003` / `CHG-012`。认不出形状的旧 id 不参与，也不挡路。 */
function mintId(prefix: string, existing: readonly string[]): string {
  const used = existing
    .map((id) => /^[A-Z]+-(\d+)$/.exec(id)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map((digits) => Number(digits));
  const next = (used.length === 0 ? 0 : Math.max(...used)) + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}
