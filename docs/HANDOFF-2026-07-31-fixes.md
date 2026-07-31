# 交接：接着修（2026-07-31）

> **这一份是给动手的人看的**，不是流水账。历史在 `HANDOFF-2026-07-30.md`（那份已经
> 堆成九段追记，只在你要查「这条为什么是这样」的时候翻它）。
> **PRD `docs/PRD-stagepass-rebuild-2026-07-28.md` 仍是唯一权威。**

## 一句话

十一个阶段**全部在真 Codex 上跑通过一整轮**，`pnpm check` **599 全绿**，工作树干净，
全部已推 `origin/main`。剩下的问题按「值不值得先修」排在 §三，**第一条最值钱**。

```bash
pnpm check      # 599 个测试 + 严格 typecheck，全离线
node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db
```

---

## 二、动手之前必须知道的（不知道会白改一天）

### 2.1 一轮对抗现在长什么样

```
StagePass 派一个 turn 给「裁判」
  裁判派生两个子 Agent（用它手上任何一个 spawn 工具）
    正方  产出 / 审 / 跑        —— 按阶段不同
    反方  挑正方的毛病
  裁判对**已经存在**的 gap 逐条表态，并**把两个子 Agent 的 agent_id 报进答案**
StagePass 拿那两个 id 去读它们各自的 rollout 原文
```

**最后那一步是 2026-07-30 换掉的，别改回去。** 原来靠 Codex 私有库里的
`threads.agent_path` 认红蓝，而那一列**只有原生 `spawn_agent({task_name})` 会设，
那个工具不是每个会话都有** —— 没有它的会话里每个阶段的每一轮都跑不了。
现在裁判报指针、StagePass 读原文，「不经裁判转述」那条保证没有被削弱。

推论，写成了测试：**提示词里不许指定或禁止某个 spawn 工具** —— 那是在替一个我们不
控制的工具集做假设。我为此白烧过三轮。

### 2.2 每个阶段的形状（三条判据，各只有一处定义）

| 阶段 | 红方干什么 | 它的发现算不算 | 蓝方够得着 | 产出 |
|---|---|---|---|---|
| PRD…TestPlan | 写自己那份文档 | 不算（自审） | 只看产出 | 文件路径 |
| Build | 按 Plan 写代码 | 不算（自审） | 改动涉及的文件 + 直接调用方，不跑 | **commit** |
| Review | 审 Build 的代码 | **算** | 被审 commit 涉及的文件 + 调用方，不跑 | 报告 |
| Fix | 改被报出来的问题 | 不算（自审） | 同 Build | **commit** |
| QA | 跑 Build 的代码 | **算** | 能读**也能跑** | 报告 |
| Merge | 写交付说明 | 不算（自审） | **这一次的全部 commit** | 文档 |
| Retro | 写复盘 | 不算（自审） | 只看产出 | 文档 |

- `redReviewsOthers`（[phase.ts:109](../src/domain/phase.ts:109)）—— Review / QA。
  判据是「红方交出来的是不是对**自己**作品的评价」。
- `producesCommit`（[phase.ts:136](../src/domain/phase.ts:136)）—— Build / Fix。
  它**同时决定产出形态和要不要查干净树**。这两件事不许分开：要 commit 却不查干净树，
  会把人没提交的活儿卷进去；查了却不 commit，是白拦人一道。
- `ID_PREFIX`（[round.ts:190](../src/domain/round.ts:190)）—— 和第一条**必然是同一批**：
  只有红方发现也算数的阶段，两边才共用一个 id 空间，撞了会静默丢一条。

**加一个阶段进任何一条，就要检查另外两条。** 注释里写了，这里再写一次。

### 2.3 rubric 现在谁判谁

```
producer  蓝方判红方        这一轮的产出够不够格
critic    裁判判蓝方        这一轮挑问题挑得怎么样
verdict   谁都不判 → 交给人  弹窗里对照裁判的表态自己看
```

**没有人给自己打分**（2026-07-30 拍板）。依据是实测的：改之前红方自评累计 20 条
**全部 yes，一个 no 都没有**。

**一个参与者只能背一份标准**，这是硬约束不是审美：`readAssessments` 见到 fence 里有
不认识的 key 会**作废整份**，两份塞给同一个人就是两份一起作废。所以这条链只能是这个
形状 —— 想加第四份判定之前先解决这个。

---

## 三、还剩什么问题（按值不值得先修排）

### A. rubric 这一整层今天对闸门零影响 ← 最值钱

两件事叠在一起，各自都不算大，合起来让这一层等于没有。

**A1. 三分之一的判定压根没答上。** 今天全程 51 条判定里 **16 条 `not_assessed`**：

```
Build   21 yes + 6 no      ← 好
Fix      4 yes + 4 no      ← 好
Merge    4 yes + 4 no      ← 好
QA       4 yes + 4 not_assessed
Retro    4 yes + 4 not_assessed
Review   8 not_assessed    ← 一条都没答
```

