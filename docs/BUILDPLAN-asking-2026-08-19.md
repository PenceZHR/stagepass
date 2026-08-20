# BuildPlan · 提问面

> 实现 `TECHSPEC-asking-2026-08-19.md`（其 §0 的更正 `rubricId → ordinal` 已批复）。
> 配套 `TESTPLAN-asking-2026-08-19.md`。

**目标**：模型在自己的 Codex 会话里调一个工具向人提问，弹原生表单，答案回到模型，
全程留档，浏览器旁边看得见。

**做法**：MCP server 做**薄客户端**（零业务、只转 HTTP），状态全在工作台那一个进程。
判据单继续走文件，提问走 MCP —— 分界是「要不要等一个人」。

**栈**：TypeScript / tsx / `node:test` / better-sqlite3 / MCP SDK（待选型）。

## 范围

这份只做 **P0a–P3**。**P4（结算改成只读产物）不在里面** —— 它要动
`runtime.settleHandoff`，是另一个子系统，单独一份 plan。

---

## 全局约束（每个任务都默认包含）

- **`pnpm check` 必须全绿**（`tsc --noEmit` ×2 + 1177 条基线）。一条红就是真回归。
- **测试和源码同目录**：`src/x/y.ts` 的测试是 `src/x/y.test.ts`。
- **新模块必须进 `src/architecture.test.ts` 的 `LAYER` 表**，层数是**依赖顶出来的**，
  不是挑的。漏登记 = 架构测试红。
- **不许手抄**：凡是 StagePass 拿去做精确匹配的字符串，都不许出现在模型必须生成的
  文本里。模型的输出只允许有两种东西 —— 枚举里的选择，和散文。
- **加依赖要先问**（现在只有 `better-sqlite3` + `three`）。
- **不碰** `web/runtime.ts` / `web/seats.ts` / `codex/app-server-*`。
- 注释写**为什么**，不写做了什么。中文。

---

## 文件地图

| 文件 | 层 | 责任 |
|---|---|---|
| `src/domain/ask.ts` | **0** | 提问的形状 + 参数校验。纯函数，只 import `domain/phase` |
| `src/store/ask-store.ts` | **1** | JSONL 追加、库索引投影、`rebuildFrom` |
| `src/web/ask-route.ts` | **4** | 组装：认当前 waiting 轮、ordinal→rubricId、落档 |
| `src/mcp/server.ts` | **0** | MCP 进程入口。**不许 import `src/` 下任何非类型模块** |
| `src/domain/rubric-sheet.ts` | **0** | 判据单答案文件的读回（和 `worklist` 同构） |

改：`web/actions.ts`(5)、`web/api.ts`(5)、`domain/gate.ts`(1)、`web/panel.js`、
`src/architecture.test.ts`、`src/db/schema.ts`。

---

## T0a · 验 elicitation 是 pull 还是 push

**不写产品代码。** 这条决定面板存亡，先花半小时。

- [ ] **步骤 1**：在 `/private/tmp/.../scratchpad` 起一个最小 MCP server，
      注册两个工具：`probe_ask`（处理调用时发 elicitation）和 `probe_push`
      （起一个 5 秒后发 elicitation 的定时器，然后立刻返回）。
- [ ] **步骤 2**：写进 `~/.codex/config.toml`，开一条真会话，各调一次。
- [ ] **步骤 3**：记下结果到 `docs/EVIDENCE-elicitation-2026-08-19.md`：
      `probe_push` 的表单**弹没弹**、报什么错。

**验收**：文档里有一条能被别人复现的结论，含原始报错文本。

**分支**：
- pull-only（预期）→ 面板留着承担轮间裁决，TechSpec §三「未验事项」改成已验。
- 能 push → 记下来，但**这一期仍然不用**，别顺手扩范围。

---

## T1 · `domain/ask.ts` —— 形状与校验

**文件**
- 建：`src/domain/ask.ts`、`src/domain/ask.test.ts`
- 改：`src/architecture.test.ts`（加 `"domain/ask.ts": 0`）

**接口（后面的任务靠这些名字）**

