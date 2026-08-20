import { isPhase } from "../domain/phase";
import { NoteStore } from "../store/note-store";
import type { ApiDeps, ApiResponse } from "./api";
import { briefFor } from "./brief-route";

/**
 * 题面和产物那两条只读路。
 *
 * **单独一个模块，只为让 `api.ts` 能动态 import 它** —— 和 `repo-routes.ts` 同一个
 * 理由：它们要拖进 RubricStore / NoteStore / ProjectStore 一整串，急加载会把 `api.ts`
 * 的依赖闭包顶到全树的七成，而那条护栏说「它正在变成第二个 panel-server，拆，别喂」。
 */
export function handleBriefRoute(
  pathname: string,
  params: URLSearchParams,
  deps: ApiDeps,
): ApiResponse {
  if (pathname === "/api/phase-brief") {
    const asked = params.get("role");
    // 模型来拿必须报目录；面板自己看不带（它就是这个工作台）。
    return {
      status: 200,
      body: briefFor(deps, asked === "blue" ? "blue" : "producer", params.get("cwd") ?? ""),
    };
  }

  const asked = params.get("phase");
  const brief = briefFor(deps, "producer", undefined,
    asked !== null && isPhase(asked) ? asked : undefined);
  // 拒的那一支现在也带着 `opening`（见 BriefRefused）—— 原样透出去，界面自己会画。
  if (!brief.ok) return { status: 200, body: brief };
  const notes = new NoteStore(deps.database).list(brief.changeId, brief.phase);
  return {
    status: 200,
    body: {
      ...brief,
      notes,
      /*
       * 第一道闸：**代码判得出来的那两条**。第二道（人点头）不在这儿 ——
       * 这一层只说「形式齐没齐」，齐不齐之外的事一个字都不判。
       */
      formGate: {
        missing: brief.missing,
        unanswered: notes.filter((note) => note.respondedAt === null).map((n) => n.id),
        green: brief.missing.length === 0 && notes.every((n) => n.respondedAt !== null),
      },
    },
  };
}
