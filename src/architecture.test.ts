import assert from "node:assert/strict";
import tsc from "typescript";

import {
  closureOf as graphClosureOf, dependenciesOf, parseModuleGraph,
} from "./graph/module-graph";
import { ingredientsFor, renderIngredients } from "./graph/ingredients";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The standing guards from the rebuild PRD, §9.3.
 *
 * These are not tests of behaviour. They are the rules that stop this tree from
 * becoming the one it replaces -- where an entire MCP App (1232 lines) and five
 * decision-card options sat in the codebase with nothing calling them, and
 * where nobody could tell by reading which parts were real.
 *
 * They are cheap to keep green while the tree is small. That is exactly why
 * they go in now rather than later.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(directory = SRC): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const FILES = sourceFiles().map((path) => ({
  path: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf-8"),
}));

/**
 * Which layer each module belongs to.
 *
 * Declared rather than derived from the directory names, because the
 * directories say what a module IS (domain, store, work) and the layer says
 * when it was allowed to exist. Both are useful and they are not the same
 * question.
 */
const LAYER: Readonly<Record<string, 0 | 1 | 2 | 3 | 4 | 5>> = {
  "domain/phase.ts": 0,
  "domain/stage-artifact.ts": 0,
  /*
   * 一轮的格子文件（C 方案的地基）。纯函数：铺结构、读回来、判合不合规，
   * 除了 `domain/phase` 什么都不碰，所以和它同层。
   */
  /*
   * 4，不是 0 —— 它 `import type { TemplateSection }` 够到 `domain/phase-template`（4）。
   * **只进 `import type` 的边在图上仍然算数**，而层数是依赖顶出来的，不是挑的。
   */
  "system/project-home.ts": 0,
  "domain/opening.ts": 4,
  "domain/prd-doc.ts": 4,
  "store/note-store.ts": 1,
  "domain/round-slots.ts": 0,
  /*
   * MCP 那根电话线。**放最低层，因为它不许 import 我们自己的任何东西** ——
   * 它一旦碰业务，「MCP server 按会话起、一台机器上三个进程各锁一份代码」那个坑
   * 当场回来（TechSpec §四）。层数在这儿不是被依赖顶出来的，是被**禁令**压下去的：
   * 0 意味着它没有任何东西可以依赖。有下面那条测试钉着。
   */
  "mcp/server.ts": 0,
  /*
   * 提问的形状和参数校验（BuildPlan T1）。纯函数，只 import `domain/phase` 的类型
   * —— 和 `round-slots` 同族：一个形状加一套判据，不碰任何 IO。
   */
  "domain/ask.ts": 0,
  /*
   * 判据单答案文件的读回（BuildPlan T6）。和 `domain/worklist.ts` 的 reader 逐字
   * 同构，但它一个 import 都没有 —— 所以比 worklist（3）低，落在最底层。
   */
  "domain/rubric-sheet.ts": 0,
  /*
   * 真依赖图的解析器（H 档第一块）。它**只 import `typescript`**，我们自己的
   * 东西一个都不碰 —— 所以放最低层，谁都够得着。
   *
   * 它同时是这条护栏自己的地基：图错了，下面「谁不许 import 谁」和「闭包别吃掉
   * 全树」两条一起变成假的。所以它的层数不是随手放的，是「它不能依赖任何会被
   * 它审判的东西」。
   */
  "graph/module-graph.ts": 0,
  // 配料单（H 档第二块）。只依赖上面那个解析器，所以同一层 —— 它俩是同一族
  // 工具：一个把树读成图，一个按图切出「这次改动该看见什么」。
  "graph/ingredients.ts": 0,
  // 两张图的对账（H 档第三块）。同一族工具，同一层：它只读图，不读代码。
  "graph/reconcile.ts": 0,
  // 图谱（spec 2026-08-12）的两块纯函数：判据和布局。只吃路径清单和图，
  // 不碰文件系统 —— 和上面同族，同层。
  "graph/code-selection.ts": 0,
  "graph/graph-layout.ts": 0,
  "graph/stage-artifact-layout.ts": 0,
  // 图谱那条路上唯一碰盘的地方（git 清单 + 读正文）。git 是注入的，
  // 和 `work/repo.ts` 同一个形状、同一层。
  "graph/read-workspace.ts": 2,
  "graph/reconstruct-stage-artifact.ts": 2,
  "graph/read-stage-artifact.ts": 2,
  // 只依赖 phase 的纯路径生成（E：产物的家）。
  "domain/artifact-home.ts": 0,
  "domain/change-state.ts": 0,
  "store/change-store.ts": 0,
  // 并行座位（批 3）。和 change-store 同一层：它是主线旁边的第二个座，
  // change-store 的收编要在同一个事务里读它的行。
  "store/parallel-store.ts": 0,
  "store/project-store.ts": 0,
  /*
   * 插件进程的库句柄（用 Node 内置 `node:sqlite` 顶 better-sqlite3 的形状）。
   *
   * 和 `graph/module-graph.ts` 同一个理由放最低层：**它运行时只 import `node:sqlite`，
   * 我们自己的东西一个都不碰**（better-sqlite3 只进 `import type`，编译后就没了）。
   * 谁都够得着，而它够不着任何人 —— 一个换驱动的垫片不该有话语权。
   */
  "web/sqlite-handle.ts": 0,


  "domain/gate.ts": 1,
  "domain/lease.ts": 1,
  "domain/gap.ts": 1,
  // 编辑过门（批 6）：纯规则，只吃 gap 的类型 —— 和 gap 同层。
  "domain/edit-gate.ts": 1,
  "store/evidence-store.ts": 1,
  "store/stage-artifact-store.ts": 1,
  "store/gap-store.ts": 1,
  // 旁路账本（彗星，2026-08-11）。它只依赖 better-sqlite3 的类型，我们自己的
  // 东西一个都不 import —— 和 gap-store 同一层，理由也一样：纯存储。
  "store/aside-store.ts": 1,
  /*
   * 提问留档（BuildPlan T2）：JSONL 追加 + 库索引 + `rebuildFrom`。它 import
   * `domain/ask.ts`（0）的类型，别的什么都不碰 —— 和这一层其他纯存储同族。
   */
  "store/ask-store.ts": 1,
  /*
   * 插件跟着 Codex 的工作目录认项目。只读 `store/project-store`（0），别的什么都不碰
   * —— 和这一层其他「薄薄一层规则盖在 store 上」的模块同族。
   */
  /*
   * 座位 = 一个 (Change, 阶段) 绑着的 Codex 会话。它够得着的最高一层是
   * `codex/app-server-transport`（2），所以住这儿 —— 层数是依赖顶出来的，不是挑的。
   */
  "web/seats.ts": 2,
  /*
   * 「这一轮跑完了没」的轮询判定（2026-08-18 让出订阅权之后唯一新写的那段）。
   *
   * 运行时它其实谁都不 import —— 历史接口和时钟全是注进来的，`AppServerHistory`
   * 只进 `import type`。但那条边在图上仍然算数，而**层数是依赖顶出来的、不是挑的**，
   * 所以它跟着 `app-server-history` 住在 2。
   */
  "web/await-turn.ts": 2,
  /*
   * 一轮跑完叫一声人（系统通知）。读 store（0）和 `system/process`（2），
   * 不认识用例、不认识界面 —— 层数照旧是依赖顶出来的。
   *
   * 它**只读状态、只发一条通知**：不推闸门、不派轮、不替人做任何决定。
   */
  "web/nudge.ts": 2,
  "store/command-store.ts": 1,
  "work/job-store.ts": 1,
  "work/turn-loop.ts": 1,

  "domain/turn.ts": 2,
  "store/binding-store.ts": 2,
  "store/turn-store.ts": 2,
  "codex/transport.ts": 2,
  // App Server 的公开 JSONL 协议边界。protocol 只定义线上的最小形状；client 是
  // 整棵树唯一会直接持有 Codex 子进程 stdin/stdout 的地方。
  "codex/app-server-protocol.ts": 2,
  "codex/app-server-client.ts": 2,
  // 外部进程只从这一个缝里出去：codex app-server 与 osascript。
  "system/process.ts": 2,
  /*
   * 格子文件落盘。持久路径（`~/.stagepass/rounds`），不是临时目录 —— 清掉之后
   * 「模型没填」和「文件被清了」在账本上长得一模一样。它只认 domain 的形状，
   * 不认识 Change 状态机和界面。
   */
  "system/slot-files.ts": 2,
  // App Server 通知在这里收束成一条可重放的 thread 事件流；session 只在这层
  // 持有 Codex thread/turn/item 生命周期，不认识 Change、phase 或界面。
  "codex/stream-state.ts": 2,
  "codex/app-server-session.ts": 2,
  "codex/app-server-transport.ts": 2,
  "codex/app-server-history.ts": 2,
  "codex/archive.ts": 2,
  // 目录信任。和 archive 同一个形状：读 Codex 自己的状态，整层可注入，只读不写。
  "codex/phase-instructions.ts": 2,

  "domain/round.ts": 4,
  // 「接受一条已知风险」这个用例（§4.1·J 从 `handle()` 里搬出来的第一个）。
  // 它够得着的最高一层是 `domain/round.ts`（轮次算法），所以住这儿 —— 层数是
  // 它的依赖顶出来的，不是挑的。
  "app/waive.ts": 4,
  // 跳转表 = 账本投影（§5.9.2）。轮次算法在 round.ts（一份实现），所以同层。
  "domain/journey.ts": 4,
  // 十三个阶段各自那一节。纯文本、只 import 一个类型，所以和读它的 round.ts 同层。
  "domain/phase-play.ts": 4,
  // 一个阶段的产出模板。和 `phase-play.ts` 逐字同一个形状（每阶段一份文本、
  // 只 import `Phase` 类型、读它的是 round.ts），所以同层。
  "domain/phase-template.ts": 4,
  "codex/subagent.ts": 4,
  "work/round-runner.ts": 4,
  // 一轮里那两句只写给人看的话（裁判的结论、反方的整体判断）。它只依赖
  // `domain/round.ts` 的来源名单，所以和它同层 —— 它不是 rubric 的东西，
  // 判定归 `rubric_assessments`，这两句谁都不判。
  "store/round-note-store.ts": 4,
  /*
   * 提问的组装（BuildPlan T3）：认当前备着的那一轮、序号换回备那一刻的判据、落档。
   * 它够得着的最高一层是 `store/handoff-store` / `store/rubric-store` 那一族的
   * 消费者，而它自己不进 `web/actions.ts`（5）—— 层数是它的依赖顶出来的。
   */
  /*
   * 4 → 5（2026-08-19 晚）。**层数是依赖顶出来的，不是挑的。**
   *
   * 「提问挂在哪一轮」的判据降级成「挂在哪个 Change」之后，它要 `defaultChange`
   * —— 那是面板挑默认 Change 用的同一个函数（`web/bind-project`，L5）。
   * **共用它而不是抄一份**：抄出来的第二份会和面板慢慢分岔，而分岔的表现是
   * 「模型问的那一条，和我在浏览器上看着的那一条，不是同一条」。
   */
  "web/brief-route.ts": 5,
  "web/same-project.ts": 1,
  "web/brief-routes.ts": 5,
  "web/ask-route.ts": 5,

  "domain/rubric.ts": 5,
  "domain/rubric-gaps.ts": 5,
  "domain/rubric-edit.ts": 5,
  "domain/rubric-defaults.ts": 5,
  "work/rubric-round.ts": 5,
  "work/round-turn-runner.ts": 5,
  // 「把这一轮的裁决交给人」这个用例 —— 三条问人的路里最绕的一条。它够得着
  // `domain/rubric.ts`（把这一轮判成什么样写进题面），所以住 5。
  "app/decide-gate.ts": 5,
  // 看和改评分标准（PRD §1.1 那个唯一的例外）。rubric 整族在 5，它也在 5。
  "app/edit-rubric.ts": 5,
  // 新建 / 删除 Project 和 Change。它只够得着 change-store（0）和 project-store（0），
  // 唯一把它顶上来的是新项目要装出厂标准（`RubricStore.installDefaults`，5）。
  "app/workspace.ts": 5,
  // git。和 `codex/archive.ts` 同一个形状（包一个外部命令、整层可注入），所以同一层。
  // 它不 import 我们自己的任何东西，所以层数只影响「谁可以用它」——2 让 L2 起都能用。
  "work/repo.ts": 2,
  "store/rubric-store.ts": 5,

  // The panel is not a new layer, but its two halves sit at different ones.
  //
  // `panel-server` also puts gate decisions to a person and applies the answer,
  // and that IS L3. It was declared 2 while it only hosted terminals; the guard
  // caught the drift the moment the question path was wired in, which is
  // exactly what this rule is for.
  /*
   * 面板那两屏读出来的东西（`/api/panel`、`/api/progress`）。
   *
   * **它在 `web/` 而不在 `app/` 是有判据的**：三条问人的路是用例（有下场，换个
   * 界面那些下场一个字都不用改），这两屏出去的东西按「界面要画什么」组织
   * （`workspace`、`currentPhase`、`mark`）—— 换个界面就是另一份形状。塞进
   * `app/` 会把界面的词汇拖进那一层。层数和 `panel-server` 一样，理由也一样。
   */
  "web/panel-view.ts": 5,
  // 又提了一层，理由和当初 2 -> 3 一样：它开始承载 rubric 编辑（PRD §1.1 那个
  // 唯一的例外），而 rubric 是 L5。这不是豁免，是把已经发生的事写下来 —— 护栏
  // 在接口写进去的那一刻就会红。
  // Codex 四态到 StagePass binding 的唯一映射；只被 Panel 边界消费。
  // 原生终端的 HTTP 边界只回归一化状态，不回 ANSI、输入或 JSON-RPC。
  /*
   * 插件那一面的数据装配（2026-08-18 定案：只做插件、网页端退休）。
   *
   * 和 `panel-server` 同层，理由也一样：它是**另一个界面的边界**——一边吃库，
   * 一边吐 widget 要的形状。它调 `panel-view` 而不是自己再算一遍，所以不能比
   * `panel-view` 低。
   */
  "web/panel-data.ts": 5,
  /*
   * 插件的数据口和进程边界，和 `panel-server` 同层同理由 —— 它俩是同一种东西的
   * 两个版本：一个把库变成 HTTP 上的 JSON，一个把库变成 MCP 上的 JSON。
   * 网页端退休后只剩后者。
   */
  "web/api.ts": 5,
  /*
   * 产物和图谱那四条路。和 `api.ts` 同层 —— 它是 `api.ts` 的一块，只因为要拖
   * TypeScript 编译器才单独成文件（唯一的动态 import 边界，理由在文件开头）。
   */
  "web/repo-routes.ts": 5,
  /*
   * 会改库的那些路，和执行通道。
   *
   * `actions` 够得着 `app/decide-gate`（5），`runtime` 够得着整条跑轮链
   * （`work/round-turn-runner` → rubric → …），所以都在这一层。`seats` 低一格：
   * 它只认 App Server 和绑定表，不认识用例。
   */
  "web/actions.ts": 5,
  "web/runtime.ts": 5,
  /*
   * 浏览器那一面的请求边界（2026-08-19 定案：状态流转回 WebUI）。和 `plugin/server`
   * 同层同理由 —— 它俩是同一种东西的两个版本：一个把库变成 MCP 上的 JSON，一个变成
   * HTTP 上的 JSON。**判据一条都不在它们里面。**
   */
  "web/serve.ts": 5,
  /*
   * 工作台绑在它所在的仓库上（2026-08-19 定案：依附一个项目，不再自己管项目）。
   * 它调 `app/workspace` 的建项目用例（5），所以住这层 —— 层数是依赖顶出来的。
   */
  "web/bind-project.ts": 5,
  // 图谱的三条路（spec 2026-08-12）。它不进 panel-server 的闭包（注入接线，
  // 理由在 PanelOptions.graph 上），但它和 panel-server 住同一层：同样是
  // 「HTTP 进、JSON 出」的界面层，读的最高一层是 store（0）和 graph（0/2）。

  "domain/question.ts": 3,
  "domain/brief.ts": 3,
  "store/question-store.ts": 3,
  /*
   * **应用层的第一块**（BACKLOG §4.1·J）：把一道题交给人、等他答。
   *
   * 和 `question` 同层，理由也一样 —— 它就是「问人」这件事本身，够得着的东西
   * 不超过 question / question-store / binding-store。它**不认识 HTTP**，所以
   * `web/`（L5）在它上面，而不是它的一部分。
   */
  "app/ask-human.ts": 3,
  // 「把这次改动要什么问出来」这个用例。够得着的最高一层是 `domain/brief.ts`（3），
  // 所以和它同层 —— 它连 Codex 都不认识（「跑一次 turn」是注进来的）。
  "app/record-brief.ts": 3,
  // 批 2「模型起草，人改」：和 record-brief 同一族用例，同一层。
  "app/converge-brief.ts": 3,
  /*
   * C 方案：模型把问题填进格子文件，落进账本等人在浏览器里答。和 ask-human 同族、
   * 同层，但**不认识会话** —— 没有人需要挂着一轮，所以也没有「会话死了」这种下场。
   */
  // 「逐条问、只收内容」那套。和 question 同层 —— 2026-08-17 拆掉 MCP 之后念它给
  // 人听的是浏览器，但类型的位置没变。
  // 名单里装的是 gap（L1）和 criterion（L5），但装的是什么不决定它住哪层，
  // **谁必须够得着它**才决定。
  "domain/worklist.ts": 3,
  "store/handoff-store.ts": 3,
  "store/worklist-store.ts": 3,

  // The schema is the union of every layer's storage, so it imports each
  // layer's enum constants. Placing it at the top is not an exemption: nothing
  // in production imports it downward -- only tests and the entry script read
  // it -- so the downward-only rule still holds everywhere it is checked.
  //
  // It moves up whenever a new layer adds tables: L5's rubric enums are imported
  // here, so 4 would now be a downward-import violation. If this line looks
  // arbitrary, it is not -- it is "the highest layer with storage".
  "db/schema.ts": 5,
};