```ts
export interface Ask {
  readonly id: string;
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly rubricId: string | null;
  readonly ordinal: number | null;
  readonly question: string;
  readonly why: string | null;
  readonly options: readonly string[];
  readonly askedAt: string;
  readonly chosen: string | null;
  readonly note: string | null;
  readonly answeredAt: string | null;
}

export interface AskRequest {
  readonly ordinal: number | null;
  readonly question: string;
  readonly options: readonly string[];
  readonly why: string | null;
}

export type AskCheck =
  | { readonly ok: true; readonly request: AskRequest }
  | { readonly ok: false; readonly error: string; readonly reason: string };

export const OPTION_MIN = 2;
export const OPTION_MAX = 6;

export function checkAsk(raw: unknown, sheetCount: number): AskCheck;
```

- [ ] **步骤 1：先写失败的测试**

```ts
// src/domain/ask.test.ts
test("序号越界要把范围原样回给模型 —— 它自己改得过来", () => {
  const outcome = checkAsk(
    { ordinal: 9, question: "选哪个？", options: ["A", "B"] },
    4,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "ordinal_out_of_range");
  // 不是「越界了」四个字 —— 那句话模型没法据以改正。
  assert.match(outcome.reason, /1[^\d]*4/);
});

test("判据单为空时允许不带序号", () => {
  const outcome = checkAsk({ ordinal: null, question: "？", options: ["A", "B"] }, 0);
  assert.equal(outcome.ok, true);
});

test("选项少于两条 = 不是选择题", () => {
  const outcome = checkAsk({ ordinal: 1, question: "？", options: ["A"] }, 4);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "bad_options");
});
```

- [ ] **步骤 2：跑一次确认它红**

```bash
node --import tsx --test src/domain/ask.test.ts
```

预期：`Cannot find module './ask'`。

- [ ] **步骤 3：写最小实现**

`checkAsk` 逐条判：`question` 非空 → `options` 落在 2..6 → `ordinal` 为 null 或
落在 `1..sheetCount`。每条失败都返回**带具体数字的 `reason`**。

判据：**`reason` 里必须出现模型能照着改的信息**（允许范围、当前条数）。
理由见 `domain/worklist.ts` 的 `bad_answer` —— 答错不抛异常，把允许值原样回给它，
抛异常会变成一句 MCP 层的错误文本，模型只知道「失败了」。

- [ ] **步骤 4：跑绿**

```bash
node --import tsx --test src/domain/ask.test.ts && pnpm typecheck
```

- [ ] **步骤 5：提交**

```bash
git add src/domain/ask.ts src/domain/ask.test.ts src/architecture.test.ts
git commit -m "feat: 提问的形状和校验 —— 模型只能生成一个小整数和散文"
```

---

## T2 · `store/ask-store.ts` —— 留档

**文件**
- 建：`src/store/ask-store.ts`、`src/store/ask-store.test.ts`
- 改：`src/db/schema.ts`（加 `asks` 表）、`src/architecture.test.ts`（`1`）

**接口**

```ts
export class AskStore {
  constructor(database: Database.Database, jsonlPath: string, now?: () => Date);
  record(input: Omit<Ask, "id" | "askedAt" | "chosen" | "note" | "answeredAt">): Ask;
  answer(id: string, chosen: string, note: string | null): void;
  list(changeId: string): readonly Ask[];
  rebuildFrom(jsonlPath: string): number;   // 返回重建了几条
}
```

**建表**（照 `handed_rounds` 的写法，`schema.ts`）

```sql
CREATE TABLE IF NOT EXISTS asks (
  id          TEXT    PRIMARY KEY,
  change_id   TEXT    NOT NULL REFERENCES changes(id),
  phase       TEXT    NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  round       INTEGER NOT NULL,
  rubric_id   TEXT        NULL,
  ordinal     INTEGER     NULL,
  question    TEXT    NOT NULL,
  why         TEXT        NULL,
  options_json TEXT   NOT NULL,
  asked_at    TEXT    NOT NULL,
  chosen      TEXT        NULL,
  note        TEXT        NULL,
  answered_at TEXT        NULL
);
CREATE INDEX IF NOT EXISTS ix_asks_change ON asks (change_id, asked_at);
```

**注意建表顺序陷阱**：引用新列的索引会让还没跑 migrate 的旧库当场打不开。
migrate 先、`SCHEMA_SQL` 后，都封在 `prepareSchema` 里。

- [ ] **步骤 1：先写失败的测试 —— 往返是「文件为准」的唯一证明**

