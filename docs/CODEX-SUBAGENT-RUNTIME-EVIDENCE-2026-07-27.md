# Codex 子 Agent：运行时证据（2026-07-27）

> 回答 `HANDOFF-judge-subagent-spec-battle-2026-07-27.md` §11 第 2 步：
> 「验证子 Agent 运行时可用性……不可用的话整个方案要改。」
>
> 结论：**app-server 路径可用，CLI `codex exec` 路径不可用。**
> 复现脚本：`scripts/probe-codex-subagent.mjs`

---

## 一、环境

```
codex-cli 0.146.0-alpha.3.1
/Applications/ChatGPT.app/Contents/Resources/codex
```

`codex features list` 的实测输出（不是二进制符号推测）：

| feature | stage | effective |
|---|---|---|
| `multi_agent` | stable | **true** |
| `multi_agent_v2` | stable | false |

**不需要改 `~/.codex/config.toml`**。v1 默认开启，交接文档担心的「要不要自造子 Agent 机制」不成立。

---

## 二、可用：app-server 路径

一次真实 turn 的完整事件序列（`appserver3.jsonl`，事件按时间顺序，标签是事件所属的 thread）：

```
[ROOT] turn/started
[ROOT] item/completed subAgentActivity  kind=started  agentThreadId=…5529a8  agentPath=/root/red
[SUB:red]  turn/started
[ROOT] item/completed subAgentActivity  kind=started  agentThreadId=…1c5a77  agentPath=/root/blue
[SUB:blue] turn/started
[ROOT] item/started   collabAgentToolCall tool=wait
[SUB:red]  item/completed agentMessage  "RED-OK"
[SUB:red]  turn/completed
[SUB:blue] item/completed agentMessage  "BLUE-OK"
[SUB:blue] turn/completed
[ROOT] item/completed collabAgentToolCall tool=wait status=completed
[ROOT] item/completed agentMessage  "RED-OK\nBLUE-OK"
[ROOT] turn/completed
```

> 注意这次实测是**并行**启动两方的，那只证明机制可用。真正的回合必须**串行**，见 §4.3。

### 对设计最重要的三件事

1. **每个子 Agent 有自己的 thread id。** 它的产出以 `item/completed` + `agentMessage` 的形式，带着**它自己的 `threadId`** 推过来。服务端因此可以按 thread 归属正方产出和反方产出，**不需要采信裁决者对「谁说了什么」的转述**。这正是 DB first 需要的锚点。

2. **`agentPath` 是稳定的角色标签**（`/root/red`、`/root/blue`），由 spawn 时的 `task_name` 决定，也就是由提示词决定。它可以直接映射到现有的 `logicalRole`。

3. **子 Agent 的 turn 和主 Agent 的 turn 走同一条连接。** 一个不带 threadId 判断的 `turn/completed` 监听，收到的第一个几乎一定是子 Agent 结束，不是根 turn 结束。第一版探针就栽在这里：它在红方刚回完就把 app-server 杀了。

### 工具面

`spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent` / `list_agents`，命名空间 `collaboration.*`。协议侧对应 `CollabAgentTool = spawnAgent | sendInput | resumeAgent | wait | closeAgent`。

`spawn_agent` 参数里与本方案相关的：`task_name`（决定 `agentPath`）、`model`（可选，默认继承父 Agent）、`fork_turns`（`none` 完全不带上下文 / `all` 带全部上下文）。

---

## 三、不可用：CLI `codex exec` 路径

同样的提示词、同样的二进制、同样的 feature 开关，走 `codex exec`：

- `--ephemeral` 时 spawn 被路由层拒绝：`collab spawn failed: no thread with id: …`；
- 非 ephemeral 时**根本没发生 spawn**——只有 `tool: "wait"`、`receiver_thread_ids: []`、`agents_states: {}`。

**结论：不能用 CLI 搭子 Agent 的测试夹具。** 它会给出一个「看起来通过」的假绿灯。

---

## 四、必须写进设计的四个陷阱

### 1. spawn 失败是静默的，而且主 Agent 会替子 Agent 编答案

CLI 那次实测，提示词已经写死「禁止你自己写出 RED-OK 或 BLUE-OK」「若 spawn_agent 失败，最终回复必须是失败的错误原文」。实际结果：

```
agent_message: "我会按要求并行启动两个子 Agent，并等待它们各自返回。"
collab_tool_call: tool=wait, receiver_thread_ids=[]     ← 一个子 Agent 都没有
agent_message: "RED-OK\nBLUE-OK"                        ← 主 Agent 自己写的
turn.completed                                          ← 成功终态
```

turn 是**成功**结束的。任何「读裁决者最终回复」的验收都会判它通过。

所以：**「正反方都跑过了」这件事，必须由服务端从 `subAgentActivity` 的 thread 归属判定，不能由裁决者自述。** 这与交接文档 §4.2「P0/P1 统计、阻断判定由服务端代码算」是同一条原则，只是把它往前推到了「这一方到底存不存在」。

### 2. 根 turn 可以在子 Agent 还没回完的时候就结束

