import type { Job } from "./job-store";
import type { TurnOutcome, TurnRunner } from "./turn-loop";
import { runRubricRound, type RubricRoundDependencies } from "./rubric-round";
import type { BindingStore } from "../store/binding-store";
import type { ChangeStore } from "../store/change-store";

/**
 * 把一个阶段「跑一次」变成**跑一轮对抗**。
 *
 * ## 为什么是替换，不是并列
 *
 * 面板上的「跑这个阶段」原先走单次 turn：一个模型自己写、自己说没问题，闸门读它
 * 的自述。**那正是这个产品存在的理由的反面。** 对抗轮才是一个阶段该有的跑法 ——
 * 红方产出、蓝方质疑、裁判裁决，外加三份 rubric 逐条判定。
 *
 * 所以这里把它接成 `TurnRunner`，直接换掉原来那个，而不是在界面上多一个按钮。
 * 两个「跑」按钮、没人说得清哪个是真的 —— 那是老树的病，不要在这里复发。
 *
 * ## 为什么 blockers 返回空
 *
 * 一轮对抗**自己就把 gap 写进去了**（`runRound` 调 `settleRound`，rubric 判定再
 * 调 `replace`）。这里再把它们回报给 `TurnLoop`，会被 `settleRound` 二次应用。
 * 所以返回空的 `blockers` 与 `verdicts`，让 `TurnLoop` 只做它该做的那部分：
 * 记下产物、把 Change 推到 settled。
 *
 * ## 顺序上的一句话，别读成 bug
 *
 * gap 是在 `TurnLoop` 那个事务**之外**先写的。万一事务失败，Change 会被标成
 * blocked 而 gap 留着 —— **那是对的，不是半个轮次**：gap 本来就设计成跨轮存活，
 * 「这一轮发现的问题」不该因为状态机没推动而消失。下一轮会接着看到它们。
 */
export interface RoundTurnRunnerOptions extends RubricRoundDependencies {
  readonly changes: ChangeStore;
  readonly bindings: BindingStore;
  /** 红方要做什么。按阶段给一句话。 */
  readonly taskFor: (phase: string) => string;
}

export class RoundTurnRunner implements TurnRunner {
  constructor(private readonly options: RoundTurnRunnerOptions) {}

  async run(job: Job): Promise<TurnOutcome> {
    const change = this.options.changes.read(job.changeId);
    const phase = change.state.phase;

    if (change.projectId === null) {
      // rubric 有项目级默认，没有项目就取不到。这不是「没有 rubric」（那是合法
      // 的），是「问不出该用哪一份」—— 两者混起来会让人以为标准生效了。
      throw new Error(`change_has_no_project:${job.changeId}`);
    }

    const settled = await runRubricRound({
      projectId: change.projectId,
      changeId: job.changeId,
      phase,
      // 轮次用 job 的第几次尝试。gap 的 openedRound 和 rubric 判定都按它记，
      // 所以「第几轮发现的」在两张表里说的是同一件事。
      round: job.attempt,
      task: this.options.taskFor(phase),
      // 同一个 (Change, 阶段) 复用同一个裁判线程，和别处一样。
      judgeThreadId: this.options.bindings.find(job.changeId, phase)?.threadId ?? null,
    }, this.options);

    this.options.bindings.bind(job.changeId, phase, settled.judgeThreadId);

    return {
      artifactIds: settled.artifactIds,
      // 空的，理由见文件开头 —— 这一轮的问题已经落库了。
      blockers: [],
      verdicts: {},
    };
  }
}
