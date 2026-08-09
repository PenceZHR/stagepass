# 下一轮会话的开场提示词

> 直接把下面整段贴给新会话。**这份每次交接都要重写** —— 上一版整篇过期了半个月
> 没人发现（还写着 `main = 144bf19`、`pnpm check 418`、一个早就不存在的 CHG-002），
> 而它正是新会话第一眼看的东西。

---

接手 StagePass。**先读这两份，别跳过：**

1. `docs/HANDOFF-2026-08-08.md` —— 最近一次的账：三个真机 bug、撤回并行座位、
   TechSpec 并进 Arch、「输出太宽泛」的治法。**它的 §〇 是三条接手须知。**
2. `docs/PLAN-2026-08-06.md` —— 五批的总纲（批 0/1/2/5 已落，批 3 撤回，批 4 待）

要挖背景再读：`PRD-stagepass-rebuild-2026-07-28.md`（唯一权威）、
`DESIGN-phase-not-the-only-axis-2026-08-06.md`（地基改动）、
`RUBRICS-AND-TEMPLATES.md`（十份模板和标准的现状，**从代码生成**，改完跑
`node --import tsx scripts/dump-rubrics.ts`）。

## 当前状态（2026-08-09 00:30）

- 分支 `build-the-base-2026-08-05`，`pnpm check` **1112 全绿**，工作树干净
- 阶段 **11 个**（TechSpec 2026-08-08 退休，并进 Arch）：
  `PRD → Spec → Arch → Plan → TestPlan → Build → Review → QA → Merge → Retro → Done`
  （`Fix` 由打回进入，不在主线上）
- 真库 `~/.stagepass/panel.db`：`PRJ-001 小游戏`（`~/Desktop/demo`）、
  **`CHG-001` 停在 `Arch/settled`，`returnStack: ["Build"]`**

## 起面板（**必须从真终端起**，别用 Run 按钮 —— 那样起的面板 spawn codex 必 EPERM 秒死）

```bash
cd ~/Desktop/stagepass && node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db --change CHG-001 --effort xhigh --turn-timeout 180
```

## 第一件事

**重启面板**（当前跑的进程是 08-08 13:04 起的旧代码，没有 `bc956c6` 那个修复），
然后处理 CHG-001 在 Arch 上等着的裁决：第 4 轮判了 6 条 `no`，裁判说还要再来一轮。
选「再来一轮」会当场续跑，不用回来再按。

## 还欠着人拍的四件事

1. **并行的 commit 阶段怎么隔离工作区** —— 批 3 重新开张的前提
   （TestPlan 和 Build 都产 commit，共用一个工作区会互相卷进对方的半成品）
2. **Review 有没有自己的闸门** —— 方案默认「没有，作为 Build 出口那一次表态的输入」
3. **删除一个 Change 的语义** —— 库 / 工作树 / git 历史三层，删到哪一层
4. **批 4（Review/Fix 联动）** —— 按计划留到 Review 真跑过一轮之后

---

## 我要的应用场景（这是判断一切的标准）

> 我和 AI 谈清楚我的具体需求 → 红方起草 PRD → 蓝方反击 → **他们把 PRD 和建议一起
> 带回给我** → 我要么再开一轮，要么接受。

## 几条不许被简化掉的规矩

- **网页上永远不许有 approve / reject 按钮。** 裁决发生在 Codex 自己画的选择器里。
  网页只能改「标准」（rubric），永远不能对「这一次的产物」下判断。
- **不许解析 pty 的字节**（PRD §9.3）。终端那块画面是 Codex 的，StagePass 一个像素
  都不画。
- **绝对不许 exec，只走面板 TUI** —— 验证性实验也算：要证什么就用生产代码那条路证。
- **精确标识符绝不许手抄** —— 凡是 StagePass 会拿去做精确匹配的字符串，都不许出现在
  模型必须生成的文本里（`DESIGN-no-hand-transcription-2026-08-02.md`）。
- **AI 的软开和人的不一样**（PLAN §八那张表）：不要按「正常软件流程」把模板、
  机械闸门、离散判定这些细节简化掉 —— 每一条背后都有一次真机取证。