```ts
test("库丢了能从 jsonl 逐条重建", () => {
  const path = join(tmp, "asks.jsonl");
  const first = new AskStore(dbA, path);
  const a = first.record({ changeId: "CHG-001", phase: "Spec", round: 1,
    rubricId: "R-4", ordinal: 4, question: "选哪个？", why: null,
    options: ["A", "B"] });
  first.answer(a.id, "A", "因为便宜");

  // 换一个全新的空库，只喂那份文件
  const rebuilt = new AskStore(dbB, path);
  assert.equal(rebuilt.rebuildFrom(path), 1);
  assert.deepEqual(rebuilt.list("CHG-001"), first.list("CHG-001"));
});

test("回答是追加一条补记，不改原行", () => {
  // 只追加的文件不能原地改写，否则 diff 会撒谎
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).chosen, undefined);
  assert.equal(JSON.parse(lines[1]).chosen, "A");
});
```

- [ ] **步骤 2：跑，确认红**
- [ ] **步骤 3：实现。** 写库和写文件在同一个方法里，**文件写成功才写库** ——
      反过来会出现「库里有、文件里没有」，而重建以文件为准。
- [ ] **步骤 4：跑绿** `node --import tsx --test src/store/ask-store.test.ts && pnpm check`
- [ ] **步骤 5：提交** `feat: 提问留档 —— 文件为准、库为索引`

---

## T3 · `web/ask-route.ts` —— 组装

**文件**
- 建：`src/web/ask-route.ts`、`src/web/ask-route.test.ts`
- 改：`src/web/actions.ts`（接 `POST /api/ask-from-model`）、
      `src/web/api.ts`（接 `GET /api/asks`）、`src/architecture.test.ts`（`4`）

**消费**：`checkAsk`（T1）、`AskStore`（T2）、`HandoffStore`（已有）

**产出**

```ts
export interface AskFromModelResult {
  readonly ok: boolean;
  readonly askId?: string;
  readonly rubricText?: string;   // 这一条判据的原文，回给模型确认它问对了
  readonly error?: string;
  readonly reason?: string;
}
export function askFromModel(deps, body: string): AskFromModelResult;
```

**流程**（每一步失败都返回**模型能自救的** `reason`）

1. 取当前项目**唯一一条 `status='waiting'`** 的 `HandedRound`。
   零条 → `no_open_round`；多于一条 → `ambiguous_round`（这是 StagePass 自己的 bug，
   照直说，别猜一条）。
2. `sheetCount = round.blueRubric?.count ?? 0`
3. `checkAsk(body, sheetCount)`
4. `ordinal → rubricId`：从 `round.rubricIds` 取。**备那一刻的版本**，不重新取。
5. `AskStore.record(...)`

- [ ] **步骤 1：先写失败的测试**

```ts
test("没有备着的轮时不弹表单，并说得出该先做什么", () => {
  const out = askFromModel(deps, JSON.stringify({ ordinal: 1, question: "？",
    options: ["A", "B"] }));
  assert.equal(out.ok, false);
  assert.equal(out.error, "no_open_round");
  assert.match(out.reason!, /备一轮|handoff/);
});

test("序号换回的是备那一刻的 rubric 版本", () => {
  // 备完之后把库里的 rubric 换掉，答案仍然挂回旧版本
  swapRubric(db, "CHG-001", "Spec");
  const out = askFromModel(deps, body({ ordinal: 2 }));
  assert.equal(store.list("CHG-001")[0]!.rubricId, RUBRIC_AT_PREPARE_TIME);
});
```

- [ ] **步骤 2–4**：红 → 实现 → 绿（`pnpm check`）
- [ ] **步骤 5：提交** `feat: 提问接进工作台 —— 序号换回备轮那一刻的判据`

---

## T4 · `src/mcp/server.ts` —— 薄客户端

**文件**
- 建：`src/mcp/server.ts`、`src/mcp/server.test.ts`
- 改：`package.json`（MCP SDK）、`src/architecture.test.ts`

**这一步唯一的设计判据**

> **`src/mcp/server.ts` 不许 import `src/` 下任何非类型模块。**

它一旦碰业务，就不再是电话线，08-19 那个「三个进程锁三份代码」的坑就回来了。
**这条要有测试钉着**（架构测试里加一条：这个文件的依赖闭包只允许 `import type`）。

