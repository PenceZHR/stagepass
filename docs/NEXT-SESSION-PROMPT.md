# 下一轮会话的开场提示词

> 直接把下面整段贴给新会话。**这份每次交接都要重写** —— 它是新会话第一眼看的
> 东西，过期一句就会误导一整个会话（上上版整篇过期了半个月没人发现）。
>
> 本版写于 2026-08-09 晚（美东）。**当天下午环 v3 六批全部落地** —— 而面板
> 大概率还跑着上午的旧代码。读到这里先查库里的真状态，别拿快照当现在。

---

接手 StagePass。**先读这三份，别跳过：**

1. `docs/PLAN-2026-08-09-ring-v3.md` —— 环 v3 总纲：一整轮谈话的八条拍板 + 七批
2. `docs/ARCH-ring-v3-2026-08-09.md` —— 环 v3 技术架构，细到文件与函数
3. `docs/HANDOFF-2026-08-08.md` —— 更早的账（真机 bug 与撤回并行的背景）

要挖背景再读：`PRD-stagepass-rebuild-2026-07-28.md`（唯一权威）、
`DESIGN-phase-not-the-only-axis-2026-08-06.md`（地基改动）、
`RUBRICS-AND-TEMPLATES.md`（模板和标准，**从代码生成**，改完跑
`node --import tsx scripts/dump-rubrics.ts`）。

## 2026-08-09 这天做了什么

**上午（旧环上的真机）**：面板重启吃到 `bc956c6`；Arch 重写七轮收工批准
（「输出太宽泛」的治法立住了）；`8938e1b` 裁决会话抽风不再干等；裁决题面
加两条真机注记（死而复生的轮、评旧产出的判定）。

**下午（环 v3 六批，217df86..b8ed59f，每批一个 commit、`pnpm check` 全绿）**：

- **批 1 域层**：主线换成八阶段
  `PRD → Spec → Arch → [BuildPlan∥TestPlan] → [Build∥Test] → QA`，QA 批准即
  closed。退休七个（TechSpec/Plan/Review/Fix/Merge/Retro/Done），名字留给历史。
  两轨互盲写进 CONSUMES；reject 处处=原地再来一轮，rerun/送修连根拆除。
- **批 2 模板**：TestPlan 收窄成纯方案（测试代码归 Test），落点从记录变**声明**。
- **批 3 迁移**：活库自动迁（rerun 给历史留席位；停在退休阶段的 Change 按
  ABSORBED_BY 搬家，Plan→BuildPlan、Review/Merge/Retro/Done→QA）。
- **批 4 并行重开**：分叉自动开座（批准落到 BuildPlan/Build 给孪生开座）；
  案 B 落地（Test 窄提交、Build 挡门 `twin_track_midflight`）；撤回审计的六条
  P0 逐条还清；插件多一个 `STAGEPASS_PHASE`。
- **批 5 QA 三攻**：读（收编旧 Review 的静态审查）/ 跑（必过判据挪过来）/
  变（还原必红 + no-op 仍绿）。案卷=任务书的上游投递，不另建装订器。
- **批 6 Arch 编辑过门**：EDIT-1（P1 gap）轮末必开；`/api/ask` 检测产出文件的
  未提交改动即关门；模型看不见这道门；人可 waive/驳回（要理由）。

## 当前状态（快照，先查库核实）

- 分支 `build-the-base-2026-08-05`，`pnpm check` **1136 全绿**
- **批 7 部分落地**（当晚）：回跳火箭计划四任务全落（删圆盘 f953308、凝结尾迹
  0b83935、小火箭 e05cc6f，真面板目检全过）。还欠：钻石画法（并行座位并排）、
  座位状态上环、closed 后自由终端的 UI 入口（后端已通有测试钉）
- 真库 `~/.stagepass/panel.db`：我查时 CHG-001 在 **`Build/running`**（上午的
  旧代码面板还在跑）。**重启面板 = 吃到环 v3 + 自动迁库** —— 老 Plan 历史行
  照旧可读，账本里的 rerun 有历史席位

## 起面板（**必须从真终端起**，别用 Run 按钮 —— 那样起的面板 spawn codex 必 EPERM 秒死）

```bash
cd ~/Desktop/stagepass && node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db --change CHG-001 --effort xhigh --turn-timeout 180
```

## 第一件事

面板已重启过、活库已迁移（三条验收全过：CHECK 换新、证据搬家、账本无损）。
CHG-001 在 `Build/blocked` 等人 retry —— 按下去就是环 v3 第一轮真轮，核两条：
任务书带 Plan-r3.md、一个字不提测试。注意 CHG-001 走不到 BuildPlan∥TestPlan
分叉（它已过那段），第一次钻石要新开一条 Change。

## 还欠着人拍的事

1. **删除一个 Change 的语义** —— 库 / 工作树 / git 历史三层，删到哪一层
2. **批 7 那三个 UI 文件** —— 你未提交的改动怎么处理（自己提交，还是让下一轮
   基于它续做钻石画法）

（原清单的另外三件已被环 v3 收掉：工作区隔离=案 B 落地；Review 闸门=并入
Build/QA；批 4 联动=Fix 退休后由通用 sendBack 覆盖。）

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
- **两轨互盲不许开后门** —— Build 的题面里不得出现测试，Test 的不得出现实现；
  有测试钉着，别为「方便」绕。
- **AI 的软开和人的不一样**（PLAN-2026-08-06 §八那张表）：不要按「正常软件流程」
  把模板、机械闸门、离散判定这些细节简化掉 —— 每一条背后都有一次真机取证。
