/**
 * Every phase name a Change has ever moved through, and where approval leads.
 * 环 v3 的主线是其中八个（`DEFAULT_GRAPH`）；其余是退休的名字，留给历史读。
 *
 * ## One phase, one name
 *
 * These identifiers are the ONLY names for these phases anywhere in the tree --
 * in code, in the database, in a card, in a log line. No aliases, no casing
 * variants, no per-layer vocabulary.
 *
 * The tree this replaces had three names for the first phase alone: the stage
 * was `intake`, its gate was `PRD`, and the decision allowlist called it
 * `Intake`. A receipt carrying one of them was compared against a binding
 * holding another, and the comparison could never succeed -- that was the first
 * structurally-impossible check found on 2026-07-28, and it cost a day.
 *
 * It also disagreed with itself about how many phases exist: `CONTENT_PHASES`
 * listed thirteen (including `Implement` and `Check`), while `PipelinePhase`
 * declared nine. Neither matched the product definition. This list does.
 */
export const PHASES = [
  "PRD",
  "Spec",
  /*
   * Arch：先划骨架，再填数据（用户 2026-08-06 拍位置：TechSpec **之前**）。
   *
   * 它给 BACKLOG §5.5 那条反馈链路第一次提供落点 ——「要新增图上没有的依赖边
   * 就停手，攒进架构那一批」，攒到的就是这儿。产出四节：动哪几个模块 / 新增哪些
   * 依赖边（每条写为什么非加不可）/ 边界划在哪 / 想过但没选的划法。
   * 「架构在脑子里」对 AI 不成立：写不下来就不存在，所以它有产出、有闸门。
   *
   * 环 v3（2026-08-09）之后它还是**钻石的分叉点**：BuildPlan 和 TestPlan 两条
   * 轨都只从它推导。分叉点就是共模点 —— Arch 的错误会被两轨一致地继承，QA 的
   * 对撞抓不住它 —— 所以人的深度介入放在这儿（编辑过门，批 6）。
   */
  "Arch",
  "TechSpec",
  "Plan",
  /*
   * 环 v3 的两条对称轨道（用户 2026-08-09 拍）：每轨「先文档后代码」——
   * BuildPlan→Build、TestPlan→Test。两轨在 Arch 契约之下互盲：Build 看不见
   * 测试，Test 看不见实现 —— 测试若读了施工方就继承施工方的盲区，QA 对撞出的
   * 一致才有信息量（串供的一致什么都不是）。
   *
   * `BuildPlan` 顶替退休的 `Plan`：名字要把「哪条轨的计划」说出来 —— 对称结构
   * 里一个裸的 Plan 分不清自己属于谁。
   */
  "BuildPlan",
  "TestPlan",
  "Build",
  /* Test：把 TestPlan 里的「写测试代码」拆出来单独成阶段 —— 文档和 commit
   * 混在一个阶段，正是并行工作区冲突的根源（批 3 撤回的那个设计题）。 */
  "Test",
  "Review",
  "Fix",
  "QA",
  "Merge",
  "Retro",
  "Done",
] as const;

export type Phase = (typeof PHASES)[number];

const PHASE_SET: ReadonlySet<string> = new Set(PHASES);

export function isPhase(value: string): value is Phase {
  return PHASE_SET.has(value);
}

/**
 * 阶段图：主线的顺序，作为**值**（BACKLOG §4.5）。
 *
 * ## 为什么从常量变成数据
 *
 * bootstrap 框架下「只有一个 Change，YAGNI」不成立 —— 不是每个项目都值得走
 * 全部八个阶段（§1.5·④）。图变成值之后，一个项目可以只走
 * `PRD → Build → QA`，而状态机一行不改。
 *
 * ## 自定义图 = 全序的子序列，不许重排
 *
 * 「上游」这个词建立在全序上，而长回边（sendBack）整个建在「上游」上。允许重排，
 * `upstreamOf` 就说不清 TestPlan 和 BuildPlan 谁先谁后 —— 那不是灵活性，是把一个
 * 有语义的顺序退化成一个列表。跳过阶段可以，交换阶段不行。
 */
