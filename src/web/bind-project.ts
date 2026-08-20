import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type Database from "better-sqlite3";

import { createProject } from "../app/workspace";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";

/**
 * 工作台绑在**它自己所在的那个仓库**上。
 *
 * ## 用户定案（2026-08-19）
 *
 * 「stagepass 彻底依附在某个项目下，不再自己主动管理项目，统一 project 用一个，
 * 彻底隔离，但是需要管理 change。」
 *
 * 于是「哪个项目」不再是一个要人回答的问题 —— 它是 `pnpm stagepass` 起在哪儿。
 * 项目选择器、`?project=`、新建项目弹层，全都不需要了。
 *
 * ## 它顺带杀掉了一整类 bug
 *
 * 今晚那个「面包屑写着一个库里根本不存在的 `CHG-1`」，根源就是「认不出自己在哪个
 * 项目」—— 认不出时代码编了一个出来。绑定之后这个问题**在结构上不存在**：起得来
 * 就一定知道自己在哪，起不来就当场说。
 */

export type BindOutcome =
  | { readonly kind: "bound"; readonly id: string; readonly name: string; readonly path: string }
  /** 不是 git 仓库。「所有项目必须先 git」—— 理由在 `app/workspace.ts` 那条同名下场上。 */
  | { readonly kind: "not_a_repository"; readonly path: string };

/**
 * 认出（必要时建出）这个目录对应的项目。
 *
 * **同一个目录只许有一条。** 每次起工作台都建一个新项目的话，Change 会散在一堆
 * 同名项目下，而人看到的只是「我的 Change 不见了」。所以先按 realpath 找，找到就用
 * 库里那条（**名字也听库里的** —— 人可能改过，目录名不该把它盖回去）。
 */
export function bindProject(database: Database.Database, cwd: string): BindOutcome {
  const path = realpathSync(cwd);
  /*
   * 判据是**这个目录自己**有没有 `.git`，不是「有没有祖先是仓库」—— 后者会把
   * 仓库里的任意子目录认成项目，而 Codex 认 project 也是按目录自己算的。
   */
  if (!existsSync(join(path, ".git"))) return { kind: "not_a_repository", path };

  const projects = new ProjectStore(database);
  const known = projects.list().find((project) => project.path === path);
  if (known !== undefined) {
    return { kind: "bound", id: known.id, name: known.name, path };
  }

  /*
   * **建就用建项目那个用例，不在这儿另写一份。** 它管着铸 id、装出厂判据、以及
   * 那一整串路径校验 —— 抄一份出来迟早会和它分叉（这棵树最恨的那种分叉）。
   * 上面的仓库判据看着重复，其实是**先说人话**：这一层要说得出「是哪个目录」。
   */
  const created = createProject({ database, name: basename(path), path });
  if (created.kind !== "created") {
    // 上面已经把仓库那条挡了，走到这儿只可能是路径在这几行之间没了。
    return { kind: "not_a_repository", path };
  }
  return { kind: "bound", id: created.id, name: created.name, path };
}

/**
 * 这个项目默认看哪条 Change。**一条都没有就是 `null`。**
 *
 * 绑定之后「看哪个项目」不再问人，「看哪条 Change」也不该 —— 一个项目通常只有一条
 * 在办的，让人为此再点一下没有意义。
 *
 * 2026-08-19 真机：用户起在海战小游戏上，库里明明有 CHG-002，而面板说「认不出是
 * 哪个 Change」、环是空的 —— 他的结论是「里面什么都没有」。**数据在，只是没被选中。**
 * 插件那一层原来替人挑了第一条，删插件时那段跟着没了。
 *
 * 按建立顺序取（`ChangeStore.list` 就是这么排的）—— 稳定、可预期，而且第一条通常
 * 就是还在办的那条。
 */
export function defaultChange(database: Database.Database, projectId: string): string | null {
  return new ChangeStore(database).list(projectId)[0]?.id ?? null;
}
