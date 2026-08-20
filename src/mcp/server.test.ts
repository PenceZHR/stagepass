import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "./server";

/**
 * 这一层唯一的设计判据是**薄**，所以测的也就是薄：工具表是不是只有那一个、
 * 它有没有偷偷 import 业务、连不上工作台时会不会自作主张。
 *
 * **不测 MCP SDK 自己符不符合协议** —— 那不归我们证（TestPlan §五）。
 */
describe("L0 · MCP 那根电话线", () => {
  async function connected() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([buildServer().connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("工具表里有且只有 stagepass_ask", async () => {
    const { tools } = await (await connected()).listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(),
      ["stagepass_ask", "stagepass_brief", "stagepass_respond"]);
  });

  /*
   * **这条是这个文件存在的理由。**
   *
   * MCP server 按会话起 —— 三条 Codex 会话就是三个进程。它们只要各自持有状态，
   * 2026-08-18 那个「改好的代码怎么点都不生效」当场回来。禁令是：这里不 import
   * `src/` 下的任何东西，状态全在工作台那一个进程里。
   */
  it("不 import 任何业务模块 —— 只许够着「项目在哪」那一层", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const relative = [...source.matchAll(/^import[^"']*["'](\.[^"']*)["']/gm)].map((m) => m[1]!);
    /*
     * **白名单只有一条**：`system/project-home` —— 它答的是「这条会话属于哪个项目」，
     * 那是寻址，不是业务；而且它只碰 git 和一个 json，一条判据都不在里面。
     *
     * 除此之外一律不许：`domain/` `store/` `web/` 任何一个进来，这根电话线就变成了
     * 第二个进程里的第二份业务实现，2026-08-18 那个「三个进程各锁不同版本的代码」
     * 当场回来。
     */
    const allowed = new Set(["../system/project-home"]);
    const bad = relative.filter((one) => !allowed.has(one));
    assert.deepEqual(bad, [], `电话线里混进了业务：${bad.join(", ")}`);
  });

  it("找不到项目时说得出该做什么，而且不去猜一个端口", async () => {
    const client = await connected();
    // 没有 .stagepass/config.json 的目录（系统临时目录不是 git 仓库）
    const was = process.cwd();
    process.chdir(tmpdir());
    delete process.env["STAGEPASS_URL"];
    const result = await client.callTool({
      name: "stagepass_brief", arguments: { role: null },
    });
    process.chdir(was);
    const said = JSON.stringify(result.content);
    assert.match(said, /no_project/);
    assert.match(said, /npm --prefix/);
  });

  it("连不上工作台时把命令念出来，而不是自己去起一个", async () => {
    /*
     * 没人在听的端口。**必须在调用之前设**，而且地址是每次调用现读的 ——
     * 这条测试原来靠 4399 上碰巧没人才绿，我起了工作台之后它当场红。
     */
    process.env["STAGEPASS_URL"] = "http://127.0.0.1:1";
    const client = await connected();
    const result = await client.callTool({
      name: "stagepass_ask",
      arguments: { questions: [{ question: "选哪个？", options: ["A", "B"] }] },
    });
    delete process.env["STAGEPASS_URL"];
    const said = JSON.stringify(result.content);
    assert.match(said, /workbench_not_running/);
    assert.match(said, /npm start/);
    // 「看状态不该有副作用」的对偶：问一句话也不该在人的机器上拉起一个进程
    assert.match(said, /别替他起/);
  });

  it("选项少于两条，SDK 那一层就挡住了 —— 工作台不用收这种", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "stagepass_ask",
      arguments: { questions: [{ question: "？", options: ["A"] }] },
    });
    assert.equal(result.isError, true);
  });
});

/*
 * **攒几个一起问**（用户 2026-08-19：「一次问一个不符合我的效率逻辑」）。
 * 这里只测契约的边界 —— 表单长什么样、人怎么点，那是 elicitation 的事，不归我们证。
 */
describe("L0 · 一次问一批", () => {
  async function connected() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([buildServer().connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("超过 5 条 SDK 就挡住 —— 表单按字段名排序，q10 会排到 q1 和 q2 中间", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "stagepass_ask",
      arguments: {
        questions: Array.from({ length: 6 }, (_, i) =>
          ({ question: `第 ${i + 1} 个`, options: ["A", "B"] })),
      },
    });
    assert.equal(result.isError, true);
  });

  it("一条都不给也挡住 —— 空批是模型出错了，不是它没什么要问", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "stagepass_ask", arguments: { questions: [] },
    });
    assert.equal(result.isError, true);
  });
});