const production = FILES.filter((file) =>
  !file.path.endsWith(".test.ts")
  // `.d.ts` 只是声明，没有实现、没有运行时依赖 —— 分层说的是「谁可以用谁」，
  // 而一个环境声明（xterm 挂成全局的那两个类）不参与任何依赖关系。
  // 2026-08-05 给 panel.js 上类型检查时加的：panel-globals.d.ts 是它的伴生声明。
  && !file.path.endsWith(".d.ts"));

/**
 * 这一整棵树的**真依赖图**，用真编译器解析（`graph/module-graph.ts`）。
 *
 * 分层护栏和闭包护栏原来各自数一遍 `from "…"` 的正则 —— §5.10 早就写着那个
 * 「只够量结构，不够当护栏」。2026-08-05 换过来时先做了对照：**今天这棵树上
 * 两者逐条一致**（48 模块 152 边，0 差异、0 落空边）。
 *
 * 所以换它的理由不是「正则今天算错了」，是**正则明天会算错而没人知道**：树里
 * 现在恰好没有副作用 import、没有动态 import、注释里也没有假的 `from "./x"`，
 * 而这三样任何一样出现，正则都会静默给出错的图 —— 一条护栏建在错的图上，
 * 比没有护栏更糟。
 */
const GRAPH = parseModuleGraph(production);