export interface PhaseGraph {
  readonly order: readonly Phase[];
}

/**
 * **退休的阶段**：名字还在（库里有它的历史），但主线上没有它了。
 *
 * ## 为什么不是从 `PHASES` 里删掉
 *
 * 十几张表的 `phase` 列都有 `CHECK (phase IN (…PHASES…))`，而真库里有它的
 * evidence、gap、逐条判定、绑定、题。名字一删，那些行连读都读不出来
 * （`ChangeStore.read` 抛「Unknown phase」），一条 Change 会变得既看不了也删不掉
 * —— 2026-08-08 合并前查实：CHG-001 当时正卡在 TechSpec 上。
 *
 * 所以退休 = **从主线图上拿掉**，名字留着给历史用。`Fix` 早就是这个形状
 * （在 `PHASES` 里、不在 `DEFAULT_GRAPH.order` 里），只是它退的理由是
 * 「不在主线上」，而不是「不再用了」。
 *
 * ## TechSpec 为什么退休（2026-08-08 用户拍）
 *
 * 它和 Arch 是同一批决定的粗细两版：Arch 的「新增哪些依赖边」「边界露什么」
 * 就是 TechSpec 的「谁调谁、传什么、返回什么」，Arch 的「想过但没选的划法」
 * 就是 TechSpec 的「选择和它的代价」。真正只属于 TechSpec 的只有「数据怎么存」
 * 一节，而那撑不起一个独立阶段。
 *
 * 一旦 Arch 按要求写到**文件与函数**一级，重叠从「粗细两版」变成完全同一件事
 * —— 而同一条规则的两份拷贝必然漂移（真机证据：Arch 那份产出里出现七次
 * 「留给 TechSpec」，人读完拿不到完整图景）。所以合并，`data` 节并进 Arch。
 *
 * ## 环 v3 一次退休六个（2026-08-09 用户拍）
 *
 * 判据一句话：**阶段的入场券是「有产物可对抗」**。逐个过堂：
 *
 *   Plan    -> 没死，改名成 BuildPlan（对称结构里裸名分不清轨道）。旧名退休，
 *              不 rename —— 历史行的名字永不改写。
 *   Review  -> 蓝方就是阶段内 review，全环统一，代码阶段不例外。它作为独立
 *              阶段的任务（读 diff、攻击逻辑与契约）由 QA 收编。
 *   Fix     -> 不是阶段，是交互：打回（sendBack）重开目标阶段，修复就是重开
 *              阶段的下一轮。它本来就不在主线上，现在连「隐藏阶段」也不是了。
 *   Merge   -> 产物是 git 动作，不是可攻击的文本。守卫已有机械形式
 *              （pre-push「绿过」印章），动作本身归人，在自由终端做。
 *   Retro   -> 自审，内容结构上不许承重。真复盘是 gap 账本 + 判例修 rubric。
 *   Done    -> 是状态不是工作。QA 闸门放行即 closed（TERMINAL_PHASE 移到 QA）。
 */
const RETIRED_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "TechSpec", "Plan", "Review", "Fix", "Merge", "Retro", "Done",
]);

export function isRetired(phase: string): boolean {
  return isPhase(phase) && RETIRED_PHASES.has(phase);
}

/**
 * 默认图：主线上的阶段，全序。环 v3 的八个：
 * `PRD → Spec → Arch → BuildPlan → TestPlan → Build → Test → QA`。
 *
 * BuildPlan∥TestPlan、Build∥Test 的并行**不在图上**：主线保持全序（sendBack /
 * 栈序 / 子序列判定的地基），并行只存在于座位层（批 4）。图上不长岔路 ——
 * 环 UI 把全序**画**成钻石，那是投影问题，不是结构问题。
 */
