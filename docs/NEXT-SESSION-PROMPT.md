# 下一轮会话的开场提示词

> 直接把下面整段贴给新会话。**这份每次交接都要重写** —— 它是新会话第一眼看的
> 东西，过期一句就会误导一整个会话（上上版整篇过期了半个月没人发现）。
>
> 本版写于 2026-08-09 07:00（美东)，当时 Plan 正在跑一轮 —— 读到这里先查库里
> 的真状态，别拿下面的快照当现在。

---

接手 StagePass。**先读这两份，别跳过：**

1. `docs/HANDOFF-2026-08-08.md` —— 最近一次的大账：三个真机 bug、撤回并行座位、
   TechSpec 并进 Arch、「输出太宽泛」的治法。
2. `docs/PLAN-2026-08-06.md` —— 五批的总纲（批 0/1/2/5 已落，批 3 撤回，批 4 待）

要挖背景再读：`PRD-stagepass-rebuild-2026-07-28.md`（唯一权威）、
`DESIGN-phase-not-the-only-axis-2026-08-06.md`（地基改动）、
`RUBRICS-AND-TEMPLATES.md`（十份模板和标准的现状，**从代码生成**，改完跑
`node --import tsx scripts/dump-rubrics.ts`）。

## 2026-08-09 这天做了什么（快照）

- **面板已经重启过了**：`bc956c6`（认自己提示词）从 06:39 起生效。此前它没生效时
  又付了两次学费：Arch 第 5 轮 3 小时超时被判死（线程后来跑完，`Arch-r5.md`
  落盘无人认领，被第 6 轮 commit 卷走）；Plan 派发 2 秒被误判。
- **Arch 重写收工并批准**（seq 79，`Arch → Plan`）：7 轮，从「11 条全 yes 但人说
  太宽泛」到「20 条含粒度挡门全过」。「输出太宽泛」的治法在真机上立住了。
- **`8938e1b`**：裁决会话模型抽风（turn 结束了却没把题端给人）不再让人干等 ——
  waitForAnswer 加第三个活性判据 + 自动补问一次 + 所有「没答上」的下场落库。
- **裁决题面加了两条真机注记**（这天最后一个 commit）：
  ① 上一轮判了失败而线程后来跑完了 → 题面说「产出可能已落盘，先看一眼再选」；
  ② 判定落库之后上游又结算过 → 题面标「这些判定评的是上游变动之前的东西」
  （Plan 那道「9 条全部满足」其实是三天前旧轮的判定，人差点拿着旧话裁新局）。

## 当时的状态（快照，先查库核实）

- 分支 `build-the-base-2026-08-05`，`pnpm check` 全绿，工作树干净
- 阶段 11 个：`PRD → Spec → Arch → Plan → TestPlan → Build → Review → QA →
  Merge → Retro → Done`（TechSpec/Fix 退休在册）
- 真库 `~/.stagepass/panel.db`：`CHG-001` 在 **`Plan/running`**（对着 Arch-r7
  重写计划的那一轮），`returnStack: ["Build"]` —— Plan 之后沿 TestPlan 回 Build

## 起面板（**必须从真终端起**，别用 Run 按钮 —— 那样起的面板 spawn codex 必 EPERM 秒死）

```bash
cd ~/Desktop/stagepass && node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db --change CHG-001 --effort xhigh --turn-timeout 180
```

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