/**
 * Entry points that live outside `src` but are production callers all the same
 * -- `pnpm verify:rebuild` is how a person runs this tree. Counted when looking
 * for orphans, so a module reachable only from a command still counts as
 * reached, and one reachable from nowhere still does not.
 */
const ENTRY_POINTS = [
  /*
   * 工作台。2026-08-19 定案之后这棵树只有一个产品出口：浏览器里的 StagePass。
   * MCP 插件那一层（widget / 构建 / 热重载）当天全部删除 —— 一夜六种事故的根子。
   */
  "scripts/stagepass.ts",
].map((path) => ({
  path,
  text: readFileSync(join(process.cwd(), path), "utf-8"),
}));

describe("standing · every module declares its layer", () => {
  /**
   * A file that is in no layer is a file nobody decided the position of. That
   * is how a tree stops having an order at all.
   */
  it("has no unplaced production module", () => {
    const unplaced = production
      .map((file) => file.path)
      .filter((path) => !(path in LAYER));
    assert.deepEqual(unplaced, []);
  });

  it("declares no layer for a module that no longer exists", () => {
    const present = new Set(production.map((file) => file.path));
    const stale = Object.keys(LAYER).filter((path) => !present.has(path));
    assert.deepEqual(stale, []);
  });
});

describe("standing · layers depend downward only", () => {
  /**
   * L1 may build on L0. L0 may not reach up into L1 -- if it could, "L0 is
   * proved before L1 exists" would be untrue by construction, and the gating
   * discipline the whole rebuild rests on would be decorative.
   */
  it("never lets a lower layer import a higher one", () => {
    const violations: string[] = [];
    for (const file of production) {
      const layer = LAYER[file.path]!;
      for (const target of dependenciesOf(GRAPH, file.path)) {
        const targetLayer = LAYER[target];
        if (targetLayer === undefined) continue;
        if (targetLayer > layer) {
          violations.push(`L${layer} ${file.path} -> L${targetLayer} ${target}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});

/**
 * **「谁是谁的上游」只有一份实现。**
 *
 * 这条是被咬过才写的：`upstreamOf` 用主线顺序的前缀算上游，而
 * `round-turn-runner` 又自己写了一遍同样的前缀去挑「已批准的上游产物」——
 * 两份拷贝，而且**两份都是错的**（TestPlan 从来没消费过 Plan，§8.6·①）。
 *
 * 判法：production 里除 `domain/phase.ts` 之外，谁都不许自己按顺序切前缀去当
 * 「上游」。要上游就调 `upstreamOf`。
 */
describe("standing · 上游只有一份算法", () => {
  it("没有第二处自己切主线前缀当上游", () => {
    const sliced: string[] = [];
    for (const file of production) {
      if (file.path === "domain/phase.ts") continue;   // 它就是那一份实现
      const code = withoutComments(file.text);
      // `PHASES.slice(0, …indexOf(phase))` / `order.slice(0, …)` 这一族。
      if (/\b(PHASES|\w*[Oo]rder)\s*\.\s*slice\(\s*0\s*,/.test(code)) {
        sliced.push(file.path);
      }
    }
    assert.deepEqual(sliced, [], "要上游就调 upstreamOf，别再自己切一遍");
  });

  it("这条护栏不是空转的 —— `upstreamOf` 真的有人在用", () => {
    const callers = production.filter((file) =>
      file.path !== "domain/phase.ts" && file.text.includes("upstreamOf("));
    assert.ok(callers.length >= 2, `只有 ${callers.length} 个调用方`);
  });
});

describe("standing · nothing exists without a caller", () => {
  /**
   * The rule the old tree lacked. `mcp/` had zero production callers and lived
   * for months; `request_plan_changes` had a label, a contract entry and a
   * renderer, and no surface that could execute it.
   *
   * Scoped two ways, and both are stated rather than assumed:
   *
   * - Values only (const, function, class). An exported TYPE is usually named
   *   only where it is declared -- a caller passing `{changeId, action, ...}`
   *   never writes `CommandRequest` -- so flagging types would report every
   *   public signature as dead. Types do not create the "is this real?"
   *   ambiguity that killed the old tree; unreachable code does.
   * - "Mentioned anywhere else in src", not "reached from a production entry
   *   point". Tightening comes when L2 gives this tree an entry point that is
   *   not a test. Claiming the stronger rule now would be a lie.
   */
  it("has no export that nothing else mentions", () => {
    const orphans: string[] = [];
    for (const file of production) {
      const others = [...FILES, ...ENTRY_POINTS]
        .filter((other) => other.path !== file.path);
      for (const name of exportedNames(file.text)) {
        const mentioned = others.some((other) =>
          new RegExp(`\\b${name}\\b`).test(other.text));
        if (!mentioned) orphans.push(`${file.path}: ${name}`);
      }
    }
    assert.deepEqual(orphans, []);
  });
});

describe("standing · one name per concept", () => {
  /**
   * The first structurally-impossible check found in the old tree came from one
   * phase having three names. The list below is the ONLY spelling of these
   * phases; anything that reintroduces an alias fails here.
   */
  it("uses no alias for a phase name", () => {
    const aliases = ["Intake", "INTAKE", "intake", "TECHSPEC", "techspec", "test_plan"];
    const found: string[] = [];
    for (const file of production) {
      // Comments are exempt: this file's own explanation of the old tree's
      // three names has to be able to quote them. The rule is about what the
      // code says, not about what the code says about itself.
      const code = withoutComments(file.text);
      for (const alias of aliases) {
        if (new RegExp(`["'\`]${alias}["'\`]`).test(code)) {
          found.push(`${file.path}: ${alias}`);
        }
      }
    }
    assert.deepEqual(found, []);
  });
});

describe("standing · Codex runtime is pure App Server", () => {
  it("has no second browser-stream session owner", () => {
    const forbidden = ["web/codex-" + "stream-api.ts", "web/" + "stream-session.ts"];
    assert.deepEqual(
      production.filter((file) => forbidden.includes(file.path)).map((file) => file.path),
      [],
    );
  });

  it("production has no PTY, legacy multiplexer, rollout-file, or private-state path", () => {
    const forbidden = [
      "node-pty",
      "@xterm",
      "/pty/",
      ["t", "mux"].join(""),
      "state_5.sqlite",
      "rollout-",
    ];
    const found: string[] = [];
    for (const file of production) {
      const code = withoutComments(file.text);
      for (const token of forbidden) {
        if (code.includes(token)) found.push(`${file.path}: ${token}`);
      }
    }
    assert.deepEqual(found, []);
  });

  it("only the system process boundary calls Node spawn", () => {
    const spawners = production
      .filter((file) => /import\s*\{[^}]*\bspawn\b[^}]*\}\s*from\s*["']node:child_process["']/.test(
        withoutComments(file.text),
      ))
      .map((file) => file.path);
    assert.deepEqual(spawners, ["system/process.ts"]);
  });
});