export const DEFAULT_GRAPH: PhaseGraph = {
  order: PHASES.filter((phase) => !RETIRED_PHASES.has(phase)),
};

/**
 * **每个阶段真正消费谁的产物。**「上游」按这张表算，不按顺序上谁在前面（§8.6·①）。
 *
 * ## 为什么顺序前缀是错的
 *
 * `upstreamOf` 原来取的是主线顺序的前缀，于是 `upstreamOf("TestPlan")` 里有
 * `Plan` —— 面板今天就摆着「从 TestPlan 打回 Plan」这个选项，而 **TestPlan 从来
 * 没消费过 Plan 的任何东西**。一个必然说不通的打回摆在人眼前，和一个假选项没有
 * 区别（§5.4：选项里不许出现选不动的东西）。
 *
 * 同一个错误有第二份拷贝：任务书里「已批准的上游产物」也是按顺序前缀取的
 * （`work/round-turn-runner.ts`），于是 TestPlan 的红方还会收到一份 Plan 的文档
 * 当输入。**两处现在读同一张表。**
 *
 * ## 顺序没有变松
 *
 * 这张表只改「谁是谁的上游」，**不改执行顺序** —— 主线仍然是全序，一个 Change
 * 仍然一次只在一个阶段上。BuildPlan∥TestPlan、Build∥Test 的真并行走座位层
 * （批 4），不走这张表，也不走图。
 *
 * `Fix` 是空的，**不是漏了**：它退休了，而且从来不在主线上 —— `sendBack` 对它
 * 从来就不合法，它的历史出口是弹栈还债。给它填上游会让「从 Fix 打回」变得
 * 合法，而 Fix 在 `returnStack` 里正是栈序校验明令禁止的。
 */
const CONSUMES: Readonly<Record<Phase, readonly Phase[]>> = {
  PRD: [],
  Spec: ["PRD"],
  /*
   * Arch 消费 Spec，而**它是完整的技术架构**（2026-08-08 合并 TechSpec）：
   * 模块、文件与函数、数据与状态、接口与契约都在这一份里。环 v3 里它还是
   * 钻石的分叉点：下面两轨都只从它推导。
   */
  Arch: ["Spec"],
  /*
   * 两轨互盲（用户 2026-08-09 拍）：BuildPlan 和 TestPlan 都只消费 Arch，
   * 互不消费；Build 只消费 BuildPlan，Test 只消费 TestPlan。**Build 的题面里
   * 不得出现测试，Test 的题面里不得出现实现** —— Build 看得见测试就会向测试
   * 过拟合（通过写出来的那几个用例，而不是满足用例背后的意图），QA 的绿就从
   * 证据退化成靶子。
   */
  BuildPlan: ["Arch"],
  TestPlan: ["Arch"],
  Build: ["BuildPlan"],
  Test: ["TestPlan"],
  /*
   * QA 是两条互盲轨道的**对撞点**：读（收编旧 Review 的活）、跑（执行 Test 轨
   * 的测试）、变（三方向变异检验测试本身）。它消费两轨的产物 —— 打回因此有了
   * 三个合法去向：代码错 → Build、测试错 → Test、契约错（共模）→ Arch
   * （传递闭包够得着，升级到人）。
   *
   * 2026-08-06 那段「四行没验证过」的存疑就此定案：QA 消费的是 Build + Test，
   * 不是 Review —— 审查阶段产出的是 findings 不是文档，「打回 Review 说它错了」
   * 从来没有含义。QA 的绿是 merge 动作的守卫（pre-push 印章），**闸门不进
   * 消费表** —— 闸门和消费是两回事。
   */
  QA: ["Build", "Test"],

  // ── 以下全是退休阶段：行留着只为让历史读得出来 —— 都不在主线图上，
  //    `upstreamOf` 按图过滤，没有任何 Change 会再走到这儿。
  TechSpec: ["Arch"],
  Plan: ["Arch"],
  Review: ["Build"],
  Fix: [],
  Merge: ["QA"],
  Retro: ["Merge"],
  Done: ["Retro"],
};

