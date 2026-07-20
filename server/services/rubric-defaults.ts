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
 * forever. See `rubricRoleAnswerability` for the full map and the reasons.
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

type FactoryRubrics = Partial<Record<RubricPhase, Partial<Record<RubricRole, string[]>>>>;

/**
 * The criteria themselves, as plain text lists. Keys are derived from position
 * by `factoryCriteria`, so the source of truth stays readable and a reordering
 * cannot silently re-key a row -- see the ordering warning there.
 */
const FACTORY_RUBRIC_TEXT: FactoryRubrics = {
  PRD: {
    producer: [
      "PRD 正文里每一条需求都写明了「谁、在什么场景下、要达成什么」，没有只写功能名的条目。",
      "PRD 列出的每一条需求都带有至少一条可判定的验收条件（读完就能答出满足或不满足）。",
      "PRD 明确写出了本次改动**不做**什么（非目标），而不是只写要做什么。",
      "PRD 里出现的每一个业务名词，在文中有定义，或指向了已有定义。",
      "PRD 没有把实现方案（技术选型、表结构、接口签名）当成需求写进来。",
      "用户在澄清问答里给出的每一个决定，都能在 PRD 正文里找到对应的落点。",
      "PRD 标注了本次改动会影响到的既有功能，或明确写出「不影响任何既有功能」。",
      "PRD 里没有「优化」「完善」「提升体验」这类无法判定是否完成的表述。",
    ],
    critic: [
      "PRD 的每一条需求，我只读 PRD 就能判断它是否被满足，不需要追问作者。",
      "PRD 中不存在两条互相矛盾的需求。",
      "PRD 声称已回答的澄清问题，正文里确实能找到对应的答案。",
      "PRD 的非目标一节确实排除了容易被顺手做掉的相邻功能，不是空话。",
      "用户在澄清阶段明确提出、而 PRD 正文只字未提的需求，一条都没有。",
      "PRD 的验收条件全部是可观察的外部行为，没有一条依赖内部实现细节。",
      "没有任何一条需求的规模明显超出本次改动声明的意图。",
    ],
  },
  Spec: {
    producer: [
      "我列出的每一条 PRD delta 都指明了它改的是 PRD 的哪一节。",
      "上一轮蓝方提出的每一个 gap，我都给出了明确处置（已修，或不修并说明理由）。",
      "我没有在 delta 里引入 PRD 从未提过的新需求。",
      "我写下的每一条验收条件都能被一次具体的操作验证。",
      "我没有在任何一条需求上留下「待定」「后续再议」。",
      "我声称已修复的每一个 gap，都能在本次 delta 正文里指出对应的改动位置。",
    ],
    critic: [
      "红方声称修复的每一个 gap，我都逐条复核过并给出了 verdict。",
      "我提出的每一个 gap 都指明了它违反了哪一条需求或哪一条验收条件。",
      "我没有把「可以做得更好」当成 gap 提出来。",
      "规格里的每一条需求，我都检查过它是否有对应的验收条件。",
      "我检查过规格是否覆盖了失败路径与边界条件，而不是只覆盖正常路径。",
      "我提出的每一个 P0 gap，都确实会导致产物无法交付，而不只是不够完善。",
    ],
    verdict: [
      "正反双方对同一条需求的判断，不存在任何未被处理的直接冲突。",
      "蓝方提出的每一个 open gap，红方都有过回应（修复或说明）。",
      "现有规格足以让下游 TechSpec 阶段开工，不需要再回头补问 PRD。",
      "本轮不存在「双方都没看过」的需求：每条需求至少被一方检查过。",
      "规格里不存在任何一条无法判定是否满足的需求。",
    ],
  },
  TechSpec: {
    producer: [
      "技术方案里的每一个改动点，都能对应到 PRD 或 Spec 的某一条需求。",
      "我写出的每一处接口或数据结构变更，都标明了它是新增、修改还是删除。",
      "我列出了本次改动会触碰的既有模块，或明确写出「不触碰任何既有模块」。",
      "方案里没有留下「具体实现时再定」的关键决策。",
      "我说明了数据迁移的处理方式，或明确写出「本次不涉及数据迁移」。",
      "我说明了失败与回滚路径，或明确写出「本次改动不需要回滚路径」并给出理由。",
      "我引入的每一个新依赖都写明了引入理由。",
      "我检查过方案不会破坏任何既有对外契约（API、DB schema、文件格式）。",
    ],
  },
  Plan: {
    producer: [
      "每一个实现步骤都指明了它要改哪些文件。",
      "每一个步骤都小到可以独立验证，没有「实现整个功能」这种一步到位的步骤。",
      "步骤之间的先后依赖是明确的，不存在两个步骤互相等待。",
      "计划覆盖了 TechSpec 里的每一个改动点，没有遗漏。",
      "计划里没有出现 TechSpec 未提及的新改动。",
      "我列出了本次计划的风险项，或明确写出「没有已知风险」。",
      "计划指明了每一步完成后要如何确认它确实完成了。",
      "计划没有把测试放在最后当成可选步骤。",
    ],
  },
  TestPlan: {
    producer: [
      "PRD 或 Spec 里的每一条验收条件，都至少有一个测试项覆盖。",
      "每一个测试项都写明了预期结果，而不是只写「验证 XX 功能」。",
      "测试计划覆盖了失败路径，而不是只测正常路径。",
      "我列出的每一条必跑命令都能在本仓库里直接执行。",
      "测试计划区分了自动化测试与需要人工确认的项。",
      "没有任何一个测试项的通过与否取决于执行者的主观判断。",
      "我说明了测试数据从哪里来，或明确写出「不需要额外测试数据」。",
    ],
  },
  Build: {
    producer: [
      "我改动的每一个文件都在计划的 expectedFiles 范围内。",
      "我没有为了让检查通过而删除、跳过或放宽任何既有测试。",
      "计划里的每一个步骤我都实现了，或明确说明了未实现的原因。",
      "我为本次改动新增或更新了测试，或明确说明了为什么不需要。",
      "我没有留下 TODO、占位实现或被注释掉的代码。",
      "我没有修改与本次需求无关的既有行为。",
      "我在本地实际运行过改动涉及的检查命令，而不是仅凭阅读判断。",
    ],
    critic: [
      "我逐个读过本次改动的产物文件，而不是只看 diff 摘要。",
      "上一轮每一条 open finding，我都给出了 verdict。",
      "我提出的每一条 finding 都指明了具体文件与位置。",
      "我检查过改动是否引入了未被测试覆盖的新分支。",
      "我检查过改动没有破坏任何既有对外契约。",
      "我提出的每一条 P0，都确实会导致功能不可用或数据损坏。",
      "我没有把风格偏好当成 finding 提出来。",
    ],
  },
  Fix: {
    producer: [
      "本轮每一条 open 的 P0/P1 finding，我都处理了。",
      "我的修复没有引入计划范围之外的文件改动。",
      "我没有通过删除或放宽测试来消除任何一条 finding。",
      "每一条我声称已修的 finding，都能指出对应的代码改动位置。",
      "我没有为了修一条 finding 而破坏另一条已经通过的验收条件。",
      "我在本地实际重跑过相关检查，而不是仅凭阅读判断。",
    ],
  },
  Retro: {
    producer: [
      "复盘里写出的每一条问题都指明了它发生在哪个阶段。",
      "每一条改进建议都具体到可以被执行，不是「以后要更小心」这类表述。",
      "我列出了本次流程中实际发生过的返工，或明确写出「没有返工」。",
      "复盘区分了「这次的偶发问题」与「会重复发生的机制问题」。",
      "我记录了本次遗留的技术债，或明确写出「没有遗留技术债」。",
      "复盘指向流程或机制，没有把问题归给某个具体的人。",
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
};

/** The pipeline stage that answers this role, or null when nothing does. */
export function rubricRoleAnsweredBy(phase: RubricPhase, role: RubricRole): string | null {
  return RUBRIC_ROLE_ANSWERED_BY[phase][role] ?? null;
}

/**
 * The factory criteria for one scope, with their stable keys.
 *
 * The key embeds the ORDINAL, so inserting a line in the middle of a list above
 * shifts every key after it -- which would re-key criteria users may already
 * have ticked as blocking. Append to the end of a list instead of inserting,
 * and never renumber. The tests pin the full key set for exactly this reason.
 */
export function factoryCriteria(
  phase: RubricPhase,
  role: RubricRole,
): FactoryRubricCriterion[] {
  const texts = FACTORY_RUBRIC_TEXT[phase]?.[role] ?? [];
  return texts.map((text, index) => ({
    criterionKey: `RBK-factory-${phase}-${role}-${String(index + 1).padStart(2, "0")}`,
    text,
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