/**
 * 两条**棘轮**护栏（BACKLOG §4.1）：单函数行数、单模块依赖闭包占比。
 *
 * ## 为什么是棘轮，不是干净的上限
 *
 * `handle()` 现在 1463 行、`panel-server.ts` 的闭包够得着全树 91% —— 定一条干净的
 * 上限它们当场就红，而「先把违例修完再装护栏」的顺序等于永远装不上。棘轮反过来：
 * **现行违例逐个钉死在例外表里，只许缩、不许涨**；其余所有函数/模块从今天起受
 * 干净上限管。修掉一个违例，就把它从表里删掉（有一条护栏盯着表不许留死条目，
 * 和 `LAYER` 那张表同一个道理）。
 *
 * ## 为什么这两个数
 *
 * 上限取的是「现状第二名再留点余量」：函数第二名 279 行（`runRound`）→ 上限 300；
 * 闭包第二名 57%（`round-turn-runner`）→ 上限 60%。**不是审美数字，是「别再长出
 * 第二个 handle()」的机械底线** —— 分层护栏防住了「下层依赖上层」，没防住
 * 「某一层长出一个吃掉一切的模块」，这两条补的就是那个盲区。
 */
const FUNCTION_LINES_CAP = 300;
const FUNCTION_RATCHET: Readonly<Record<string, number>> = {
  // §4.1 的主角。拆应用层（BACKLOG §四 J 批）每拆走一块就把这个数往下钉。
  // 2026-08-05：抽 launchAskPrompt（1463 → 1462）、askFollowUp（→ 1453）、
  // phasesFor（→ 1410）、waitForAnswer 收掉四份手写的等答案循环（→ 1329）、
  // `app/waive.ts` —— 应用层的第一个真用例（→ 1225）、`app/record-brief.ts`（→ 1093）、
  // `app/decide-gate.ts`（→ 875）。三条问人的路现在全在应用层，`handle()` 只剩转发。
  // 再抽 `app/edit-rubric.ts` + `web/panel-view.ts`（那两屏的读）（→ 652）、
  // `app/workspace.ts`（新建 / 删除）（→ 607）。
  //
  // **剩下的不再是「抽一块业务逻辑」能降的了。** pty 那一段 113 行是真正的 HTTP 流，
  // 十几条路由各自的转发加起来又是三百多 —— 要下到 300，得把这条 if 链换成一张
  // 路由表，那是另一种改动，不是这一批的延长线。
  // 2026-08-06：`serveRubricSave` / `serveRubricUpgrade` 抽出去（607 → 579）。
  // **加一条路由必须先还等量的债**，这条棘轮就是这么用的。
  // 2026-08-07：这一批加了四条路由（aside / brief-draft / brief-confirm /
  // parallel），债用 `serveArtifact` + `servePanel` 还的（579 → 553）；
  // 同日再抽 `serveParallel`、撤掉并行座位的入口（553 → 517）。

};
const CLOSURE_SHARE_CAP = 0.6;
const CLOSURE_RATCHET: Readonly<Record<string, number>> = {
  /*
   * 插件进程是整个产品**唯一的入口**（网页端 2026-08-18 退休后就它一个），所以它
   * 够得着大半棵树 —— 那是入口的定义，不是 panel-server 那种「一个模块把业务逻辑
   * 全吃了」。这条护栏原来没碰到过这种情况，因为上一个入口在 `scripts/` 里，不算
   * production 模块。
   *
   * **不给豁免，给棘轮。** 闭包只能靠删依赖变小，搬代码没用；而这些依赖都是真的
   * （数据口 + 产物 + 图谱）。钉在实测值上，**涨一点就红** —— 于是「又给入口多挂
   * 了一条依赖」这件事永远要经过一次显式的抬手。
   *
   * 它本身仍然被另外两条护栏管着：配料单不许过三成、单个函数不许长成一层。
   * 那两条才是「它有没有在变成第二个 panel-server」的真判据。
   */
  /*
   * ## 2026-08-18 晚：接完剩下四条路，这两个数**又**涨了（92→95、73→77）
   *
   * 这是同一批数字的**第三次**抬手，而每一次的原因都一样：给路由器接一条界面本来
   * 就在调的路，闭包必然涨一格。`actions.ts` 这次多够得着的是 `app/record-brief`
   * 和 `app/converge-brief` —— 两个**用例**，判据在它们自己里面，各自有测试。
   *
   * **一条每次正常改动都必须抬一次的棘轮，它没在拦什么，只是在教人抬数字。**
   * 交接 §六 提的出路（让这条护栏排除声明过的入口）没做，因为 `actions.ts` 不是
   * 入口 —— 它是路由器，那条出路盖不住它。这件事该由人定，不该由这次改动顺手改掉。
   *
   * 在那之前仍然钉在实测值上（server 95.29%、actions 76.47%），再涨还是红。
   * 而真正在管「它有没有在变成第二个 panel-server」的是另外两条，**这次都没红**：
   * 配料单不许过三成、单个函数不许长成一层。
   */
    /*
     * ## 2026-08-19 晚：72 → 73
     *
     * 接了题面和产物两条路（`/api/brief`、`/api/prd`，DESIGN-prd-phase-2026-08-19）。
     * 它们**已经走了动态 import**（和图谱那条同一个办法），但闭包算的是图上的边，
     * 动态与否不影响 —— 涨的这一格是真的：题面要 RubricStore、产物要 NoteStore。
     *
     * 要让它降下来只有一条路：**让 brief 不再自己去凑那四样**，改成由更上面一层
     * 把它们喂进来。那是一次真重构，不是搬文件，所以先抬手记账。
     *
     * ## 同夜 73 → 74，而这一格**不是又喂了一口**
     *
     * 「项目对不对得上」那三个函数一度塞在 `ask-route` 里，`brief-route` 为了用它们
     * 把整条 handoff 链拖进了闭包 —— 那次是真涨，护栏抓得对，已经抽成
     * `web/same-project.ts`（只 import ProjectStore，谁都够得着而它谁都不拖）。
     *
     * 抽完还差一格，是**分母变了**：多一个产品模块，`total` 加一，于是每个人的占比
     * 都动一点点。这个数会随着树长大自己漂 —— 它拦的是「谁又多够着了一大片」，
     * 不是小数点后两位。
     */
    "web/api.ts": 0.74,
  /*
   * 它是**另一个入口的路由器**，够得着 api + actions 的并集 —— 和 `plugin/server`
   * 一样是同义反复，不是坏味道。真正管着「有没有长成第二个 panel-server」的是另外
   * 两条（配料单不许过三成、单个函数不许长成一层），这个文件 70 行、一个分支。
   */
  "web/serve.ts": 0.96,
  "web/actions.ts": 0.80,
  /*
   * 题面／产物的组装点。73% —— 和 `api.ts` 同一批边，理由也同一条：它要同时够着
   * 模板、rubric、意见、项目路径，才拼得出「模型现在该干什么」。
   *
   * **它是组装点，不是业务层**：判据全在 `domain/`（模板七节、缺哪节）和 `store/`
   * （意见有没有下文）里，各自有测试。这里只负责把它们摆在一起。
   */
  "web/brief-routes.ts": 0.74,
};

