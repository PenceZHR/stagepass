import { blockersFrom, type Gap, type Verdict } from "../domain/gap";
import type { Blocker } from "../domain/gate";
import type { Phase } from "../domain/phase";
import {
  judgePrompt, readConclusion, readRound, readVerdicts, renderOpenGaps,
  renderSettled,
  type RoundAgents, type RoundConclusion,
} from "../domain/round";
import { RESULT_CONTRACT_NOTES } from "../domain/turn";
import type { CodexTransport } from "../codex/transport";
import type { GapStore } from "../store/gap-store";
import type { WorkItem, WorklistStore } from "../store/worklist-store";
import type { WorkItemDraft } from "../domain/worklist";

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
  /**
   * 除了「对已有问题表态」之外，这一轮还要裁判逐条答的东西。
   *
   * L5 用它塞 critic 那份 rubric 的每一条标准 —— **和 `addenda` 同一个形状的道理**：
   * 这一层不知道 rubric 是什么，它只知道「名单上还有别人加的几条」。
   *
   * 必须和 gap 那些**在同一份名单里**：游标只有一个，两份名单就是两个游标，
   * 而模型手上只有一个 `stagepass_next`。
   */
  readonly extraWorkItems?: readonly WorkItemDraft[];
  /**
   * 反方这一轮还要逐条判定的那几条标准在哪、答案写到哪。
   *
   * **这一层不知道 rubric 是什么**，和 `extraWorkItems` 同一个道理：它只管把两个
   * 路径原样带进裁判的提示词。写文件、读回来、按序号映射，全在 L5
   * （`work/rubric-round.ts`）。
   *
   * 为什么非得经裁判转达：Codex 禁止外部驱动子 Agent 线程（2026-08-03 实测，
   * `scripts/probe-subagent-input.ts`），反方的父线程是唯一还通的通道。
   */
  readonly blueRubric?: {
    readonly criteriaPath: string;
    readonly answersPath: string;
    readonly count: number;
  } | undefined;
  /**
   * 反方这一轮的意见写到哪。这一层只管原样带进裁判的提示词
   * （`RoundInstructions.blueDocPath`），家在哪由 `domain/artifact-home.ts` 说。
   */
  readonly blueDocPath?: string | undefined;
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
  /**
   * 裁判这一轮逐条表态的名单。
   *
   * **这一层拥有游标，不是 L5** —— 因为 gap 那部分只有这里知道（`openGaps` 就在
   * 手边），而一份名单只能有一个游标。L5 要加的几条从 `extraWorkItems` 进来。
   */
  readonly worklist: WorklistStore;
  /**
   * 把这一轮要给模型读的一份文本落成文件，返回它的绝对路径。
   *
   * **为什么走文件**：开着的问题名单在提示词里出现两次（红方要去改、裁判要据此写
   * 结论），占掉整份提示词的四分之一，而它天然是一份文档。用户 2026-08-03：
   * 「能文件化的就以文件的形式传给提示词，否则提示词过于冗长。」
   *
   * 比省字数更值钱的一条：**路径比段落难被改写**。这份名单要经裁判转达给红方，而
   * 实测过好几次「裁判把要转达的正文改写或省略掉了」（`domain/round.ts` 的
   * `relayedTo`）—— 一个路径它没什么可消化的，转坏了红方会大声报读不到，而不是
   * 安静地照一份缩水的名单干活。
   *
   * 注入是为了离线证。真实现写在临时目录，**不写进工作区** —— 那会把干净树弄脏，
   * 而干净树是派轮的前置条件（`workspace_dirty`）。子 Agent 的沙箱把 `/private/tmp`
   * 列在可写根里，实测见过。
   */
  readonly writeRoundFile: (name: string, content: string) => string;
  /**
   * 读回一份这一轮写出去的文件，**不在就是 `null`**。
   *
   * 「文件不在」和「写了但对不上号」要分开 —— 前者是反方压根没照做，后者是它照做了
   * 但数不对。人对这两件事该做的事完全不同（`readBlueRubricAnswers` 各给一句话）。
   */
  readonly readRoundFile: (path: string) => string | null;
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
   * 这一轮裁判逐条答成什么样，**连同它看不见的那一列**（`target`）。
   *
   * 交出来是给 L5 用的：它塞进去的那几条标准要按 `target` 认回自己的 criterion key。
   * gap 那部分已经在这一层翻译成 verdict 了，L5 不必再看。
   */
  readonly workItems: readonly WorkItem[];
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
   * 名单落成文件，提示词里只印路径。空名单不写 —— 那时提示词里那句
   * 「本阶段目前没有未关闭的问题」比一个空文件清楚。
   */
  const openGapsPath = openGaps.length === 0
    ? undefined
    : dependencies.writeRoundFile(
        `open-problems-${request.phase}-r${request.round}.md`,
        [
          `# ${request.changeId} · ${request.phase} 第 ${request.round} 轮：还开着的问题`,
          "",
          renderOpenGaps(openGaps),
          "",
        ].join("\n"),
      );

  /*
   * 人已经裁定过的事，**跨这个 Change 的所有阶段**。
   *
   * 和 `openGapsPath` 对称地放在这里，理由也一样：同一份内容不能一处渲染进文件、
   * 另一处渲染进提示词，两份迟早漂开。
   *
   * 跨阶段是它存在的全部理由：每个阶段一条新线程、一个新反方，从零开始怀疑，而人在
   * Spec 里裁过的事 TechSpec 的反方结构上看不见。2026-08-02 实测：去重语义被重提
   * 5 次、范围定义 3 次，每次烧一轮 turn 加一次裁决。
   *
   * 一条都没有就不写文件、提示词里也一行不印 —— 一个空文件只会让三方都去猜它
   * 是不是该有内容。
   */
  const settled = dependencies.gaps.humanSettled(request.changeId);
  const settledPath = settled.length === 0
    ? undefined
    : dependencies.writeRoundFile(
        `settled-${request.changeId}.md`,
        [
          `# ${request.changeId}：人已经裁定过的事`,
          "",
          renderSettled(settled),
          "",
        ].join("\n"),
      );

  /*
   * 结果契约里说明那一半走文件（BACKLOG §3.4）。
   *
   * **无条件写** —— 和 settled / openGaps 那两份不一样：它们「没有内容就不写」，
   * 因为一个空文件会让三方去猜它是不是该有内容。而这份的内容是常量，永远有。
   *
   * 只挪说明，骨架仍然原样印两遍 —— 判据在 `RESULT_CONTRACT` 那段注释里：
   * 骨架缺了整轮无法解析，说明缺了只是写得糙。
   */
  const contractNotesPath = dependencies.writeRoundFile(
    "result-contract-notes.md",
    [
      "# 交答案时，这几个字段是什么意思",
      "",
      RESULT_CONTRACT_NOTES,
      "",
    ].join("\n"),
  );

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

  /*
   * **名单要在 turn 之前开好** —— 裁判一起来就可能调 `stagepass_next`。
   *
   * 顺序也是这里定的：先所有 open gap，再 L5 追加的那几条标准。裁判影响不了它，
   * 那正是重点 —— 它连「现在答的是哪一条」都不知道。
   */
  const items: WorkItemDraft[] = [
    ...openGaps.map((gap) => ({
      kind: "gap" as const,
      target: gap.id,
      // **标题和人说的话进去，id 不进去。** 进去了它就会照着抄。
      prompt: [
        `这个问题还成不成立？`,
        gap.note === null ? gap.title : `${gap.title}\n人说：${gap.note}`,
      ].join("\n"),
      choices: ["closed", "still_open"],
    })),
    ...(request.extraWorkItems ?? []),
  ];
  dependencies.worklist.open(request.changeId, request.phase, request.round, items);

  const delivery = await dependencies.transport.runTurn({
    threadId: request.judgeThreadId,
    prompt: judgePrompt({
      phase: request.phase,
      round: request.round,
      task: request.task,
      openGaps,
      openGapsPath,
      ...(request.blueRubric === undefined ? {} : { blueRubric: request.blueRubric }),
      ...(request.blueDocPath === undefined ? {} : { blueDocPath: request.blueDocPath }),
      ...(settledPath === undefined ? {} : { settledPath }),
      contractNotesPath,
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

  /*
   * 名单收工，读回它答成什么样。
   *
   * **一条都没答，而名单不是空的 —— 那是机制被绕过了**，不是它的判断。提示词明写着
   * 逐条走工具，全不答只可能是它压根没调（工具没起来、或者它自作主张写进了 json）。
   * 记进 `malformed`，于是线程被放开，下一轮从干净的开 —— 一条中毒的线程会把
   * 「不用那个工具」这件事也一起抄下去。
   *
   * **答了一部分不算**：那是它的判断，沉默的那几条按老规矩保持 open。
   */
  dependencies.worklist.close(request.changeId, request.phase, request.round);
  const answered = dependencies.worklist.read(
    request.changeId, request.phase, request.round,
  );
  if (items.length > 0 && answered.every((item) => item.answer === null)) {
    malformed.push("worklist_unanswered");
  }

  const verdicts: Record<string, Verdict> = {};
  for (const item of answered) {
    if (item.kind !== "gap" || item.answer === null || item.reason === null) continue;
    verdicts[item.target] = {
      kind: item.answer as Verdict["kind"], reason: item.reason,
    };
  }

  const reading = readRound({
    phase: request.phase,
    round: request.round,
    red,
    blue,
    judge: delivery.text,
  }, verdicts);

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
    workItems: answered,
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
