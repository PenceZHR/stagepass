import type { RubricPhase, RubricRole } from "./rubric-assessment";

/**
 * The factory rubrics every project starts with (§4.5).
 *
 * ## Why every line is a yes/no question about a fact
 *
 * §2.4 is the user's own wording: "否则 AI 打分会出幻觉，用大量的 yes or no 来
 * 规范模型". A criterion that cannot be answered with a bare yes or no is not a
 * weaker criterion, it is a different mechanism -- the model starts grading
 * itself, and a grade is exactly what this design refuses to store. So each
 * line below is phrased so that a reader holding only the artifact can point at
 * the thing that makes the answer no. "计划覆盖了 TechSpec 里的每一个改动点" is
 * checkable; "计划质量良好" is not, and would have been a score wearing a
 * boolean's clothes.
 *
 * The recurring "...或明确写出「不涉及」" shape is deliberate for the same
 * reason. Without it the honest answer to "说明了数据迁移" on a change that has
 * no migration is neither yes nor no, and a model with no legal answer invents
 * one. Making the explicit disclaimer a passing answer keeps the question
 * binary on every change instead of only on the ones it happens to fit.
 *
 * ## Why they all ship non-blocking
 *
 * `blocking: false` everywhere, and the reason is not timidity.
 *
 * A blocking criterion produces a P0 the moment a verdict says `no` OR the
 * model fails to answer at all. Every existing project would meet these
 * standards for the first time on whatever stage it happens to run next,
 * against wording nobody on that project has read, answered by a model that has
 * never seen this protocol -- and the derived P0 is unclearable by every
 * ordinary route (a gap refuses `human_cannot_resolve_gap`, a P0 finding is
 * unwaivable four ways, `stage_gates` has no override). The only exit is the
 * drawer. Shipping these as blocking would be shipping a pipeline-wide stall
 * whose remedy is a UI most users have not opened yet.
 *
 * There is a second reason, and it is the one that makes non-blocking actually
 * SAFE rather than merely polite: `activeRubricBlockers` intersects the derived
 * blockers with `blockingCriterionKeysInForce`, so a criterion the user has not
 * ticked produces no blocking record even when its verdict is `not_assessed`.
 * A factory rubric therefore cannot stall anything at all -- it can only
 * record, and be read in the drawer. Ticking `blocking` is an informed act by
 * someone who has now read the wording.
 *
 * ## Roles are only declared where something answers them
 *
 * A role absent from a phase here has no answerer in the pipeline, and shipping
 * a checklist nobody answers would fill the drawer with rows that stay blank
 * forever. See `RUBRIC_ROLE_ANSWERED_BY` below for the full map and the reasons.
 */

export type FactoryRubricCriterion = {
  /**
   * Stable across projects and across re-seeds. `criterionKey` is the handle
   * §4.3.1's exit hangs on, and a randomly minted one would make a factory
   * criterion's identity differ per project for no benefit -- these rows are
   * literally the same standard everywhere. The uniqueness index is
   * (rubric_id, criterion_key), so sharing a key across projects collides with
   * nothing.
   */
  criterionKey: string;
  text: string;
};

/**
 * One authored criterion. The key is written down rather than derived, because
 * derivation has to derive it from something, and both candidates are wrong:
 * position changes when you insert a line, text changes when you reword.
 */
type FactoryRubricSource = { key: string; text: string };

type FactoryRubrics = Partial<
  Record<RubricPhase, Partial<Record<RubricRole, FactoryRubricSource[]>>>
>;

/**
 * The criteria themselves, each carrying its own key.
 *
 * These used to be plain strings with `factoryCriteria` deriving the key from
 * the array index. Two comments assured the reader that a reordering could not
 * silently re-key a row, and that the tests pinned the full key set. Neither was
 * true: inserting one line renumbered every criterion below it, and the only
 * assertions were on key SHAPE and count -- nothing bound a key to its text, so
 * the renumbering was green.
 *
 * That matters because `criterionKey` IS identity. Derived blockers persist as
 * `RUBRIC:<criterionKey>` and §4.3.1's exit hangs on it, so a silent renumber
 * retires a blocker the user never withdrew and opens one they never saw. Now
 * that these criteria also reach users as editable files, the same edit is one
 * they can make in a text editor.
 *
 * Editing rules: reorder, insert and reword freely -- the key travels with the
 * line. Never reuse a retired key for different text, and never "fix a typo" in
 * a key: a different key is a different criterion.
 */
