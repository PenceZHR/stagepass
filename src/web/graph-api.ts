import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";

import { artifactHome } from "../domain/artifact-home";
import { parseExcludes } from "../graph/code-selection";
import { readFileIngredients, readWorkspaceGraph } from "../graph/read-workspace";
import { ProjectStore } from "../store/project-store";
import type { RepoOps } from "../work/repo";

/**
 * 图谱的三条路（图谱 spec 2026-08-12）：场景、一个文件的配料单、勾选目录。
 *
 * ## 为什么是独立模块 + 注入，不是 panel-server 的三个路由
 *
 * panel-server 的依赖闭包有一条**只许缩**的棘轮（architecture.test.ts 的
 * CLOSURE_RATCHET）：它已经够得着全树九成，图谱一族 import 进去它当场红 ——
 * 而那条护栏红得对，「它正在变成第二个 panel-server —— 拆，别喂」。
 * 所以这里自成一个模块，panel-server 只认一个注入的函数签名（`PanelOptions.graph`），
 * 接线在入口（scripts/panel.ts）—— archive / trust / repo 全是这个形状。
 *
 * **看图谱是只读动作**（「看状态不该有副作用」）：不启动 turn、不碰 Codex、
 * 不推任何闸门 —— 唯一的写是人亲手勾目录那条 POST，写的也只是勾选本身。
 *
 * 错误全是 JSON `{ error }`，fail-loud：路径没填、项目不存在、不是 git 仓库，
 * 每一种都明说，不画空图 —— 空图长得和「路径填错了」一模一样。
 */
export function createGraphApi(input: {
  database: Database.Database;
  repo: RepoOps;
}): (
  url: URL, request: IncomingMessage, response: ServerResponse,
) => Promise<boolean> {
  const trackedFiles = (cwd: string): readonly string[] | null =>
    input.repo.trackedFiles(cwd);

  return async (url, request, response) => {
    if (url.pathname !== "/api/graph" && url.pathname !== "/api/file"
      && url.pathname !== "/api/graph-excludes") {
      return false;   // 不是图谱的路 —— handle() 接着往下走
    }

    const json = (body: unknown, status = 200): void => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
    };
    const fail = (status: number, error: string): void => {
      json({ error }, status);
    };

    const projects = new ProjectStore(input.database);
    const projectId = url.searchParams.get("project") ?? "";
    if (projectId === "") { fail(400, "project-required"); return true; }
    let root: string | null;
    try {
      root = projects.read(projectId).path;
    } catch {
      fail(404, "project-unknown"); return true;
    }
    if (root === null) { fail(409, "no-path"); return true; }
    const excluded = projects.graphExcludes(projectId);

    if (url.pathname === "/api/graph" && request.method === "GET") {
      /*
       * 带 `change=` 就叠 Arch 的图纸（BACKLOG §十一）：读
       * `docs/stagepass/<CHG>/arch.graph.json`、对账、把叠影一起带回。
       * Change 必须真属于这个项目 —— 拿别的项目的 changeId 读不到任何东西。
       */
      const changeId = url.searchParams.get("change");
      let planFile: string | undefined;
      if (changeId !== null && changeId !== "") {
        const owner = input.database.prepare(
          "SELECT project_id FROM changes WHERE id = ?",
        ).get(changeId) as { project_id: string | null } | undefined;
        if (owner === undefined || owner.project_id !== projectId) {
          fail(404, "change-unknown"); return true;
        }
        planFile = `${artifactHome(changeId)}/arch.graph.json`;
      }
      const graph = readWorkspaceGraph({
        root, excluded, trackedFiles,
        ...(planFile === undefined ? {} : { planFile }),
      });
      if (!graph.ok) { fail(409, graph.reason); return true; }
      json(graph.plan === undefined
        ? graph.scene : { ...graph.scene, plan: graph.plan });
      return true;
    }

    if (url.pathname === "/api/file" && request.method === "GET") {
      const wanted = url.searchParams.get("path") ?? "";
      if (wanted === "") { fail(400, "path-required"); return true; }
      const reading = readFileIngredients({
        root, path: wanted, excluded, trackedFiles,
      });
      if (!reading.ok) {
        fail(
          reading.reason === "path-outside" ? 403
            : reading.reason === "not-a-repo" ? 409 : 404,
          reading.reason,
        );
        return true;
      }
      json(reading.ingredients);
      return true;
    }

    if (url.pathname === "/api/graph-excludes" && request.method === "POST") {
      // 解析在 `graph/code-selection.ts` —— `src/web/` 不许出现 JSON.parse
      // （第五条常驻护栏），而「什么样的勾选算数」本来就是判据的一部分。
      const dirs = parseExcludes(await readBody(request));
      if (dirs === null) { fail(400, "bad-excludes"); return true; }
      projects.setGraphExcludes(projectId, dirs);
      json({ excluded: dirs });
      return true;
    }

    fail(404, "unknown-graph-route");
    return true;
  };
}

/** 和 panel-server 里那份同形状 —— 它没导出，而为了 8 行去开一条依赖边不值。 */
function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => { chunks.push(chunk); });
    request.on("end", () => { resolve(Buffer.concat(chunks)); });
    request.on("error", reject);
  });
}
