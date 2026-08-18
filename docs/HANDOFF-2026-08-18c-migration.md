# StagePass 交接 · 2026-08-18c —— 从网页端迁到插件，迁到哪了

> 接 `HANDOFF-2026-08-18b-plugin-only.md`（定案：只做插件）。
> 这份记的是**迁移本身**：哪些路已经在插件里跑通、哪些还没接、下一个人从哪继续。

## 一、一句话状态

**看的那一半全接完了，做的那一半接了大部分，`pnpm check` 1145 全绿。**
插件自给自足：不起 HTTP 服务、不连端口、机器上不需要任何东西在后台跑着。

```bash
pnpm plugin     # 构建 + 装到 ~/.codex/plugins/cache/stagepass-local/stagepass/0.0.1
pnpm preview    # 在浏览器里看同一份产物、同一个数据口（开发工具，不是产品）
```

**装完必须开一条新的 Codex 会话** —— MCP server 按会话起，覆盖文件不影响已开着的会话。
判据：`ps` 里没有插件进程 ＋ `plugin.log` 里没有新 `tools/call` ＝ 新代码一次都没跑过。

## 二、路由清单：接上了什么

| 路径 | 状态 | 落在哪 |
|---|---|---|
| `GET /api/panel` | ✅ | `plugin/panel-data.ts` → 真 `panelView` |
| `GET /api/parallel` | ✅ | `plugin/api.ts` |
| `GET /api/rubric` | ✅ | `app/edit-rubric` 的 `rubricFor` |
| `GET /api/artifact` | ✅ | `plugin/api.ts`（两道闸：必须是这个阶段报出来的、必须在项目目录里） |
| `GET /api/graph`、`/api/file` | ✅ | `plugin/repo-routes.ts` |
| `GET /api/stage-artifacts`、`/api/stage-file` | ✅ | 同上 |
| `POST /api/answer` | ✅ | `plugin/actions.ts` |
| `POST /api/waive` | ✅ | `app/waive` |
| `POST /api/change`、`/api/project` | ✅ | `app/workspace` |
| `POST /api/rubric` | ✅ | `app/edit-rubric` 的 `saveRubric` |
| `POST /api/aside` | ✅ | `store/aside-store` |
| `POST /api/run` | ✅ | `plugin/runtime.ts` —— **执行通道** |
| `POST /api/ask` | ✅ | `app/decide-gate` + 执行通道的 rerun |
| `GET /api/progress` | ❌ | 要 `AppServerHistory` 的进度视图 |
| `POST /api/brief`、`/api/brief-draft`、`/api/brief-confirm` | ❌ | 要执行通道里的「起草」那条 |
| `POST /api/close` | ❌ | 要座位的收尾 |

没接的**明着回 501 + 一句人话**（`reason` 字段），不静默。
上面那些 `409` 不是没接 —— 是「这个目录不是 git 仓库」，诚实的拒绝。

## 三、新加的模块

```
src/plugin/
  server.ts        进程边界（stdio JSON-RPC）。230 行，全是管道，不拿主意
  api.ts           只读的数据口。GET 走这里
  actions.ts       会改库的那些路。POST 走这里
  repo-routes.ts   要读仓库的四条（产物/图谱）—— 唯一的动态 import 边界
  panel-data.ts    /api/panel 的载荷，调真 panelView，不是第二份 view
  runtime.ts       执行通道：懒起 app-server daemon，派轮
  seats.ts         座位 = 一个 (Change,阶段) 绑着的 Codex 会话
  workspace.ts     跟着 Codex 的工作目录认项目
  sqlite-handle.ts 用 node:sqlite 顶 better-sqlite3 的形状（插件没有 node_modules）
  widget/          prelude.js / widget.css / background.jpg
scripts/
  plugin-build.ts  pnpm plugin
  plugin-preview.ts pnpm preview
```

### 两个库句柄，不是一个句柄两种用法

`api.ts` 拿**只读**打开的句柄 —— 「看一眼」在物理上就不可能写坏什么。
`actions.ts` 拿另一个**可写**的，第一次要写时才打开、那时才跑迁移。
靠纪律共用一个句柄迟早会在某次改动里失效。

### 懒加载两处，都实测过

- **TypeScript 编译器**（产物/图谱要它）：`splitting:true` + 动态 import，
  启动仍是 **110~120ms**，`typescript` 启动时不在 `require.cache` 里。
  急切加载实测会让启动翻倍（→200ms）、堆多 21MB，而多数会话不看那两屏。
