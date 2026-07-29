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

import { SCHEMA_SQL } from "../src/db/schema";
import { ChangeStore } from "../src/store/change-store";
import { ProjectStore } from "../src/store/project-store";
import { createPanelServer, type PanelSessions } from "../src/web/panel-server";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(argument("port") ?? 4173);
const changeId = argument("change") ?? "CHG-1";
const dbPath = argument("db")
  ?? join(mkdtempSync(join(tmpdir(), "stagepass-panel-")), "ship.db");

const database = new Database(dbPath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(SCHEMA_SQL);

// One project for the workspace Codex runs in, so the first column has
// something real to show. `ensure` is idempotent, so restarting is safe.
const projectId = argument("project") ?? "PRJ-001";
const project = new ProjectStore(database).ensure(
  projectId, argument("project-name") ?? basename(process.cwd()),
);

const changes = new ChangeStore(database);
if (!database.prepare("SELECT 1 FROM changes WHERE id = ?").get(changeId)) {
  changes.create(changeId, {
    projectId: project.id,
    title: argument("title") ?? changeId,
  });
}

const { server, sessions } = createPanelServer({
  database,
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
    reasoningEffort: "low",
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
  console.log("\n每个阶段一个终端。点开一个 tab 就在那个阶段的线程里起一个 Codex。");
  console.log("Ctrl-C 结束。");
});