const FACTORY_RUBRIC_TEXT: FactoryRubrics = {
  PRD: {
    producer: [
      { key: "RBK-factory-PRD-producer-01", text: "PRD 正文里每一条需求都写明了「谁、在什么场景下、要达成什么」，没有只写功能名的条目。" },
      { key: "RBK-factory-PRD-producer-02", text: "PRD 列出的每一条需求都带有至少一条可判定的验收条件（读完就能答出满足或不满足）。" },
      { key: "RBK-factory-PRD-producer-03", text: "PRD 明确写出了本次改动**不做**什么（非目标），而不是只写要做什么。" },
      { key: "RBK-factory-PRD-producer-04", text: "PRD 里出现的每一个业务名词，在文中有定义，或指向了已有定义。" },
      { key: "RBK-factory-PRD-producer-05", text: "PRD 没有把实现方案（技术选型、表结构、接口签名）当成需求写进来。" },
      { key: "RBK-factory-PRD-producer-06", text: "用户在澄清问答里给出的每一个决定，都能在 PRD 正文里找到对应的落点。" },
      { key: "RBK-factory-PRD-producer-07", text: "PRD 标注了本次改动会影响到的既有功能，或明确写出「不影响任何既有功能」。" },
      { key: "RBK-factory-PRD-producer-08", text: "PRD 里没有「优化」「完善」「提升体验」这类无法判定是否完成的表述。" },
    ],
    critic: [
      { key: "RBK-factory-PRD-critic-01", text: "PRD 的每一条需求，我只读 PRD 就能判断它是否被满足，不需要追问作者。" },
      { key: "RBK-factory-PRD-critic-02", text: "PRD 中不存在两条互相矛盾的需求。" },
      { key: "RBK-factory-PRD-critic-03", text: "PRD 声称已回答的澄清问题，正文里确实能找到对应的答案。" },
      { key: "RBK-factory-PRD-critic-04", text: "PRD 的非目标一节确实排除了容易被顺手做掉的相邻功能，不是空话。" },
      { key: "RBK-factory-PRD-critic-05", text: "用户在澄清阶段明确提出、而 PRD 正文只字未提的需求，一条都没有。" },
      { key: "RBK-factory-PRD-critic-06", text: "PRD 的验收条件全部是可观察的外部行为，没有一条依赖内部实现细节。" },
      { key: "RBK-factory-PRD-critic-07", text: "没有任何一条需求的规模明显超出本次改动声明的意图。" },
    ],
  },
  Spec: {
    producer: [
      { key: "RBK-factory-Spec-producer-01", text: "我列出的每一条 PRD delta 都指明了它改的是 PRD 的哪一节。" },
      { key: "RBK-factory-Spec-producer-02", text: "上一轮反方提出的每一个 gap，我都给出了明确处置（已修，或不修并说明理由）。" },
      { key: "RBK-factory-Spec-producer-03", text: "我没有在 delta 里引入 PRD 从未提过的新需求。" },
      { key: "RBK-factory-Spec-producer-04", text: "我写下的每一条验收条件都能被一次具体的操作验证。" },
      { key: "RBK-factory-Spec-producer-05", text: "我没有在任何一条需求上留下「待定」「后续再议」。" },
      { key: "RBK-factory-Spec-producer-06", text: "我声称已修复的每一个 gap，都能在本次 delta 正文里指出对应的改动位置。" },
    ],
    critic: [
      { key: "RBK-factory-Spec-critic-01", text: "我方执行代理声称修复的每一个 gap，我都逐条复核过并给出了 verdict。" },
      { key: "RBK-factory-Spec-critic-02", text: "我提出的每一个 gap 都指明了它违反了哪一条需求或哪一条验收条件。" },
      { key: "RBK-factory-Spec-critic-03", text: "我没有把「可以做得更好」当成 gap 提出来。" },
      { key: "RBK-factory-Spec-critic-04", text: "规格里的每一条需求，我都检查过它是否有对应的验收条件。" },
      { key: "RBK-factory-Spec-critic-05", text: "我检查过规格是否覆盖了失败路径与边界条件，而不是只覆盖正常路径。" },
      { key: "RBK-factory-Spec-critic-06", text: "我提出的每一个 P0 gap，都确实会导致产物无法交付，而不只是不够完善。" },
    ],
    verdict: [
      { key: "RBK-factory-Spec-verdict-01", text: "正反双方对同一条需求的判断，不存在任何未被处理的直接冲突。" },
      { key: "RBK-factory-Spec-verdict-02", text: "反方提出的每一个 open gap，正方都有过回应（修复或说明）。" },
      { key: "RBK-factory-Spec-verdict-03", text: "现有规格足以让下游 TechSpec 阶段开工，不需要再回头补问 PRD。" },
      { key: "RBK-factory-Spec-verdict-04", text: "本轮不存在「双方都没看过」的需求：每条需求至少被一方检查过。" },
      { key: "RBK-factory-Spec-verdict-05", text: "规格里不存在任何一条无法判定是否满足的需求。" },
    ],
  },
  TechSpec: {
    producer: [
      { key: "RBK-factory-TechSpec-producer-01", text: "技术方案里的每一个改动点，都能对应到 PRD 或 Spec 的某一条需求。" },
      { key: "RBK-factory-TechSpec-producer-02", text: "我写出的每一处接口或数据结构变更，都标明了它是新增、修改还是删除。" },
      { key: "RBK-factory-TechSpec-producer-03", text: "我列出了本次改动会触碰的既有模块，或明确写出「不触碰任何既有模块」。" },
      { key: "RBK-factory-TechSpec-producer-04", text: "方案里没有留下「具体实现时再定」的关键决策。" },
      { key: "RBK-factory-TechSpec-producer-05", text: "我说明了数据迁移的处理方式，或明确写出「本次不涉及数据迁移」。" },
      { key: "RBK-factory-TechSpec-producer-06", text: "我说明了失败与回滚路径，或明确写出「本次改动不需要回滚路径」并给出理由。" },
      { key: "RBK-factory-TechSpec-producer-07", text: "我引入的每一个新依赖都写明了引入理由。" },
      { key: "RBK-factory-TechSpec-producer-08", text: "我检查过方案不会破坏任何既有对外契约（API、DB schema、文件格式）。" },
    ],
  },
  Plan: {
    producer: [
      { key: "RBK-factory-Plan-producer-01", text: "每一个实现步骤都指明了它要改哪些文件。" },
      { key: "RBK-factory-Plan-producer-02", text: "每一个步骤都小到可以独立验证，没有「实现整个功能」这种一步到位的步骤。" },
      { key: "RBK-factory-Plan-producer-03", text: "步骤之间的先后依赖是明确的，不存在两个步骤互相等待。" },
      { key: "RBK-factory-Plan-producer-04", text: "计划覆盖了 TechSpec 里的每一个改动点，没有遗漏。" },
      { key: "RBK-factory-Plan-producer-05", text: "计划里没有出现 TechSpec 未提及的新改动。" },
      { key: "RBK-factory-Plan-producer-06", text: "我列出了本次计划的风险项，或明确写出「没有已知风险」。" },
      { key: "RBK-factory-Plan-producer-07", text: "计划指明了每一步完成后要如何确认它确实完成了。" },
      { key: "RBK-factory-Plan-producer-08", text: "计划没有把测试放在最后当成可选步骤。" },
    ],
  },
  TestPlan: {
    producer: [
      { key: "RBK-factory-TestPlan-producer-01", text: "PRD 或 Spec 里的每一条验收条件，都至少有一个测试项覆盖。" },
      { key: "RBK-factory-TestPlan-producer-02", text: "每一个测试项都写明了预期结果，而不是只写「验证 XX 功能」。" },
      { key: "RBK-factory-TestPlan-producer-03", text: "测试计划覆盖了失败路径，而不是只测正常路径。" },
      { key: "RBK-factory-TestPlan-producer-04", text: "我列出的每一条必跑命令都能在本仓库里直接执行。" },
      { key: "RBK-factory-TestPlan-producer-05", text: "测试计划区分了自动化测试与需要人工确认的项。" },
      { key: "RBK-factory-TestPlan-producer-06", text: "没有任何一个测试项的通过与否取决于执行者的主观判断。" },
      { key: "RBK-factory-TestPlan-producer-07", text: "我说明了测试数据从哪里来，或明确写出「不需要额外测试数据」。" },
    ],
  },
  Build: {
    producer: [
      { key: "RBK-factory-Build-producer-01", text: "我改动的每一个文件都在计划的 expectedFiles 范围内。" },
      { key: "RBK-factory-Build-producer-02", text: "我没有为了让检查通过而删除、跳过或放宽任何既有测试。" },
      { key: "RBK-factory-Build-producer-03", text: "计划里的每一个步骤我都实现了，或明确说明了未实现的原因。" },
      { key: "RBK-factory-Build-producer-04", text: "我为本次改动新增或更新了测试，或明确说明了为什么不需要。" },
      { key: "RBK-factory-Build-producer-05", text: "我没有留下 TODO、占位实现或被注释掉的代码。" },
      { key: "RBK-factory-Build-producer-06", text: "我没有修改与本次需求无关的既有行为。" },
      { key: "RBK-factory-Build-producer-07", text: "我在本地实际运行过改动涉及的检查命令，而不是仅凭阅读判断。" },
    ],
    critic: [
      { key: "RBK-factory-Build-critic-01", text: "我逐个读过本次改动的产物文件，而不是只看 diff 摘要。" },
      { key: "RBK-factory-Build-critic-02", text: "上一轮每一条 open finding，我都给出了 verdict。" },
      { key: "RBK-factory-Build-critic-03", text: "我提出的每一条 finding 都指明了具体文件与位置。" },
      { key: "RBK-factory-Build-critic-04", text: "我检查过改动是否引入了未被测试覆盖的新分支。" },
      { key: "RBK-factory-Build-critic-05", text: "我检查过改动没有破坏任何既有对外契约。" },
      { key: "RBK-factory-Build-critic-06", text: "我提出的每一条 P0，都确实会导致功能不可用或数据损坏。" },
      { key: "RBK-factory-Build-critic-07", text: "我没有把风格偏好当成 finding 提出来。" },
    ],
  },
  Fix: {
    producer: [
      { key: "RBK-factory-Fix-producer-01", text: "本轮每一条 open 的 P0/P1 finding，我都处理了。" },
      { key: "RBK-factory-Fix-producer-02", text: "我的修复没有引入计划范围之外的文件改动。" },
      { key: "RBK-factory-Fix-producer-03", text: "我没有通过删除或放宽测试来消除任何一条 finding。" },
      { key: "RBK-factory-Fix-producer-04", text: "每一条我声称已修的 finding，都能指出对应的代码改动位置。" },
      { key: "RBK-factory-Fix-producer-05", text: "我没有为了修一条 finding 而破坏另一条已经通过的验收条件。" },
      { key: "RBK-factory-Fix-producer-06", text: "我在本地实际重跑过相关检查，而不是仅凭阅读判断。" },
    ],
  },
  Retro: {
    producer: [
      { key: "RBK-factory-Retro-producer-01", text: "复盘里写出的每一条问题都指明了它发生在哪个阶段。" },
      { key: "RBK-factory-Retro-producer-02", text: "每一条改进建议都具体到可以被执行，不是「以后要更小心」这类表述。" },
      { key: "RBK-factory-Retro-producer-03", text: "我列出了本次流程中实际发生过的返工，或明确写出「没有返工」。" },
      { key: "RBK-factory-Retro-producer-04", text: "复盘区分了「这次的偶发问题」与「会重复发生的机制问题」。" },
      { key: "RBK-factory-Retro-producer-05", text: "我记录了本次遗留的技术债，或明确写出「没有遗留技术债」。" },
      { key: "RBK-factory-Retro-producer-06", text: "复盘指向流程或机制，没有把问题归给某个具体的人。" },
    ],
  },
  // Done's producer is the delivery stage (design §3.4). Every line is written
  // in the first person because delivery.md is the only prompt that answers this
  // rubric and it defines exactly one role -- 交付说明撰写者 -- so a criterion
  // naming any other role would be asking about someone who is not in the room.
  //
  // §3.4 offers 「已知限制一节列出的内容，与库里 open 的 gap / 已豁免的 P1 一致」
  // as a tier-1 candidate. It is deliberately NOT shipped: that section is
  // generated from the database and the model cannot write it, so the criterion
  // could only ever be answered `yes` by construction, and a question whose
  // answer is fixed teaches the model that `yes` is the shape of a good answer.
  // What is shipped instead is the falsifiable neighbour: whether the model's
  // OWN half contradicts it.
  Done: {
    producer: [
      { key: "RBK-factory-Done-producer-01", text: "交付单里写的启动方式，我是在当前仓库状态下逐条确认过的，不是从文档或 README 抄来的。" },
      { key: "RBK-factory-Done-producer-02", text: "我写出了入口文件的具体路径，而不是只写模块名或目录名。" },
      { key: "RBK-factory-Done-producer-03", text: "我写明了运行前是否需要安装依赖，或明确写出「不需要安装依赖」。" },
      { key: "RBK-factory-Done-producer-04", text: "我写明了跑起来之后应该看到什么，读者据此能自己判断是否跑成功了。" },
      { key: "RBK-factory-Done-producer-05", text: "「本次改动带来了什么」里的每一条，都给出了读者可以自己执行的验证方式。" },
      { key: "RBK-factory-Done-producer-06", text: "文件地图覆盖了本次新增或修改的每一个文件，没有遗漏。" },
      { key: "RBK-factory-Done-producer-07", text: "文件地图里的每一个文件都标明了它是入口还是内部实现。" },
      { key: "RBK-factory-Done-producer-08", text: "我没有把本次没有做的事写成已经做了的事。" },
      { key: "RBK-factory-Done-producer-09", text: "我写出了本次明确不做的范围，或明确写出「本次没有明确排除的范围」。" },
      { key: "RBK-factory-Done-producer-10", text: "我写出了本次踩到的已知坑，或明确写出「没有踩到已知坑」。" },
    ],
  },
};

