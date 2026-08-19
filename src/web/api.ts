import { realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type Database from "better-sqlite3";

import { rubricFor } from "../app/edit-rubric";
import { isPhase } from "../domain/phase";
import type { AppServerHistory } from "../codex/app-server-history";
import { progressView, type LiveSessions } from "../web/panel-view";
import { EvidenceStore } from "../store/evidence-store";
import { ParallelStore } from "../store/parallel-store";
import { ProjectStore } from "../store/project-store";
import { ChangeStore } from "../store/change-store";
import { looksLikeSha, type RepoOps } from "../work/repo";
import { panelPayload } from "./panel-data";

/**
 * 插件那一面的数据口。
 *
 * ## 它替掉的是什么
 *
 * 网页端退休之前，widget 的 `fetch("/api/…")` 是被改道到 `callTool("sp_api")`、再由
 * MCP server 代理到面板的 HTTP 服务（`127.0.0.1:4173`）上的。那条链现在整条拆掉 ——
 * **插件自己读库**，不需要任何进程在后面跑着。
 *
 * ## 三种回答，没有第四种
 *
 * 界面代码一个字都没改，它还是那些 `fetch("/api/…")`。所以这一层必须对每条路径给
 * 一个明确的回答：
 *
 * - **能读**：从库里读出来，和面板给的是同一份（调的就是同一个 `panelView`）。
 * - **读不到**：`404`，界面本来就会处理（比如 Change 不在库里）。
 * - **这儿没有**：`501` + `not_wired_yet` + 路径 + **一句人话**。让它静默失败，人会
 *   以为「点了没反应是 bug」；明着说一句，人至少知道自己在等什么。
 */

/**
 * 进度要问的两样：座位活着吗、绑的线程读得到吗。
 *
 * 故意是结构类型而不是 `PluginSeats` / `AppServerHistory`：这一层是只读的那一半，
 * 它**不该拿得到派轮的能力**。给它一个只能问不能起的窄面，测试也能塞假的进来。
 */
export interface ProgressSources {
  readonly sessions: LiveSessions;
  readonly history: Pick<AppServerHistory, "readThread">;
}

export interface ApiDeps {
  readonly database: Database.Database;
  /** 图谱那两条路要问 git 「这个仓库跟踪了哪些文件」。 */
  readonly repo: RepoOps;
  /**
   * 现在有没有一条活着的控制连接。**没起过就是 `null`，这里绝不去起**
   * —— 看一眼不该在机器上留下一个 daemon（用户的界面原则：看状态不该有副作用）。
   *
   * 不给 = 当作没有。那不是「不知道」而是事实：daemon 是插件进程的孩子，
   * 它不在，StagePass 派出去的那一轮就真的没了。
   */
  readonly live?: () => ProgressSources | null;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 要读仓库（因而要 TypeScript 编译器）的那四条。见 `repo-routes.ts` 的开头。 */
const REPO_ROUTES = new Set(["/api/stage-artifacts", "/api/stage-file", "/api/graph", "/api/file"]);

/** 只读的路径 —— 看状态不该有副作用，所以这一层只认 GET。 */
export async function handleApi(path: string, deps: ApiDeps): Promise<ApiResponse> {
  const [pathname = "", query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const changeId = params.get("change") ?? "";

  if (pathname === "/api/panel") {
    return {
      status: 200,
      body: panelPayload({
        database: deps.database,
        changeId,
        askedProject: params.get("project"),
      }),
    };
  }

  if (pathname === "/api/parallel") {
    return { status: 200, body: { seats: new ParallelStore(deps.database).list(changeId) } };
  }

  if (pathname === "/api/rubric") {
    const phase = params.get("phase") ?? "";
    if (!isPhase(phase)) return { status: 400, body: { error: "phase-invalid" } };
    const outcome = rubricFor({ database: deps.database, changeId, phase });
    if (outcome.kind === "no_such_change") {
      return { status: 404, body: { error: "no-such-change" } };
    }
    return { status: 200, body: { roles: outcome.roles } };
  }

  if (pathname === "/api/artifact") return artifact(params, deps);

  if (pathname === "/api/progress") return progress(changeId, deps);

  /*
   * 产物和图谱 —— **唯一一处动态 import**。
   *
   * 它们要真解析 import，因而要 TypeScript 编译器。实测急切加载让插件启动从 110ms
   * 变成 ~200ms、堆多 21MB，而绝大多数会话根本不看这两屏。所以编译器跟着这一行
   * 才进内存，第二次起是 0。
   */
  if (REPO_ROUTES.has(pathname)) {
    const { handleRepoRoute } = await import("./repo-routes");
    return handleRepoRoute(pathname, params, deps);
  }

  /*
   * 剩下的两类，对界面来说要长得一样：一个说得出「为什么现在没有」的回答。
   *
   * 一是 `/api/terminal/*` 这种**插件里没有对应物**的路（旧面板的终端门户，
   * 前端已经不再要了）；二是会改库的那些 —— 那些走 `actions.ts`，到这儿来
   * 说明界面把方法用错了。
   */
  return {
    status: 501,
    body: {
      error: "not_wired_yet",
      path: pathname,
      /*
       * **`reason` 是给人看的那一句，不能省。**
       *
       * 面板每一处失败都写成 `没问成：${result.reason}` / `没跑成：${result.reason}`。
       * 少这个字段，屏幕上出现的是「没问成：undefined」—— 2026-08-18 用户点了
       * 「请 Codex 问我」，看到的就是它，读起来和「坏了」一模一样，所以他报的是
       * 「没反应」。回一个 501 不等于把话说清楚了；**话是这个字段说的。**
       */
      reason: "插件里没有这条路。它要么是旧面板才有的（终端门户），"
        + "要么该用 POST 走动作那一侧。",
    },
  };
}

/** 一份产出的正文。**上限 2MB** —— 超了要说「太大」，不是把浏览器噎住。 */
const ARTIFACT_MAX_BYTES = 2_000_000;

/**
 * 读一份这个阶段**报出来过**的产出。
 *
 * 两道闸，缺一不可：
 *
 * 1. **必须在 `artifactIds` 里** —— 不是这个阶段报出来的东西，不猜、不去别处找。
 * 2. **必须在项目目录里** —— realpath 之后比前缀，挡掉软链和 `../`。
 *
 * 「读不到」要说出**为什么**读不到：一个空白的正文框和「这份产出不见了」是两件
 * 完全不同的事。
 */
function artifact(params: URLSearchParams, deps: ApiDeps): ApiResponse {
  const changeId = params.get("change") ?? "";
  const phase = params.get("phase") ?? "";
  const wanted = params.get("id") ?? "";
  if (!isPhase(phase)) return { status: 404, body: { error: "no_such_phase" } };

  const listed = new EvidenceStore(deps.database).read(changeId, phase).artifactIds;
  if (!listed.includes(wanted)) {
    return { status: 200, body: { path: wanted, readable: false, reason: "not_produced_here" } };
  }
  const root = projectRoot(deps.database, changeId);
  if (root === null) {
    return { status: 200, body: { path: wanted, readable: false, reason: "project_has_no_path" } };
  }

  /*
   * 产出可以是一个 commit（Build 走这条）。判据是**这一格长得像不像 sha**，
   * 不是「这是不是 Build 阶段」—— 按阶段猜错的那天，commit 会被当成路径去磁盘上找，
   * 回来一句「这份产出不见了」。
   */
  if (looksLikeSha(wanted)) {
    const shown = deps.repo.show(root, wanted);
    return shown === null
      ? { status: 200, body: { path: wanted, readable: false, reason: "gone", kind: "commit" } }
      : { status: 200, body: { path: wanted, readable: true, kind: "commit", bytes: shown.length, text: shown } };
  }

  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(isAbsolute(wanted) ? wanted : join(realRoot, wanted));
  } catch {
    return { status: 200, body: { path: wanted, readable: false, reason: "gone" } };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { status: 200, body: { path: wanted, readable: false, reason: "outside_project" } };
  }
  if (!statSync(real).isFile()) {
    return { status: 200, body: { path: wanted, readable: false, reason: "not_a_file" } };
  }
  const bytes = statSync(real).size;
  if (bytes > ARTIFACT_MAX_BYTES) {
    return { status: 200, body: { path: wanted, readable: false, reason: "too_big", bytes } };
  }
  return { status: 200, body: { path: wanted, readable: true, bytes, text: readFileSync(real, "utf-8") } };
}

/** 这个 Change 的代码在哪。没有项目、或者项目没路径，都算「没有」。 */
/**
 * 一轮跑到哪了。界面在跑的时候每隔几秒问一次。
 *
 * 判据一个字都不在这里 —— 全在 `progressView`（面板用的是同一个）。这里只做两件事：
 * 把「现在有没有活着的控制连接」翻成它要的两个接口，和把「没有这个 Change」翻成 404。
 *
 * ## 没有连接时报的不是「不知道」，是「没了」
 *
 * daemon 是插件进程的孩子。插件重启，它跟着没；而库里那条 `running` 还挂着。
 * 这时 `live=false` → `processGone=true` **是事实，不是降级** —— 那一格正是为这种
 * 死法存在的：不然界面会一直显示「在跑」，一路显示到 30 分钟超时。
 *
 * 读不出线程时 `stage` 给 `null`，界面照实说「还看不出走到哪一步」。**不编一个阶段名**。
 */
async function progress(changeId: string, deps: ApiDeps): Promise<ApiResponse> {
  const live = deps.live?.() ?? null;
  const view = await progressView({
    database: deps.database,
    sessions: live?.sessions ?? { has: () => false, quietForMs: () => null },
    history: live?.history ?? { readThread: async () => null },
    changeId,
  });
  return view === null
    ? { status: 404, body: { error: "no_such_change" } }
    : { status: 200, body: view };
}

function projectRoot(database: Database.Database, changeId: string): string | null {
  try {
    const change = new ChangeStore(database).read(changeId);
    if (change.projectId === null) return null;
    const path = new ProjectStore(database).read(change.projectId).path;
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

