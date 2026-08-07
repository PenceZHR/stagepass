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

/**
 * StagePass 自己打进旁路窗口的话，都以它开头。
 *
 * ## 为什么要标记
 *
 * 「这个窗口里人说过话吗」是起草的前置判据，而 rollout 的 `user_message` 里
 * **StagePass 自己发的提示词和人打的字混在一起** —— 开场白、起草指令都算「输入」。
 * 不标记就只能靠猜（比对正文、按长度、按时间），而每一种猜法都会在某天悄悄判反。
 *
 * 标记是给人看的，也是诚实的：那句话确实不是他说的。
 */
export const STAGEPASS_SAID = "[StagePass]";

/**
 * 2026-08-07 之前，StagePass 打进旁路窗口的话**没有标记**。
 *
 * 这两条是它那时发过的原文的开头，认出来只为了一件事：不把自己说过的话算成人说的。
 * 这不是「猜哪句像人说的」—— 两句都是 StagePass 自己写的常量，它当然认得。
 *
 * **它是过渡条款**：2026-08-06 真机上那条线程里躺着这两句，于是加了标记之后那道闸
 * 仍然放行，又写出一份空草稿。等那批线程都不在了，这个常量可以整个删掉。
 */
const SAID_BEFORE_THE_MARK: readonly string[] = [
  "这是 StagePass 里 ",
  "把我们在这个会话里谈到的、",
];

/** 这条线程上**人**说过几句（把 StagePass 自己说的刨掉）。 */
export function humanTurnsIn(messages: readonly string[]): number {
  return messages.filter((text) => {
    const said = text.trimStart();
    if (said.startsWith(STAGEPASS_SAID)) return false;
    return !SAID_BEFORE_THE_MARK.some((prefix) => said.startsWith(prefix));
  }).length;
}

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
export function draftPrompt(changeId: string): string {
  return `${STAGEPASS_SAID} 把我们在这个会话里谈到的、关于 ${changeId} 这次改动的`
    + "内容，整理成一份需求（brief）草稿。它是下游每个阶段的任务书，要写清："
    + "要什么、为什么要、边界在哪（不做什么）、怎么算做完。用我说过的话，"
    + "不要替我发明需求；我没谈到的就不写。只输出 brief 正文，不要开场白、"
    + "不要解释、不要落款。";
}

export type DraftOutcome =
  | { readonly kind: "no_such_change" }
  /** 没有旁路会话可读 —— 先开「旁路窗口」谈，谈完再来起草。 */
  | { readonly kind: "no_aside_conversation" }
  /**
   * **窗口开着，可是人一句话都没说。**
   *
   * 2026-08-06 真机撞出来的：判据原来是「有没有旁路会话」，而按一下「旁路窗口」
   * 会话当场就建好 —— 于是那道闸永远放行，模型照样交回一份草稿，四节全是
   * 「本会话尚未谈到具体改动内容」，而 StagePass 把它当草稿写进了文件。
   *
   * 一份没有对话的草稿不是「差一点的草稿」，它是**凭空的需求**，而这整条路存在的
   * 理由就是不许出现凭空的需求。所以判据换成「人开过口没有」。
   */
  | { readonly kind: "no_conversation_yet" }
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
  /**
   * 这条线程上打进去过哪些话（`codex/subagent.ts` 的 `readThreadUserMessages`）。
   * 注进来是为了这一层能离线证 —— 它只管数，不管从哪读。
   */
  saidIn: (threadId: string) => readonly string[];
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
  /*
   * **人得先开口。** 会话存在不等于谈过 —— 见 `no_conversation_yet`。
   * StagePass 自己打进去的话（开场白、上一次的起草指令）按标记刨掉。
   */
  if (humanTurnsIn(input.saidIn(aside.threadId)) === 0) {
    return { kind: "no_conversation_yet" };
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
  | {
    readonly kind: "recorded";
    readonly brief: string;
    /**
     * **它顶掉了一份已经存在的 brief。**
     *
     * 下游每个阶段的任务书都读 brief，顶掉它就是换掉整条流水线的地基 —— 那件事
     * 人得知道自己做了。这一层只把事实说出来，怎么呈现（提示、还是先拦一道）
     * 归界面。原文一起交出去：屏幕上说得出「被顶掉的是哪一份」，人才追得回来。
     */
    readonly replaced: string | null;
  };

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
  let existing: string | null;
  try {
    existing = changes.read(changeId).brief;
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
  return { kind: "recorded", brief, replaced: existing };
}