/**
 * Why a role does or does not have an answerer in the pipeline.
 *
 * This is not documentation, it is the map the drawer reads (§7) so that a
 * checklist nobody answers is visibly inert instead of silently inert. Batches
 * 3-5 each found one of these: a mechanism that looks armed and is not is the
 * failure mode this project keeps paying for.
 *
 * `false` entries are the honest gaps in §3's table, and each one is a fact
 * about the code rather than a decision taken here:
 *
 *  - **Refine** is a chat loop (`refine-service.ts`). It writes no `runs` row at
 *    all -- its own comment says so -- and `rubric_assessments.run_id` is NOT
 *    NULL, so a verdict has nothing to hang on. It also owns no `stage_gates`
 *    row, so a verdict could not block anything even if it could be stored.
 *  - **QA** and **Merge** run no model whatsoever. `runCheck` shells out to
 *    `runLocalChecks`; `computeMergeReadiness` is arithmetic over findings and
 *    gaps. Neither file contains an `engine.run` call. §3 already calls both
 *    "确定性检查"; the consequence it does not draw is that there is nobody to
 *    put a checklist in front of.
 *  - **Fix's critic.** §3 assigns it to "review（复跑）", and review does re-run
 *    after a fix -- but there is only ONE review stage and it can answer only
 *    one critic rubric. Batch 4 already resolved the same ambiguity in the UI by
 *    mapping the Review panel onto the BUILD rubric, on the grounds that Review
 *    is Build's critic rather than a phase of its own. Splitting the stage's
 *    answer by `BuildRunFile.purpose` would make the Review panel show an empty
 *    Build checklist on exactly the runs that produced Fix verdicts. One critic
 *    rubric, on Build, is what keeps the drawer and the stage agreeing; the Fix
 *    critic tab is marked unanswered rather than quietly collecting nothing.
 */
