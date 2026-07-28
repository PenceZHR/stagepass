# 交接：Codex 卡片回路（2026-07-28）

## 一句话

`web 点击 → Codex 执行 → 弹卡 → 人点击 → 落库 → 续接` 这条回路今天第一次跑通并落库。
挡住它的不是一个 bug，是**五处各自都足以让它不可能成功的判定**，外加五处把真实原因吞掉的错误消息。

---

## 一、唯一的卡片模型

**`stagepass-card` 是唯一的卡片实现，其它都不要再造。**

```
present_stagepass_choices   →  渲染 ui://stagepass/requirement-choice-v2
record_stagepass_choice     →  POST /api/codex/card-choice-receipts
```

一张卡的形状只有一种：**一批问题，每题若干选项**。

- 需求澄清 = N 个问题
- **阶段批准 = 1 个问题、2 个选项**（`questionId: stagepass_stage_approval`，A 批准 / B 打回）

批准不是另一种卡。今天曾为它写过第二套 widget（`gate-decision-v1`，192 行），
是纯重复，已删除。**下次想加卡片前，先确认它不是"一批带选项的问题"。**

### 其它插件的状态

| 插件 | 状态 |
|---|---|
| `stagepass-card` | **唯一卡片模型**。源码在 `.stagepass/plugin-development/stagepass-card/`，安装位置是 `~/.codex/plugins/cache/personal/stagepass-card/`，两者是独立副本，改完要手动 `cp` 过去 |
| `stagepass-gate` | 保留 `present_stagepass_interaction`（编排器在调），但**它的 record 路径不通** —— 见第三节 |
| `stagepass-ui-spike` | 07-23 的桥接探针，已在 `~/.codex/config.toml` 关闭 |

---

## 二、回路的六步与各自的落库证据

判定一步是否真的成功，**只看表，不看模型说什么**。

| 步 | 动作 | 落库证据 |
|---|---|---|
| ① | web 点击触发阶段 | `pipeline_jobs` 新行，HTTP 202 |
| ② | Codex 执行 | `runs` + `codex_logical_turns` + `codex_thread_bindings` |
| ③ | 模型弹卡 | 插件侧 `~/.codex/plugin-data/stagepass-card/stagepass-presented-cards.jsonl`（StagePass 此时还不知道这张卡） |
| ④ | 人点击 | `codex_interactions`(requirement_choice, completed) + `pipeline_command_receipts`(record_stagepass_choice) |
| ⑤ | 续接 turn | `pipeline_jobs`(job_kind=interaction_wakeup) |
| ⑥ | 批准推进 | `changes.status` 前进（如 INTAKE_READY → SPECCING） |

**③ 不落 StagePass 的库是设计使然**：卡由模型发起，StagePass 在收到答案时才知道它存在。

---

## 三、今天修掉的东西（按危害排序）

### 结构性不可能通过的判定（5 处）

1. **阶段级 scope 比较** —— `codex_thread_bindings.scope_id` 是 `CHG-002:prd`（用 stage id），
   而回执带的 `stage` 是 `"intake"`（阶段名）。这个仓库里 stage / phase / gate 三套命名
   对同一阶段各有叫法。**已放弃重建 scope id**：binding 是通过 logical turn 找到的，
   project / change / thread 已逐一校验，scope id 提供不了额外信息。
   > 教训：我第一次"修好"它时，是用自己传的 `stage:"prd"` 验证的 —— 证明了假设，没证明行为。

2. **批准卡形状识别** —— `isApprovalOnlyCard` 读 `structuredContent.answers[].questionId`，
   那是**已完成**卡片的形状；阶段 turn 只会产生**呈现中**的形状（`questions[].id`）。
   于是纯批准卡也被判成"又问了一批"，阶段永远不收敛、gate 永远不开。

3. **卡片跨进程记忆** —— `presented` 是内存 Map。批准卡在 turn 末尾呈现、turn 结束后点击，
   那时插件进程已循环。已持久化到 jsonl。

4. **并发覆盖**（我引入的）—— 第一版持久化用整份覆盖，而每个 Codex 对话有独立插件进程、
   共用一个数据目录，互相抹掉。已改为一卡一行追加、加载时合并。

5. **actor surface** —— `executeStageApproval` 是 StagePass 自己的代码，却给命令贴
   `codex_mcp_app`（外部 MCP 应用）标签，于是网关要求它出示只有外部才有的 nonce。
   改为 `stagepass_web_emergency`，网关本就为这组人工裁决动作开了这个口。

### 被通用错误消息掩盖的（5 处）

