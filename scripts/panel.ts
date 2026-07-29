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
    sandbox: "read-only",
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
