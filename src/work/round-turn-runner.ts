import type { Job } from "./job-store";
import type { TurnOutcome, TurnRunner } from "./turn-loop";
import { runRubricRound, type RubricRoundDependencies } from "./rubric-round";
import { artifactHome, blueDocPath, redDocPath } from "../domain/artifact-home";
import { PHASES, producesCommit, type Phase } from "../domain/phase";
import type { RoundConclusion } from "../domain/round";
import type { BindingStore } from "../store/binding-store";
import type { ChangeStore } from "../store/change-store";
import type { EvidenceStore } from "../store/evidence-store";
import type { RoundNoteStore } from "../store/round-note-store";
import { looksLikeSha, type RepoOps } from "./repo";

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
  /** 裁判的结论和反方的整体判断落在这里。两句都不动闸门。 */
  readonly notes: RoundNoteStore;
  /** 上游阶段产出了什么 —— 任务书要把它们的路径带给红方。 */
  readonly evidence: EvidenceStore;
  /** git。Build 一轮的产出是一个 commit（见 `work/repo.ts`）。 */
  readonly repo: RepoOps;
  /** 这个 Change 的仓库在哪。拿不到就不 commit。 */
  readonly workspaceFor: (changeId: string) => string | null;
  /** 红方要做什么。按阶段给一句话。 */
  readonly taskFor: (phase: string) => string;
  /**
   * 只写给人看的一行去哪（缺省 console）。目前唯一的客户是越界报告 ——
   * 它进不了 `round_notes`：那张表的 `source` CHECK 建表时定死，加新值会让
   * 所有已存在的库当场拒收（`closed_by` 那次的教训），而这一行不值得一次真迁移。
   */
  readonly log?: (line: string) => void;
}

/**
 * 一份上游产物在任务书里怎么写。
 *
 * **一个 commit 不是一份文档。** Build 的产出是 sha，而这一节原来的抬头是「已批准的
 * 上游文档（先读完再动手）」—— 红方会拿着 `349c17d7…` 当文件名去找，然后报一条
 * 「这个文件不存在」，白烧一轮。
 *
 * 判据用的是 `looksLikeSha`，和服务端读产出那一条**同一个**：一个阶段产出什么形态是
 * 那一轮的事实，两处各判一套必然漂移。
 */
