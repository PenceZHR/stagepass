import { handleAction, type ActionDeps } from "../plugin/actions";
import { handleApi, type ApiDeps } from "../plugin/api";

/**
 * 浏览器那一面的请求边界。
 *
 * ## 为什么它回来了
 *
 * 2026-08-19 定案（[[stagepass-no-execution-channel]]）：状态流转回到 WebUI。
 * 一夜六种事故全部出在 widget 那层实验性的壳上 —— 生命周期不归我们（Codex 想重启
 * MCP 进程就重启）、沙箱是草案（全局只读、不许导航、~700px、外部源全封）、卡片不是
 * 窗口（宿主重画一次就点不动）。而浏览器里这些一条都不成立：F5 能恢复、有 DevTools、
 * 宽度是真面板宽度。
 *
 * **同一份界面开在三个地方**：Codex 的 in-app browser、Claude Code 的 Browser pane、
 * 普通浏览器。三处共用这一个后端。
 *
 * ## 这不是把 08-18 那条定案倒回去
 *
 * 当时退休网页端的理由是 `panel-server.ts` 2177 行、`handle()` 484 行、终端座位那坨
 * —— 那些 08-18 已经删干净了。回来的是**一层薄壳**：这个文件只做分发，一条判据都
 * 不拿主意，全在 `api.ts` / `actions.ts` 里，和插件用的是同一份。
 */

export interface ServeDeps {
  /** 只读那半边。看一眼在物理上就不可能写坏什么。 */
  readonly read: ApiDeps;
  /**
   * 会写那半边 —— **要写的时候才叫**。
   *
   * 开可写句柄会顺手跑迁移；一个只是打开页面看看的人不该在库上留下任何痕迹。
   * 所以这里收的是个工厂，不是现成的句柄。
   */
  readonly write: () => ActionDeps;
}

export interface ServeAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 一条请求该怎么答。
 *
 * **按方法分岔，不按路径猜** —— 同一条 `/api/rubric` 既能读也能写，路径分不出来。
 * 这和插件那边 `sp_api` 的分岔是同一条规矩（widget 把 method 一起送上来）。
 */
export async function serveRequest(
  method: string,
  path: string,
  body: string,
  deps: ServeDeps,
): Promise<ServeAnswer> {
  const verb = method.toUpperCase();
  if (verb === "GET") return handleApi(path, deps.read);
  if (verb === "POST") {
    const [pathname = "", query = ""] = path.split("?");
    return handleAction(pathname, new URLSearchParams(query), body, deps.write());
  }
  /*
   * **方法不认识要说出来。** 浏览器的 `fetch` 默认发 GET，写操作全靠显式
   * `method: "POST"` —— 写错时静默按 GET 处理，一次「跑这个阶段」会变成一次
   * 「读面板」：按钮按下去，屏幕上什么都不动，而两边的日志都显示一切正常。
   */
  return {
    status: 405,
    body: {
      error: "method_not_allowed",
      method: verb,
      path,
      reason: "这条路只认 GET（读）和 POST（写）。写操作要显式带 method: \"POST\"。",
    },
  };
}
