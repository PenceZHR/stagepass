import type { ActionDefinition } from "./action-contract-types";
import { isProviderBackedAction } from "./provider-selection-service";

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  { actionId: "approve_intake", phase: "PRD", label: "批准 Intake", requiredStatus: "INTAKE_READY" },
  { actionId: "reject_intake", phase: "PRD", label: "打回 Intake", requiredStatus: "INTAKE_READY" },
  { actionId: "run_prd", phase: "PRD", label: "生成 PRD", requiredStatus: "INTAKE_PENDING" },
  { actionId: "retry_prd", phase: "PRD", label: "重新生成 PRD", requiredStatus: ["INTAKE_PENDING", "INTAKE_READY", "BLOCKED"] },
  { actionId: "run_prd_briefing_questions", phase: "PRD", label: "生成 PRD 追问", requiredStatus: ["INTAKE_PENDING", "INTAKE_READY", "BLOCKED"] },
  { actionId: "run_prd_briefing_draft", phase: "PRD", label: "生成 PRD 草稿", requiredStatus: ["INTAKE_PENDING", "INTAKE_READY", "BLOCKED"] },
  { actionId: "run_prd_briefing_final_review", phase: "PRD", label: "执行 PRD 终审", requiredStatus: ["INTAKE_PENDING", "INTAKE_READY", "BLOCKED"] },
  { actionId: "approve_spec", phase: "Spec", label: "批准 Spec", requiredStatus: "SPEC_READY" },
  { actionId: "reject_spec", phase: "Spec", label: "打回 Spec", requiredStatus: "SPEC_READY" },
  { actionId: "run_spec", phase: "Spec", label: "开始 Spec 对抗", snapshotPhase: "PRD", requiredStatus: ["INTAKE_READY", "SPECCING"] },
  { actionId: "retry_spec", phase: "Spec", label: "重新 Spec 对抗", snapshotPhase: "PRD", requiredStatus: ["INTAKE_READY", "SPECCING", "BLOCKED"] },
  { actionId: "waive_spec_p1", phase: "Spec", label: "接受 Spec P1 风险" },
  { actionId: "run_tech_spec", phase: "Plan", label: "生成 TechSpec", snapshotPhase: "Spec", requiredStatus: "SPEC_READY" },
  // Mirrors what runTechSpec actually accepts. SPEC_READY is the normal entry;
  // TECHSPECCING is the stranded-run entry, where runDocumentStage rolls the
  // change back to SPEC_READY first (recoverStrandedRunningStatus) and then
  // runs. Leaving requiredStatus unset advertised the retry at every other
  // status too -- TECHSPEC_READY, PLANNING, BLOCKED -- where the runner's
  // SPEC_READY assert still rejects it, which is the a9a953f2 phantom-button
  // shape. Narrowing must NOT drop TECHSPECCING: that is the one status where
  // the retry is the only way out.
  {
    actionId: "retry_tech_spec",
    phase: "Plan",
    label: "重新生成 TechSpec",
    snapshotPhase: "Spec",
    requiredStatus: ["SPEC_READY", "TECHSPECCING"],
  },
  {
    actionId: "approve_tech_spec",
    phase: "Plan",
    label: "批准 TechSpec",
    snapshotPhase: "TechSpec",
    requiredStatus: "TECHSPEC_READY",
  },
  {
    actionId: "reject_tech_spec",
    phase: "Plan",
    label: "打回 TechSpec",
    snapshotPhase: "TechSpec",
    requiredStatus: "TECHSPEC_READY",
  },
  { actionId: "approve_plan", phase: "Plan", label: "批准作战计划", requiredStatus: ["PLAN_READY", "TESTPLAN_DONE"] },
  { actionId: "run_plan", phase: "Plan", label: "生成作战计划", snapshotPhase: "TechSpec", requiredStatus: ["TECHSPEC_READY", "PLAN_READY"] },
  // Mirrors what generatePlan actually accepts (pipeline-plan-stage-service
  // assertStatus): TECHSPEC_READY is the normal entry, PLAN_READY the
  // regenerate entry, and PLANNING is the stranded-run entry, where
  // generatePlan rolls the change back to TECHSPEC_READY first
  // (recoverStrandedRunningStatus) and then runs. Leaving requiredStatus unset
  // advertised the retry at every other status too -- PLAN_APPROVED,
  // IMPLEMENTING, BLOCKED, DONE -- where the runner's assert still rejects it,
  // which is the a9a953f2 phantom-button shape. Narrowing must NOT drop
  // PLANNING: that is the one status where the retry is the only way out.
  // BLOCKED belongs to retry_prd/retry_spec, not here -- the Plan runner has
  // never accepted it.
  {
    actionId: "retry_plan",
    phase: "Plan",
    label: "重新生成作战计划",
    snapshotPhase: "TechSpec",
    requiredStatus: ["TECHSPEC_READY", "PLAN_READY", "PLANNING"],
  },
  { actionId: "regenerate_plan_report", phase: "Plan", label: "刷新 Plan 战报" },
  { actionId: "waive_plan_p1", phase: "Plan", label: "接受 Plan P1 风险" },
  { actionId: "run_test_plan", phase: "TestPlan", label: "执行测试计划", snapshotPhase: "Plan", requiredStatus: "PLAN_APPROVED" },
  // Mirrors what runTestPlan actually reaches (pipeline-design-stage-service
  // TEST_PLAN_ALLOWED_STATUSES): PLAN_APPROVED is the normal entry, and
  // TESTPLANNING is the stranded-run entry, where runDocumentStage rolls the
  // change back to PLAN_APPROVED first (recoverStrandedRunningStatus) and then
  // runs. Advertising it anywhere else (observed live at CHECK_FAILED) is the
  // a9a953f2 phantom shape, which is why this was pinned to PLAN_APPROVED
  // alone -- but that narrowing predates 8ac5c4ec teaching the document-stage
  // runner to recover, and left the mirror dead end that commit warned about:
  // a TestPlan run killed mid-flight strands the change at TESTPLANNING, the
  // runner can repair it, and nothing could enqueue the retry that does.
  {
    actionId: "retry_test_plan",
    phase: "TestPlan",
    label: "重新执行测试计划",
    snapshotPhase: "Plan",
    requiredStatus: ["PLAN_APPROVED", "TESTPLANNING"],
  },
  { actionId: "run_build", phase: "Build", label: "开始 Build", snapshotPhase: "TestPlan", requiredStatus: "PLAN_APPROVED" },
  // The two statuses retryBuildStreamed can reach a run from: PLAN_APPROVED
  // straight through, and IMPLEMENTING once recoverStaleBuildRun has taken over
  // a Build whose provider process is provably gone. retryBuildDecision already
  // narrowed GET /gate to the same pair (identically, to not_at_gate) and the
  // implement route preflights assertRetryBuildCanStart, but the enqueue
  // authority skips its status filter entirely when this field is unset --
  // leaving it the one layer that green-lit the action at every status.
  // Deliberately NOT narrower: whether an IMPLEMENTING change is retryable
  // depends on run liveness, which a flat status list cannot express, so the
  // inspection stays authoritative and this is only the outer bound.
  {
    actionId: "retry_build",
    phase: "Build",
    label: "重新开始 Build",
    snapshotPhase: "TestPlan",
    requiredStatus: ["PLAN_APPROVED", "IMPLEMENTING"],
  },
  { actionId: "adopt_build", phase: "Build", label: "收编 Build" },
  { actionId: "adopt_fix", phase: "Build", label: "收编 Fix" },
  { actionId: "reject_build", phase: "Build", label: "拒绝本轮施工" },
  // Git is the pipeline's substrate, not one of its stages, so both entries are
  // deliberately left without requiredStatus. That is the OPPOSITE of the
  // a9a953f2 phantom-button shape rather than a relapse into it: the phantom
  // case is an action advertised at statuses where its *runner* would reject it,
  // and git has no status precondition to mirror -- `git init` succeeds on any
  // change status, and so does a commit. The git facts alone decide these
  // (action-contract-git-policy), and a status filter here could only hide
  // init_git_repo at the statuses where it is most needed: a project whose
  // repoPath is not a repository stalls at run_build/PLAN_APPROVED with
  // build_base_camp_blocked, and this is the only action that clears it.
  //
  // They are filed under the Build phase because that is where the pipeline
  // first touches the working tree, which puts them on the Build and Fix stages
  // in the UI (pipeline-ui-model maps both onto actionPhase "Build").
  { actionId: "init_git_repo", phase: "Build", label: "初始化 Git 仓库" },
  { actionId: "commit_changes", phase: "Build", label: "提交改动" },
  { actionId: "run_review", phase: "Review", label: "开始反方审查", requiredStatus: "IMPLEMENTED" },
  { actionId: "retry_review", phase: "Review", label: "重新反方审查", requiredStatus: ["IMPLEMENTED", "CHECK_FAILED", "SCOPE_FAILED", "BLOCKED"] },
  // Mirrors runFixStreamed's FIX_ALLOWED_STATUSES (pipeline-build-stage-service)
  // plus the running status its recovery repairs, which is also exactly what
  // reviewControlDecision's FIX_ENTRY_STATUSES allows. reviewControlDecision
  // already filtered status at GET /gate, but the enqueue authority skips its
  // own filter entirely when requiredStatus is unset, so POST was the
  // unguarded half.
  {
    actionId: "fix_blockers",
    phase: "Review",
    label: "修复阻断项",
    requiredStatus: ["CHECK_FAILED", "SCOPE_FAILED", "FIXING"],
  },
  { actionId: "waive_review_p1", phase: "Review", label: "接受 Review P1 风险" },
  { actionId: "recompute_report", phase: "Review", label: "重新结算战报" },
  { actionId: "rebuild_mirror", phase: "Review", label: "重建镜像" },
  { actionId: "stop_change", phase: "Review", label: "终止 Change" },
  { actionId: "enter_qa", phase: "Review", label: "进入 QA" },
  { actionId: "run_qa", phase: "QA", label: "执行 QA", requiredStatus: ["IMPLEMENTED", "CHECK_FAILED", "SCOPE_FAILED"] },
  { actionId: "retry_qa", phase: "QA", label: "重新执行 QA", requiredStatus: ["CHECKING", "CHECK_FAILED", "SCOPE_FAILED"] },
  { actionId: "approve_merge", phase: "Merge", label: "批准 Merge", requiredStatus: "MERGE_READY" },
  { actionId: "reject_merge", phase: "Merge", label: "打回 Merge", requiredStatus: "MERGE_READY" },
  { actionId: "merge", phase: "Merge", label: "合并", requiredStatus: "MERGE_READY" },
  { actionId: "run_retro", phase: "Merge", label: "运行 Retro", requiredStatus: "RETRO_PENDING" },
];

for (const definition of ACTION_DEFINITIONS) {
  const providerBacked = isProviderBackedAction(definition.actionId);
  definition.requiresProvider = providerBacked;
  definition.providerSelectable = providerBacked;
}
