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

    /*
     * **没有需求就不许跑。任何阶段。**
     *
     * 这一条是用户 2026-07-29 发现的洞的正面修法。在这之前，红方收到的是一句写死的
     * 通用指令（「Write the product requirement for this change…」），而「this change」
     * 是哪个 change 从来没被告知 —— 那份 PRD 只能是编的，而下游每个阶段都写着
     * 「Turn the approved PRD into…」，整条流水线建在一份凭空产生的需求上。
     *
     * 为什么是所有阶段而不只是 PRD：一条没有记录过需求的 Change，压根就不该在跑对抗
     * 轮。一条规则，没有例外要记。
     *
     * 为什么是拒绝而不是「有就用、没有就算」：能绕过的录入等于装饰。
     */
    if (change.brief === null) {
      throw new Error(`change_has_no_brief:${job.changeId}`);
    }

    const settled = await runRubricRound({
      projectId: change.projectId,
      changeId: job.changeId,
      phase,
      // 轮次用 job 的第几次尝试。gap 的 openedRound 和 rubric 判定都按它记，
      // 所以「第几轮发现的」在两张表里说的是同一件事。
      round: job.attempt,
      // 通用指令 + **人自己答出来的需求**。后者是这一整套的重点：模型不再需要猜
      // 「this change」是什么。
      task: [
        this.options.taskFor(phase),
        "",
        "人要的是这些（他自己在选择器里答的，不是模型猜的）：",
        change.brief,
      ].join("\n"),
      // 同一个 (Change, 阶段) 复用同一个裁判线程。
      //
      // **必须看 status。** 一条 detached 的绑定仍然留着 threadId —— 直接拿它去
      // resume，等于把 turn 送进一个已经被明确放开的线程。codex/turn-runner.ts
      // 一直是这么判的，这里先前漏了。
      judgeThreadId: (() => {
        const bound = this.options.bindings.find(job.changeId, phase);
        return bound?.status === "bound" ? bound.threadId : null;
      })(),
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
