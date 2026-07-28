export const STAGE_CLARIFICATION_ORDER = [
  "prd",
  "spec",
  "tech_spec",
  "plan",
  "test_plan",
  "build",
  "review",
  "fix",
  "qa",
  "merge",
  "retro",
  "done",
] as const;

export type StageClarificationId =
  (typeof STAGE_CLARIFICATION_ORDER)[number];

export interface StageClarificationPolicy {
  id: StageClarificationId;
  label: string;
  objective: string;
  webSummary: string;
  completionRule: string;
  maxQuestionsPerBatch: 10;
  phaseAliases: readonly string[];
  exampleQuestions: readonly [string, string, string, ...string[]];
}

export type ResolvedStageClarificationPolicy =
  | StageClarificationPolicy
  | {
      id: "generic";
      label: "当前阶段";
      objective: string;
      webSummary: string;
      completionRule: string;
      maxQuestionsPerBatch: 10;
      phaseAliases: readonly [];
      exampleQuestions: readonly [string, string, string];
    };

export const STAGE_CLARIFICATION_POLICIES: Record<
  StageClarificationId,
  StageClarificationPolicy
> = {
  prd: {
    id: "prd",
    label: "PRD",
    objective: "把产品意图收敛成可验证、可交付的需求基线。",
    webSummary: "确认目标用户、核心结果、范围边界与可观察验收标准。",
    completionRule: "目标、范围和验收标准足够明确，可以生成并锁定 PRD。",
    maxQuestionsPerBatch: 10,
    phaseAliases: [
      "PRD",
      "Intake",
      "intake",
      "prd",
      "prd_briefing_questions",
      "prd_briefing_draft",
      "prd_briefing_final_review",
    ],
    exampleQuestions: [
      "第一版主要服务哪一类用户和使用场景？",
      "用户完成一次游戏后必须得到什么可观察结果？",
      "哪些能力明确不进入本次交付范围？",
      "用什么具体结果判断这次需求已经验收通过？",
    ],
  },
  spec: {
    id: "spec",
    label: "Spec",
    objective: "把 PRD 变成没有行为歧义和边界漏洞的功能规格。",
    webSummary: "确认精确行为、边界情况、错误处理与兼容约束。",
    completionRule: "所有关键行为和边界都有唯一解释，可以进入技术设计。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Spec", "spec", "spec_critic", "spec_verdict"],
    exampleQuestions: [
      "玩家触发两个互斥动作时系统应优先执行哪一个？",
      "输入为空、重复或越界时界面必须表现成什么状态？",
      "旧存档或旧配置与新规则冲突时应保留还是迁移？",
    ],
  },
  tech_spec: {
    id: "tech_spec",
    label: "Tech Spec",
    objective: "把功能规格收敛为可施工、可迁移的技术边界。",
    webSummary: "确认接口、数据、并发、迁移与安全边界。",
    completionRule: "关键接口、状态变化、数据迁移和故障策略都有明确方案。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["TechSpec", "tech_spec"],
    exampleQuestions: [
      "该状态由前端、服务端还是持久层作为唯一事实来源？",
      "并发提交同一选择时应拒绝、覆盖还是幂等复用？",
      "已有数据升级失败时系统必须回滚还是停止启动？",
    ],
  },
  plan: {
    id: "plan",
    label: "Plan",
    objective: "把批准的技术方案拆成有顺序、可验证、可回滚的实施步骤。",
    webSummary: "确认实施顺序、依赖、回滚点与验证命令。",
    completionRule: "每一步都有输入、产出、验证方式和失败后的恢复路径。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Plan", "plan", "generate_plan"],
    exampleQuestions: [
      "必须先完成哪一项改动才能安全开始后续步骤？",
      "哪一步失败时需要回滚已经写入的数据或文件？",
      "完成实现后必须运行哪些命令才能证明计划达成？",
    ],
  },
  test_plan: {
    id: "test_plan",
    label: "Test Plan",
    objective: "在施工前确定覆盖关键风险的可执行验证路径。",
    webSummary: "确认关键路径、环境、测试数据与通过标准。",
    completionRule: "每个关键风险都有可运行的测试和明确的通过或失败判据。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["TestPlan", "test_plan"],
    exampleQuestions: [
      "哪条用户路径失败会直接阻止本次交付？",
      "测试必须使用真实 Codex App 还是允许使用协议夹具？",
      "哪些历史行为必须加入回归测试才能防止再次破坏？",
    ],
  },
  build: {
    id: "build",
    label: "Build",
    objective: "在批准的边界内完成实现并留下可审计的验证证据。",
    webSummary: "只确认无法从已批准文档和仓库事实中推导的施工决策。",
    completionRule: "实现、迁移和验证均完成，没有未决施工选择。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Build", "Implement", "build", "implement"],
    exampleQuestions: [
      "这项兼容性取舍应保留旧行为还是执行新规格？",
      "无法同时满足性能与精确性时本次优先保证哪一项？",
      "需要修改范围外文件才能完成时是否允许扩大本次施工范围？",
    ],
  },
  review: {
    id: "review",
    label: "Review",
    objective: "判断实现是否满足规格，并把阻断问题转成明确处置决定。",
    webSummary: "确认 finding 严重度、必须修复项与显式豁免。",
    completionRule: "所有阻断 finding 都已修复或获得有依据的人工豁免。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Review", "review"],
    exampleQuestions: [
      "这个兼容性偏差应判为阻断项还是可接受的已知限制？",
      "该 finding 必须按哪一种修复方案处理？",
      "是否接受带有明确理由和风险记录的人工豁免？",
    ],
  },
  fix: {
    id: "fix",
    label: "Fix",
    objective: "修复已确认阻断项，同时守住兼容与回归边界。",
    webSummary: "确认修复策略、兼容要求与回归范围。",
    completionRule: "指定 finding 已修复，原问题和相关回归验证均通过。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Fix", "fix", "fix_findings"],
    exampleQuestions: [
      "该问题应局部修补还是调整共享协议从根因修复？",
      "修复后必须保留哪一项旧行为以避免兼容性回归？",
      "哪些相邻路径必须一起验证才能证明没有引入新问题？",
    ],
  },
  qa: {
    id: "qa",
    label: "QA",
    objective: "在目标环境中证明交付满足关键路径与质量门槛。",
    webSummary: "确认验证环境、执行范围、失败判据与剩余风险。",
    completionRule: "规定的 QA 检查已执行，失败均已处理且剩余风险被明确接受。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["QA", "Check", "qa", "check", "local_check"],
    exampleQuestions: [
      "最终验收必须在哪个运行环境和设备组合上完成？",
      "哪一类失败必须阻止进入 Merge？",
      "是否允许带着这个已知但不影响关键路径的问题继续？",
    ],
  },
  merge: {
    id: "merge",
    label: "Merge",
    objective: "在事实完整、风险可控时完成合并或发布决定。",
    webSummary: "确认合并策略、发布范围、回滚与最终授权。",
    completionRule: "合并目标、发布方式、回滚条件和授权均已明确。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Merge", "merge", "release"],
    exampleQuestions: [
      "本次应直接合并、压缩合并还是保留完整提交历史？",
      "合并后是立即发布还是只进入待发布状态？",
      "出现哪一种线上信号时必须立即回滚？",
    ],
  },
  retro: {
    id: "retro",
    label: "Retro",
    objective: "把本次交付中的经验转成有责任人的后续行动。",
    webSummary: "确认复盘结论、后续范围、责任人与完成条件。",
    completionRule: "需要跟进的事项都有明确负责人和可验证的完成条件。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Retro", "retro"],
    exampleQuestions: [
      "这次最需要固化成流程规则的经验是什么？",
      "哪一项遗留问题必须建立后续 Change 继续处理？",
      "后续行动由谁负责并以什么结果视为完成？",
    ],
  },
  done: {
    id: "done",
    label: "Done",
    objective: "形成可让他人运行、理解和接手的最终交付说明。",
    webSummary: "确认运行方法、交付范围、文件地图与已知限制。",
    completionRule: "交付说明足够让新接手者独立运行并理解本次变更。",
    maxQuestionsPerBatch: 10,
    phaseAliases: ["Done", "done", "delivery"],
    exampleQuestions: [
      "用户需要执行哪条最短命令才能运行本次交付？",
      "最终交付说明必须明确列出哪些没有完成的范围？",
      "哪些关键文件需要进入交付文件地图并说明用途？",
    ],
  },
};

