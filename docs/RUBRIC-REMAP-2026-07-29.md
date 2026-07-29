# Rubric 重新映射到新树（2026-07-29）

> **`RUBRIC-DESIGN.md` 写的是老树，而老树已经删了。** 这份文档不取代它 —— 它把
> 那份文档里买命换来的结论逐条搬到新树上，并且说清楚哪几条**因为新树的形状而作废**。
>
> 动 L5 的代码之前读这份。只读 `RUBRIC-DESIGN.md` 会照着一份对不上号的图施工。

---

## 一、先确认一件事：那份文档引用的东西，新树里一个都没有

实测（`src/` + `scripts/` 全文搜索）：

```
saveRubricVersion · human_cannot_resolve_gap · openBlockingReviewFindingIds
computeMergeReadiness · stage_gates · approveGate · deleteChangeRecords
briefing_questions · prdStageHashQuestionRows · battle_rounds · stage_runs
isMergeBlockingGap · rubric · criterion
```

**一个都没有。** 新树只有十一张表：

```
projects · changes · change_events · change_evidence · commands · jobs
change_bindings · turns · gaps · questions · answers
```

`RUBRIC-DESIGN.md` 里的「第 1 批实现时的修正」「第 3 批发现」「第 5 批实测确立」
「第 6 批修正」—— **那六批是在老树上做完的**（`204f3f5` 仍在历史里），重建把它们
连同整棵树一起删了。所以那份文档的 §5 数据模型和 §4.3 的三条通道，**没有一条能
按字面实现**。

---

## 二、因为新树的形状而作废的（不必再解的题）

### 2.1 §4.3.1 那一整段死锁 —— 根源消失了

原文说三条通道「照字面实现，**每一条都会造出无出口的死锁**」：

| 老树的通道 | 死锁 |
|---|---|
| Spec → requirement gap | `human_cannot_resolve_gap` 禁止人工解，`waive_p1` 只认 P1 |
| Build/Fix → review finding | P0 不可豁免有四层；`source != "review"` 的 finding 进不了冻结集 |
| 文档阶段 → stage gate blocker | `stage_gates` 没有审批列，构造上不可清除 |

**这三条通道的存在本身就是病因。** 新树只有一个阻断机制：`gaps`。所以：

- 不存在"某类 finding 永远进不了某个集合"
- 不存在"P0 不可豁免的四层"—— `gaps` 的 `waive` 是一个函数，规则全在 `domain/gap.ts`
- 不存在"append-only 又可以被静默丢掉"的 gate

**§4.3.1 论证的那三个具体死锁，在新树里不需要解，因为造不出来。**
但它推导出的**那条规则**仍然绑死，见 §三。

### 2.2 §8 第 1 批的「migration + 在生产库副本上验迁移」

新树没有任何存量 rubric 数据，schema 由 `SCHEMA_SQL` 用 `CREATE TABLE IF NOT
EXISTS` 建出来。**没有要迁的东西。** 这一批直接变成"加表 + 加 store"。

### 2.3 §4.4 的「rubric 正文绝不进 sourceDbHash」

新树的 fence 是 `domain/gate.ts` 的 `snapshotOf`，它哈希的是：

```
phase · status · returnPhase · artifactIds · blockers(severity:id) · waived
```

**rubric 正文本来就不在里面，构造性满足。** 这一条不用做任何事 —— 但**不许因此
以为 §4.4 整条作废**，它的后半段在新树里反而更要命，见 §3.2。

---

## 三、仍然绑死的（买命钱换来的，一条都不许省）

### 3.1 出口就是 criterion 本身（§4.3.1）

> **rubric 派生的阻断项，只在它背后那条 criterion 仍被标为阻断时才活着。**
> 取消勾选「阻断」或删掉该 criterion，它派生的阻断项随之退休。

新树里落成：rubric 派生的 gap，其 `id` 从 `criterion_key` 派生，退休 = 把它
`closed` 掉并写明理由。

**为什么是 `closed` 而不是 `waived`**：`waived` 的语义是"问题还在，有人决定接受
它"；撤下一条标准说的是"这件事本来就不该算问题"。两者在 `domain/gap.ts` 开头被
明确区分过，别合并。

### 3.2 criterion_key 在新树里是**承重结构**，不是整洁

`snapshotOf` 哈希 blocker 的 **id**。所以：

- gap id 若从「版本内的行 id」派生 → **每编辑一次 rubric，所有 rubric 派生 gap 的
  id 都变** → snapshot 变 → **每一个 open question 的 fence 当场作废**，人正在回答
  的问题被拒绝。
- gap id 从 `criterion_key` 派生 → 改一条 criterion 的错别字，**id 不动、snapshot
  不动**，已盖章的东西一个都不受影响。

**这正是 §4.4 后半段「编辑 rubric 不使任何已完成的 run 或已盖章的 gate 失效」在新
树里的落点。** 它不是自动满足的，它由 `criterion_key` 扛着。