- [ ] **步骤 1：加依赖前先验一次真启动**

```bash
pnpm add @modelcontextprotocol/sdk
node -e "import('@modelcontextprotocol/sdk/server/index.js').then(()=>console.log('ESM ok'))"
```

预期：打印 `ESM ok`。**打不出来就停** —— `ws` 是 CJS，打进 ESM 就抛，
三次构建从来没启动成功过，烧掉一整夜。

- [ ] **步骤 2：写工具注册的失败测试**

```ts
test("工具表里有且只有 stagepass_ask", async () => {
  const tools = await listTools(await startServer());
  assert.deepEqual(tools.map((t) => t.name), ["stagepass_ask"]);
});

test("工作台没起来时说得出起它的命令，而不是自己去起", async () => {
  const out = await callAsk({ port: 1 /* 没人听 */ });
  assert.match(out.content[0].text, /npm start/);
  // 「看状态不该有副作用」的对偶：问一句话也不该顺手起一个进程
  assert.equal(spawnedProcesses(), 0);
});
```

- [ ] **步骤 3：实现。** 收调用 → `fetch("http://127.0.0.1:4399/api/ask-from-model",
      {method:"POST", body})` → 校验失败原样回给模型；通过则发 elicitation，
      拿到选择再 `POST /api/answer-ask`。
- [ ] **步骤 4：跑绿**
- [ ] **步骤 5：提交** `feat: MCP 薄客户端 —— 零业务，状态全在工作台那一个进程`

---

## T5 · 面板渲染 asking 流

**文件**：改 `src/web/panel.js`、`src/web/panel.html`、`src/web/panel-view.ts`

- [ ] **步骤 1**：`panel-view.ts` 加纯函数 `renderAsks(asks): string`，写测试
      （项目现有的前端测试是正则 grep —— **这一条要真解析**，见 TestPlan §四）。
- [ ] **步骤 2**：接 `GET /api/asks?change=…`，**2 秒轮询，`document.hidden` 时停**。
      不上 SSE / websocket。
- [ ] **步骤 3**：未答的那条高亮。
- [ ] **步骤 4**：`pnpm check` + 真机开一次面板，截图。
- [ ] **步骤 5：提交** `feat: 面板看得见问过什么`

---

## T6 · 判据单答案文件读回

**文件**
- 建：`src/domain/rubric-sheet.ts`、`src/domain/rubric-sheet.test.ts`（层 `0`）

**和 `domain/worklist.ts` 逐字同构** —— 一个人手里两种格式，就是两次答错的机会。

```
3: pass  spec.md §2.3 已经写明「不做多人协作」
4: blocked  这条我判不了，见 ASK-0007
```

```ts
export type Claim = "pass" | "blocked" | "n_a";
export interface SheetLine { readonly ordinal: number; readonly claim: Claim;
  readonly evidence: string; }
export interface SheetRead {
  readonly lines: readonly SheetLine[];
  readonly missing: readonly number[];    // 没写的序号
  readonly problems: readonly string[];   // 写错的，每条带序号
}
export function readSheet(text: string, count: number): SheetRead;
```

- [ ] **步骤 1：失败的测试**

```ts
test("答一半不作废 —— 少一行就是少一条，不会让别的条错位", () => {
  const out = readSheet("1: pass 见 spec.md\n3: blocked 判不了", 4);
  assert.deepEqual(out.missing, [2, 4]);
  assert.equal(out.lines.length, 2);
});

test("claim=pass 但没写证据，算 missing 不算 problem", () => {
  // 它不是格式错，是没交代 —— 闸门要拦的正是这个
  assert.deepEqual(readSheet("1: pass", 1).missing, [1]);
});
```

- [ ] **步骤 2–4**：红 → 实现 → 绿
- [ ] **步骤 5：提交** `feat: 判据单读回 —— 按序号，和名单同构`

---

## T7 · 闸门加第三条

**文件**：改 `src/domain/gate.ts` + `src/domain/gate.test.ts`

**产出**

```ts
export interface Evidence {
  // …既有字段不动…
  /** 判据单还缺哪几条。**代码算的**，不是模型报的。空数组 = 齐了。 */
  readonly sheetMissing: readonly number[];
}
export type RefusalReason =
  | "not_legal_in_this_status" | "nothing_was_produced"
  | "blocking_problem_outstanding"
  | { readonly kind: "rubric_sheet_incomplete"; readonly missing: readonly number[];
      readonly texts: readonly string[] };
```

