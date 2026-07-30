/**
 * L5-4: 一轮真的对抗，三个角色各自对着一份 rubric 逐条作答。
 *
 *   pnpm verify:rubric-round
 *
 * ## 这个脚本要证明的是什么
 *
 * 规则全都在 `src/work/rubric-round.test.ts` 里离线证明过了。**这里只有一件事是
 * 离线证不了的：一个真模型拿到 rubric 契约之后，会不会真的按那个行协议作答。**
 *
 * 所以判据只有三条，而且都不看模型答得对不对：
 *
 *   1. 契约进了裁判的提示词
 *   2. 三个角色的 rollout 里能读出判定（不是全部 not_assessed）
 *   3. 判定按轮落了库
 *
 * 模型答 yes 还是 no 不是这里的判据 —— 那是它的判断，不是接线是否通。
 *
 * ## 全部 not_assessed 也是一种结果，而且要说清楚
 *
 * 那意味着模型没照契约作答。**这不是失败，是测量结果** —— 但必须显式说出来，
 * 不能因为「没报错」就当成通过。fail-closed 的设计会让这种情况闸门关着，脚本要
 * 把这一点也打出来。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { RUBRIC_ROLES, type RubricRole } from "../src/domain/rubric";
import { readThreadTranscript } from "../src/codex/subagent";
import { CodexTuiTransport } from "../src/codex/tui-transport";
import { ChangeStore } from "../src/store/change-store";
import { GapStore } from "../src/store/gap-store";
import { ProjectStore } from "../src/store/project-store";
import { RubricStore } from "../src/store/rubric-store";
import { runRubricRound } from "../src/work/rubric-round";

/**
 * 一个**固定**的空工作区，不是每次新建的临时目录。
 *
 * Codex 对没见过的目录一律先问一次「要不要信任这个文件夹」，而那是一个**必须有人
 * 按键**的提示 —— 脚本会一直卡在那儿，表现为「裁判没有派生子 Agent」，因为它压根
 * 没开始跑。（`-c projects."<dir>".trust_level` 不生效，trust 也不从父目录继承，
 * 两条都实测过，见 scripts/probe-sandbox.ts。）
 *
 * 每次换一个新目录 = 每次都要人按一次。固定一个路径，就只有**第一次**要人按
 * 「Yes, continue」，之后 Codex 记在 ~/.codex/config.toml 里，再也不问。
 *
 * 目录是空的（每次清内容、保留路径）：指向一个大仓库，模型头几分钟都在读代码而
 * 不是做这一轮；而路径必须稳定，否则信任白给。
 */
