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

import { SCHEMA_SQL, migrate } from "../src/db/schema";
import { ChangeStore } from "../src/store/change-store";
import { ProjectStore } from "../src/store/project-store";
import { RubricStore } from "../src/store/rubric-store";
import { recoverStuckTurns } from "../src/work/turn-loop";
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
const turnTimeoutMs = minutes("turn-timeout", 30);

const changeId = argument("change") ?? "CHG-1";
const dbPath = argument("db")
  ?? join(mkdtempSync(join(tmpdir(), "stagepass-panel-")), "ship.db");

const database = new Database(dbPath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(SCHEMA_SQL);
// 旧库补列。SCHEMA_SQL 只会建新表，不会给已存在的表加列 —— 见 migrate 的注释。
migrate(database);

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

// 出厂标准：只补空缺，人改过的一个字都不碰，所以每次启动都调是安全的。
// 全部不阻断 —— 它们是给人一个起点去读、去改、去决定哪几条值得挡，
// 不是替他做那个决定（domain/rubric-defaults.ts）。
const installed = new RubricStore(database).installDefaults(project.id);

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

const { server, sessions } = createPanelServer({
  database,
  askTimeoutMs,
  turnTimeoutMs,
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

const stop = (registry: PanelSessions): void => {
  registry.closeAll();
  server.close();
  database.close();
  process.exit(0);
};
process.on("SIGINT", () => { stop(sessions); });
process.on("SIGTERM", () => { stop(sessions); });

server.listen(port, () => {
  console.log(`面板   http://localhost:${port}/?change=${encodeURIComponent(changeId)}`);
  console.log(`数据库 ${dbPath}`);
  // 恢复要说出来。静默恢复和「什么都没发生」在屏幕上一模一样，而它刚刚把一个
  // Change 从「在跑」改成了「上一轮失败了」—— 那是人需要知道的事。
  if (recovered.failed.length > 0 || recovered.resumed.length > 0) {
    console.log(`恢复   上次死掉时留下的活：`
      + `${recovered.failed.length} 个判为失败（可以 retry），`
      + `${recovered.resumed.length} 个重新排队`);
    for (const each of recovered.failed) console.log(`       ${each.id} —— ${each.reason}`);
  }
  if (installed > 0) console.log(`出厂标准 补了 ${installed} 份（全部不阻断）`);
  // 截止时间要说出来。到点之后 StagePass 会把会话关掉，而那在屏幕上是「终端自己
  // 没了」—— 人得先知道有这么个东西，才可能把它和自己刚才的等待对上。
  console.log(`截止   问人 ${askTimeoutMs / 60_000} 分钟 · 一轮 ${turnTimeoutMs / 60_000} 分钟`);
  console.log("\n每个阶段一个终端。点开一个 tab 就在那个阶段的线程里起一个 Codex。");
  console.log("Ctrl-C 结束。");
});