/*
 * ## 2026-08-18：`plugin/server.ts` 到了 92%，和当年的 panel-server 一个数
 *
 * **这个数字现在已经不说明问题了，得说清楚为什么。**
 *
 * 执行通道接上之后，插件入口够得着整条跑轮链（`round-turn-runner` → rubric →
 * domain 全家）。而它是**整个产品唯一的入口** —— 一个入口够得着全树是同义反复，
 * 不是坏味道。panel-server 当年 91% 的真问题是**它自己 2177 行、`handle()` 484 行**，
 * 那才是「改一次要读小半棵树」。
 *
 * `plugin/server.ts` 现在 230 行，全是管道；拿主意的都在 `api` / `actions` /
 * `runtime` / `seats` 里，各自有测试。
 *
 * **所以这条护栏对「入口」这个位置该退休，换成另外两条守：** 配料单不许过 30%
 * （改它一次要读多少），单个函数不许长成一层。它们现在都没红。在没人动手改这条
 * 护栏之前，棘轮至少保证「又给入口挂了一条依赖」要经过一次显式抬手。
 */

/*
 * ## 关于上面这两条，得说清楚它们和 panel-server 那条不是一回事
 *
 * 网页端退休后（2026-08-18），插件是整个产品**唯一的入口**，而 `api.ts` 是它唯一的
 * 路由器。**接一条路，就多够得着那条路要的那一片** —— 闭包涨是路由器的定义，不是
 * 坏味道。panel-server 当年 91% 的问题不在够得着多少，在于它自己**长到 2177 行、
 * 把业务逻辑吃进去了**。
 *
 * 真正在管这件事的是另外两条，而它们现在都没红：
 *
 *   - **配料单不许过 30%** —— 「改它一次要读多少」，那才是痛感的度量；
 *   - **单个函数不许长成一层** —— panel-server 的 `handle()` 当年 484 行。
 *
 * 所以这里给的仍然是棘轮而不是豁免：数字钉在实测值上，**再涨就红**，于是「又给
 * 路由器挂了一条依赖」永远要经过一次显式的抬手。但抬手时该问的是上面那两条，
 * 不是这一条。
 */