缺的那一侧多半是**裁判**（critic 那份由它答）。它一个 turn 里要派生两个子 Agent、
等它们跑完、对所有旧 gap 逐条表态、再答两份 rubric —— 活儿太多，最后那件最容易掉。

`not_assessed` 本身是诚实的（fail-closed，标了阻断的漏答会挡门），但今天没有一条
标阻断，所以它的后果是「这一轮 rubric 判过了」这句话有三分之一是空的。

**A2. 出厂标准一条都不阻断。** 这是拍过板的，理由写在
[rubric-defaults.ts](../src/domain/rubric-defaults.ts) 开头：出厂就阻断 = 任何一次漏答
立刻给每个项目挂上挡门的东西，而人还完全不知道 rubric 是什么。

但两条叠起来的后果是：**判 `no` 也好、漏答也好，闸门都不看**。今天 Build 判了 6 条
`no`、Fix 4 条、Merge 4 条 —— 一条都没挡住任何东西。

> **我的方案（要先跟人确认）**：
> 1. 每个阶段挑**一两条**最要紧的标成阻断。这件事该由人在面板上做（rubric 是网页上
>    唯一能改的东西），不该我改默认值 —— 改默认只影响新项目（`installDefaults`
>    跳过已有的），而且会翻掉一条拍过板的规矩。
> 2. **把裁判那一轮的负担减下来**，这是 A1 的正面修法。可选：把 critic 那份 rubric
>    从裁判身上挪走（但挪给谁？红方不行 —— 那是自审的反面，蓝方也不行 —— 那是自评）；
>    或者让裁判**分两次**答（先裁决、再判 rubric），代价是多一个 turn。
>    **这一条我没想清楚，别照着做，先想。**

### B. 库里有一批在 bug 下产生的数据（只需知道，不必动手）

**CHG-002（用户真库）** 停在 `PRD/settled`，三条 gap 记在第 3 轮。**那次续跑是在
「第二轮读到第一轮」那个 bug 下跑的**（子 Agent 线程跨轮复用，而读的时候永远从头扫），
所以那三条的状态未必反映真实的第二轮。

bug 本身已修（`findLastCompletedTurn`）。账本 append-only，**不要去改它** ——
下次动 CHG-002 之前知道这件事就够了。

### C. 会烦你的

**C1. 上游产物不在磁盘上，要烧一整轮才发现。**
今天 Review 的红方把产出报成 `RV-index-html`，磁盘上没有这个文件；QA 和 Merge 的
四个角色各自独立发现了它（下游兜住了，系统行为是对的）。但一轮几分钟只为发现
「输入不见了」可以省。

> 方案：在 `runRound` 里加第五道派发前预检（已有四道：brief / path / trust / dirty），
> 检查当前阶段的上游 artifactIds 在不在。**注意 Build/Fix 的产出是 sha 不是路径 ——
> 用 `looksLikeSha`（[repo.ts](../src/work/repo.ts)）分开，sha 走 `git cat-file -e`，
> 路径走文件存在性。** 判据要和 `/api/artifact` 那边同一个，别另算一套。

**C2. `/api/run` 还是 await 整一轮**（[panel-server.ts:640](../src/web/panel-server.ts:640)）。
进度轮询让界面不再沉默了，但那个 POST 本身几分钟才回来。

> 方案：派完就返回 `{queued, jobId}`。`TurnLoop.runOnce` 的失败已经落库，不 await 是
> 安全的。代价：`/api/ask` 的 `continued` 字段和几个测试要从「等结果」改成「等派发」。

**C3. 续跑之后你看的那个终端是死的。** 服务端关掉旧会话再起新的，浏览器还连着旧的
那条流，而 `panel.js` 里**没有任何重连**（grep `reconnect` 得 0）。

> 方案：那条流结束时自动重连一次。注意别和「进程真的死了」搞混 —— 后者要让人看见
> 尸体（`onExit` 留的最后一屏），不能默默重连成一个空终端。

### D. 结构性的，还没咬人

- **项目 / Change 删除路径至今不存在**。谁第一个写必须一并处理 `rubrics.project_id`
  的外键（REMAP §4.3）。
- **面板没有任何身份概念** —— 任何能打开 `localhost:4173` 的东西都能推闸门。
  今天靠环境成立，不靠设计成立。
- `verify:decision` 还走 osascript，没改成派发进面板。
- 阶段侧栏（用户说过先不做）。

### E. 不在我们手里的（都已绕开，记着免得重新排查）

- **原生 `spawn_agent` 时有时无。** 同一天同一台机器，几小时前有、后来没有。已经不
  依赖它了。**如果又冒出「找不到子 Agent」，先查这个，别去改提示词。**
- **Codex 会成批归档线程**（实测 51 条 / 12 秒）。已自动解归档
  （[archive.ts](../src/codex/archive.ts)）。
