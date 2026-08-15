/**
 * Start the terminal panel.
 *
 *   pnpm panel [--db <path>] [--change <id>] [--port 4173]
 *
 * Opens StagePass Web with one terminal per phase. Codex runs inside those
 * terminals and draws them itself; the panel moves bytes and routes no
 * decision. Approvals still happen in the selector Codex draws -- it is just in
 * a browser now instead of a Terminal.app window.
 *
 * With no `--db`, a throwaway database is created so the panel can be looked at
 * without touching anything real.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";

import { AppServerClient } from "../src/codex/app-server-client";
import {
  AppServerCodexTransport,
  AppServerSessionHost,
} from "../src/codex/app-server-transport";
import { prepareSchema } from "../src/db/schema";
import { PHASES } from "../src/domain/phase";
import { RUBRIC_ROLES } from "../src/domain/rubric";
import { orphanedStandardKeys, retireStandards } from "../src/domain/rubric-gaps";
import { ChangeStore } from "../src/store/change-store";
import { GapStore } from "../src/store/gap-store";
import { ProjectStore } from "../src/store/project-store";
import { FACTORY_UPGRADE_REASON, RubricStore } from "../src/store/rubric-store";
import { createRepoOps } from "../src/work/repo";
import { recoverStuckTurns } from "../src/work/turn-loop";
import { createGraphApi } from "../src/web/graph-api";
import { createPanelServer, type PanelSessions } from "../src/web/panel-server";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(argument("port") ?? 4173);

/**
 * 模型和思考预算，命令行说了算。
 *
 * `--model gpt-5-codex --effort xhigh`。两个都不给就是「默认模型 + xhigh」。
 *
 * **不校验模型名**：能用哪些是 Codex 那边的事，在这里维护一张白名单，只会在它加了
 * 新模型的那天挡住人。写错了 Codex 会自己报，而那句报错比这里能给的准。
 */
const model = argument("model");
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const asked = argument("effort") ?? "xhigh";
if (!(EFFORTS as readonly string[]).includes(asked)) {
  console.error(`--effort 只能是 ${EFFORTS.join(" / ")}，收到的是「${asked}」`);
  process.exit(1);
}
const effort = asked as typeof EFFORTS[number];

/**
 * 两个截止时间，命令行说了算。单位是分钟。
 *
 * `--ask-timeout 45 --turn-timeout 60`。不给就是出厂值（15 / 30 分钟）。
 *
 * **为什么要能调大。** 出厂那 15 分钟是从「提示词打进会话」起算的，而人要答上话，
 * 中间还隔着一道 StagePass 看不见的门：`-a on-request` 之下，每个会话第一次调
 * stagepass 工具，Codex 会先弹自己的许可提示（`Allow the stagepass MCP server to
 * run tool "stagepass_ask"?`）。2026-08-03 实测，一次录需求就这么废掉了 ——
 * 人的 15 分钟被那道门吃掉一截，表单还没露面就到点了，`sessions.close()` 一执行，
 * 终端当场消失，而现场看到的只是「点了没反应 / 自己跳没了」。
 *
 * 病根是「问人的预算里混进了一段不属于人的等待」，那要另外治（见交接）。这里做的
 * 是把旋钮交出来：**验收的时候人就在键盘前，没有理由让他跟秒表赛跑。**
 */
/**
 * **两条路都要乘 60000。** 缺席那一支原来直接把「15」当毫秒返回了 —— 于是不带
 * 参数启动时，问人的截止时间是 15 **毫秒**，每一次问人都会瞬间超时并把会话关掉。
 *
 * 2026-08-03 引入、当天被启动横幅抓住（它打出 `问人 0.00025 分钟`）。那行横幅
 * 加进来的理由是「人得先知道有这么个东西」，而它先抓住的是写它的人。
 */