- **app-server daemon**：第一次真派轮才拉起来。只看不跑的会话一个子进程都不起。

## 四、必须先解决的一件事：审批归谁

**这是下一个人接手时最该先想的。**

StagePass 起的 turn，它自己就是订阅者，所以审批 / elicitation 会打回**插件这条控制
连接**，而不是打给在 Codex App 里看着的人。`runtime.ts` 把它们交给
`AppServerSessionHost` 按 threadId 路由到对应会话（记进 `interactions`），
**但目前没有任何界面在答它们** —— 一个要审批的 turn 会停在那里。
`seats.quietForMs()` 会显示它很久没动静，那正是这个字段存在的理由。

两条出路，都没做：

1. 给 StagePass 起的 turn 设一个不问的 `approvalPolicy`（现在是 `on-request`，
   和旧面板一样 —— **没有偷偷改安全姿态**）；
2. 把待答的 interaction 画到面板上，让人在 widget 里答。

第 2 条更符合这套东西的本意（人要看得见、要能介入），但它要先有个地方画。

## 五、还没验过的（重要）

- **执行通道从来没在真机上跑过一轮。** `/api/run` 的路由、判据、翻译都有测试，
  但「真的开一条 Codex 会话跑完一轮」在插件里一次都没发生过。第一次跑会撞上什么，
  最可能是上面那条审批。
- **`/api/stage-artifacts` 没在真数据上验过** —— 库里唯一有 Change 的项目
  （海战小游戏）不是 git 仓库，而唯一的仓库（demo）没有 Change。要验得先造一个组合。

## 六、护栏上的一处判断，需要复核

**`plugin/server.ts` 的依赖闭包到了 92%，和当年 panel-server 一个数。**
我抬了棘轮而不是拆代码，理由写在 `architecture.test.ts` 的注释里：

插件入口是**整个产品唯一的入口**，够得着全树是同义反复。panel-server 当年的真问题是
它自己 2177 行、`handle()` 484 行；`plugin/server.ts` 现在 230 行全是管道，拿主意的
都在 api / actions / runtime / seats 里各自有测试。真正在管这件事的是另外两条护栏
（配料单不许过 30%、单个函数不许长成一层），它们都没红。

**但这仍然是「改护栏来迁就自己的代码」的边缘。** 更干净的做法是让闭包护栏
**排除声明过的入口**，而不是给入口一个越抬越高的棘轮。没做，留给复核的人定。

## 七、被删掉的（这一天总计 8000+ 行）

```
scripts/panel.ts                面板进程入口
src/web/panel-server.ts         2177 行 HTTP 路由（+ 测试）
src/web/panel-listener.ts       端口占用（+ 测试）
src/web/terminal-api.ts         终端 HTTP 边界（+ 测试）
src/web/terminal-bridge.js      终端门户前端（+ 测试）
src/web/graph-api.ts            图谱的 HTTP 壳
src/web/stage-artifact-api.ts   产物的 HTTP 壳（+ 测试）
src/web/native-sessions.ts      座位=Terminal 窗口（675 行 + 570 行测试）
src/system/terminal-app.ts      驱动 macOS Terminal（+ 测试）
src/seat/seat-terminal.ts       终端座位适配器（+ 测试）
src/panel-entry.test.ts
panel.html/panel.js 里的 Projects 那一列、新建项目弹层、终端门户
```

**没删**（丢了调用者，不是死了）：`app/*` 的用例、`work/round-*` 引擎、`db/schema`、
`graph/*`。它们零入边的唯一原因是唯一的调用者 `panel-server.ts` 被删了，而它们正是
插件接下来要接的东西。照着「零入边」删会把产品掏空。

## 八、几条会咬人的实测结论

- **Codex widget 的全局是只读的** —— 改 `window.setTimeout` 直接抛，整个脚本当场死。
- **widget 里不许导航** —— `location.search = …` 会把它打死。panel.js 现在用
  `goTo()` 原地重画（两边都变好了，没有一边是迁就）。
- **`threadSource:"user"`** 决定线程进不进 Codex App 的项目分类。这个差异
  **在 API 层完全看不出来**，只有 `state_5.sqlite` 的 `threads.thread_source` 不一样。
- **回一个正确的状态码不等于把话说清楚了。** 501 少了 `reason` 字段，界面显示的是
  「没问成：undefined」，人报的是「没反应」。守的是那句人话在不在。
- **`thread/list` 的返回键是 `data`**，不是 `threads`/`items`。