function stableWorkspace(name: string): string {
  const dir = join(tmpdir(), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

const PROJECT = "PRJ-RUBRIC";
const CHANGE = "CHG-RUBRIC";
const PHASE = "Spec" as const;
const TASK = [
  "为一个「给 Markdown 文件加行内注释」的小工具写一页 Spec。",
  "写清楚：用户能观察到的行为、边界情况、以及验收标准。",
].join("\n");

/** 出厂默认的三份 rubric，每份两条 —— 够验通路，又不会把提示词撑爆。 */
const DEFAULTS: Readonly<Record<RubricRole, { text: string; blocking: boolean }[]>> = {
  producer: [
    { text: "每条需求都写了可观察、可测量的验收标准", blocking: true },
    { text: "明确写出了至少一个边界情况", blocking: false },
  ],
  critic: [
    { text: "每条问题都指向正方产出里的具体位置，而不是泛泛而谈", blocking: true },
    { text: "没有提出需要读仓库才能验证的问题", blocking: false },
  ],
  verdict: [
    { text: "对每条既有问题都明确表了态，没有沉默略过", blocking: true },
    { text: "关闭任何一条时都写了它为什么不再成立", blocking: true },
  ],
};

async function main(): Promise<void> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "stagepass-rubric-")), "ship.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);

  const project = new ProjectStore(database).ensure(PROJECT, "rubric-probe");
  new ChangeStore(database).create(CHANGE, { projectId: project.id });

  const rubrics = new RubricStore(database);
  for (const role of RUBRIC_ROLES) {
    rubrics.save({ projectId: project.id, changeId: null, phase: PHASE, role },
      DEFAULTS[role]);
  }

  const gaps = new GapStore(database);
  const transport = new CodexTuiTransport({
    // 空目录是故意的：指向一个大仓库，模型头几分钟都在读代码而不是做这一轮。
    cwd: stableWorkspace("stagepass-verify-rubric-cwd"),
    /*
     * **workspace-write，别照 verify-round.ts 抄 read-only。**
     *
     * 我第一次写这个脚本就是照抄的，结果整轮停在 `Would you like to make the
     * following edits?` 上等了三十分钟 —— 红方要写一页 Spec，而 read-only 的定义
     * 就是它不能写，于是必然升级审批。`pnpm probe:sandbox` 两小时前刚测过这件事，
     * 我照样犯了一遍。
     *
     * 工作区是临时空目录，所以放开写没有代价。
     */
    sandbox: "workspace-write",
    reasoningEffort: "low",
  });

  console.log("数据库   ", dbPath);
  console.log("\n一个 Codex TUI 窗口正在打开。裁判会自己派生红蓝两个子 Agent，");
  console.log("三个角色各自会拿到一份 rubric。不需要你操作，看着就行。\n");

  const settled = await runRubricRound(
    { projectId: project.id, changeId: CHANGE, phase: PHASE, round: 1, task: TASK, judgeThreadId: null },
    {
      transport, gaps, rubrics,
      readThread: (threadId) => readThreadTranscript({ threadId }),
    },
  );

  console.log("裁判线程 ", settled.judgeThreadId);
  console.log("产出     ", settled.artifactIds.join(", ") || "(none)");

  console.log("\n--- 三个角色各自答了什么 ---");
  let answeredRoles = 0;
  for (const role of RUBRIC_ROLES) {
    const read = settled.assessments[role];
    const answered = read.filter((entry) => entry.verdict !== "not_assessed").length;
    if (answered > 0) answeredRoles += 1;
    console.log(`${role.padEnd(9)} ${answered}/${read.length} 条答上了`
      + (answered === 0 && read.length > 0 ? "   <- 没按契约作答" : ""));
    for (const entry of read) {
      console.log(`  ${entry.criterionKey} ${entry.verdict.padEnd(13)}`
        + `${entry.evidence ?? ""}`.slice(0, 70));
    }
  }

  console.log("\n--- 判定落库了吗（直接读表，不看返回值）---");
  console.log(database.prepare(
    `SELECT role, criterion_key, verdict, blocking_then FROM rubric_assessments
      WHERE change_id = ? AND round = 1 ORDER BY role, criterion_key`,
  ).all(CHANGE));

  console.log("\n--- 闸门看到什么 ---");
  const blockers = gaps.blockers(CHANGE, PHASE);
  for (const blocker of blockers) {
    console.log(`  ${blocker.kind.padEnd(9)} ${blocker.severity ?? "-"}  ${blocker.id}`);
  }
  if (blockers.length === 0) console.log("  (none)");

  console.log("\n--- 判据 ---");
  const stored = database.prepare(
    "SELECT count(*) AS n FROM rubric_assessments WHERE change_id = ?",
  ).get(CHANGE) as { n: number };
  const checks: [string, boolean][] = [
    ["契约进了裁判的提示词", true /* 由 rubric-round.test.ts 离线钉住 */],
    ["三个角色都有 rollout 可读", settled.transcripts.red !== "" && settled.transcripts.blue !== ""],
    ["判定按轮落了库", stored.n === 6],
    ["至少一个角色照契约答上了", answeredRoles > 0],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);

  const pass = checks.every(([, ok]) => ok);
  console.log(pass ? "\nL5-4 通过。" : "\nL5-4 未通过 —— 上面哪条 FAIL 就查哪条。");
  if (!pass && answeredRoles === 0) {
    console.log("全部 not_assessed 意味着模型没按行协议作答。**这是测量结果，不是崩溃**：");
    console.log("fail-closed 的设计让闸门此刻关着，符合预期；要修的是契约的措辞。");
  }

  database.close();
  if (!pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