describe("standing · 没有一个函数长成一层", () => {
  /** 用真编译器量，不用正则猜函数边界 —— 边界猜错一次这条护栏就静默失效。 */
  const measured: { key: string; lines: number }[] = [];
  for (const file of production) {
    const source = tsc.createSourceFile(
      file.path, file.text, tsc.ScriptTarget.ES2022, true);
    const visit = (node: tsc.Node): void => {
      if (
        tsc.isFunctionDeclaration(node) || tsc.isMethodDeclaration(node)
        || tsc.isArrowFunction(node) || tsc.isFunctionExpression(node)
      ) {
        const lines = source.getLineAndCharacterOfPosition(node.getEnd()).line
          - source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const name = (tsc.isFunctionDeclaration(node) || tsc.isMethodDeclaration(node))
          && node.name !== undefined ? node.name.getText()
          : tsc.isVariableDeclaration(node.parent) && tsc.isIdentifier(node.parent.name)
            ? node.parent.name.getText() : "(anon)";
        measured.push({ key: `${file.path}#${name}`, lines });
      }
      tsc.forEachChild(node, visit);
    };
    visit(source);
  }

  it("**超过上限的只有例外表里那几个，而且没涨**", () => {
    const over = measured
      .filter(({ key, lines }) =>
        lines > (FUNCTION_RATCHET[key] ?? FUNCTION_LINES_CAP))
      .map(({ key, lines }) => `${key} = ${lines} 行`);
    assert.deepEqual(over, [], "要么拆它，要么（仅当它在缩）更新例外表");
  });

  it("例外表里没有已经修好的死条目", () => {
    // 修到上限以下还留在表里，下一个人会以为它还是雷。和 LAYER 那条同一个形状。
    const stale = Object.keys(FUNCTION_RATCHET).filter((key) => {
      const now = measured.find((entry) => entry.key === key);
      return now === undefined || now.lines <= FUNCTION_LINES_CAP;
    });
    assert.deepEqual(stale, [], "把它从 FUNCTION_RATCHET 里删掉");
  });
});

