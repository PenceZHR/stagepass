# C 方案实施计划：问人改走文件交接

日期：2026-08-17

设计：`docs/superpowers/specs/2026-08-17-file-handoff-design.md`

## 已落地（2026-08-17 夜）

- [x] `src/domain/round-slots.ts` —— 格子文件的完整契约：铺结构、预填 id 与
      artifacts、按阶段决定要不要 overall、读回来时逐条判、`slotContract()` 题面文本。
      14 条测试，每条守卫做过变异验证（逐个拆掉确认变红）。
- [x] 合并进主 worktree（快进，64 个提交），全绿。

## 关键发现：文件 IO 的接缝已经在了

`RoundDependencies` 里本来就有这两样（`src/work/round-runner.ts:147` / `:154`）：

```ts
readonly writeRoundFile: (name: string, content: string) => string;  // 返回路径
readonly readRoundFile: (path: string) => string | null;             // 不在就是 null
```

而且注释里已经写明「文件不在」和「写了但对不上号」必须分开 —— 正是格子文件要的
两种失败。**格子文件不需要新建 IO 层，直接插进来。**

## 剩下的三刀，按顺序

### 第一刀：轮次契约改走格子（模型 → StagePass 这个方向）

这是「整轮作废」那一类不稳定的来源，自成一体，不依赖浏览器改动。

涉及的点（都已定位）：

| 位置 | 现在 | 改成 |
|---|---|---|
| `domain/turn.ts` `RESULT_CONTRACT` / `BLUE_VERDICT_ONLY_CONTRACT` | 印在提示词里的 JSON 骨架 | 删掉，换 `slotContract(path)` |
| `domain/round.ts:679 / :704 / :713`（`judgePrompt`） | 把上面两个契约拼进红蓝两份题面 | 拼进各自的格子文件路径 |
| `domain/round.ts:1235 `readRound`` | `parseTurnResult(transcript.red/blue)` 解析模型自撰 JSON | 收下两份 `SlotDocumentResult`，不再解析 transcript |
| `work/round-runner.ts:488`（`readRound` 调用点） | 传 transcript | 派轮前用 `writeRoundFile` 铺两份（红/蓝各一份），收轮后用 `readRoundFile` 读回来 |
| `work/turn-loop.ts:390` | `outcome.blockers.map(...)` | 不动 —— 形状一样，上游换了源而已 |

要点：

1. **红蓝各一份文件**，路径含角色（`r7-red.json` / `r7-blue.json`）。
   `SlotHeader` 要加 `role`，否则两份文件可以互换而判不出来。
2. 拒绝的理由走**现有的 `malformed` 通道**（`RoundSettled.malformed`），
   它本来就会带进下一轮 —— 不需要新建失败通路。
3. 红方 blockers 在多数阶段本来就被丢（`discardBlockers: !redReviewsOthers(phase)`），
   丢的规则不动，只换来源。
4. `round-prompt.golden.txt` 会变，**那是要人看的**，别自动接受。

### 第二刀：问人改在浏览器里答（这一刀才解掉 CHG-002 的卡）

现状：`/api/ask`（`web/panel-server.ts:1853`）发起一轮，让模型去调
`stagepass_ask`，人在 **TUI 的 MCP elicitation 表单**里答。

**注意：问题的形状和 blocker 不一样**（问题是「问句 + 可选项」，blocker 是
`severity/title/where/why`）。所以 `round-slots.ts` 要泛化成「一种声明好的格子形状」，
让轮次契约和问人各用各的形状，共用同一套保证（预填 id、上限 10、余量 15、
整份拒绝）。**这一步是新设计，不是接线，动手前先定形状。**

然后：

1. 模型把问题填进格子文件 → StagePass 读出来写进 `questions`（`store/question-store.ts`）；
2. 面板渲染成表单（`questions` 和恢复机制都不用动）；
3. 人在浏览器里答 → 新增一条 `POST /api/answer` → `questions.answer()`
   （`store/question-store.ts:192` 是**唯一**的答案入口，插件那条也是走它，
   所以账本语义天然一致）；
4. 答案写进回答文件，下一轮信封指过去。

### 第三刀：把 MCP 整条拆掉

**必须等第二刀落地之后**，否则问人这条路会断。要拆的：

- `src/plugin/`（整个目录：`server.ts` / `protocol.ts` 及其测试）
- `web/panel-server.ts:194 pluginAppServerConfigFor` 与 `:1730 configFor`
- `codex/native-tui-owner.ts`（反向请求处理，连同它的「出声」逻辑一起）
- `system/terminal-app.ts` 里 `TerminalTarget.config` 与 `-c` 覆盖
  （2026-08-17 实测：`--remote` 下这些 `-c` 对 MCP 无效，本来就是死代码）
- `docs/CODEX-CONTRACT.md` 里的 MCP 所有权规则

不留回退。两条路同时活着，就是「同一件事两条路只有一条做对」。

## 顺带清掉的两笔

- **零轮次线程会被绑进 binding**（`web/native-sessions.ts`，`openOnce` 里
  `host.open` 之后立刻 `bind`）。Codex 让零轮次线程保持 ephemeral，于是它永远进不了
  `thread/list`，下次被判 missing → detach → 再建一条，无限churn。
  `90fd19e` 给旧的 `StreamSessions` 立过「零轮次不绑」的规矩，原生 TUI 这条路没跟上。
- **21 个 `plugin/server.ts` 进程没人回收**（每次 resume 起一个）。第三刀拆掉 MCP
  之后这条自动消失。
