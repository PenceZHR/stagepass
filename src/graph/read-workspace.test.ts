import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readFileIngredients, readWorkspaceGraph } from "./read-workspace";

/**
 * 这一份是补回来的。
 *
 * 它原来的覆盖挂在 `web/graph-api.ts` 的测试里 —— 2026-08-18 网页端退休、那层 HTTP
 * 壳被删掉时，覆盖跟着一起没了，而**逻辑还在**。整个 `graph/` 里只有这一个模块没有
 * 自己的测试，就是这么来的：它的判据一直寄居在别人家里。
 *
 * 两个 git 相关的入口都注入（`trackedFiles` / `readFile`），所以这一组不碰真仓库、
 * 不跑 git、也不需要任何目录存在。
 */

const CODE = new Map<string, string>([
  ["src/a.ts", "import { b } from \"./b\";\nexport const a = b;\n"],
  ["src/b.ts", "export const b = 1;\n"],
]);

function fakeWorkspace(files: ReadonlyMap<string, string> = CODE) {
  return {
    root: "/repo",
    excluded: [] as readonly string[],
    trackedFiles: (): readonly string[] => [...files.keys()],
    readFile: (absolute: string): string | null =>
      files.get(absolute.replace("/repo/", "")) ?? null,
  };
}

describe("graph · 从工作区读出那张图", () => {
  /*
   * 「这个目录还不是仓库」和「出错了」是两件事，界面要分得开：前者是流程还没走到
   * （新建的项目目录还没 git init），后者才该报错。
   */
  it("不是 git 仓库时说 not-a-repo，而不是抛", () => {
    const graph = readWorkspaceGraph({
      root: "/nowhere", excluded: [], trackedFiles: () => null,
    });

    assert.deepEqual(graph, { ok: false, reason: "not-a-repo" });
  });

  it("读得出一张有节点和边的图", () => {
    const graph = readWorkspaceGraph(fakeWorkspace());

    assert.equal(graph.ok, true);
    if (!graph.ok) return;
    assert.equal(graph.scene.nodes.length, 2);
    assert.equal(graph.scene.edges.length >= 1, true);
  });

  /*
   * 这一条是安全判据，不是功能：`?path=` 是人给的。白名单（必须在 `git ls-files`
   * 里）比任何黑名单都严 —— 它同时挡掉指向目录外的软链、`.git/` 内部、和没被跟踪
   * 的文件。少了它，`?path=../../.ssh/id_rsa` 就通了。
   */
  it("没被 git 跟踪的路径一律拒绝", () => {
    const workspace = fakeWorkspace();

    for (const path of ["../../.ssh/id_rsa", "/etc/passwd", "src/never-tracked.ts"]) {
      const reading = readFileIngredients({ ...workspace, path });
      assert.equal(reading.ok, false, `${path} 不该读得到`);
    }
  });

  it("不是仓库时读文件也说 not-a-repo", () => {
    const reading = readFileIngredients({
      root: "/nowhere", path: "src/a.ts", excluded: [], trackedFiles: () => null,
    });

    assert.deepEqual(reading, { ok: false, reason: "not-a-repo" });
  });
});