/**
 * standing · 配料单**真的只带一小片树**（§5.4.1 / §5.7）。
 *
 * 「只给签名不给实现」这个机关的收益是可以量的：改一个模块时，喂进去的东西
 * 占全树多少。2026-08-05 第一次量（49 个模块 / 502 KB）：
 *
 * ```
 * domain/gap.ts               18.0 KB   3.6%   28×
 * domain/journey.ts           18.7 KB   3.7%   27×
 * work/round-turn-runner.ts   32.2 KB   6.4%   16×
 * web/panel-server.ts        145.9 KB  29.0%    3×   ← 说明问题的那一个
 * ```
 *
 * **收益和「这棵树拆得好不好」成正比**：一个划得干净的模块拿到 28×，而那个
 * 1410 行的 `handle()` 只有 3× —— 它自己正文就 94.6 KB，还牵着 33 个依赖。
 * 换句话说，J 批（拆 handle）不只是好看，它直接决定这套机关值不值钱。
 *
 * **J 批之后（2026-08-05 晚，56 个模块 / 524.6 KB）** —— 这不是预测，是搬完
 * 量出来的：
 *
 * ```
 * web/panel-server.ts         91.1 KB  17.4%    6×   ← 29.0% / 3× 搬下来的
 * app/decide-gate.ts          32.2 KB   6.1%   16×   ← 裁决
 * web/panel-view.ts           31.7 KB   6.0%   17×   ← 那两屏的读
 * app/waive.ts                20.8 KB   4.0%   25×   ← 接受风险
 * app/record-brief.ts         16.6 KB   3.2%   31×   ← 录需求
 * app/edit-rubric.ts          15.8 KB   3.0%   33×   ← 改标准
 * app/ask-human.ts            11.7 KB   2.2%   45×   ← 三条问人的路共用的那段
 * ```
 *
 * 同一段逻辑，待在 `handle()` 里是 3×，搬出去就是 16~45×。**这是「拆它直接
 * 提升整套机关的收益」这句话的实测值**，不是一句好听的话。
 *
 * 这条护栏钉的是**别再退步**：除了例外表里那个，谁的配料单都不许超过全树三成。
 */
