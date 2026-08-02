import { blockersFrom, type Gap } from "../domain/gap";
import type { Blocker } from "../domain/gate";
import type { Phase } from "../domain/phase";
import {
  judgePrompt, readAgents, readConclusion, readRound,
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
 * sub-agents at the paths it was told to use.
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
   * **不再按 `agent_path` 认红蓝** —— 那一列只有原生 `spawn_agent({task_name})`
   * 会设，而那个工具不是每个 Codex 会话都有（2026-07-30 实测）。现在由裁判把它
   * 派生的两个 `agent_id` 报进答案。
   */
  readonly readThread: (threadId: string) => string;
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
   * 裁判报出来的那两条线程，然后读它们自己的话。
   *
   * **顺序不能换**（见文件开头）：两边都读到了，才允许写 gap。裁判没报 id 会在这里
   * 抛 —— 那是对的，一轮读不到正反两方说了什么，就不该在闸门那边留下任何痕迹。
   */
  const agents = readAgents(delivery.text);
  /*
   * **红蓝都不许是裁判自己**（2026-08-02 Fix 第 2 轮真机撞出的）。
   *
   * 裁判把自己的线程 id 报成了某一方 —— `readThread` 于是读回它自己的开场白，
   * `parseTurnResult` 拿着一段裁判散文找 json，报出来的错（turn_result_no_json，
   * 详情是裁判的话）指向完全错误的方向。`readAgents` 早有「红蓝不许相同」的守卫，
   * 漏了这一种。在这里拦是因为只有这一层同时握着两边的 id 和裁判自己的 id。
   */
  if (agents.red === delivery.threadId || agents.blue === delivery.threadId) {
    throw new Error(
      `judge_reported_itself: 裁判把自己的线程 ${delivery.threadId.slice(0, 12)}… 报成了子 Agent`,
    );
  }
  const red = dependencies.readThread(agents.red);
  const blue = dependencies.readThread(agents.blue);

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
    /*
     * 结论读不出来**不作废这一轮** —— 它不决定任何状态，为一句读不准的建议扔掉
     * 一轮几分钟的对抗不成比例。`readConclusion` 把「读不出来」当成一个值交出来，
     * 而不是抛，理由写在它自己那儿。
     */
    conclusion: readConclusion(delivery.text),
    blueOverall: reading.blueOverall,
  };
}
