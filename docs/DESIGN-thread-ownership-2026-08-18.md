# 线程归谁：StagePass 订阅，还是人订阅（2026-08-18）

> 用户真机报告：在插件里点「跑这个阶段」，轮真的跑起来了，但 Codex App 里点开那条
> 线程显示 **"This is open in another app. Close it there to continue here."**，
> 而且看到的内容有延时。
>
> 这份原本是**动手之前的代价清单**（用户选了「先盘清楚」）。
> **2026-08-18 用户定案，见第八节 —— 账已经不用算了，方向定了。**

## 一、症状不是 bug，是一个设计选择的必然结果

一条 Codex 线程同一时刻只能被**一个客户端 attach**。

StagePass 今天用 `thread/start` 开线程（`seats.ts` → `AppServerSessionHost.open`），
于是**它成了那条线程的订阅者**。人在 App 里点开同一条线程，App 只能说「它在别处开着」。

这枚硬币的另一面就是交接 §四 那个没定的问题：**审批归订阅者**。StagePass 订阅着，
所以审批 / elicitation 打回插件这条控制连接，而没有任何界面在答它们。

| 谁订阅 | StagePass 拿到 | 人拿到 |
|---|---|---|
| **StagePass（今天）** | 完整事件流 | 线程看得见、**打不开、打不了字、审批不归他** |
| **人（App）** | 拿不到流 | 能打开、能接着聊、审批弹给他 |

## 二、那条流今天到底供了什么 —— 只有三样

全树 grep 过，消费事件流的只有这三处：

| # | 谁在用 | 用来做什么 | 位置 |
|---|---|---|---|
| 1 | `AppServerSession.awaitTurn` | 等 `turn/completed`，并交出**最终文本** | `app-server-session.ts` |
| 2 | `PluginSeats.watch` | 记 `lastEventAt` → `quietForMs`（多久没动静） | `seats.ts:203`，**一行** |
| 3 | `onServerRequest` → host | 审批 / elicitation 路由 | `runtime.ts` |

第 3 条**正是我们想失去的那个**。

## 三、那份「最终文本」有人用 —— 而它不必来自流

`round-runner.ts` 拿 `delivery.text` 做四件事：

```
524  readConclusion(delivery.text)          这一轮的结论
526  readVerdicts(delivery.text).unreadable 判定读不读得出
561  judge: delivery.text                   记进证据
574  transcripts.judge                      交接给下游
```

而 `AppServerHistory.readThread()` 返回的 `ThreadHistory` 里**已经有 `lastCompletedText`**
（连同 `turnCount` / `status` / `childThreadIds` / `contextUsage` / `userMessages`）。

**所以第 1 条是可替代的，不是会丢的。** 换的是取法：从流里接 → 轮询着读。

## 四、不依赖流、一个字都不用改的（这是大头）

- **进度那一屏**的 `spawned` / `stage` / `context` —— 走 `history.readThread`，本来就不是流
- **红蓝两方是谁**（`childThreadsOf`）—— history
- **红蓝两方说了什么**（`readThreadTranscript`）—— history
- **一轮的产出**（格子文件 / round 文件）—— 文件系统
- **账本的一切**（job / 状态机 / 证据 / gap / rubric）—— 库
- **座位绑定**、并行座位、闸门、裁决、豁免、brief —— 全部

## 五、改了会真的失去或变差的

### 5.1 `quietForMs` 会变粗（唯一真正的损失）

它现在是「这条线程最后一次收到事件到现在多久」。没有流之后只能从轮询推 ——
**分辨率从「事件级」掉到「轮询间隔级」**。

它的用途是把三种「在跑」分开：真在跑 / 进程死了 / 活着但卡住。第三种正是**等审批**
那种卡住 —— 而改完之后审批归人，这一格的意义反而下降了。

### 5.2 完成判定会晚一个轮询间隔

一轮实测 60~343 分钟。晚 5~15 秒，可忽略。

### 5.3 多一份轮询负载

一轮期间每隔 N 秒一次 `thread/read`。和 widget 现在每 5 秒一次 `/api/stage-artifacts`
同量级（那个已经在跑）。

### 5.4 「一轮跑完了」这件事本身要新写一段

现在是 `awaitTurn` 等通知。换成轮询 `thread/read` 比 `turnCount` / `status` ——
**这段代码今天不存在**，要新写并测。`app-server-history.ts` 里已有的轮询判定
（`thread/loaded/list` + `thread/list`）解决的是「线程还在不在」，不是「这一轮完了没」。

## 六、已经验过的、和还没验的

### 已经验过（08-17b 真机，两次）

