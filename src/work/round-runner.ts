import { blockersFrom, type Gap } from "../domain/gap";
import type { Blocker } from "../domain/gate";
import type { Phase } from "../domain/phase";
import {
  judgePrompt, readConclusion, readRound, readVerdicts,
  type RoundAgents, type RoundConclusion, type RoundInstructions,
} from "../domain/round";
import type { CodexTransport } from "../codex/transport";
import type { GapStore } from "../store/gap-store";

/**
 * One adversarial round, from prompt to settled gaps.
 *
 * The four things this joins were each proved separately -- the judge's prompt,
 * finding a sub-agent's own rollout, reading three transcripts into an outcome,
 * and writing that outcome to the gap store. What was missing was the wire
 * between them, and a wire is exactly the kind of thing the tree this replaces
 * had a hundred of: built, plausible, and never once run end to end.
 *
 * ## Red and blue are read before anything is written
 *
 * If blue's transcript cannot be found, this throws and the gap store is
 * untouched. That ordering is the whole safety property: a round that half
 * happened must leave the gate reading the state from before it, not a state in
 * which red's artifacts were recorded and blue's objections were lost. "Blue
 * could not be read" and "blue found nothing" are the two things that must never
 * arrive at the gate as the same thing, and here they differ by an exception.
 *
 * ## Everything unproven is injected
 *
 * The transport and the rollout reader are parameters, so the whole of this runs
 * offline against `ScriptedCodexTransport` and a stub reader. What is left that
 * needs a real Codex is one thing only: whether a judge actually spawns two
 * sub-agents, one after the other.
 */

export interface RoundRequest {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  /** What red is asked to produce. */
  readonly task: string;
  /** The judge's thread, or null to start one. */
  readonly judgeThreadId: string | null;
  /** 原样转给 `judgePrompt`。这一层同样不知道里面是什么。 */
  readonly addenda?: RoundInstructions["addenda"];
}

export interface RoundDependencies {
  readonly transport: CodexTransport;
  readonly gaps: GapStore;
  /**
   * 一条线程自己说的话，按线程 id 读。
   *
   * 拿到 id 的那条路见 `childThreads` —— 这里只管「拿着 id 去读它说了什么」。
   */
  readonly readThread: (threadId: string) => string;
  /**
   * 一条线程派生的子 Agent，按出生先后排（`codex/subagent.ts` 的 `childThreadsOf`）。
   *
   * **这条取代了「让裁判把两个 `agent_id` 报进答案」。** 那一版把 36 字符的 UUID
   * 放进了模型必须手抄的文本里，而抄错一个字符这一轮就作废、正反两方说的话谁也
   * 看不到（`02059a8` 实测过一次：它把自己的线程报成了子 Agent）。
   *
   * 判据换成 rollout 里 `session_meta` 的 `parent_thread_id` —— 76/76 有值，
   * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
   */
  readonly childThreads: (parentThreadId: string) => readonly string[];
}

/** 这一轮认不出正反两方跑在哪两条线程上。 */
export class RoundAgentsNotFoundError extends Error {
  constructor(readonly spawned: number) {
    super(`round_agents_not_found: 这一轮只认出 ${spawned} 条子 Agent 线程，需要两条`);
    this.name = "RoundAgentsNotFoundError";
  }
}

export interface RoundSettled {
  /** The thread the judge ran on. Later rounds resume it. */
  readonly judgeThreadId: string;
  readonly artifactIds: readonly string[];
  readonly gaps: readonly Gap[];
  /** What the gate will see. Empty means this phase is not blocked. */
  readonly blockers: readonly Blocker[];
  /**
   * 三个角色各自说了什么，原文交出来。
   *
   * 这里已经读到了它们（红蓝各自的 rollout、裁判的返回），交出来是为了让上层不必
   * 再读一次 —— 再读一次不只是浪费，而是**可能读到不同的东西**：rollout 是活的，
   * 两次读之间它可以长。上层要对同一份文本做判定，就必须是这一份。
   */
  readonly transcripts: {
    readonly red: string;
    readonly blue: string;
    readonly judge: string;
  };
  /**
   * 这一轮跑在哪两条线程上。
   *
   * 交出来是为了让上层能去问那两条线程**收到过什么** —— 「反方没答」和「反方压根
   * 没收到契约」是两件必须分开的事，而后者只有拿着线程 id 才查得了
   * （`codex/rollout.ts` 的 `allTextIn`）。
   */
  readonly agents: RoundAgents;
  /**
   * 这一轮实际派生了几条子 Agent 线程。**正常是 2。**
   *
   * 交出来是因为 >2 时 StagePass 取的是最后两条，而那是一个**判断**：会多出来通常
   * 是裁判重派了一次（第一次的子 Agent 失败了），这时最后两条是对的；但它也可能是
   * 裁判违反了「一个跑完再派下一个」。两者在这里分不出来，所以不猜也不静默 ——
   * 照数报上去，让人在账本上看得见。
   */
  readonly spawned: number;
  /**
   * 这一轮里**形状坏掉**的地方。空 = 三方的答复读起来都是完整的。
   *
   * ## 为什么它得单独交出来
   *
   * 一份坏格式不只毁掉这一轮 —— 它**留在那条线程自己的历史里**。resume 回去，模型
   * 接着抄自己上一轮的坏形状（2026-08-02 实测：同一个抄错的 UUID 连抄三轮，同一个
   * 少了右花括号的信封连写两轮）。提示词里的告诫压不过它自己的历史。
   *
   * 而这些轮**是成功的** —— gap 照写、状态照推，只是某样东西没读出来。所以靠
   * 「job 失败了没有」判断要不要放开线程的那条路看不见它们（`web/panel-server.ts`）。
   *
   * 上层拿它去 `BindingStore.detach`，下一轮从干净线程开。放开是安全的：线程从来
   * 不是真相的载体 —— 开着的 gap、任务、契约每一轮都完整写在提示词里。
   */
  readonly malformed: readonly string[];
  /**
   * 裁判对「还要不要再来一轮」的结论。null = 它没给。
   *
   * **不动闸门**（用户 2026-07-31：裁判给结论，人按按钮）。这一层只负责把它读出来
   * 交上去，怎么呈现是上层的事。
   */
  readonly conclusion: RoundConclusion | null;
  /** 反方对这一轮的整体判断，一句话。同样不动闸门。 */
  readonly blueOverall: string | null;
}

