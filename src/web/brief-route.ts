import { readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { renderOpening } from "../domain/opening";
import { templateFor, missingSections } from "../domain/phase-template";
import { artifactPathOf, splitSections, type DocSection } from "../domain/prd-doc";
import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import { NoteStore, type Note } from "../store/note-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { defaultChange } from "./bind-project";
import { projectRootOf, sameProject, wrongProjectReason } from "./same-project";

/**
 * 「模型现在该干什么」—— 一次 pull 拿全（DESIGN-prd-phase-2026-08-19 §五）。
 *
 * ## 为什么是 pull，不是人点了推给它
 *
 * 用户 2026-08-19 原话：「我现在已经搬到 codex 和 claude code 内部了，压根不需要
 * 点击了，只需要题面」。原来那条路要人在面板上点「取题面」，再把信封粘进会话 ——
 * **那是执行通道时代的遗产**，他的流程里没有它的位置，而且他实际上点不动。
 *
 * ## 它一次给全，不给「下一步是什么」
 *
 * 阶段、七节题面、rubric、上一版正文、**还没下文的意见** —— 模型据此自己判断该写
 * 初稿还是该改。**StagePass 不替它排序**：那是模型的活，而且它比这一层知道得多
 * （它刚和人聊完）。
 */
export interface BriefDeps {
  readonly database: Database.Database;
  readonly boundProjectId: string;
}

export type BriefRole = "producer" | "blue";

export interface Brief {
  readonly ok: true;
  readonly changeId: string;
  readonly phase: Phase;
  readonly role: BriefRole;
  /** 产物写到哪。**路径由代码拼**，模型一个字都不写。 */
  readonly artifactPath: string;
  /** 七节：写什么、已经写了什么。 */
  readonly sections: readonly (DocSection & { readonly asks: string })[];
  /** 这一节还空着 —— 闸门的第一道。 */
  readonly missing: readonly string[];
  readonly rubric: readonly { readonly text: string; readonly section: string | null }[];
  /**
   * 还没下文的意见。**模型逐条处理完才算这一轮做完。**
   *
   * `ordinal` 是它在**全部意见**里的位置（不是在「还没下文的」里）—— 答掉一条不会
   * 让别的条错位。给的是序号不是 `NOTE-0007`：那串 id 是 StagePass 拿去做精确匹配的，
   * 让模型生成它就是又开一个手抄面（DESIGN-no-hand-transcription-2026-08-02）。
   */
  readonly notes: readonly {
    readonly ordinal: number;
    readonly sectionKey: string;
    readonly text: string;
  }[];
  /**
   * 人开新会话时原样粘进去的两段话。**这一格是给面板的，模型用不着** ——
   * 它已经在会话里了，不需要一段告诉它怎么进会话的话。
   */
  readonly opening: { readonly producer: string; readonly blue: string };
}

export interface BriefRefused {
  readonly ok: false;
  readonly error: string;
  readonly reason: string;
  /**
   * 拒了也要带上的两样。
   *
   * **开场白只需要阶段名，不需要模板** —— 它被 `no_template` 顺手挡掉过一次
   * （2026-08-19，用户截图：七个没模板的阶段上写着「这个阶段还没有开场白」）。
   * 一个判据挡掉另一个跟它无关的东西，是这一层最容易犯的错：提前返回一刀切下去，
   * 连带砍掉了本来算得出来的那些。
   */
  readonly phase?: Phase;
  readonly opening?: { readonly producer: string; readonly blue: string };
}

/** 这个阶段的两段开场白。**和模板、和产物、和 Change 都无关**，只认阶段名。 */
function openingFor(phase: Phase): { producer: string; blue: string } {
  const source = openingSource();
  return {
    producer: renderOpening(source, phase, "producer") ?? "",
    blue: renderOpening(source, phase, "blue") ?? "",
  };
}

/**
 * 还没下文的那些，带着它们在**全部意见**里的序号。
 *
 * 序号取自全表而不是取自「还没下文的」那一段：模型答掉一条之后，剩下几条的序号
 * **一个都不会动**。否则它连答两条就会把第二条答到别人身上，而那种错在账本上
 * 看着完全正常。
 */
function notesWithOrdinals(database: Database.Database, changeId: string, phase: Phase) {
  const all = new NoteStore(database).list(changeId, phase);
  return all
    .map((note, index) => ({ note, ordinal: index + 1 }))
    .filter(({ note }) => note.respondedAt === null)
    .map(({ note, ordinal }) => ({ ordinal, sectionKey: note.sectionKey, text: note.text }));
}

/** 序号换回那条意见。**换不回来就是 null，不猜。** */
export function noteByOrdinal(
  database: Database.Database, changeId: string, phase: Phase, ordinal: number,
): Note | null {
  return new NoteStore(database).list(changeId, phase)[ordinal - 1] ?? null;
}

/**
 * 开场白的源文本。**每次现读** —— 它是给人改的（`src/prompts/opening.md`），
 * 改完刷新页面就该看到新的，而不是要重起工作台。文件小，读一次的代价可以忽略。
 */
function openingSource(): string {
  try {
    return readFileSync(new URL("../prompts/opening.md", import.meta.url), "utf8");
  } catch {
    return "";
  }
}

export function briefFor(
  deps: BriefDeps, role: BriefRole, cwd?: unknown,
  /**
   * 只影响**开场白**是哪个阶段的。
   *
   * 人在环上点哪一格，要的就是那一格的开场白 —— 而产物、意见、闸门仍然是这条
   * Change **当前**阶段的（它就在那个阶段，看别的阶段的产物没有意义）。
   * 两件事分开：**点哪儿看哪儿的说明，做哪儿算哪儿的账。**
   */
  openingPhase?: Phase,
): Brief | BriefRefused {
  /*
   * **面板自己看时不带 `cwd`（它就是这个工作台），模型来拿时必须带。**
   * 判据见 `ask-route.ts` 的 `sameProject`：一台机器一个工作台，而任何一条会话都
   * 打得到它 —— 少了这一格，别的项目的会话会把题面拿走、把产物写到这边来。
   */
  if (cwd !== undefined) {
    const root = projectRootOf(deps.database, deps.boundProjectId);
    if (!sameProject(root, cwd)) {
      return { ok: false, error: "wrong_project", reason: wrongProjectReason(root, cwd) };
    }
  }
  const changeId = defaultChange(deps.database, deps.boundProjectId);
  if (changeId === null) {
    return {
      ok: false, error: "no_change",
      reason: "这个项目里还没有任何 Change。请人去 StagePass 面板上新建一条。",
    };
  }
  const change = new ChangeStore(deps.database).read(changeId);
  const phase = change.state.phase;
  const template = templateFor(phase);
  if (template === null) {
    return {
      ok: false, error: "no_template",
      reason: `${phase} 这个阶段还没有产物模板 —— 这一步 StagePass 还没做到`
        + "（现在只有 PRD 那一整套是通的）。**开场白照样能用。**",
      // 模板没有不代表开场白没有：它只认阶段名
      phase, opening: openingFor(openingPhase ?? phase),
    };
  }

  /*
   * 正文从**项目仓库里那份文件**读，不从库读。接口就是一个目录：零 API、零版本、
   * 零协议，厂商怎么迭代都打不到（DESIGN §3.3）。读不到就是还没写，不是错。
   */
  const path = artifactPathOf(changeId, phase);
  const root = change.projectId === null
    ? null
    : new ProjectStore(deps.database).read(change.projectId).path;
  let markdown = "";
  if (root !== null && root !== "") {
    try { markdown = readFileSync(join(root, path), "utf8"); } catch { markdown = ""; }
  }

  const bodies = splitSections(markdown, template);
  const asksOf = new Map(template.map((one) => [one.key, one.asks]));
  const rubric = change.projectId === null ? null : new RubricStore(deps.database)
    .effective(change.projectId, changeId, phase, role === "blue" ? "critic" : "producer");

  return {
    ok: true,
    changeId,
    phase,
    role,
    artifactPath: path,
    sections: bodies.map((one) => ({ ...one, asks: asksOf.get(one.key) ?? "" })),
    missing: missingSections(markdown, template),
    rubric: (rubric?.criteria ?? []).map((one) => ({ text: one.text, section: one.section })),
    /*
     * **蓝方拿不到意见。** 它挑的是「你俩一起没想到的」，而意见正是那两个人一起想
     * 出来的东西 —— 给它看，它就只会顺着你们的思路往下说。互盲盲的就是这一层。
     */
    notes: role === "blue" ? [] : notesWithOrdinals(deps.database, changeId, phase),
    opening: openingFor(openingPhase ?? phase),
  };
}