const INGREDIENT_SHARE_CAP = 0.3;

describe("standing · 配料单只带一小片树", () => {
  /**
   * **依赖那半份里一个注释都不许有。**
   *
   * 这条是在真树上看输出才发现要写的：第一版用 `getText()` 取签名，它把花括号里
   * 的注释一起带出来 —— `ChangeState` 那个接口的成员上挂着十几行讲不变量和历史
   * 的 JSDoc，整段漏进了配料单。而「只给签名不给实现」这个机关的全部价值就在于
   * **看不见实现**，注释里恰恰装着实现（这棵树尤其如此）。
   *
   * 玩具夹具测不出这个 —— 它的注释太短、太干净。所以护栏放在真树上。
   */
  it("**依赖的签名里没有注释** —— 注释装着实现，漏一行机关就少一分", () => {
    const leaking: string[] = [];
    for (const file of production) {
      const list = ingredientsFor({ graph: GRAPH, files: production, group: [file.path] });
      for (const dependency of list.dependencies) {
        const text = dependency.signatures.join("\n");
        if (/\/\*|\/\//.test(text)) leaking.push(`${file.path} -> ${dependency.path}`);
      }
    }
    assert.deepEqual(leaking, []);
  });

  it("**没有模块的配料单吃掉全树三成以上**", () => {
    const whole = production.reduce((sum, file) => sum + file.text.length, 0);
    const over = production
      .map((file) => ({
        path: file.path,
        share: renderIngredients(
          ingredientsFor({ graph: GRAPH, files: production, group: [file.path] }),
        ).length / whole,
      }))
      .filter(({ share }) => share > INGREDIENT_SHARE_CAP)
      .map(({ path, share }) => `${path} = ${(share * 100).toFixed(0)}%`);
    assert.deepEqual(over, [], "改它一次就要读小半棵树 —— 拆它");
  });
});

describe("standing · 没有一个模块的依赖闭包吃掉全树", () => {
  it("**闭包占比超线的只有例外表里那几个，而且没涨**", () => {
    const total = production.length;
    const over = production
      .map((file) => ({
        path: file.path,
        share: (graphClosureOf(GRAPH, file.path).length - 1) / total,
      }))
      .filter(({ path, share }) => share > (CLOSURE_RATCHET[path] ?? CLOSURE_SHARE_CAP))
      .map(({ path, share }) => `${path} = ${(share * 100).toFixed(0)}%`);
    assert.deepEqual(over, [], "它正在变成第二个 panel-server —— 拆，别喂");
  });

  it("例外表里没有已经修好的死条目", () => {
    const total = production.length;
    const stale = Object.keys(CLOSURE_RATCHET).filter((path) =>
      !production.some((file) => file.path === path)
      || (graphClosureOf(GRAPH, path).length - 1) / total <= CLOSURE_SHARE_CAP);
    assert.deepEqual(stale, [], "把它从 CLOSURE_RATCHET 里删掉");
  });
});


function exportedNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of withoutComments(text).matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|function|class|enum)\s+(\w+)/g,
  )) {
    names.add(match[1]!);
  }
  return [...names];
}

function withoutComments(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "");
}

describe("standing · 每个按钮的处理器都指向一个真的函数", () => {
  /**
   * 2026-07-29 抓到过两个死按钮：`recordBrief` 和 `waive`。
   *
   * 两次都是同一个原因：用脚本改文件时 `str.replace` 的锚点没匹配上，**它不报错，
   * 原样返回**。于是监听器插进去了，函数没插进去。表现是「按钮看着能点，按下去
   * 什么都不发生」—— 而 `pnpm check` 全绿，`node --check` 也全绿，因为
   * `ReferenceError` 只在**点下去的那一刻**才发生。
   *
   * 这就是老树那种病的活体样本：有标签、有渲染、永远执行不了（PRD §2.3）。
   * 只是这次它长在前端，而前端没有类型检查兜着。
   *
   * 这条护栏是机械的：panel.js 里每个 `addEventListener(..., () => fn())` 里的
   * `fn`，必须在同一个文件里有定义。
   */
  const panel = readFileSync(join(SRC, "web", "panel.js"), "utf-8");

  it("panel.js 里没有指向未定义函数的处理器", () => {
    const defined = new Set<string>();
    for (const match of panel.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) {
      defined.add(match[1]!);
    }
    // 箭头函数常量也算：`const foo = (x) => …`
    for (const match of panel.matchAll(/const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) {
      defined.add(match[1]!);
    }

    const dead: string[] = [];
    for (const match of panel.matchAll(
      /addEventListener\(\s*"\w+"\s*,\s*\([^)]*\)\s*=>\s*\{?\s*(?:void\s+)?(\w+)\(/g,
    )) {
      const name = match[1]!;
      if (!defined.has(name)) dead.push(name);
    }
    assert.deepEqual(dead, [], "这些处理器点下去会抛 ReferenceError");
  });

  it("这条护栏不是空转的 —— 它确实找到了处理器", () => {
    // 正则一旦被改坏，上面那条会静默变绿。这里保证它至少匹配到了几个。
    const found = [...panel.matchAll(
      /addEventListener\(\s*"\w+"\s*,\s*\([^)]*\)\s*=>\s*\{?\s*(?:void\s+)?(\w+)\(/g,
    )];
    assert.ok(found.length >= 8, `只匹配到 ${found.length} 个处理器，正则可能坏了`);
  });
});