export class InvalidPhaseGraphError extends Error {
  constructor(readonly code:
    | "must_end_with_terminal"
    | "retired_phase"
    | "unknown_phase"
    | "not_a_subsequence",
  readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "InvalidPhaseGraphError";
  }
}

/**
 * 从一串阶段名构造一张图。**拒绝发生在构造时，不在走到一半时** —— 一张走到
 * Build 才发现没有出口的图，比一张建不出来的图贵得多。
 */
export function phaseGraphOf(order: readonly string[]): PhaseGraph {
  if (order.length === 0 || order[order.length - 1] !== TERMINAL_PHASE) {
    throw new InvalidPhaseGraphError("must_end_with_terminal", order.join(","));
  }
  const phases: Phase[] = [];
  for (const name of order) {
    if (!isPhase(name)) throw new InvalidPhaseGraphError("unknown_phase", name);
    // 退休的阶段不许排进任何一张图 —— 它的名字只为读历史而留着。
    // 下面那道子序列判定其实也会拒（它不在 DEFAULT_GRAPH 里），但那句报错说的是
    // 「顺序不对」，而真因是「这个阶段已经没了」。报错要指着真正挡住它的那一条。
    // Fix 也走这条：环 v3 起它是退休阶段，不再需要自己的错误码。
    if (RETIRED_PHASES.has(name)) {
      throw new InvalidPhaseGraphError("retired_phase", name);
    }
    phases.push(name);
  }
  // 子序列判定：在全序里按序找得到每一个。找不到 = 重排或重复。
  let cursor = 0;
  const full = DEFAULT_GRAPH.order;
  for (const phase of phases) {
    const found = full.indexOf(phase, cursor);
    if (found === -1) {
      throw new InvalidPhaseGraphError("not_a_subsequence", order.join(","));
    }
    cursor = found + 1;
  }
  return { order: phases };
}

/**
 * Where an approval moves the Change.
 *
 * 环 v3 之前这里有一条 `Fix` 特判（返回 null：不在主线上，出口是弹栈）。
 * Fix 退休后没有任何调用方再拿它来问 —— 修复就是重开阶段的下一轮，
 * 「送修」这个概念连同它的特判一起没了。
 */
