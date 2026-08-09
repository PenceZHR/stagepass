# 并行的 commit 阶段怎么隔离工作区（批 3 重开的前提）

> 状态：**方案，等人拍。** 2026-08-09。
>
> 背景：批 3（并行座位）2026-08-08 撤回，审计 12 个问题、6 个 P0（交接
> §四）。其中 5 条 P0 是独立 bug，逐条修就是；**只有第 5 条是设计层没答的**：
> 两个整树 commit 的阶段共用一个工作区，先收工的把另一条的半成品 commit 进
> 自己的 sha。这份文档只答这一条。

## 地基事实（都在代码里，不是推测）

1. `commitAll` 的使用者只有三个阶段：`PRODUCES_COMMIT = {Build, Fix, TestPlan}`
   （`domain/phase.ts`）。批 3 的默认场景 TestPlan ∥ Build 恰好两个都在名单里。
2. **设计类阶段已经不整树提交了**：2026-08-05 起轮末走 `repo.commitPaths`，
   只碰 `docs/stagepass/<change>/`，目录外一个字节不动（`round-turn-runner.ts`
   `producedBy`）。也就是说「窄提交」这条路已经铺好、真机跑了四天。
3. **Codex 的目录信任按 git 根记**（2026-08-05 实测，没信任的目录整轮静默烧满
   超时）。git worktree 的 `--show-toplevel` 是 worktree 自己的路径 —— 每棵
   新树都要人重新点一次信任。
4. `workspaceFor` 是单路径假设：Change → Project → path，面板、产物读取、
   fence、dirtyPaths 全走它。
5. 新模板（2026-08-08）要求 TestPlan 的用例带 **id 和落点文件** —— 它的产出
   面是可声明、可枚举的。

## 三案

### 案 A：git worktree，一个座位一棵树

物理隔离最彻底，`commitAll` 语义不用动。代价三条，每条都不小：

- **信任面**（事实 3）：worktree 动态建就动态要人点信任 —— 无人值守死。
  只有「固定双轨」变体可行：预建两棵长期 worktree，信任各点一次。
- **单路径地基**（事实 4）：`workspaceFor` 要长出「座位 → 路径」一层，面板、
  产物、fence、dirty 检查全要跟着走。改动面是全树的。
- **合并没人答**：两棵树各自 commit，最终要合回主线 —— 这凭空造出一个
  「谁来 merge、冲突谁裁」的新阶段，比原问题还大。

### 案 B：TestPlan 退出整树提交，Build 提交前挡门（推荐）

顺着事实 2 已经铺好的路走：

1. **TestPlan 从 `PRODUCES_COMMIT` 摘掉整树语义**，轮末改窄提交：
   `commitPaths(cwd, [artifactHome, ...红方声明的落点文件], …)`。
   它的 sha 本来就只该代表「测试方案 + 测试代码」，整树快照是搭便车。
2. **Build 保持 `commitAll`** —— 它是第一个要求干净树的阶段，独占树是它的
   语义本身。
3. **Build 提交前加一道机械挡门**：`dirtyPaths ∩ 并行座位声明的落点` 非空
   → 这一轮 blocked，报「谁的哪几个文件挡了路」（和 `workspace_dirty`
   同一个形状，文件名单齐全）。不静默卷走，不静默排除 —— 阻断归人管。
4. git index 锁的短暂并发冲突：commit 失败重试一次，还不行就照常 blocked
   报人。

**冲突面收敛成一条可检查的规矩**：并行座位各自声明落点，Build 不碰别人声明
的落点。违反了不是悄悄合进去，是当场停下来给人看。

代价（要诚实说的）：TestPlan 的 sha 不再含 Build 的同期改动 —— 下一轮蓝方
要看「基于哪一版」时，看到的是测试文件自己的血缘。这正是并行的语义：两条线
本来就不该互为基线。

### 案 C：并行只许「不产 commit」的组合

TestPlan ∥ Build 禁掉，只放 Plan ∥ TestPlan 这类。最小改 —— 但批 3 的主场景
（用户点名的 TestPlan ∥ Build）没了，等于不做。不推荐。

## 推荐与理由

**案 B。** 不引入新的信任面（案 A 的坑 3）、不动单路径地基（坑 4）、不造
merge 阶段；窄提交那半已经真机跑了四天。剩余风险都缩成了机械可查、失败可见
的形状。

## 重开批 3 的完整清单（案 B 拍了之后）

1. 案 B 的三条改动 + 回归测试
2. 审计其余 5 条 P0 逐条修：worklist 按 (Change, 阶段) 分队列、孤儿座位、
   blocked 座位的出口、`sendBack` 不收编 settled 座位、`Done` 不开座位
3. `serveParallel` 撤回解除，真机验收：TestPlan ∥ Build 一整轮

## 要真机验的点（离线证不了的）

- 两个 codex 同时收工时 git index 锁的真实表现（重试一次够不够）
- Build 真实轮里 `tests/` 交集出现的频率（挡门会不会太吵）