每一处修完之后，**下一个 bug 都是一步定位的**：

| 通用消息 | 真实原因 |
|---|---|
| `unsupported protocol capabilities` | `TERM_PROGRAM=Apple_Terminal` 让 UA 不进白名单 |
| `choice_receipt_record_failed`(500) | `PRD gate has no snapshot to fence the decision` |
| `提交失败，请重试` | `continuation_not_acknowledged`（运行已死，重试无用） |
| `record_failed` | 工具自己的错误码被 catch 丢掉 |
| `project_ai_run_transition_invalid` | 心跳无法把租约前移 |

**这是这套系统最值得继续投入的方向**：不是加功能，是让每一次失败都说真话。

### 其它

- **等人被记成失败** —— `StageAwaitingClarificationError` 无人接住，逃到失败账本，
  UI 显示"失败"而卡片正好好等着。Spec 早就写对了，其它 document 阶段都漏了。
- **租约钳到 deadline 后心跳必然违法** —— 状态机要求严格前移，而租约已到顶。
- **读接口写文件** —— `listBaselineDocs` / `readBaselineDoc` 调 `scaffoldBaseline`，
  一次 GET 写十个文件；阶段边界检查分不清 StagePass 的写和模型的写，
  **打开项目页就能让正在跑的阶段判为越界**。
- **边界检查硬编码忽略列表** —— 改为问 git。
- **`CHOICE_CARD_ROLES` 与解析器矛盾** —— 两份真相，已合并到 `stage-output-contract.ts`。
- **`confirm` 未暴露** —— PRD 写完了但没有接口把它变 ready，Change 永远建不了。
- **新 Change 显示「重新生成」** —— 按阶段状态选 run/retry。

---

## 四、坑（会再咬人的）

1. **worker 不热重载**。改了 `server/services/` 必须重启整个 dev，否则 worker 用旧代码，
   症状是"我明明修了但行为没变"。今天为此浪费过一整轮。

2. **`TERM_PROGRAM` 覆盖 `TERM`**。从 Terminal.app 起和从 IDE 起会产生不同的 UA，
   一个进白名单一个不进。用 `scripts/dev-codex.sh`，它会 `unset TERM_PROGRAM`。

3. **插件是独立副本**。`.stagepass/plugin-development/` 改完不会自动生效，
   要 `cp` 到 `~/.codex/plugins/cache/personal/stagepass-card/*/scripts/server.mjs`，
   然后**重启 Codex App**。

4. **两个路由对 `expectedHeadSha` 规则相反**：`/commands` 要求必填可为 null，
   `/intake` 的前置校验拒绝 null。未统一。

5. **同一阶段三个名字**：stage `intake` / gate `PRD` / 决策白名单 `Intake`。
   跨层传递时必须确认用的是哪一个。

---

## 五、还没解决的

- **`stagepass-gate` 的 record 路径不通**。它 POST 到公开 `/commands`，
  而业务裁决在那条路上被 `actor_surface_forbidden` 拒绝。
  Spec / TechSpec / Plan / TestPlan 的 Server 发起决策卡走的是它，**同样不通**。
  可选出路：给它一个带 `interactionId` 的入口并使用 emergency surface，
  或让它复用 `stagepass-card` 的回执路径。**今天没做，因为它动到安全边界。**

- **大量"建好但没接上"的机制**。今天遇到的：`scaffoldBaseline`（唯一调用者在读路径里）、
  `gate_decision`（零调用者，直到今天）、`interaction_present`（零派发）、
  `GatePanel`（零挂载，且有两条测试禁止挂载）、`stagepass_web_emergency`（零路由）、
  host-attested MCP（从未部署，且插件无处提供 broker FD）。

  **建议做一次系统性扫描**：对每个 export 统计生产调用者，为 0 的要么接上要么删掉。
  这能把"还剩多少洞"从未知变成一张清单，不用再靠跑一次发现一个。

---

## 六、关于要不要重构

**不建议。** 今天 19 个 bug 里没有一个是设计错误，全是"两个正确的部件之间连线缺失或接错"。

- 生产代码 10.8 万行，测试 10.3 万行（近 1:1），32 个迁移，64 张表
- 重写作废那 10 万行测试，而它们是今天每一次定位能成立的原因
- 严格状态机、fence、租约、DB-first —— 今天每一处精确诊断都靠它们。
  心跳那个 bug 是被触发器**当场 ABORT** 才暴露的；一个没有这些的新系统里，
  它会以"数据悄悄不对"的形式存在，查都没法查

真正的问题是**建得比接得快**，那是流程问题，重写一遍会长出同样的孤儿。
