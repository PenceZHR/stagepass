import type { Phase } from "./phase";

/**
 * 一个 Change 的产物在仓库里的家：`docs/stagepass/<change-id>/`。
 *
 * ## 路径由 StagePass 指定，不由模型现编
 *
 * 这是 E（产物污染干净树）的全部前提。模型现编文件名的下场实测过：一个仓库里
 * 四套互不兼容的命名，**连 Change id 都编**（`CHG_002`，任何库里都没有过这个 id）
 * —— 「从文件名认出它属于谁」这条路根本不通，所以反过来：家在哪由这里说，
 * 每一轮的任务书把确切路径递给红蓝双方。
 *
 * ## 为什么每个 Change 一个目录，而不是 StagePass 一个目录
 *
 * 轮末的窄提交（`RepoOps.commitPaths`）提交的是**这个** Change 的目录 ——
 * 同一个仓库里跑两个 Change 时，谁也提交不了对方的东西。目录就是提交边界。
 *
 * ## 为什么在 docs/ 下而不是点目录
 *
 * 用户 2026-08-04 拍板「文档是交付物的一部分，跟着代码走」—— 交付物藏在
 * `.stagepass/` 那种点目录里，和这句话反着。
 *
 * ## 文件名用阶段标识符原样
 *
 * `phase.ts` 的「One phase, one name」管到「in a card, in a log line」——
 * 文件名也是 log line 的一种。`Spec-r1.md`，不是 `spec-r1.md`。
 *
 * ## 这个模块是纯的
 */
export function artifactHome(changeId: string): string {
  return `docs/stagepass/${changeId}`;
}

/** 正方这一轮的文档写到哪。相对项目根 —— Codex 就跑在项目根。 */
export function redDocPath(changeId: string, phase: Phase, round: number): string {
  return `${artifactHome(changeId)}/${phase}-r${round}.md`;
}

/**
 * 反方这一轮的意见写到哪。
 *
 * 它一直在写（每个阶段都见过 `-opposition` / `-review` 落在仓库根目录），
 * 只是从来没人告诉它写到哪 —— 于是它自己起名、自己挑地方。给它一个名字，
 * 它就不用发明第二个。
 */
export function blueDocPath(changeId: string, phase: Phase, round: number): string {
  return `${artifactHome(changeId)}/${phase}-r${round}-opposition.md`;
}