**非订阅连接可以发 `turn/start`**，两条都 `completed`（5.6s / 5.4s）。其中第二条是
**在别人 attach 着那条线程的时候**发的（一个活的 TUI，pid 73462，全程没死）。
那条连接「一条 `turn/*` 都没收到」—— 正是这个设计要的形状。

### 还没验（动手前必须先答）

1. **StagePass 能不能开完线程就放手。** 开线程要 `thread/start`（那一刻它是订阅者），
   之后 `host.close(threadId)` 放掉。**放掉之后 App 能不能 attach，没验过。**
2. **没有人 attach 时，要审批的 turn 会怎样。** 今天是 StagePass 收着不答（挂住）。
   改完之后如果人也没打开，是挂住、还是按 `approvalPolicy` 自己走？**这条决定了
   「无人值守」还成不成立。**
3. **零轮次线程的老问题。** 刚 `thread/start` 还没跑过 turn 的线程不进 `thread/list`
   （记忆里那条），人在 App 里能不能找到它去 attach？

## 七、账的总结

**会丢的**：一格分辨率（`quietForMs`），而它的意义正在下降。
**要新写的**：一段轮询完成判定（几十行 + 测试）。
**要先验的**：三条，全都不需要写产品代码，是真机实验。
**换来的**：线程归人 —— 能点开、能接着打字、**审批弹到他面前**。而这正是
`stagepass-no-exec-only-tui` 那条老规矩的**理由**（「人要看得见它跑」），
08-18 换通道时以为 `threadSource:"user"` 能保住它，现在看只兑现了一半。

**判断：这笔账划算。** 代价集中在一处可测的新代码上，而收益是把交接 §四 那个悬着的
问题一起解决掉 —— 审批不再需要「给它一个界面」，它本来就该在人手上。

**但先做第六节那三条实验。** 第 1 条不成立的话，整条路走不通；第 2 条的答案决定
「无人值守」这件事的形状。两条都不写产品代码就能答。


## 八、定案（2026-08-18 用户原话）

> 「stagepass 不需要拿到流啊，我只要在相应的 session 看到就行了，stagepass 需要回到
> 最精简的状态，但是需要完整的 session 监控。」

三句话，各定一件事：

### 「不需要拿到流」—— 订阅权让出去

StagePass 不再 attach 那条线程。第五节里唯一真正的损失（`quietForMs` 的分辨率）
就此接受；`delivery.text` 改从 `ThreadHistory.lastCompletedText` 取。

### 「在相应的 session 看到就行」—— 线程归人

那条线程在 Codex App 里能点开、能接着打字、能看到流。这正是老规矩
（`stagepass-no-exec-only-tui`）那句「人要看得见它跑」的**原义**，而 08-18 换通道时
以为 `threadSource:"user"` 能保住它 —— 现在承认只兑现了一半，用这条补上。

### 「最精简」+「完整的 session 监控」—— 这两句不矛盾，它们划出同一条线

**精简**说的是**持有**：不 attach 线程、不占订阅位、不当中间人、不替人收审批。
**完整监控**说的是**读**：一轮跑完没有、裁判说了什么、派生了哪两条子线程、
两方各自说了什么、上下文离墙多远 —— 一样都不能少。

这条线是可以划的，因为**监控要的全部来自 `thread/read`，不是流**：

| 要监控的 | 来源 | 今天就有吗 |
|---|---|---|
| 这一轮完了没 | `turnCount` / `status` | 字段有，**轮询那段要新写** |
| 裁判说了什么 | `lastCompletedText` | ✅ |
| 派生了哪两条 | `childThreadIds` | ✅ |
| 两方说了什么 | `readThreadTranscript` | ✅ |
| 上下文用量 | `contextUsage` | ✅ |
| 线程还在不在 | `thread/loaded/list` + `thread/list` | ✅ |

**只有第一行要新写。** 其余全是现成的，而且本来就没走流。

### 审批：走钩子，不走订阅（用户同日提出）

Codex 有 `permission_request` 钩子。审批交给一个钩子程序：写进 StagePass 的库 →
面板上画出来 → 人按 → 钩子返回 `permissionDecision`。

这样审批**既不归 StagePass 的连接、也不要求人正好 attach 着**——它和订阅权彻底解耦。
于是第六节那条「没人 attach 时要审批的 turn 会怎样」不再是拦路的未知。

## 九、按这个定案，还剩几条未知

1. **开完线程能不能放手让 App attach**（第六节第 1 条，仍然是拦路的那条）
2. **`permission_request` 会不会为 daemon 里跑的 turn 触发** —— 钩子那条路的生死判据
3. 零轮次线程在 App 里找不找得到（第六节第 3 条）

三条都不写产品代码就能答。第 2 条要往 `~/.codex/hooks/hooks.json` 装一个只记日志的
探针 —— **那是改用户的 Codex 配置，动手前要问。**