const describeArtifact = (id: string): string =>
  looksLikeSha(id) ? `commit ${id}（用 \`git show ${id}\` 看这一轮的改动）` : id;

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

    /*
     * **轮次从账本数，不用 `job.attempt`。**
     *
     * attempt 是「这个 job 的第几次尝试」，而每次「跑这个阶段」都新建一个 job ——
     * 于是它恒等于 1。实测过的后果：CHG-002 跑了两轮，`gaps.opened_round` 全是 1，
     * 「第几轮发现的」在库里是假话，而 REMAP §3.5「按轮读，不按 run 读」建在这个
     * 数上。
     *
     * 账本 append-only：这个阶段第几次落到 `running`（`start` 和 `retry`，只有
     * 这两个动作落进 running），就是第几轮。`queueTurn` 在派发之前就把这一轮的
     * `start` 写进去了，所以这里数出来的正是**当前**这一轮。失败后的 retry 也
     * 天然算得进去 —— 那确实是新的一轮。
     */
    const round = this.options.changes.ledger(job.changeId)
      .filter((entry) => entry.to.phase === phase && entry.to.status === "running")
      .length;

    /*
     * **轮前把脏文件拍个快照** —— 轮末的越界报告靠差集把「模型这一轮写的」和
     * 「人本来就没提交的」分开。少了这一步就只能拿轮末的全量脏名单去指认，
     * 把人写了一半的活儿说成模型的违规。
     */
    const cwd = this.options.workspaceFor(job.changeId);
    const dirtyBefore = cwd === null
      ? null : new Set(this.options.repo.dirtyPaths(cwd));

    /*
     * **裁判线程一出现就绑上，不等整轮跑完。**
     *
     * 绑定原来只写在这个方法的最后一行，于是第一轮跑到一半时 `/api/progress` 说不出
     * 「走到哪了」（子 Agent 要从裁判 threadId 查），而中途死掉的第一轮什么都不留 ——
     * 线程建了，StagePass 却不认识它。gap 的设计是跨轮存活，线程也该是：它是这个
     * (Change, 阶段) 的对话，不是这一轮成功与否的奖品。
     *
     * `bind` 幂等，所以结尾那次照旧保留 —— 它是「一轮走完了绑定必须在」的兜底。
     */
    const inner = this.options.transport;
    const transport: typeof inner = {
      /*
       * 一轮里只有一个 turn，它就是裁判那条线程 —— 所以无条件绑。
       *
       * 这里原来按 `dispatch.aside` 分流：补问那种跑在**反方**的线程上，绑了就会
       * 试图坐进裁判的座位（2026-08-02 第 9 轮真机实测，绑定层正确地拒了
       * `already bound`，补问整个死掉）。那种 turn 2026-08-03 起不存在了 ——
       * Codex 禁止外部驱动子 Agent 线程，反方那半 rubric 改走文件
       * （`work/rubric-round.ts` 的 `blueRubricFiles`）。
       */
      runTurn: (dispatch) => inner.runTurn({
        ...dispatch,
        onThread: (threadId) => {
          this.options.bindings.bind(job.changeId, phase, threadId);
        },
      }),
    };

    const settled = await runRubricRound({
      projectId: change.projectId,
      changeId: job.changeId,
      phase,
      // gap 的 openedRound 和 rubric 判定都按它记，「第几轮发现的」在两张表里
      // 说的是同一件事。
      round,
      /*
       * 通用指令 + **人自己答出来的需求** + **上游已批准的产物路径**。
       *
       * 后两样各堵一个「凭空生成」的口子：brief 让模型不用猜「this change」是什么；
       * 上游路径让 Spec 起的阶段不用猜「the approved PRD」在哪 —— 每个阶段一条新
       * 线程（§6.5 规则 2），线程之间只能靠文档传信息，而这一条正是 binding-store
       * 注释里写明的代价：「every phase's opening prompt has to carry its upstream
       * documents itself」。
       *
       * 规则是阶段无关的：当前阶段之前、有产出的阶段，按线的顺序逐条列。不建
       * 每阶段的映射表 —— 那是 PHASES 这条线的第二份拷贝，两份必然漂移。
       * 能走到阶段 N 就意味着 N 之前的都被批准过（approve 是离开一个阶段的唯一
       * 前进路），所以「有产出的上游」就是「已批准的上游」。
       */
      task: [
        this.options.taskFor(phase),
        "",
        /*
         * **需求正文走文件，提示词里只给路径。**
         *
         * 两个理由，后一个更重要：
         *
         * 1. 它天然是一份文档，而且能有几百字（用户 2026-08-03：能文件化的就走文件，
         *    否则提示词过于冗长）。
         * 2. **它要经裁判转达给红方，而路径比段落难被改写。** 2026-08-02 CHG-003
         *    第一轮实测：裁判的提示词里明明有这几行人自己答的需求，红方的 rollout
         *    里却一个字都没有 —— 它转述时改写丢了，红方只能报「缺少产品输入」，
         *    四条 rubric 全判 no，一整轮白烧。一个路径它没什么可消化的，转坏了红方
         *    会大声说读不到，而不是安静地照一份缩水的需求干活。
         */
        "人要的是这些（他自己在选择器里答的，不是模型猜的），全文在这个文件里，"
        + `**先读它**：${this.options.writeRoundFile(
          `requirement-${job.changeId}.md`,
          `# ${job.changeId}：人自己答出来的需求\n\n${change.brief}\n`,
        )}`,
        ...(() => {
          const upstream = PHASES
            .slice(0, PHASES.indexOf(phase))
            .map((each) => ({
              phase: each,
              artifactIds: this.options.evidence.read(job.changeId, each).artifactIds,
            }))
            .filter((entry) => entry.artifactIds.length > 0);
          return upstream.length === 0 ? [] : [
            "",
            "已批准的上游产物（先看完再动手，它们是这一阶段的输入）：",
            ...upstream.map((entry) =>
              `- ${entry.phase}: ${entry.artifactIds.map(describeArtifact).join("、")}`),
          ];
        })(),
        /*
         * **输出路径由 StagePass 指定，不让红方自己起名**（E，用户 2026-08-04 拍板）。
         *
         * 模型现编文件名的下场实测过：一个仓库里四套互不兼容的命名，连 Change id
         * 都编。这一行在 `task` 里，而 task 是**原样转达**给红方的（上面那个抬头），
         * 路径到得了。Build / Fix 不加 —— 它们的产出是 commit，不是一份文档。
         */
        ...(producesCommit(phase) ? [] : [
          "",
          `这一轮的文档写到仓库里这个路径（相对项目根）：${
            redDocPath(job.changeId, phase, round)
          } —— 不要写到别的地方，也不要自己起名。`,
        ]),
      ].join("\n"),
      // 反方的那份同理，经裁判的提示词转达（共享模板，不进 PHASE_PLAY 那张
      // 十一份的表）。所有阶段都给 —— 反方在每个阶段都写意见，Build 也不例外。
      blueDocPath: blueDocPath(job.changeId, phase, round),
      // 同一个 (Change, 阶段) 复用同一个裁判线程。
      //
      // **必须看 status。** 一条 detached 的绑定仍然留着 threadId —— 直接拿它去
      // resume，等于把 turn 送进一个已经被明确放开的线程。codex/turn-runner.ts
      // 一直是这么判的，这里先前漏了。
      judgeThreadId: (() => {
        const bound = this.options.bindings.find(job.changeId, phase);
        return bound?.status === "bound" ? bound.threadId : null;
      })(),
    }, { ...this.options, transport });

    this.options.bindings.bind(job.changeId, phase, settled.judgeThreadId);
    this.recordNotes(job.changeId, phase, round, settled);
    this.releaseIfMalformed(job.changeId, phase, round, settled.malformed);

    const artifactIds = this.producedBy(job.changeId, phase, round, settled.artifactIds);

    /*
     * **越界的文件当场报出来，不自动收拾**（用户 2026-08-04 拍板）。
     *
     * 到这里产物目录已经入档（`producedBy`），树上剩下的、轮前没有的，就是模型
     * 写到家外面的东西。**不动它们** —— 收编、删除都是替人决定；报出来，让人处置。
     *
     * 报告走 `log`（面板 stdout —— 收尸人也在那儿说话，是既有的人看的通道）。
     * 不进 `round_notes`：那张表的 source CHECK 建表定死，加值会让已存在的库
     * 当场拒收（`closed_by` 的教训）。文件真被留着不管，Build 的干净树预检还会
     * 兜底把它们逐个列给人（`workspace_dirty`）。
     */
    if (cwd !== null && dirtyBefore !== null) {
      const home = `${artifactHome(job.changeId)}/`;
      const strays = this.options.repo.dirtyPaths(cwd)
        .filter((path) => !dirtyBefore.has(path) && !path.startsWith(home));
      if (strays.length > 0) {
        (this.options.log ?? console.log)(
          `[round] ${job.changeId}/${phase} 第 ${round} 轮有文件写到了产物目录外`
          + `（不自动收拾，人处置）：${strays.join("、")}`,
        );
      }
    }

    return {
      artifactIds,
      // 空的，理由见文件开头 —— 这一轮的问题已经落库了。
      blockers: [],
      verdicts: {},
    };
  }

  /**
   * 这一轮那两句只写给人看的话。
   *
   * ## 为什么写在这一层
   *
   * 它们不是 rubric 的东西（`rubric-round.ts` 只管逐条判定），也不是 `runRound` 的
   * 东西（那一层只认 gap）。它们是「这一轮发生过，记下来」—— 而这正是这个类已经在
   * 干的事：绑线程、记产物、推状态。
   *
   * ## 结论读不出来也要记
   *
   * 用户 2026-07-31：「每对抗一轮，我都是要知情的。」裁判给了却写坏了，人要看见的
   * 是「它给了但读不出来」，不是一片空白 —— 那和「它没给」是两件事。
   *
   * 这时 `anotherRound` 记 **null**，不是 `false`：「还要不要再来一轮」这个问题
   * 没有答案。记 `false` 会被界面渲染成「可以了」—— 那是**替裁判说了一句它没说过
   * 的话**，而这一整套改动的立身之本正是不许出现这种话。
   */
  /**
   * 形状坏了就放开裁判线程，下一轮从干净的线程开。
   *
   * ## 为什么这一条不能靠「job 失败了没有」
   *
   * `panel-server.ts` 那条 detach 看的是 `jobs.status === 'failed'`（`e3eee6d`），
   * 它接住的是**整轮死掉**那一种。而这里说的这些轮是**成功的** —— gap 照写、状态
   * 照推，只是某样东西没读出来：一份 rubric 整份作废被记成 `not_assessed`，一个
   * 少了右花括号的信封被当成「裁判没给裁决」。轮次成功，线程留着。
   *
   * 于是 2026-08-02 CHG-003 实测到的样子：Build 阶段 critic 那份**连续三轮全部
   * 作废**，同一个抄漏一段的 UUID 连抄三轮。提示词里的告诫压不过模型自己的历史 ——
   * 它 resume 回去看见的是自己上一轮那么写的。
   *
   * ## 放开是安全的
   *
   * **线程从来不是真相的载体**：开着的 gap、任务、上游产物、rubric 契约，每一轮都
   * 完整写在提示词里（PRD §6.5 —— 线程之间只能靠文档传信息）。丢掉的只有毒。
   *
   * ## 人要看得见
   *
   * 用户 2026-07-31：「每对抗一轮，我都是要知情的。」所以放开这件事记一条
   * round note，而不是悄悄做掉 —— 一条无缘无故换了线程的记录，比不换更让人困惑。
   */
  private releaseIfMalformed(
    changeId: string,
    phase: Phase,
    round: number,
    malformed: readonly string[],
  ): void {
    if (malformed.length === 0) return;
    this.options.bindings.detach(changeId, phase);
    this.options.notes.put(changeId, phase, round, {
      source: "judge_conclusion",
      // **不是 false。**「还要不要再来一轮」这个问题在这里没有答案 —— 记 false 会被
      // 界面渲染成「可以了」，那是替裁判说了一句它没说过的话。
      anotherRound: null,
      text: `这一轮有读不出来的地方（${malformed.join("、")}），`
        + "已放开裁判线程，下一轮从干净的线程开 —— 坏格式会留在线程自己的历史里循环。",
    });
  }

  private recordNotes(
    changeId: string,
    phase: Phase,
    round: number,
    settled: { conclusion: RoundConclusion | null; blueOverall: string | null },
  ): void {
    const { conclusion, blueOverall } = settled;
    if (conclusion !== null) {
      this.options.notes.put(changeId, phase, round, {
        source: "judge_conclusion",
        anotherRound: conclusion.kind === "advised" ? conclusion.anotherRound : null,
        text: conclusion.kind === "advised"
          ? conclusion.reason
          : `裁判给了结论但读不出来：${conclusion.detail}`,
      });
    }
    if (blueOverall !== null) {
      this.options.notes.put(changeId, phase, round, {
        source: "blue_overall", text: blueOverall,
      });
    }
  }

  /**
   * 这一轮到底产出了什么。
   *
   * ## 设计阶段：红方报的路径
   *
   * 一份文档天然对应一个路径，一个路径就说全了。
   *
   * ## Build / Fix：一个 commit（用户 2026-07-30 拍板）
 *
 * 判据是 `producesCommit` —— **红方在这一阶段写的是代码**。
   *
   * 文件列表说不出「改了什么」—— 同一个路径，改之前改之后都是它；diff 说不出
   * 「基于哪一版」，而下一轮的蓝方正需要这个。commit 两样都有，还多了稳定 id、
   * 能 revert、能进 fence。
   *
   * **是替换，不是并列。** 两种说法并存，下游（弹窗、fence、下一轮的蓝方）就得挑
   * 一个信 —— 那正是「一个概念一个名字」要挡的事。
   *
   * ## 提交在这里，因为这是红蓝都干完了的那一刻
   *
   * 蓝方读的是工作树（它现在能读改动涉及的代码），所以 commit 必须在它读完之后。
   * `runRubricRound` 返回时整个裁判 turn 已经结束，红蓝都收工了 —— 这一行是最早的
   * 安全点，也是最晚的必要点。
   *
   * ## 什么都没改就返回空，不造空 commit
   *
   * 「红方这一轮什么都没写」是人需要知道的事，而闸门本来就不放行一个什么都没产出的
   * 阶段。造一个空 commit 会把这件事伪装成有产出，然后闸门放行 —— 那是最坏的一种谎。
   */
  private producedBy(
    changeId: string,
    phase: string,
    round: number,
    reported: readonly string[],
  ): readonly string[] {
    const cwd = this.options.workspaceFor(changeId);
    if (cwd === null) return reported;
    if (!producesCommit(phase)) {
      /*
       * **设计/报告类阶段轮末把产物目录窄提交掉**（E，2026-08-05）。
       *
       * 在这之前它们写文件不 commit，树越攒越脏，走到 Build（第一个要求干净树的
       * 阶段）一次性爆掉 —— 08-02 手动 `git commit` 入档 5 次、08-05 又清了 33 个。
       *
       * 只提交 `docs/stagepass/<change>/`，目录外一个字节不碰（连人的暂存区都不动，
       * 见 `repo.commitPaths`）——「不替人 commit 他自己的活儿」那条保护原样成立。
       *
       * **证据仍然是红方报的路径，不换 sha。** commit 只是让树干净的记账：下游
       * （面板读产物、上游产物列表、fence）都按路径找，这里换了它们全断。
       * 提交失败（不是 git 仓库、目录是空的）也照样返回路径 —— 记账失败不该
       * 吃掉一轮真产出。
       */
      this.options.repo.commitPaths(
        cwd, [artifactHome(changeId)], `StagePass ${changeId} ${phase} 第 ${round} 轮`);
      return reported;
    }
    const sha = this.options.repo.commitAll(
      cwd, `StagePass ${changeId} ${phase} 第 ${round} 轮`);
    return sha === null ? [] : [sha];
  }
}