const GENERIC_POLICY: ResolvedStageClarificationPolicy = {
  id: "generic",
  label: "当前阶段",
  objective: "在继续执行前消除无法从现有事实安全推导的关键歧义。",
  webSummary: "确认当前阶段尚未解决的具体阻塞决定。",
  completionRule: "没有会阻止当前阶段正确运行的未决问题。",
  maxQuestionsPerBatch: 10,
  phaseAliases: [],
  exampleQuestions: [
    "哪一个未决选择会改变当前阶段的正确实现结果？",
    "这个选择的可接受结果和失败边界分别是什么？",
    "是否存在必须由用户明确授权才能继续的风险？",
  ],
};

function normalizePhase(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const POLICY_BY_PHASE = new Map<string, StageClarificationPolicy>(
  STAGE_CLARIFICATION_ORDER.flatMap((stageId) => {
    const policy = STAGE_CLARIFICATION_POLICIES[stageId];
    return [
      [normalizePhase(stageId), policy] as const,
      ...policy.phaseAliases.map(
        (alias) => [normalizePhase(alias), policy] as const,
      ),
    ];
  }),
);

export function resolveStageClarificationPolicy(
  phase: string,
): ResolvedStageClarificationPolicy {
  return POLICY_BY_PHASE.get(normalizePhase(phase)) ?? GENERIC_POLICY;
}
