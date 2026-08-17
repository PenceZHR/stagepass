# C 方案实施计划：问人改走文件交接

日期：2026-08-17

设计：`docs/superpowers/specs/2026-08-17-file-handoff-design.md`

## 已落地（2026-08-17 夜）

**地基与纯域逻辑全部做完，1190/1190 绿。** 剩下的都是接线和界面。

- [x] 合并进主 worktree（快进，64 个提交），全绿。
- [x] `src/domain/round-slots.ts` —— 格子文件的完整契约。**按声明的形状走**，
      轮次契约和问人共用同一套保证（结构预铺、id 预填、上限 10、余量 15、
      任何一条对不上就整份拒绝）：
      - `BLOCKER_SHAPE`：severity / title / where / why / owner
      - `QUESTION_SHAPE`：question / why；可选项由调用方传入，措辞归 `question.ts`
      - 抬头带 `role`，红蓝两份不可能互换
      - `artifacts` 预填，模型碰它算越界
      - id 补零成 `G-01`…`G-15`（见下）
      20 条测试，每条守卫做过变异验证。
- [x] `src/system/slot-files.ts` —— 落盘。`~/.stagepass/rounds/<change>/<phase>/r<round>-<role>.json`，
      **持久路径不是临时目录**；重铺幂等；「文件不在」和「一个字没填」分得开。7 条测试。
- [x] `domain/question.ts` 的 `draftedQuestions()` —— 填好的问句格子 → 那张
      「10 字段业务表单」，走的是现成的 `compose`，账本语义一个字没动。4 条测试。

**途中抓到并修掉的一个坑**：格子 id 不补零的话字典序是 `G-1, G-10, G-11, …, G-2`，
撞上 `compose` 的 `order_not_sorted` 守卫（2026-07-30 实测的客户端排序行为），
整批问题发不出去。变异验证确认这条补零是承重的。

## 关键发现：文件 IO 的接缝已经在了

`RoundDependencies` 里本来就有这两样（`src/work/round-runner.ts:147` / `:154`）：

```ts
readonly writeRoundFile: (name: string, content: string) => string;  // 返回路径
readonly readRoundFile: (path: string) => string | null;             // 不在就是 null
```

而且注释里已经写明「文件不在」和「写了但对不上号」必须分开 —— 正是格子文件要的
两种失败。**格子文件不需要新建 IO 层，直接插进来。**

## 三刀，全部落地（2026-08-17）

### 第一刀：轮次契约改走格子 —— ✅ 已落地

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

### 第二刀：问人改在浏览器里答 —— ✅ 已落地并真机验过

已经通的（2026-08-17 夜）：

```
draftQuestions()  铺格子 → 跑一轮 → 读回来 → 落进账本 → 立刻返回（不挂着等）
    ↓
openQuestionOf()  面板把在等的那道题发到浏览器
    ↓
浏览器一组 radio（value 是序号，不是选项原文）
    ↓
POST /api/answer  按 schema 把序号映射回原文 → questions.answer({action,content})
    ↓
账本 status = answered
```

**真机验过**：隔离副本上造一道两问的题，选 → 提交 → 库里 `answered`，
答案是完整措辞；半张表被拒；答完表单消失。

三条问人的路（裁决 `/api/ask`、录需求 `/api/brief`、接受风险 `/api/waive`）都换完了。
一个语义跟着变了、而且是对的：**「会话死了」不再等于「这道题废了」** —— 题就摆在
页面上，跟会话活不活着没关系。

真机点出来、单测碰不到的一个坑（已修并补测）：`questions.answer` 收的是
elicitation 那个信封 `{action, content}`，不是裸答案表 —— 塞裸表炸
`answer_action_unknown`。换的是人在哪儿答，不是账本的语义。

### 第三刀：把 MCP 整条拆掉 —— ✅ 已落地

**必须等第二刀落地之后**，否则问人这条路会断。要拆的：

- `src/plugin/`（整个目录：`server.ts` / `protocol.ts` 及其测试）
- `web/panel-server.ts:194 pluginAppServerConfigFor` 与 `:1730 configFor`
- `codex/native-tui-owner.ts`（反向请求处理，连同它的「出声」逻辑一起）
- `system/terminal-app.ts` 里 `TerminalTarget.config` 与 `-c` 覆盖
  （2026-08-17 实测：`--remote` 下这些 `-c` 对 MCP 无效，本来就是死代码）
- `docs/CODEX-CONTRACT.md` 里的 MCP 所有权规则

不留回退。两条路同时活着，就是「同一件事两条路只有一条做对」。

## 顺带清掉的

- ✅ **MCP 进程泄漏**：拆掉 MCP 之后不再有 `plugin/server.ts` 被拉起。
- ✅ **还没跑过 turn 的新线程被判失败**：`readRecentTurns` 撞上
  `not materialized yet` 会让整个 job failed（真机在「再来一轮」续跑时点出来）。
  一条连第一条用户消息都没收到的线程可证明有零轮 turn —— 那是答案不是错误。

## 还没做

- **零轮次线程仍会被绑进 binding**（`web/native-sessions.ts`，`openOnce` 里
  `host.open` 之后立刻 `bind`）。Codex 让零轮次线程保持 ephemeral，于是它永远进不了
  `thread/list`，下次被判 missing → detach → 再建一条。`90fd19e` 给旧的
  `StreamSessions` 立过「零轮次不绑」的规矩，原生 TUI 这条路没跟上。
- **一整轮红蓝真跑**没有验过 —— 格子文件那条路的单测齐了，但它最终的判据是
  真机上跑一轮红蓝出来。
