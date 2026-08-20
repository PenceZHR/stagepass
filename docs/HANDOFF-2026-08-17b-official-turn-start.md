# StagePass 交接 · 2026-08-17b —— 把终端这条路换成官方接口

分支：`build-the-base-2026-08-05`（主 worktree）

前一份是 `docs/HANDOFF-2026-08-17.md`，它讲的是「三层合一页」和「问人改走文件交接」。
这一份只讲一件事：**面板对终端做的三件事里，有两件今天走的不是官方路，换掉。**

环境：`codex-cli 0.147.0`；daemon 是 `codex app-server --remote-control --listen unix://`，
控制 socket `/Users/zhanghr/.codex/app-server-control/app-server-control.sock`。

---

## 一、结论

面板需要终端做三件事。官方接口三件全有，今天只有一件走的是官方路。

| 需要 | 今天怎么做 | 应该怎么做 |
|---|---|---|
| 起一个挂在指定线程上的 TUI | `do script "exec codex resume … <id>"` | 一样 —— `codex resume <SESSION_ID> --remote unix://` 本来就是官方 CLI ✅ |
| 判断这条线程还在不在 | `thread/list`（[app-server-history.ts:342](../src/codex/app-server-history.ts:342) 的 `listIncludes`） | `thread/loaded/list` |
| 给这条线程送一轮输入 | 写信封文件 + AppleScript 往标签页打字 + 补一个空 `do script` 当回车 | `turn/start { threadId, input }` |

换完之后 **AppleScript 只剩开窗 / 聚焦 / 关窗** —— 这三件本来就该它做。
原生 TUI 反而更权威：它是订阅者，流和审批都归它，面板不再靠打字去傀儡它。

---

## 二、真机证据（2026-08-17 晚，全部在运行中的面板 + daemon 上做的）

线程 `01a01286-a71e-71e3-82d6-567f9d909873`（CHG-002 / PRD，面板自己建的）。

### A. 非订阅连接可以发 `turn/start`，而且拿不到流 ✅

用仓库自己的 `connectUnixAppServer` 连 daemon，**只 `initialize`，从没 `thread/start` /
`thread/resume`**：

| turn | 结果 | 耗时 |
|---|---|---|
| `01a01288-9c65-7b90-91f3-4712114b47af` | `completed`，回「收到。」 | 5.6s |
| `01a0128b-8deb-7520-9963-38f390d1eb14` | `completed`，回「验证B已渲染。」 | 5.4s |

第二条是**在 TUI 活着的时候**发的（pid 73462, ttys000，全程没死）。
这条连接收到的通知只有 `remoteControl/status/changed` 和 `thread/status/changed` ——
**一条 `turn/*` 都没有，一条反向请求（审批 / elicitation）都没有。**

用户当场目视确认：两条回答**都出现在 TUI 里**。

→ 订阅者拿流和审批，非订阅者能驱动但拿不到流。这正是要的分工。
→ **代价**：面板收不到 `turn/completed`，完成判定继续轮询 `thread/turns/list`。
   它今天就是这么做的，不用改。

### B. `thread: missing` 的真凶 ✅

- `01a01286` 刚建出来（零轮次）：`thread/list` **查不到** → 面板报 `missing` →
  detach → 重绑。**`HANDOFF-2026-08-17.md` §三 第一条那个 churn 就是这么来的。**
- 同一时刻 `thread/loaded/list` **查得到**。
- 发完第一个 turn 后 rollout 文件出现
  （`~/.codex/sessions/2026/08/17/rollout-…-01a01286….jsonl`），
  `/api/terminal/status` 立刻从 `missing` 变 `idle`。

→ 零轮次线程不是不存在，是**还没落盘所以 `thread/list` 看不见**。

### C. 标签页秒死的原因 ✅

第一次 `/api/terminal/open` 返回 `terminal: open`，一秒后变 `stale`，`ps` 里一个
`codex resume` 都没有。等那条线程有了真 turn 之后，同样的路径、同样的命令，TUI 就活了
并且稳住。**零轮次线程 `codex resume` 挂不上去。**

### D. `thread/loaded/list` 的语义，别搞错

原文注释是 *"Thread ids for sessions currently loaded in memory"* ——
**「加载着」不等于「有客户端挂着」**。证据：TUI 死掉之后 `01a01286` 仍在 loaded 里；
被判 missing 的 `01a01279` 也一直在。

所以它答的是「这条线程还能不能恢复」，**不是**「哪个标签页跑着谁」。别拿它当活性判据。

### E. 没有被验到的

**`e21d007`（`fix: 发之前先核对终端里跑的是不是这条线程`）那段 `ps -t` 线程核对，
一次都没被执行到。** 面板进程是 07:52 起的，那段代码 21:19 才写进文件、之后才提交。
上面所有的绿跑的都是它之前的代码，跟它无关。

---

## 三、要改的

按这个顺序做。**注意第 1 步和第 2 步必须一起上**，理由见第 1 步末尾。

### 1. 存活判据换成 `thread/loaded/list`

[app-server-history.ts:342](../src/codex/app-server-history.ts:342) 的 `listIncludes`
翻 `thread/list` 分页找 id。改成先问 `thread/loaded/list`，命中就算在；
没命中再回落 `thread/list`（已归档 / 冷线程只在 list 里）。