const minutes = (name: string, fallbackMinutes: number): number => {
  const raw = argument(name);
  if (raw === undefined) return fallbackMinutes * 60_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} 要一个正数（分钟），收到的是「${raw}」`);
    process.exit(1);
  }
  return value * 60_000;
};
const askTimeoutMs = minutes("ask-timeout", 15);
// 180：Arch 按新模板（九节 + 图纸）一轮实测 3.5 小时，30 分钟把活轮判死了
// （2026-08-12 真机）。用户拍：全部统一 180。
const turnTimeoutMs = minutes("turn-timeout", 180);

/**
 * 跑几轮之后开始把收敛数据摊给人看。默认 5。
 *
 * **不是硬上限**：「再来一轮」仍然提供，只是从这一轮起，裁决那张表会告诉他这个阶段
 * 一共提过几条问题、现在还开着几条 —— 每轮关掉几条也会新开几条，纯靠轮次清不了零，
 * 而人在按按钮之前有权知道这件事。停不停仍然是他的决定（用户 2026-08-03）。
 */
const roundBudget = (() => {
  const raw = argument("round-budget");
  if (raw === undefined) return 5;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--round-budget 要一个 ≥1 的整数，收到的是「${raw}」`);
    process.exit(1);
  }
  return value;
})();

const changeId = argument("change") ?? "CHG-1";
const dbPath = argument("db")
  ?? join(mkdtempSync(join(tmpdir(), "stagepass-panel-")), "ship.db");