export function advancesTo(
  phase: Phase,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase | null {
  const index = graph.order.indexOf(phase);
  if (index === -1) {
    // 一个不在图上的阶段没有「下一步」可言。返回 null 会让 transition 把它
    // 当成终点直接 closed —— 静默失败往危险那边倒，所以抛。
    throw new InvalidPhaseGraphError("unknown_phase", phase);
  }
  return graph.order[index + 1] ?? null;
}

/**
 * `phase` 真正的上游 —— **它消费的，以及它消费的东西所消费的**（`CONSUMES` 的
 * 传递闭包）。sendBack（长回边，§5.9.1）的合法目标名单就是它。
 *
 * 出去的按**主线顺序**排 —— 调用方靠这个取「最近的那个上游」（`journey.ts` 画环
 * 时用 `.at(-1)`）。跳过的阶段不出现在名单里，但它的上游照样传递得过来：把
 * TechSpec 跳掉，Plan 的上游仍然是 Spec / PRD。
 *
 * 第一个阶段是空名单（没有上游）。空名单的含义由调用方判 —— 一道没有选项的题
 * 不该问出去（domain/question.ts 那条规矩）。
 */
export function upstreamOf(
  phase: Phase,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase[] {
  const seen = new Set<Phase>();
  const walk = (each: Phase): void => {
    for (const source of CONSUMES[each]) {
      if (seen.has(source)) continue;
      seen.add(source);
      walk(source);   // 传递：消费的东西所消费的，也是上游
    }
  };
  walk(phase);
  /*
   * **按这个 Change 自己的图过滤并排序。**
   *
   * 过滤：跳过的阶段没有产出，打回到它没有含义。
   * 排序：名单的顺序是有语义的（`.at(-1)` = 最近的那个上游），而闭包的遍历顺序
   * 不是 —— 靠遍历顺序等于靠巧合。
   */
  return graph.order.filter((each) => seen.has(each));
}

/**
 * 这些阶段里，**红方审的是别人的东西**，所以它报出来的问题算数。
 *
 * ## 它推翻的是哪条规矩
 *
 * 一轮对抗默认忽略红方报的问题（`readRound`）：产出者报告自己作品的毛病不是对抗性
 * 发现，让红方决定自己的东西有多糟，正是蓝方存在的理由。
 *
 * **到 QA 这条理由不成立** —— 红方拿着案卷读的是 Build 的 diff、跑的是 Test 轨
 * 写的测试，没有一样是自己写的。而 QA 的活儿就是找缺陷，照旧丢掉等于这个阶段
 * 什么都不产出（用户 2026-07-30 对旧 Review 拍的板，QA 收编了它的任务，
 * 这条理由跟着过来）。
 *
 * ## 为什么只剩 QA 一个
 *
 * 用户 2026-07-30 定的通则：「红方写或者审，但绝对不能自审，然后蓝方来纠错。」
 * 判据就是**红方交出来的东西是不是对它自己作品的评价**：
 *
 *   QA      读/跑/变 Build 和 Test 的产出  -> 不是自审，算数
 *   Build   按 BuildPlan 实现              -> 写自己的代码，自审，不算
 *   Test    按 TestPlan 写测试             -> 写自己的测试，自审，不算
 *   设计阶段 写自己那份文档                 -> 自审，不算
 *
 *   （Review 曾在名单里 —— 环 v3 把它整个收编进 QA，名单跟着收缩。）
 *
 * 这个名单里少一个，最坏是那个阶段的红方白报一次；多一个，就是让一个模型对自己
 * 产出的评价直接变成挡门的东西。所以判据要能一句话说清，而上面那一列就是它。
 */
const RED_REVIEWS_OTHERS: ReadonlySet<Phase> = new Set<Phase>(["QA"]);

export function redReviewsOthers(phase: string): boolean {
  return isPhase(phase) && RED_REVIEWS_OTHERS.has(phase);
}

/** The phase every Change starts in. */
export const FIRST_PHASE: Phase = "PRD";

/**
 * The phase a Change ends in. Nothing leaves it.
 *
 * 环 v3 起是 **QA**：闸门放行即 closed。Merge 是 git 动作（守卫 = pre-push
 * 印章，动作归人、在自由终端做）、Retro 是自审（内容不许承重）、Done 是状态
 * 不是工作 —— 三个都过不了「有产物可对抗」这道入场券，一起退休。
 */
export const TERMINAL_PHASE: Phase = "QA";

/**
 * 这些阶段的产出是一个 **commit**，不是一份文档。
 *
 * 判据只有一条：**红方在这一阶段写的是代码**。一组改动天然对应一个 commit ——
 * 文件列表说不出「改了什么」（同一个路径改前改后都是它），diff 说不出「基于哪一版」，
 * commit 两样都有，还多了稳定 id、能 revert、能进 fence（用户 2026-07-30 拍板）。
 *
 *   Build  按 Plan 实现          -> 写代码，记 commit
 *   Fix    改掉被报出来的问题     -> 写代码，记 commit
 *   别的    写文档 / 写报告        -> 一个路径就说全了
 *
 * 这个名单还决定**要不要查干净树**：StagePass 提交的是工作树里所有的改动，它分不出
 * 哪一行是红方写的、哪一行是人自己写了一半的。所以凡是要 commit 的阶段，派发之前
 * 必须先确认树是干净的 —— 两件事同一个名单，不许分开。
 *
 * **名单外的阶段轮末也 commit，但那不违反上面这条**（E，2026-08-05）：它们走的是
 * `repo.commitPaths`，只提交 `docs/stagepass/<change>/` —— 逐个点名，结构上卷不走
 * 没点到的东西，所以不需要干净树。上面那条约束的前提是「分不出哪行是谁写的」，
 * 而一个 StagePass 独占的目录就是那条分界。意思是「整树提交」的名单，仍然精确
 * 等于意思是「要求干净树」的名单。
 */
/*
 * ## 环 v3（2026-08-09）：名单换成 {Build, Test}
 *
 * - **Fix 退休**：修复就是重开阶段的下一轮，「送修」的 commit 由重开的那个
 *   阶段自己记。
 * - **TestPlan 收窄成纯文档**：2026-08-06 它进名单是因为「Build 不许自己写
 *   测试」而当时没有别的阶段能交测试代码 —— 现在有了（`Test`），写代码的
 *   职责整个挪过去，TestPlan 回到 `commitPaths` 只交文档。文档和 commit 混在
 *   一个阶段，正是并行工作区冲突的根源。
 * - **Test 进来**：它写测试代码，产出天然是 commit。
 *
 * 批 4 会把这条约束再拆一半：Test 改走「声明落点」的窄提交（TestPlan 模板里
 * 用例带落点文件，落点即分界），整树提交 + 要求干净树的只剩 Build —— 那时
 * 「整树名单 = 干净树名单」这条等式依然精确成立，只是名单缩成一个。
 * 在那之前 Build 与 Test 串行执行，两个都走 commitAll 是安全的。
 */
const PRODUCES_COMMIT: ReadonlySet<Phase> = new Set<Phase>([
  "Build", "Test",
]);

export function producesCommit(phase: string): boolean {
  return isPhase(phase) && PRODUCES_COMMIT.has(phase);
}

/**
 * 产 commit 的阶段里，**谁提交整树**（批 4 · 案 B 把那条等式拆成两半）。
 *
 * - **Build 整树**（`commitAll`）：独占树是它的语义 —— 它分不出哪行是红方写的、
 *   哪行是别人的半成品，所以它同时是唯一**要求干净树**的阶段（dispatchPrecheck
 *   的 dirty 预检按这个名单走，不再按 `producesCommit`）。
 * - **Test 窄提交**（`commitPaths`：产物目录 + 红方声明的落点文件）：逐个点名，
 *   结构上卷不走没点到的东西 —— 所以它不要求干净树，也就能和 Build 并行。
 *
 * 「整树名单 = 干净树名单」那条等式依然精确成立，只是名单缩成了一个。
 */
const COMMITS_WHOLE_TREE: ReadonlySet<Phase> = new Set<Phase>(["Build"]);

export function commitsWholeTree(phase: string): boolean {
  return isPhase(phase) && COMMITS_WHOLE_TREE.has(phase);
}

/**
 * 钻石的两次分叉（批 4）：主线**批准落到**键上那个阶段时，给值上那个孪生阶段
 * 开一个并行座位 —— BuildPlan∥TestPlan、Build∥Test。
 *
 * 只在 approve 到达时开（`ChangeStore.apply`）：sendBack 到达是打回重开，
 * 那时孪生阶段自己该不该重跑由人裁（它不消费被打回的这个，见 `CONSUMES`）——
 * 自动给它开座位就是替人决定「你也得重来」。
 */
const PARALLEL_TWINS: Readonly<Partial<Record<Phase, Phase>>> = {
  BuildPlan: "TestPlan",
  Build: "Test",
};

export function parallelTwinOf(phase: string): Phase | null {
  return isPhase(phase) ? PARALLEL_TWINS[phase] ?? null : null;
}