§5.1 的两条细则原样保留：

1. **编辑器回传的 key 是第一优先级，文本匹配只做后备。** 只按正文匹配的话，改一个
   错别字仍会孤立已开的 gap —— 病一样，只是触发条件变窄。
2. **不属于本 scope 的 key 一律不信任。** 信了就等于允许一个请求把新 criterion 绑
   到已开的 gap 上。

### 3.3 派生方向不对称（§4.3.1）

- **开启**读「判定当时那条 criterion 的正文快照 + 当时的 blocking 值」
- **退休**读「当前生效的 rubric」

因此**编辑 rubric 只能关不能开** —— 一次编辑绝不可能让一个已盖章的 change 重新被挡。
落到 schema 上：`rubric_assessments` 必须存 `criterion_text` 和 `blocking_then`。

### 3.4 退休需要正面证据，缺席永远不算（§4.3.1 规则 1 / §5.2）

只有「标准被撤下」或「后续判定答了 yes」能退休一条 rubric gap。**某一轮判定缺失
绝不退休** —— 一轮在 rubric 跑之前就死掉，不是"标准已满足"的证据。

**新树天然站在正确的一侧**：`domain/gap.ts` 的 `applyRound` 就是"沉默保持 open，
关闭必须说明理由"。rubric 判定接进 `settleRound` 即可，不要另造一条路径。

### 3.5 按轮读，不按 run 读（§5.2）

蓝方续跑那一轮不重跑红方，本次新 run 下没有 producer 判定行，旧行还在、带着**同一
个 round**。按 run 读会看到「producer 无判定」并读成「没有 rubric」= 通过。

新树里 `gaps.opened_round` 已经是 round 语义，`work/round-runner.ts` 也按轮组织。
**主键里放 round，不放 run。**

### 3.6 三态 + 未知即作废（§4.1 / §4.2）

```
yes           满足
no            不满足
not_assessed  未评估（模型漏答的记账，模型自己不许写这个值）
```

- 每条 criterion **必须恰好一行**输出
- **缺失 → 记 `not_assessed`**；**标了阻断的** criterion 缺失才视同阻断
- **未知 verdict 值 → 作废整份输出**（可重试；`not_assessed` 是永久记账，更重）
- **未知 criterion key → 作废整份输出**

### 3.7 判定必须是是/否，不许打分（§2.4，用户拍板不可推翻）

> 原话：「否则 AI 打分会出幻觉，用大量的 yes or no 来规范模型」

与新树现状一致 —— 现有判定全是枚举，没有一处让模型给分数。

### 3.8 模型不亲手写 JSON（§6）

固定行协议，结构由 StagePass 决定。判据是**结构由谁决定**，不是格式是不是 JSON。

---

## 四、新树的数据模型（三张表）

```sql
rubrics
  id          TEXT PRIMARY KEY
  project_id  TEXT NOT NULL REFERENCES projects(id)
  change_id   TEXT     NULL REFERENCES changes(id)   -- NULL = 项目级默认
  phase       TEXT NOT NULL CHECK (phase IN (<PHASES>))
  role        TEXT NOT NULL CHECK (role IN ('producer','critic','verdict'))
  version     INTEGER NOT NULL
  is_current  INTEGER NOT NULL
  reason      TEXT     NULL   -- 退休了活着的阻断项时必填（PRD §1.1）
  created_at  TEXT NOT NULL

rubric_criteria
  rubric_id      TEXT NOT NULL REFERENCES rubrics(id)
  criterion_key  TEXT NOT NULL          -- 跨版本稳定身份
  ordinal        INTEGER NOT NULL
  text           TEXT NOT NULL CHECK (length(trim(text)) > 0)
  blocking       INTEGER NOT NULL
  PRIMARY KEY (rubric_id, criterion_key)

rubric_assessments
  change_id      TEXT NOT NULL REFERENCES changes(id)
  phase          TEXT NOT NULL CHECK (phase IN (<PHASES>))
  role           TEXT NOT NULL
  round          INTEGER NOT NULL
  rubric_id      TEXT NOT NULL REFERENCES rubrics(id)
  criterion_key  TEXT NOT NULL
  verdict        TEXT NOT NULL CHECK (verdict IN ('yes','no','not_assessed'))
  evidence       TEXT     NULL
  criterion_text TEXT NOT NULL     -- 判定当时的正文快照（§3.3）
  blocking_then  INTEGER NOT NULL  -- 判定当时是否阻断（开启读它，不读当前）
  created_at     TEXT NOT NULL
  PRIMARY KEY (change_id, phase, role, round, criterion_key)
```

### 4.1 唯一索引必须是**两条部分索引**，不能是一条