`RefusalReason` 从字符串枚举扩成联合类型。**`refusals` 必须说得出缺哪几条**（序号 +
判据原文）—— 少了这一步，面板上是一个灰按钮和一句「判据单不全」，人不知道去补哪条。

- [ ] **步骤 1：失败的测试**

```ts
test("判据单缺一条就不许批准，而且说得出缺的是第几条", () => {
  const gate = computeGate(settledState, { ...EMPTY_EVIDENCE,
    artifactIds: ["A-1"], sheetMissing: [2, 4] });
  assert.ok(!gate.permitted.includes("approve"));
  const reason = gate.refusals["approve"];
  assert.equal(typeof reason === "object" && reason.kind, "rubric_sheet_incomplete");
  assert.deepEqual(typeof reason === "object" && reason.missing, [2, 4]);
});

test("reject / retry / sendBack 不受判据单影响", () => {
  // 出口不能被证据不好挡住，否则 Change 会卡到没有合法动作
  const gate = computeGate(settledState, { ...EMPTY_EVIDENCE, sheetMissing: [1] });
  assert.ok(gate.permitted.includes("reject"));
});

test("sheetMissing 进 snapshot —— 补完一条，旧的裁决围栏要失效", () => {
  assert.notEqual(
    snapshotOf(s, { ...EMPTY_EVIDENCE, sheetMissing: [1] }),
    snapshotOf(s, { ...EMPTY_EVIDENCE, sheetMissing: [] }));
});
```

- [ ] **步骤 2–4**：红 → 实现 → 绿。**`unresolved()` 一个字不改**
      （P2 不挡闸门那件事这一期不治，它是另一条闸门）。
- [ ] **步骤 5：提交** `feat: 判据单不全就不许进下一阶段 —— 齐不齐是代码判的`

---

## T8 · 护栏：题面提到的工具必须真的存在

**文件**：建 `src/system/tool-names.test.ts`

**这条是用血换的**：`stagepass_next` / `stagepass_answer` 随 `src/plugin/` 一起删掉，
**题面还在叫裁判去调它们，而 1177 条测试全绿** —— 每轮表态全丢、每条标准记
`not_assessed`，而那是把闸门**沉默地**关死。

- [ ] **步骤 1：写测试**

```ts
test("题面里出现的每一个 stagepass_* 工具名，都在 MCP 工具表里", async () => {
  const mentioned = new Set<string>();
  for (const file of promptSources()) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bstagepass_[a-z_]+\b/g)) {
      mentioned.add(m[0]);
    }
  }
  const registered = new Set(await toolNames());
  assert.deepEqual([...mentioned].filter((n) => !registered.has(n)), []);
});
```

- [ ] **步骤 2**：跑，确认它现在**真的红**（题面里还有 `stagepass_next`）。
      红了才证明它有用。
- [ ] **步骤 3**：把题面里已经不存在的工具名清掉。
- [ ] **步骤 4**：绿。
- [ ] **步骤 5：提交** `test: 题面说得出名字的工具都真的存在`

---

## 顺序与并行

```
T0a ──→ T1 ──→ T2 ──→ T3 ──→ T4 ──→ 真机验收 1、5
                        │
                        └──→ T5（面板，可与 T4 并行）
T6 ──→ T7 ──→ 真机验收 4        （T6/T7 不依赖 T1–T5，可先做）
T8 独立，任何时候
```

**检查点**：T4 之后停一次，真机跑一遍验收 1、2、5 再往下。
不通就别开 T6。

---

## 自审（对着 TechSpec 走了一遍）

- §0 ordinal 更正 → T1、T3
- §一 文件/MCP 分界 → T4、T6（判据单走文件）
- §三 契约与错误自救 → T1
- §四 薄客户端 → T4
- §五 留档、文件为准 → T2
- §六 判据单与闸门 → T6、T7
- §七 面板 → T5
- §八 测试策略 → TestPlan
- §九 P4 → **不在这份里**，单独一份
- §十一 悬着的第 3 条（并行座位退不退休）→ **没做任何删除动作**，等你定