export const RUBRIC_ROLE_ANSWERED_BY: Record<
  RubricPhase,
  Partial<Record<RubricRole, string>>
> = {
  Refine: {},
  PRD: { producer: "prd_briefing_draft", critic: "prd_briefing_final_review" },
  Spec: { producer: "spec", critic: "spec_critic", verdict: "spec_verdict" },
  TechSpec: { producer: "tech_spec" },
  Plan: { producer: "generate_plan" },
  TestPlan: { producer: "test_plan" },
  Build: { producer: "implement", critic: "review" },
  Fix: { producer: "fix_findings" },
  QA: {},
  Merge: {},
  Retro: { producer: "retro" },
  // Like Retro: one producing stage, no critic anywhere in the pipeline, and no
  // `stage_gates` row for the phase -- so Done's verdicts are recorded and shown
  // but can never block.
  Done: { producer: "delivery" },
};

/** The pipeline stage that answers this role, or null when nothing does. */
export function rubricRoleAnsweredBy(phase: RubricPhase, role: RubricRole): string | null {
  return RUBRIC_ROLE_ANSWERED_BY[phase][role] ?? null;
}

/**
 * The factory criteria for one scope, with the keys authored alongside them.
 *
 * Nothing here derives identity any more, so the ordering warning this comment
 * used to carry is gone with the ordering dependency. `factory-rubric-keys`
 * (rubric-rollout.test.ts) pins every key to its text, which is the assertion
 * that was missing while the keys were positional.
 */
export function factoryCriteria(
  phase: RubricPhase,
  role: RubricRole,
): FactoryRubricCriterion[] {
  const entries = FACTORY_RUBRIC_TEXT[phase]?.[role] ?? [];
  return entries.map((entry) => ({
    criterionKey: entry.key,
    text: entry.text,
  }));
}

/** Every scope that ships factory criteria. */
export function factoryRubricScopes(): Array<{ phase: RubricPhase; role: RubricRole }> {
  const scopes: Array<{ phase: RubricPhase; role: RubricRole }> = [];
  for (const [phase, roles] of Object.entries(FACTORY_RUBRIC_TEXT)) {
    for (const role of Object.keys(roles ?? {})) {
      scopes.push({ phase: phase as RubricPhase, role: role as RubricRole });
    }
  }
  return scopes;
}
