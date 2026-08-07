import type Database from "better-sqlite3";

import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";

/**
 * **把闲聊收敛成 brief**（批 2，DESIGN-phase-not-the-only-axis §3.4）。
 *
 * 分工是用户 2026-08-06 拍的：**模型起草，人改。** 人在旁路会话里谈到满意，
 * 模型把那段对话整理成一份草稿，**人改过的那一版才是 brief**。
 *
 * ## 机械判据：未经人编辑的草稿不算 brief
 *
 * `round-turn-runner` 里那句「人要的是这些，他自己答的，不是模型猜的」是下游
 * 每个阶段的地基。直接接受模型草稿等于没改 —— 那句话就成了假话。所以定稿时
 * 逐字比对（`normalise` 后）：终稿和草稿相同就拒绝，这不靠流程叮嘱，靠代码。
 *
 * ## 两步各自是一个动作
 *
 *   draftBrief    在旁路线程上跑一个 turn，把对话整理成草稿，落成两份文件：
 *                 草稿（对照底本，之后不动）和工作稿（人改的那份，初始 = 草稿）
 *   confirmBrief  人说改完了 —— 读回工作稿，和草稿比对，不同才录成 brief
 *
 * 中间那段（人在编辑器里改文件）不经过 StagePass —— 它本来就是人的活儿。
 *
 * ## 它不认识 HTTP，也不认识 Codex
 *
 * 跑 turn、读写文件全是注进来的，和 `record-brief.ts` 同一条纪律 —— 这一层
 * 因此能在没有 Codex 的情况下整条跑完。
 */

/** 草稿和工作稿的文件名 —— 定稿那步靠同一套名字找回来，别在两处各拼一份。 */
export function briefFileNames(changeId: string): {
  readonly draft: string;
  readonly edit: string;
} {
  return { draft: `${changeId}-draft.md`, edit: `${changeId}.md` };
}

/**
 * 起草的提示词。跑在**旁路线程**上 —— 那段对话就在它自己的历史里，
 * 不需要转述（转述会丢，`relayedTo` 那一课）。
 */
function draftPrompt(changeId: string): string {
  return [
    `把我们在这个会话里谈到的、关于 ${changeId} 这次改动的内容，整理成一份需求`
    + "（brief）草稿。它是下游每个阶段的任务书，要写清：要什么、为什么要、边界在哪"
    + "（不做什么）、怎么算做完。用我说过的话，不要替我发明需求；我没谈到的就不写。",
    "只输出 brief 正文，不要开场白、不要解释、不要落款。",
  ].join("\n");
}

export type DraftOutcome =
  | { readonly kind: "no_such_change" }
  /** 没有旁路会话可读 —— 先开「旁路窗口」谈，谈完再来起草。 */
  | { readonly kind: "no_aside_conversation" }
  | { readonly kind: "draft_failed"; readonly detail: string }
  | {
    readonly kind: "drafted";
    readonly draftPath: string;
    readonly editPath: string;
    readonly draft: string;
  };

export async function draftBrief(input: {
  database: Database.Database;
  changeId: string;
  /** 在这条线程上跑一个 turn，回它说的话。会话怎么起、超时多少，全在 web 层。 */
  runTurn: (threadId: string, prompt: string) => Promise<string>;
  /** 落一份文件，返回绝对路径。放哪由 web 层定（生产在 ~/.stagepass/briefs/）。 */
  writeBriefFile: (name: string, content: string) => string;
}): Promise<DraftOutcome> {
  const { database, changeId } = input;
  try {
    new ChangeStore(database).read(changeId);
  } catch {
    return { kind: "no_such_change" };
  }
  const aside = new BindingStore(database).findAside(changeId);
  if (aside === null || aside.status !== "bound") {
    return { kind: "no_aside_conversation" };
  }

  let draft: string;
  try {
    draft = (await input.runTurn(aside.threadId, draftPrompt(changeId))).trim();
  } catch (error: unknown) {
    return {
      kind: "draft_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (draft === "") {
    // 一份空草稿没有可改的东西 —— 「改空稿」和「自己从头写」在判据上分不开。
    return { kind: "draft_failed", detail: "模型交回来的是一段空白" };
  }

  const names = briefFileNames(changeId);
  // 草稿是对照底本，工作稿从它拷出来 —— 人只动后者，比对时前者就是「没改」的样子。
  const draftPath = input.writeBriefFile(names.draft, draft);
  const editPath = input.writeBriefFile(names.edit, draft);
  return { kind: "drafted", draftPath, editPath, draft };
}

export type ConfirmOutcome =
  | { readonly kind: "no_such_change" }
  /** 没起草过（或草稿被删了）—— 没有底本，「改没改过」这个判据就问不出来。 */
  | { readonly kind: "nothing_drafted" }
  /** 工作稿不见了。 */
  | { readonly kind: "edit_missing" }
  /** **机械判据挡住的那条路**：终稿和草稿逐字相同 —— 未经人编辑的草稿不算 brief。 */
  | { readonly kind: "draft_unedited" }
  /** 改成了一片空白 —— 一段空 brief 等于回到那份编出来的 PRD。 */
  | { readonly kind: "empty_brief" }
  | { readonly kind: "recorded"; readonly brief: string };

/** 行尾和首尾空白不算「改过」—— 编辑器保存时自动做的那些事不是人的编辑。 */
const normalise = (text: string): string =>
  text.replaceAll("\r\n", "\n").split("\n").map((line) => line.trimEnd())
    .join("\n").trim();

export function confirmBrief(input: {
  database: Database.Database;
  changeId: string;
  /** 读回一份文件，不在就是 null。 */
  readBriefFile: (name: string) => string | null;
}): ConfirmOutcome {
  const { database, changeId } = input;
  const changes = new ChangeStore(database);
  try {
    changes.read(changeId);
  } catch {
    return { kind: "no_such_change" };
  }

  const names = briefFileNames(changeId);
  const draft = input.readBriefFile(names.draft);
  if (draft === null) return { kind: "nothing_drafted" };
  const edited = input.readBriefFile(names.edit);
  if (edited === null) return { kind: "edit_missing" };

  const brief = normalise(edited);
  if (brief === "") return { kind: "empty_brief" };
  if (brief === normalise(draft)) return { kind: "draft_unedited" };

  changes.setBrief(changeId, brief);
  return { kind: "recorded", brief };
}