- **目录信任不继承，按 git 根算。** 已在派发前预检（[trust.ts](../src/codex/trust.ts)）。
  **验收用的工作区不要 `git init`**，除非你打算让用户自己去答一次信任提问 ——
  **绝不要替他答**，那会往他的 `~/.codex/config.toml` 里写东西。

---

## 四、怎么验（照着做，别自己发明）

### 4.1 一次性库 + 一次性工作区，绝不在用户真库上验

```bash
V=.stagepass/verification/<你的名字>          # 这个目录被 gitignore
mkdir -p "$V/workspace"
node --import tsx scripts/panel.ts --port 4175 --db "$V/panel.db" \
  --change CHG-1 --project-name x --project-path "$(pwd)/$V/workspace"
```

用户真库是 `~/.stagepass/panel.db`，跑在 4173 上。**在共享的库上你分不出自己的动作和
用户的动作** —— 2026-07-30 为此排查了十几分钟，最后靠用户一句「是我按的」收场。

### 4.2 几个会浪费你时间的坑

- **Bash 的 curl 连不上 localhost**（沙箱拦的，任何端口都返回空）。用 Browser pane 的
  `javascript_tool` 里 `fetch`。
- **`preview_start({name})` 起不来**（spawn 出的进程 cwd 是 `/` 且不可读）。
  用 Bash 后台起进程 + `preview_start({url})` 开标签页。
- **`/api/run` 要几分钟才返回**，所以用 `Monitor` 盯库，别 await 那个 fetch。
- **一轮跑完 TUI 不会退出**，下一次派发会撞 `phase_already_running`。
  先 `POST /api/close?change=…&phase=…`。
- **跑一轮之前别进那个阶段的终端** —— 会把正在跑的那一轮挤掉。
- **`ps` 会把非 ASCII 转义**，所以别用它 grep 中文提示词。从 rollout 文件读原文。

### 4.3 把一个 Change 摆到某个阶段

离线走状态机（L1 那条「假答案」纪律）：

```ts
new ChangeStore(db).apply("CHG-1", "start");    // pending -> running
new ChangeStore(db).apply("CHG-1", "settle");   // running -> settled
new ChangeStore(db).apply("CHG-1", "approve");  // settled -> 下一个阶段
```

**注意 `approve` 只在 `settled` 合法** —— `Review/pending` 上直接 approve 会抛
`IllegalTransitionError`，要先 start + settle。换阶段之后**放开旧绑定**
（`new BindingStore(db).detach(changeId, phase)`），让新阶段开一条干净的裁判线程。

---

## 五、今天新增的坑（其余见 07-30 那份 §七）

| 事实 |
|---|
| **Codex 有两个 spawn 入口，只有原生 `spawn_agent({task_name})` 设 `agent_path`**，而它不是每个会话都有。已不依赖，但「找不到子 Agent」先查这个。 |
| **`git status --porcelain` 会把非 ASCII 文件名转义成八进制**（`"\350\215\211…"`）。要原样路径用 `-z`。 |
| **JavaScript 的正则没有 `\z`**（那是 Perl 的）。写进去会被当成字母 z，整个 lookahead 静默失效。 |
| **子 Agent 的线程跨轮复用**，一条 rollout 里躺着这个阶段每一轮的答案。读的时候要取**最后**一个完成的 turn。 |
| **`readAssessments` 见到 fence 里有不认识的 key 会作废整份** —— 所以一个参与者只能背一份 rubric。 |
| **模型可能不包 ```json 围栏**。三个解析器现在共用 `jsonAnswerIn`（没围栏就挖最后那个完整对象）—— 别只改其中一个，那种「红方漏了能读、裁判漏了读不了」的差别咬过一次。 |
| **`installDefaults` 只补空缺**，所以改 `rubric-defaults.ts` 只影响新项目，已有项目保留它们当初装上的那一份。 |

---

## 六、下一轮开场

```bash
node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db
```

用户真库里现在有：

| | |
|---|---|
| PRJ-001 stagepass | `/Users/zhanghr/Desktop/stagepass` |
| PRJ-002 捕鱼达人 | `/Users/zhanghr/Desktop/捕鱼达人` |
| CHG-001 | PRJ-001 · PRD/pending · 有需求 |
| **CHG-002 建立项目骨架** | PRJ-002 · **PRD/settled** · 3 条 open gap（见 §三·B）· 有产出 |
| CHG-003 加一个排行榜 | PRJ-002 · PRD/pending · 有需求 |

`.stagepass/verification/build-0730/` 里那套（CHG-1 走完十一个阶段的完整数据 +
一个真 git 工作区）**留着没删** —— 要复现任何一个阶段的行为，从那儿起最快。

**先做哪件**：C1 最便宜（半天，机械）。A 最值钱但**要先和人谈**（它牵扯一条拍过板的
规矩，而且 A1 的修法我没想清楚）。B 只需要知道。