```sql
CREATE UNIQUE INDEX uq_rubric_current_change ON rubrics
  (project_id, change_id, phase, role) WHERE is_current = 1 AND change_id IS NOT NULL;
CREATE UNIQUE INDEX uq_rubric_current_project ON rubrics
  (project_id, phase, role)            WHERE is_current = 1 AND change_id IS NULL;
```

**SQLite 的唯一索引里 NULL 互不相等。** 一条索引会让所有项目级 rubric 版本同时是
current —— 而且是**静默**失效。version 唯一性同理。（这条是老树第 1 批实测发现的，
和树无关，照搬。）

### 4.2 `change_id` 必须在 `rubric_assessments` 上

否则针对项目级 rubric 做出的判定，在删 change 时找不到 —— `rubric_id` 指向一个比
change 活得更久的对象。（老树原因相同，结论照搬。）

### 4.3 项目级 rubric 的删除

`rubrics.project_id` 引用 `projects.id`，项目级 rubric 不属于任何 change。新树目前
**没有任何删除路径**（没有 `deleteChange`，也没有 `deleteProject`），所以这一条现在
不咬人 —— **但谁第一个写删除，必须一并处理它**，否则建过 rubric 的项目再也删不掉。
这里先记着。

---

## 五、判定怎么变成阻断

**唯一通道是 `gaps`，不新建平行机制。**

```
判定 verdict=no 且 blocking_then=1
  → gaps 里 upsert 一条 id = `RB:<role>:<criterion_key>` 的 open gap
    severity 取自 criterion（见下）
    title 用 criterion_text 快照，不回溯派生

退休（两条正面证据之一）
  a. 当前 rubric 里这条 criterion 没了、或 blocking 被取消
  b. 后续某一轮判定答了 yes
  → closed，resolution 写明是哪一条
```

### 5.1 severity —— **已定：rubric 没有 severity（2026-07-29 用户拍板）**

我先前给的两个选项（一律 P1、criterion 上加一列 severity）**都错了** —— 两个都是
在把一个二元结论硬塞进分级刻度。用户的原话：

> 因为 rubric 判断的是对或者错，是二元判断，所以不用套 P0 P1 P2。

落地：`gaps` 加一列 `kind`。

```
finding    发现的一个问题。模型报的，必带严重度：问的是「这有多糟」
standard   一条没被满足的标准。rubric 判的，必无严重度：问的是「满足了没有」
```

schema 用配对 CHECK 把不合法状态做成不可表示：
`CHECK ((kind = 'finding') = (severity IS NOT NULL))`。

**真正让两者必须分开的不是有没有严重度，是出口不同：**

| | 出口 |
|---|---|
| `finding` P1 | waive —— 人接受这个风险 |
| `standard` | 撤下那条标准 —— 人说这件事本来就不该要求 |

「接受风险」和「撤销要求」是两句不同的话。所以 `waive` 明确拒绝 `standard`
（`InvalidVerdictError("standard_not_waivable")`），`unresolved` 也不认 waive 名单
对它的豁免。`kind` 同时进 fence 哈希：同一个 id 换了 kind，出口就变了，那是决策
依据变了。

这一格已经在 L1 落地并有测试（commit `06ef926`），L5-3 直接用。

---

## 六、实现顺序（重排到新树，每批独立可验证，逐批合并）

| 批 | 内容 | 验收 |
|---|---|---|
| **L5-1** | 三张表 + 两条部分唯一索引 + store；`criterion_key` 稳定性（编辑器回传优先、文本匹配后备、跨 scope 的 key 不信任） | **完全离线** |
| **L5-2** | 行协议 + fail-closed 解析：恰好一行、缺失记 `not_assessed`、未知 verdict / 未知 key 作废整份 | **完全离线**（纯 domain） |
| **L5-3** | 判定 → `gaps`：开启读快照、退休读当前 rubric、退休需正面证据 | **完全离线** |
| **L5-4** | 接进 `work/round-runner.ts`（L4 的红/蓝/裁判已经在跑） | 需真 Codex |
| **L5-5** | UI：编辑器 + 判定展示 + 退休理由（PRD §1.1） | 面板里真点一次 |
| **L5-6** | 铺开到其余阶段 —— **这就是 L6** | 需真 Codex |

L5-1 到 L5-3 全部离线可证，符合"下层不过不许动上层"。

## 七、每批都要满足

1. `pnpm check` 全绿，含 `src/architecture.test.ts` 五条常驻护栏
2. 新模块在 `architecture.test.ts` 的 `LAYER` 里声明层号（rubric 属 **L5**）
3. 不许在 `src/web/` 里解析 pty 输出（第五条护栏）
4. 网页上不许出现对**具体产物**的裁决入口 —— 编辑 rubric 是例外且仅此一个，
   边界见 PRD §1.1
5. 一个概念一个名字：`criterion_key` 就叫 `criterion_key`，不许再冒出 `criterionId`