这一步把 detach → 重绑那条 churn 掐掉。**但它不能单独上线**：§二C 证明了零轮次线程
`codex resume` 挂不上去，所以只改这一步的结果是「不再重绑了，改成开一个秒死的标签页」——
把一个坏症状换成另一个。要么和第 2 步一起上（线程建出来就有一轮，落盘了就能 resume），
要么在开 TUI 之前先确认这条线程至少有一轮。

### 2. 送输入改走 `turn/start`

[native-sessions.ts:397-419](../src/web/native-sessions.ts:397) 那一段：
`promptFiles.create` → `terminal.submit` → `waitForEnvelopeTurn`，整段换成一次
`turn/start`，turn id 从响应里直接拿（`result.turn.id`）。

**注意：不能用 `AppServerSession.startTurn`**（[app-server-session.ts:178](../src/codex/app-server-session.ts:178)）。
那个方法挂在 session 对象上，而 session 是 `thread/start` / `thread/resume` 建的 ——
**一建就订阅，审批就被抢走了**。要的是在控制连接上直接
`connection.request("turn/start", { threadId, input })`，全程不订阅。

跟着可以删掉的：`src/codex/prompt-file.ts` 整个模块、`waitForEnvelopeTurn`、
AppleScript 里的 `submit` 分支（打字 + `delay 0.2` + 空 `do script` 那个补回车的竞态）。

`turn/start` 的必填参数是 `["input", "threadId"]`；可选里有 `cwd`、`approvalPolicy`、
`model`、`effort` —— 都是「本轮及以后」的覆盖，别每轮乱传。

### 3. 零轮次线程别再单独绑

[native-sessions.ts:587](../src/web/native-sessions.ts:587) 是 `host.open` 之后立刻
`bind`。第 1 步之后 churn 已经不发生了；第 2 步之后第一轮由面板发起，线程立刻实体化。
两条都落地后这里可以只留一条断言（绑定的线程必须 loaded 或 listed），不必再抄
`90fd19e` 那套「零轮次不绑」。

### 4. 标记里带上线程 id，撤掉 `ps`

`e21d007` 那版 `ps -t <tty> -o args=` 的核对**建议撤掉**。理由不是它写错了，是它的判据是
「解析别人的 argv」，而它所有的降级方向都是 `false` → `stale` → `close markedWindow`，
**而关窗会杀掉正在跑的 turn**。codex 哪天换成 `--last`、或者 id 走 config、或者中间加一层
wrapper，它就永久失效且没有声音。

改成：`terminalMarker` 从 `hash(change, seat)` 变成
`STAGEPASS:sp_<座位20位>_<线程8位>`。AppleScript 一次字符串全等就同时回答了
「标签页在 / 是这个座位的 / 跑的是这条线程」；按 `<座位20位>_` 前缀还能扫出这个座位的
孤儿标签页，明确地关掉。

成本很低：`terminalMarker` 只有 [native-sessions.ts:137](../src/web/native-sessions.ts:137)
一个调用点现算，**没落库**，改格式不涉及迁移。

第 2 步之后这一条的紧迫性其实已经降了 —— 提示词不再经过窗口，认错窗口最多是聚焦错了，
不会再把提示词送进陌生会话。但「关错窗口」这个破坏性动作还在，所以还是要做。

### 5. 后续，这次不动

`turn/start` 有 `outputSchema`（*"constrain the final assistant message"*）——
那是官方版的「格子文件」。等上面四步稳了再看要不要换。

---

## 四、风险与没答的问题

- **`codex app-server` 在 `--help` 里标着 `[experimental]`。** 但它是这个系统里唯一被机器
  核对过的契约（[app-server-contract.test.ts](../src/codex/app-server-contract.test.ts)
  每次从真二进制重新生成 schema 核方法名和参数），而 AppleScript + `ps` 没有任何东西在核。
  这一步是把易碎面从 3 个减到 1 个，不是新增依赖。**记得把 `thread/loaded/list` 和
  `turn/start` 的参数加进那份 `REQUIRED` 基线。**
- **审批只在「没触发过」的意义上验过。** 两轮实验都没让模型跑命令，所以没有真的
  approval 请求出现。已证的是：非订阅连接**收不到**反向请求。「真有审批时它出现在 TUI 上」
  这一条是推论，不是实测。第 2 步落地后拿一轮真的会触发审批的 turn 补验。
- **`turn/start` 之后没有完成通知**，必须轮询。别在实现里等一个不会来的
  `turn/completed`。

---

## 五、这次动过的真实数据

- `~/.stagepass/panel.db` 备份在
  `~/.stagepass/panel.db.bak-2026-08-17-before-turnstart-probe`
- CHG-002 / PRD 的 binding 换成了 `01a01286-a71e-71e3-82d6-567f9d909873`
  （上一条 `01a01279…` 当时已经是 missing）
- 那条线程上多了两个测试 turn（「收到。」/「验证B已渲染。」）；
  项目目录 `/Users/zhanghr/Desktop/海战小游戏` 没有被读写
- Terminal 里开着一个挂在这条线程上的 TUI（pid 73462, ttys000）
- **我没动过任何代码**，探针都在 scratchpad，没进仓库。
  （`e21d007` 是这次会话期间落进分支的，不是这轮验证的产物 —— 见 §二E）
- 用户当天把此前所有 codex session 归档并删除了 —— 旧 threadId 查不到 rollout 是正常的，
  不是故障

---

## 六、启动方式没变

**从你自己的 Terminal 起**，不要点代码块的 Run 按钮：

```bash
cd /Users/zhanghr/Desktop/stagepass && pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```