export async function runRound(
  request: RoundRequest,
  dependencies: RoundDependencies,
): Promise<RoundSettled> {
  // Only open gaps are put to the judge. A closed one is not a question, and
  // listing it would invite a verdict that reopens something already settled.
  const openGaps = dependencies.gaps
    .all(request.changeId, request.phase)
    .filter((gap) => gap.status === "open");

  /*
   * **这一轮之前它已经有哪些孩子** —— 必须在 turn 之前问。
   *
   * 成功的轮复用裁判线程，所以一条裁判线程会累积多轮的子 Agent（实测见过一条挂着
   * 7 个）。差集给出的正是「这一次派生的」，而且它不依赖任何时钟 —— 拿时间戳去比
   * 要假设 StagePass 和 Codex 的钟对得上，差集不用。
   *
   * 新线程时 `judgeThreadId` 是 null，此时它还不存在，孩子当然也没有。
   */
  const before = request.judgeThreadId === null
    ? []
    : dependencies.childThreads(request.judgeThreadId);

  const delivery = await dependencies.transport.runTurn({
    threadId: request.judgeThreadId,
    prompt: judgePrompt({
      phase: request.phase,
      round: request.round,
      task: request.task,
      openGaps,
      addenda: request.addenda,
    }),
  });

  /*
   * 这一轮派生的那两条线程，然后读它们自己的话。
   *
   * **顺序不能换**（见文件开头）：两边都读到了，才允许写 gap。认不出两条会在这里
   * 抛 —— 那是对的，一轮读不到正反两方说了什么，就不该在闸门那边留下任何痕迹。
   *
   * **先出生的是红方，后出生的是蓝方**（`childThreadsOf` 那里写了依据）。多于两条时
   * 取最后两条：多出来通常是裁判重派了一次，那时最后两条是对的。这个判断连同实际
   * 派了几条一起交上去（`spawned`），不静默。
   */
  const fresh = dependencies.childThreads(delivery.threadId)
    .filter((threadId) => !before.includes(threadId));
  if (fresh.length < 2) throw new RoundAgentsNotFoundError(fresh.length);
  const agents: RoundAgents = {
    red: fresh[fresh.length - 2]!,
    blue: fresh[fresh.length - 1]!,
  };

  const red = dependencies.readThread(agents.red);
  const blue = dependencies.readThread(agents.blue);

  /*
   * 信封坏没坏，和「它给没给裁决」是两件事 —— 见 `VerdictReport.unreadable`。
   * 结论读不出来同理：它不作废这一轮（那句话不动闸门），但坏格式一样会循环。
   */
  const conclusion = readConclusion(delivery.text);
  const malformed: string[] = [];
  if (readVerdicts(delivery.text).unreadable) malformed.push("verdicts_unreadable");
  if (conclusion?.kind === "unreadable") malformed.push("conclusion_unreadable");

  const reading = readRound({
    phase: request.phase,
    round: request.round,
    red,
    blue,
    judge: delivery.text,
  });

  const gaps = dependencies.gaps.settleRound(
    request.changeId, request.phase, reading.outcome,
  );

  return {
    judgeThreadId: delivery.threadId,
    artifactIds: reading.artifactIds,
    gaps,
    blockers: blockersFrom(gaps),
    transcripts: { red, blue, judge: delivery.text },
    agents,
    spawned: fresh.length,
    malformed,
    /*
     * 结论读不出来**不作废这一轮** —— 它不决定任何状态，为一句读不准的建议扔掉
     * 一轮几分钟的对抗不成比例。`readConclusion` 把「读不出来」当成一个值交出来，
     * 而不是抛，理由写在它自己那儿。
     *
     * 但它会进 `malformed`：不作废这一轮，和「让这份坏格式在线程里循环下去」
     * 是两件事。
     */
    conclusion,
    blueOverall: reading.blueOverall,
  };
}