const database = new Database(dbPath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
/*
 * 建表 + 迁移，**顺序由 `prepareSchema` 定死**（先拉平旧形状，再补齐新东西）。
 *
 * 这里原来是 `exec(SCHEMA_SQL)` 紧跟 `migrate(database)` 两句 —— 2026-08-06
 * 真机上炸了：旧库的 `change_bindings` 还没有 `kind` 列，而 SCHEMA_SQL 里的
 * 部分索引引用它，面板起不来。顺序挪进那个函数里，这里就没有可排错的东西。
 */
prepareSchema(database);

/*
 * 收拾上一次进程死掉时留下的活。**这是 L1 崩溃恢复的生产调用者。**
 *
 * 在它之前一个都没有：`JobStore.recover` 写好了、离线证过，但没人调。于是
 * 2026-07-30 实测到它本该防住的那件事 —— 面板被杀掉，库里留下一个 `running` 的
 * Change，而 `running` 只允许 `settle` / `fail`，两个都不是人能裁决的动作，
 * 那个 Change 就**永远动不了了**（所有按钮全灰）。
 *
 * 放在建表之后、起服务之前：恢复要在任何人看见这个库之前做完，否则第一眼看到的是
 * 一个假的「在跑」。
 */
const recovered = recoverStuckTurns(database, Date.now());

// One project for the workspace Codex runs in, so the first column has
// something real to show. `ensure` is idempotent, so restarting is safe.
const projectId = argument("project") ?? "PRJ-001";
/*
 * 默认项目**必须带上路径**，因为 Codex 就跑在项目的目录里（2026-07-30 起）。
 *
 * 不给的话就是这个进程的 cwd —— 也就是过去那个隐式行为，只是现在它被明确写进库里，
 * 而不是藏在服务端一个定死的 cwd 里。区别是：现在你在界面上能看见它跑在哪，别的
 * 项目也不会被悄悄指到这儿来。
 */
const project = new ProjectStore(database).ensure(
  projectId,
  argument("project-name") ?? basename(process.cwd()),
  argument("project-path") ?? process.cwd(),
);

/*
 * 出厂标准：**起面板时补空缺 + 把机器写的那些升到最新版**。
 *
 * ## 为什么升级在这儿，而不是界面上一个按钮
 *
 * 原来是「标准」页签里一个「把出厂标准升到最新版」的按钮。用户 2026-08-06：
 * 「页面不要带升级到最新版，就直接后台升级就行了。」—— 判据也站得住：升级不是
 * 一个决定，它只是把**没有人碰过的那些**跟上代码，人在界面上没有可选的东西。
 *
 * ## 它碰不到人改过的
 *
 * 判据是 `rubrics.reason` 上那个标记（`FACTORY_UPGRADE_REASON`）加上「还是第 1 版」。
 * 人自己保存的那一版，理由要么是他写的话、要么是 null，两种都对不上。
 *
 * ## 跳过的照样要说出来
 *
 * 后台做不等于闷声做。跳过的逐条打到面板的 stdout —— 人得知道他那份为什么没跟着变，
 * 而这是他唯一会看到它的地方。
 */
const rubrics = new RubricStore(database);
const gaps = new GapStore(database);
const changeIndex = new ChangeStore(database);
for (const each of new ProjectStore(database).list()) {
  rubrics.installDefaults(each.id);
  const upgraded = rubrics.upgradeDefaults(each.id);
  if (upgraded.upgraded.length > 0) {
    console.log(`[rubric] ${each.id} 升了 ${upgraded.upgraded.length} 份：${
      upgraded.upgraded.join("、")}`);
  }
  for (const skip of upgraded.skipped) {
    console.log(`[rubric] ${each.id} ${skip.scope} 没升 —— ${skip.why}`);
  }
  /*
   * **对账：标准已经不在名单上的阻断项，退休掉。**
   *
   * 和人手动改标准那条路（`app/edit-rubric.ts`）同一条规则，但判据不同：那儿是
   * 事件驱动（这次编辑撤下了谁），这儿是**状态驱动**（现在开着的，标准还在不在）。
   *
   * 两条都要，因为事件会漏 —— 2026-08-10 真机：两条孤儿是**上一次**升级留下的，
   * 而这一次启动没有升级发生（rubric 已是最新），事件驱动那条一次也走不到它们
   * 身上。代价是那两条谁也关不掉：标准没了，反方不会再判它；红方又不可能满足
   * 一条已退休的要求（「TestPlan 必须通过」留在 Build 上，而任务书禁止 Build
   * 碰测试）—— 它就永远挡着闸门。
   *
   * 幂等：退休过的不再是 open，下一次对账看不见它。
   */
  for (const change of changeIndex.list(each.id)) {
    for (const phase of PHASES) {
      for (const role of RUBRIC_ROLES) {
        const live = rubrics.effective(each.id, change.id, phase, role);
        if (live === null) continue;
        const before = gaps.all(change.id, phase);
        const orphans = orphanedStandardKeys(
          before, role, live.criteria.map((entry) => entry.key));
        if (orphans.length === 0) continue;
        gaps.replace(change.id, phase, retireStandards(
          before, role, orphans, FACTORY_UPGRADE_REASON));
        for (const key of orphans) {
          const gap = before.find((each2) => each2.id === `RB:${role}:${key}`);
          console.log(`[rubric] ${change.id}/${phase} 退休了一条阻断项（标准已不在名单上）：${
            (gap?.title ?? key).slice(0, 44)}`);
        }
      }
    }
  }
}

/*
 * 演示 Change 只在两种情况下种：**明确用 `--change` 要了**，或者**库里一条 Change
 * 都没有**（第一次打开，总得有东西可看）。
 *
 * 原来是「默认 id 不存在就种」—— 于是对着一个已经有 CHG-001/002/003 的真库启动，
 * 会静默多出一条谁也没要的 `CHG-1`（2026-08-02 在用户真库里实际发生了）。账本
 * append-only、删除路径还不存在，种错一条就删不掉 —— 所以宁可不种。
 */
const changes = new ChangeStore(database);
const anyChange = database.prepare("SELECT 1 FROM changes LIMIT 1").get();
if (
  !database.prepare("SELECT 1 FROM changes WHERE id = ?").get(changeId)
  && (argument("change") !== undefined || anyChange === undefined)
) {
  changes.create(changeId, {
    projectId: project.id,
    title: argument("title") ?? changeId,
  });
}

/*
 * git 那一层建在这里、两处共用：pty 会话（提交产出）和图谱（ls-files）拿到的
 * 必须是同一套 —— 两套各自 exec git 不会错，但「哪条路走的哪个 git」就说不清了。
 */
const repo = createRepoOps();

/*
 * 这条分支的 Codex 运行时只有这一份 App Server 进程。所有阶段 thread 都复用它，
 * 反向的审批/elicitation 再按 threadId 路由回各自 session；绝不为每一轮另起 TUI。
 */
let appServerHost: AppServerSessionHost | null = null;
const appServerClient = AppServerClient.spawn({
  command: "codex",
  args: ["app-server", "--listen", "stdio://"],
  cwd: process.cwd(),
  env: process.env,
  onNotification: () => {},
  onServerRequest: (request) => appServerHost === null
    ? Promise.reject(new Error("app-server session host is not ready"))
    : appServerHost.handleServerRequest(request),
  onStderr: (message) => {
    if (message !== "") console.error(`[app-server] ${message}`);
  },
});
appServerHost = new AppServerSessionHost(appServerClient);
await appServerClient.initialize();

const { server, sessions } = createPanelServer({
  database,
  askTimeoutMs,
  turnTimeoutMs,
  roundBudget,
  repo,
  /*
   * 图谱的三条路（spec 2026-08-12）。在入口接线而不是让 panel-server 自己
   * import —— 它的依赖闭包有一条只许缩的棘轮，理由写在 PanelOptions.graph 上。
   */
  graph: createGraphApi({ database, repo }),
  appServerTransport: ({ cwd, config, timeoutMs }) =>
    new AppServerCodexTransport(appServerHost!, {
      cwd,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      effort,
      config,
      ...(model === undefined ? {} : { model }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  session: {
    // Where Codex runs. The repository itself, because a phase's work is about
    // this tree -- unlike the probes, which use an empty directory on purpose.
    cwd: process.cwd(),
    /*
     * `workspace-write`, not `read-only` (PRD §6.6, 2026-07-29 更正).
     *
     * 每个阶段的活儿都要产出文件 —— 设计阶段产文档，Build/Fix 产代码。read-only
     * 的定义就是模型不能写，于是它想写就**必然**要升级审批，整个 turn 停在那儿
     * 等人按 Enter：实测二十分钟 rollout 一个字节没长，没有报错、没有任何迹象。
     *
     * `pnpm probe:sandbox` 是这条的判据：同一提示词、同一 `-a on-request`，只变
     * `-s`，turn 跑起来后一个键都不按 —— read-only 等满 150s 没写成，
     * workspace-write 26.1s 写成了且没弹过任何审批。
     *
     * **代价是真的**：这样 Codex 能改工作区里的任何文件，包括源码。"设计阶段不
     * 碰代码"从此不由沙箱保证，只是个约定。工作区外的写和网络仍然要升级审批。
     *
     * 别为了"更安全"把它改回 read-only —— 那不是更安全，那是让每个 turn 都卡住。
     */
    sandbox: "workspace-write",
    // `never` 会让 Codex 自动 decline 掉 elicitation，而那是唯一的问人通道
    // （PRD §6.6）。类型上已经不可表达，这里写出来是为了让人别去找那个值。
    approval: "on-request",
    /*
     * **默认 xhigh，可以用 `--effort` 调低。**
     *
     * 原来写死 `low`，而且是写死在这个脚本里 —— 面板上看不见、命令行也改不了。
     * 用户 2026-08-03：「默认的模型是 so low，但是我要的是 so ultra high。」
     *
     * 默认往高了取，是因为这套东西的产出要被人当依据用：一轮对抗几分钟起步，
     * 省那点思考预算换回一份判得更浅的结论，不划算。要省的人显式降。
     */
    reasoningEffort: effort,
    /*
     * **不给就不传 `-m`**，让 Codex 用它自己的默认 —— 在这里写死一个模型名，
     * 等于把「哪个模型可用」这件事冻结在这个脚本里，而它变得比这个仓库快。
     */
    ...(model === undefined ? {} : { model }),
  },
});

// Codex 的状态事实已经能判定时，先把悬空 binding 收掉，再让任何 HTTP 请求进来。
// unavailable 只报告，不写库；真正 archived 的线程留到用户打开时再解开。
const bindingRecovery = sessions.reconcileBindings();

let stopping = false;
const stop = async (registry: PanelSessions): Promise<void> => {
  if (stopping) return;
  stopping = true;
  registry.closeAll();
  appServerHost?.closeAll();
  server.close();
  await appServerClient.close(1_000);
  database.close();
  process.exit(0);
};
process.on("SIGINT", () => { void stop(sessions); });
process.on("SIGTERM", () => { void stop(sessions); });

/*
 * **只绑回环。**（BACKLOG §3.4「面板无鉴权 0 处」的那一半）
 *
 * `listen(port)` 不给 host 时 Node 绑的是**所有网卡** —— 而这个面板零鉴权，
 * 它能派轮、能改 rubric、能删 Change、能把字节写进一个跑着 Codex 的 pty。
 * 同一个咖啡馆 wifi 里的任何人都够得着，共用一个真库之后这件事更值钱。
 *
 * 鉴权本身没做（也不该急着做：用户数 1 是设计不是缺陷，§1.1）。但「不做鉴权」
 * 和「向全世界开放」是两件事 —— 前者可以接受，后者不行。绑回环把攻击面从
 * 「一个网段」缩到「这台机器上的进程」，而那正是这个产品的实际使用面。
 */
server.listen(port, "127.0.0.1", () => {
  console.log(`面板   http://localhost:${port}/?change=${encodeURIComponent(changeId)}`);
  console.log(`数据库 ${dbPath}`);
  for (const binding of bindingRecovery.detached) {
    const seat = binding.kind === "round" ? binding.phase : "aside";
    console.log(
      `Session 恢复   ${binding.changeId}/${seat} ${binding.threadId}`
      + " —— missing，已 detached；下次打开会 fresh",
    );
  }
  for (const item of bindingRecovery.unavailable) {
    const seat = item.binding.kind === "round" ? item.binding.phase : "aside";
    console.log(
      `Session 恢复   ${item.binding.changeId}/${seat} ${item.binding.threadId}`
      + ` —— unavailable，binding 保留：${item.reason}`,
    );
  }
  // 恢复要说出来。静默恢复和「什么都没发生」在屏幕上一模一样，而它刚刚把一个
  // Change 从「在跑」改成了「上一轮失败了」—— 那是人需要知道的事。
  if (recovered.failed.length > 0 || recovered.resumed.length > 0) {
    console.log(`恢复   上次死掉时留下的活：`
      + `${recovered.failed.length} 个判为失败（可以 retry），`
      + `${recovered.resumed.length} 个重新排队`);
    for (const each of recovered.failed) console.log(`       ${each.id} —— ${each.reason}`);
  }
  // 第二档也要说出来（2026-08-05 启动收掉 CHG-001 时这里还没有这一句，账本动了
  // 而屏幕没说 —— 正是这套东西要防的那类）。
  if (recovered.stranded.length > 0) {
    console.log(`恢复   running 却没有任何活儿的 Change，收回 blocked（可以 retry）：`
      + recovered.stranded.join("、"));
  }
  // 升级前批的整轮长租约（180 分钟）被按现行短 TTL 重新计时 —— 上一个面板真死了
  // 的话，几分钟内收尸人就会收它，而不是等满 3 小时。
  if (recovered.clamped.length > 0) {
    console.log(`恢复   ${recovered.clamped.length} 份超长租约按现行 TTL 重新计时：`
      + recovered.clamped.join("、"));
  }
  // 出厂标准的补/升在建库那一段就做完了，逐条打过 —— 这里不再复述一遍。
  // 截止时间要说出来。到点之后 StagePass 会把会话关掉，而那在屏幕上是「终端自己
  // 没了」—— 人得先知道有这么个东西，才可能把它和自己刚才的等待对上。
  console.log(`截止   问人 ${askTimeoutMs / 60_000} 分钟 · 一轮 ${turnTimeoutMs / 60_000} 分钟`);
  console.log(`轮次   跑满 ${roundBudget} 轮之后，裁决表会告诉你它到底在不在收敛`);
  console.log("\n每个阶段一个终端。**看一眼不会起进程** —— 要一个按「开一个终端」。");
  console.log("Ctrl-C 结束。");
});