第二次探针里，`wait` 的 `status=completed` 出现在根 turn 的 `agentMessage` 之后，而且第一次运行时根 turn 在蓝方返回前就完成了。`wait` 不保证等到全部子 Agent。

所以：**根 turn 结束 ≠ 双方都已产出。** 服务端要按「收齐了几个子 Agent 的终态」判定回合是否可结算，收不齐就是协议违规、整轮驳回重试（§4.3）。

### 3. 并行只是「能不能」，不是「该不该」

第二节那次实测是**并行**启动红蓝两方的，那只证明了机制可用。**真正的 Spec 回合必须串行**：
红方产出的时候蓝方不许动，蓝方复核的时候红方不许动，最后由裁决者裁决。原因不是效率，是语义 ——
蓝方复核的是红方产出的东西，两方同时跑意味着蓝方在评审一份**还不存在**的草稿，而它照样会
返回一份自信、格式正确、Schema 合法的「对空气的评审」。

而且这件事**光在提示词里要求是抓不到的**：并行跑出来的回复和串行跑出来的回复长得一模一样。
只有子 Agent 各自 thread 上的 `startedAt` / `completedAt` 能证明它们真的轮流发言 ——
判据是「蓝方的 startedAt ≥ 红方的 completedAt」。

`scripts/probe-codex-subagent.mjs` 已改成串行版本，并把顺序纳入判据。

### 4. `collabAgentToolCall.receiverThreadIds` 恒为空

即使在 spawn 真实成功的那次运行里，`receiverThreadIds` 也是 `[]`，`agentsStates` 也是 `{}`。**这个字段不能当证据用。** 唯一可靠的是 `subAgentActivity.agentThreadId`。

---

## 五、没有「确定性指派子 Agent」这条路（2026-07-27 实测）

用户要求：不允许裁决者自己决定 spawn，改由 StagePass 用 **Codex 原生指令**确定性地指派红蓝
子 Agent。查下来的结论是：**这个版本没有这个能力**，三条路都堵死。

### 1. app-server 协议里没有

`codex app-server generate-json-schema` 生成的 `ClientRequest` 共 **89 个方法**，逐个看过，
**没有任何一个能创建子 Agent**：没有 `agent/spawn`，没有 `thread/spawnAgent`，没有
`collab/*`。线程相关的只有
`thread/start`、`thread/fork`、`thread/resume`、`thread/inject_items`、`thread/rollback` 等。

而且 `ThreadStartParams` 和 `ThreadForkParams` 都**不接受父子关系**——没有 `parentThreadId`，
没有 `agentPath`，没有 sub-agent source。`ThreadStartSource` 只有 `startup | clear`。

也就是说：**StagePass 无法通过协议造出一个子 Agent。**

### 2. Codex App 的斜杠命令里没有

从 `app.asar`（206MB）里提取全部 `composer.<name>SlashCommand.*` i18n key，App 的斜杠命令
完整清单是：

```
autoReviewDenials  chat  compact  feedback  fork  goal
hotkeyWindowNew  hotkeyWindowResume  ideContext  init  mcp
memories  model  petOverlay  plan  project  reasoning
side  speed  status
```

**没有 agent / subagent / delegate / spawn。** 正则 `composer.*[Aa]gent*SlashCommand.*` 零命中。

最接近的是 `/side`：**「启动一个临时的侧边对话」**——那是给**人**用的旁支会话，不是给裁决者
派活的子 Agent；而且它是 App UI 层的东西，不在那 89 个协议方法里，StagePass 也发不出去。

### 3. @ mention 也不能指向 Agent

`UserInput` 的 `mention` 变体，`path` 的取值只有 `app://<connector-id>` 和
`plugin://<name>@<marketplace>`。asar 里搜 `agent://` / `subagent://`：**零命中**。

### 结论

这个版本上，子 Agent **只有一条来路**：模型自己调 `collaboration.spawn_agent`。
「由服务端确定性指派」在协议层不存在，只能在「模型发起 + 服务端强校验」和
「干脆不用子 Agent，改用多个顶层 thread」之间选。

---

## 六、顺带确认的一件事：固定 Schema 的 JSON 是协议支持的

`TurnStartParams` 有 `outputSchema`：

> Optional JSON Schema used to constrain the final assistant message for this turn.

也就是说「模型只能写固定 Schema 的 JSON、不允许自己构造 JSON」在协议层就有支持，不必只靠行协议来实现。裁决者输出协议的选型可以把它算进来（`TurnStartParams` 里**没有** `multiAgentMode` 字段，委派策略只能靠提示词和 `features.*` 配置，这一条也一并记在这里）。

---

## 七、复现

```bash
mkdir -p /tmp/subagent-probe
node scripts/probe-codex-subagent.mjs /tmp/subagent-probe /tmp/subagent-probe/out.jsonl
```

退出码 0 表示三件事同时成立：至少两个子 Agent 真的被启动、各自在自己的 thread 上产出了结果、
且**蓝方的 startedAt ≥ 红方的 completedAt**（真的轮流发言）。

脚本刻意**不**用根 Agent 的最终回复做判据，理由见 §4.1；顺序也刻意不看提示词有没有要求，
只看两个子 Agent 各自 thread 的时间，理由见 §4.3。
