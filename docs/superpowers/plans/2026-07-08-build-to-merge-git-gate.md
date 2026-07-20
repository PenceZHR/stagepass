# Build 到 Merge 的 Git 操作与 Gate 修复方案

> **给执行 agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行。每个步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 所有阶段都允许用户手动执行基础 Git 操作（状态刷新、选择文件 commit、push、commit & push），但在 Merge 之前，Git 状态绝不能阻塞 Build、Review、Fix、QA 等流程；只有 Merge 阶段才强制 Git clean、HEAD 未漂移，并真正把 Build/Fix patch 写入主仓。

**架构：** Build/Fix 输出在 Merge 前都被视为“已批准的隔离产物”，主仓只作为项目和 `.ship` 元数据承载地。Review/QA 读取已批准的 Build/Fix workspace 或 artifact，不要求主仓已应用 patch。Git 面板作为全阶段可用的用户工具存在，所有非 Merge 阶段只显示提示，不参与 action contract 的硬阻塞。

**技术栈：** Next.js App Router、TypeScript service 层、Drizzle/SQLite、现有 Build workspace patch 文件、`tsx` Node test runner、现有 `/api/projects/[id]/git` 与 `GitWorkspacePanel`。

---

## 判断结论

用户的新规则是正确的：

- 用户可以在任意阶段手动 commit/push，这是项目管理工具能力，不应被限制到 Merge 页。
- Build、Review、Fix、QA 都应该能在主仓 dirty 的情况下继续，因为它们使用隔离 workspace 或已批准 artifact。
- Merge 是唯一真正需要主仓 Git 强一致的阶段，因为只有 Merge 会把 patch 应用回主仓。
- Merge 前的 Git 操作必须是“手动工具”，不能反向变成流程 gate。

当前实现的主要问题：

- `server/services/pipeline-build-stage-service.ts` 的 `approveBuildAbsorb` / `approveFixAbsorb` 会在 Build/Fix 批准时调用 `absorbBuildPatch` / `adoptFixPatch`，提前写主仓。
- `server/services/action-contract-service.ts` 对 `adopt_build` / `adopt_fix` 使用 `{ blockDirtyStatus: true }`，导致 Build 阶段被主仓 dirty 阻塞。
- Review/QA 多处代码仍依赖 “latest adopted Build” 和主仓 HEAD，导致把 Merge 语义提前带到 Review/QA。
- QA 当前可能在 Merge 前记录或提交主仓 delivery HEAD，这与“只有 Merge 写主仓”冲突。
- Git commit/push UI 目前主要在项目 Git 页，不是每个 change 阶段都可见。

## 必须满足的行为

- 任意阶段页面都能打开同一个 Git 操作面板或区域，支持：
  - 刷新工作区状态
  - 选择文件
  - 填写或生成 commit message
  - commit
  - push
  - commit & push
- Git 操作失败只显示 Git 操作自己的错误，不改变当前阶段 action contract，不阻塞 Build/Review/Fix/QA。
- Build start/retry/approve、Review、Fix、QA 不因主仓 dirty 被禁用。
- Review/QA 必须读取 approved Build/Fix workspace 或 artifact，不读未应用 patch 的主仓产品文件。
- Merge action contract / release route 必须同步检查主仓 working tree 完全 clean、HEAD 未漂移，失败时不启动异步 Merge。
- Merge 阶段才调用 patch apply，并在成功后把 BuildRun 标记为 `adopted`。

## 非目标

- 不移除 Merge 的 Git 强校验。
- 不删除 `.ship/` 或流水线元数据。
- 不自动丢弃 tracked 用户改动。
- 不在 Build 阶段把产品文件写入主仓。
- 不要求用户在 Merge 前必须 commit/push；Merge 前 Git 操作永远是可选工具。

## 任务 1：解除 Build/Fix 对主仓 dirty 的硬阻塞

**文件：**
- 修改：`server/services/action-contract-service.ts`
- 修改测试：`server/services/action-contract-service.test.ts`

- [ ] **步骤 1：改写失败测试**

在 `server/services/action-contract-service.test.ts` 中，把“dirty Base Camp 会禁用 Build absorb”的断言改为“dirty Base Camp 不禁用 `adopt_build`”。

断言形态：

```ts
assert.equal(adoptBuild?.enabled, true);
assert.equal(adoptBuild?.reasonCode, null);
```

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "Build absorb.*dirty|dirty.*Build absorb|Build actions" server/services/action-contract-service.test.ts
```

修改前预期：测试失败，`adopt_build` 被 `build_base_camp_blocked` 禁用。

- [ ] **步骤 3：修改 action contract**

在 `server/services/action-contract-service.ts` 中，`adopt_build` / `adopt_fix` 分支不要再传 `{ blockDirtyStatus: true }`。

目标代码语义：

```ts
if (definition.actionId === "adopt_build" || definition.actionId === "adopt_fix") {
  return buildBaseCampDecision(
    changeId,
    repoPath,
    adoptBuildRunDecision(getActionContractDb(), changeId),
  );
}
```

这样仍可阻塞“不是 Git repo / HEAD 不存在”这类基础不可用情况，但不阻塞普通 dirty 工作区。

- [ ] **步骤 4：验证**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "Build absorb.*dirty|dirty.*Build absorb|Build actions" server/services/action-contract-service.test.ts
```

预期：通过。

## 任务 2：Build/Fix 批准只批准 artifact，不应用 patch 到主仓

**文件：**
- 修改：`server/services/pipeline-build-stage-service.ts`
- 修改测试：`server/services/pipeline-service.test.ts`

- [ ] **步骤 1：添加失败测试**

在现有 `approveBuildAbsorb` 测试附近添加测试：Build workspace patch 修改 `src/app.ts`，但点击批准后主仓 `src/app.ts` 不变。

断言形态：

```ts
await approveBuildAbsorb(CHANGE_ID);
assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "approved_for_absorb");
assert.equal(getChange(CHANGE_ID)?.status, "IMPLEMENTED");
```

如果附近有 `approveFixAbsorb` 测试 helper，也添加 Fix 对应测试。

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "approveBuildAbsorb|approveFixAbsorb|Build absorb" server/services/pipeline-service.test.ts
```

修改前预期：测试失败，因为当前 `absorbBuildPatch` 会修改主仓。

- [ ] **步骤 3：修改批准逻辑**

在 `server/services/pipeline-build-stage-service.ts`：

- `approveBuildAbsorb` 只调用 `approveBuildForAbsorb`，然后 `setStatus(changeId, "IMPLEMENTED")`。
- `approveFixAbsorb` 只批准 Fix artifact，推进到 `IMPLEMENTED`。
- 不调用 `absorbBuildPatch(...)`。
- 不调用 `adoptFixPatch(...)`。

- [ ] **步骤 4：保留 artifact 校验**

不要绕过 `approveBuildForAbsorb`。它仍必须验证 patch path、patch hash、base commit、approval file。

- [ ] **步骤 5：验证**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "approveBuildAbsorb|approveFixAbsorb|Build absorb" server/services/pipeline-service.test.ts
```

预期：通过，且主仓产品文件未被修改。

## 任务 3：把 patch 应用移动到 Merge，并同步强制 Git gate

**文件：**
- 修改：`server/services/pipeline-release-retro-stage-service.ts`
- 修改：`server/services/merge-readiness-service.ts`
- 修改：`app/api/projects/[id]/changes/[changeId]/release/route.ts`
- 可能修改：`server/services/build-workspace-service.ts`
- 修改测试：`server/services/merge-readiness-service.test.ts`
- 修改测试：`server/services/pipeline-routes.test.ts`
- 修改测试：`server/services/pipeline-service.test.ts`
- 修改测试：`server/services/action-contract-service.test.ts`

- [ ] **步骤 1：添加 approved artifact 的 Merge readiness 测试**

构造 latest BuildRun / build record：

```ts
status: "approved_for_absorb"
baseCommit: MAIN_HEAD
patchHash: "patch-hash"
changedFilesHash: "changed-files-hash"
adoptedHeadSha: null
```

断言：

```ts
const readiness = computeMergeReadiness({ changeId: CHANGE_ID, requireApproval: false });
assert.equal(readiness.blockers.some((item) => item.reasonCode === "build_not_adopted"), false);
```

使用 `requireApproval: false` 或 seed merge approval row，避免测试被 `merge_approval_missing` 干扰。

- [ ] **步骤 2：添加同步 dirty Merge gate 测试**

为 release route 和 action contract 增加测试：主仓 dirty 时，Merge 在异步任务启动前失败。

route 断言：

```ts
const response = await POST(request, context);
assert.equal(response.status, 409);
assert.match(await response.text(), /dirty|uncommitted|working tree|Git/i);
```

action contract 断言：

```ts
const merge = actions.find((action) => action.actionId === "merge");
assert.equal(merge?.enabled, false);
assert.match(merge?.reason ?? "", /dirty|uncommitted|working tree|Git/i);
```

- [ ] **步骤 3：添加 Merge 应用 patch 测试**

断言 `runRelease` 或 Merge route 在 readiness 通过后，才把 approved patch 应用到主仓：

```ts
await runRelease(CHANGE_ID);
assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
```

- [ ] **步骤 4：修改 Merge readiness source**

在 `server/services/merge-readiness-service.ts` 中，替换只接受 `status = "adopted"` 的逻辑。

Merge 前 resolver 必须接受：

```ts
status === "approved_for_absorb" || status === "adopted"
```

Merge 前 source identity 使用：

```ts
buildRunId
baseCommit
patchHash
changedFilesHash
```

Merge 前不得要求：

```ts
adoptedHeadSha
adoptedAt
```

- [ ] **步骤 5：同步强制 Git clean**

在 `computeMergeReadiness` / `assertCanMerge` 中同步检查：

```ts
currentHead === approvedBuild.baseCommit
主仓 working tree 完全 clean
```

dirty working tree 必须作为 Merge blocker 返回，不能等 `runRelease` 异步失败。这里的 clean 是完整 Git clean，不按产品文件和非产品文件区分；`.ship`、生成物、未追踪文件等只要 Git 认为 dirty，都必须在 Merge 同步 gate 中阻塞。

blocker 形态可按本地约定：

```ts
{
  blockerType: "git",
  severity: "P1",
  reasonCode: "git_worktree_dirty"
}
```

- [ ] **步骤 6：Merge 阶段应用 patch**

在 `runRelease` 生成 release note 前，调用现有 patch apply 逻辑：

```ts
absorbBuildPatch({ repoPath: project.repoPath, changeId });
```

如果 latest run 是 Fix：

```ts
adoptFixPatch({ repoPath: project.repoPath, changeId });
```

- [ ] **步骤 7：Merge 成功后才标记 adopted**

patch 成功应用后，BuildRun 才能写成：

```ts
status: "adopted"
adoptedHeadSha: getHeadSha(project.repoPath)
adoptionDecisionId: "..."
adoptedAt: now
```

Merge 前保持 `approved_for_absorb` 或明确的 pre-merge approved 状态。

- [ ] **步骤 8：保证 retry 幂等**

如果 Merge 部分成功后重试，必须：

- 检测 approved patch 已经匹配主仓并补写 adopted 状态；或
- 返回清晰、可重试、不破坏文件的 conflict。

优先复用现有 `adoptedPatchMatchesWorkspace`，不要写第二套 patch matcher。

- [ ] **步骤 9：验证**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "release|Merge|dirty|approved Build" server/services/pipeline-service.test.ts server/services/pipeline-routes.test.ts server/services/merge-readiness-service.test.ts server/services/action-contract-service.test.ts
```

预期：Merge readiness 接受 approved artifact；Merge 同步阻塞 dirty Git；Merge 才应用 patch。

## 任务 4：Review/QA 使用 approved Build/Fix workspace，不依赖主仓

**文件：**
- 修改：`server/services/pipeline-service.ts`
- 修改：`server/services/action-contract-build-policy.ts`
- 修改：`server/services/action-contract-qa-policy.ts`
- 修改：`server/services/review-run-service.ts`
- 修改：`server/services/review-center-service.ts`
- 修改：`server/services/review-qa-gate-service.ts`
- 修改：`server/services/pipeline-qa-stage-service.ts`
- 修改测试：`server/services/review-run-service.test.ts`
- 修改测试：`server/services/review-center-service.test.ts`
- 修改测试：`server/services/qa-run-service.test.ts`
- 修改测试：`server/services/action-contract-service.test.ts`

- [ ] **步骤 1：添加 action contract 测试**

证明主仓 dirty 时，只要存在 latest approved Build artifact：

```ts
assert.equal(runReview?.enabled, true);
assert.equal(enterQa?.enabled, true);
assert.notEqual(runReview?.reasonCode, "review_build_adoption_incomplete");
assert.notEqual(enterQa?.reasonCode, "head_drift");
```

- [ ] **步骤 2：添加 Review 路径测试**

证明 Review engine 收到的是 Build workspace：

```ts
assert.equal(reviewEngineInput.repoPath, buildRun.workspacePath);
```

另外添加 Fix 后 Review/QA 用例，测试名可使用：

```ts
"uses latest approved Fix workspace for Review and QA after a fix run"
```

该用例必须证明 Fix 后不会回读旧 Build workspace 或主仓。

- [ ] **步骤 3：添加 QA 不写主仓测试**

证明 QA 在 Merge 前不提交、不修改主仓：

```ts
await runCheck(CHANGE_ID);
assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
assert.equal(gitLogDoesNotContainAutoCommit(repoPath, CHANGE_ID), true);
```

如果当前导出的 QA 入口名不同，使用 `server/services/pipeline-qa-stage-service.ts` 中现有入口。

- [ ] **步骤 4：实现 approved Build/Fix source resolver**

创建或复用 resolver，返回：

```ts
{
  buildRunId: string;
  workspacePath: string;
  sourceHeadSha: string | null;
  patchHash: string | null;
  changedFilesHash: string | null;
}
```

resolver 必须同时覆盖 approved Build artifact 和 approved Fix artifact/workspace，接受 `approved_for_absorb` 和迁移期间的 `adopted`。新流程优先使用最新的 `approved_for_absorb`，尤其是 Fix 之后不得回读旧 Build 或主仓。

- [ ] **步骤 5：替换 Review/QA action gate**

以下文件都必须使用同一个 resolver：

```ts
server/services/action-contract-build-policy.ts
server/services/action-contract-qa-policy.ts
server/services/review-qa-gate-service.ts
```

Review/QA entry decision 不得再用主仓 HEAD drift 作为 Merge 前 blocker。

- [ ] **步骤 6：Review preflight 使用 workspace**

`preflightReviewRun` 不再调用“主仓 HEAD 匹配 adopted Build”的硬断言，改用 approved source resolver。

Review engine 调用：

```ts
repoPath: approvedBuild.workspacePath
```

`.ship` raw capture 和 pipeline 元数据仍写主项目 `.ship`。

- [ ] **步骤 7：QA 使用 workspace**

`runLocalChecks`、`runScopeCheck` 等 QA 检查应对 approved Build workspace 或等价 staged workspace 运行，而不是未应用 patch 的主仓。

- [ ] **步骤 8：移除 Merge 前 QA 主仓提交/HEAD evidence**

在 `server/services/pipeline-qa-stage-service.ts` 中移除或 gate off：

```ts
commitWithMessage(project.repoPath, finalMsg)
recordQaDeliveryHead({ qaRunId, deliveryHeadSha: sha })
```

QA 可以记录 Build run id、patch hash、changed-files hash、workspace identity，但不能在 Merge 前创建主仓 commit，也不能把主仓 HEAD 当成最终 delivery。

- [ ] **步骤 9：验证**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "Review requires|latest adopted|sourceBuildRunId|QA source|run_qa|runCheck" server/services/review-run-service.test.ts server/services/review-center-service.test.ts server/services/qa-run-service.test.ts server/services/action-contract-service.test.ts
```

预期：Review/QA 从 approved artifact 继续，不要求主仓已应用 patch，不写主仓。

## 任务 5：修复 Git commit 后端的选择文件语义

**文件：**
- 修改：`server/services/git-service.ts`
- 修改测试：`server/services/git-service.test.ts`（若不存在则新增）
- 可能修改：`app/api/projects/[id]/git/route.ts`

- [ ] **步骤 1：添加 selected paths 后端测试**

为 `commitWithMessage(repoPath, message, paths)` 添加测试，覆盖四类路径：

```ts
modified file
untracked file
deleted file
renamed file
```

测试必须证明：传入 `paths` 时，只提交选中的路径，不提交未选中的 dirty 文件。

断言形态：

```ts
commitWithMessage(repoPath, "selected commit", ["src/changed.ts", "src/deleted.ts"]);
const committed = gitShowNameOnly(repoPath, "HEAD");
assert.deepEqual(committed.sort(), ["src/changed.ts", "src/deleted.ts"].sort());
assert.match(gitStatus(repoPath), /src\/unselected\.ts/);
```

renamed file 必须有明确断言：选择重命名文件后，commit 中应体现旧路径删除和新路径新增/重命名；未选择文件仍保持 dirty。

- [ ] **步骤 2：添加禁止 fallback 全量提交测试**

构造一个显式 `paths` 场景，其中包含 deleted file。测试必须证明：

```ts
paths.length > 0
```

时，`commitWithMessage` 不允许 fallback 到：

```bash
git add -A
```

因为这会把未选择文件也提交。

- [ ] **步骤 3：实现安全 repo-relative pathspec 校验**

在 `server/services/git-service.ts` 中为 selected paths 增加校验：

- 必须是 repo-relative path。
- 不允许绝对路径。
- 不允许 `..` 越界。
- 不允许空字符串。
- 保留删除文件 path，因为删除文件在 filesystem 中不存在但仍是合法 Git pathspec。

校验后使用：

```ts
spawnWithTimeout("git", ["add", "-A", "--", ...validatedPaths], ...)
```

注意：`git add -A -- path` 能正确 stage 删除文件；不要用 `fs.statSync` 判断 path 是否存在作为唯一依据。

- [ ] **步骤 4：显式 paths 失败时不全量提交**

如果显式 paths 的 `git add -A -- ...paths` 失败，应该抛出错误，并让 API 返回错误；不得 fallback 到全量 `git add -A`。

只有在 `paths` 为空或未提供时，才允许全量：

```bash
git add -A
```

- [ ] **步骤 5：验证 API paths 透传**

确保 `app/api/projects/[id]/git/route.ts` 的 `commit_changes` action 继续把 `paths` 传给 `commitWithMessage`：

```ts
commitWithMessage(repoPath, commitMsg.trim(), paths);
```

新增或更新 route 测试，证明 request body 中的 selected paths 被传入 service。

- [ ] **步骤 6：验证**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "commitWithMessage|selected paths|commit_changes" server/services/git-service.test.ts server/services/project-service.test.ts
```

预期：modified/untracked/deleted/renamed selected paths 都能正确提交，未选择文件保留 dirty，显式 paths 不会 fallback 到全量提交。

## 任务 6：每个阶段页面提供手动 Git 操作面板，但不参与流程阻塞

**文件：**
- 修改：`app/projects/[id]/changes/[changeId]/page.tsx`
- 修改：`app/projects/[id]/changes/[changeId]/phase-stage-shell.tsx` 或 `stage-frame.tsx`（按现有结构选择）
- 复用或抽取：`app/projects/[id]/git-workspace-panel.tsx`
- 可能新增：`app/projects/[id]/changes/[changeId]/stage-git-panel.tsx`
- 修改测试：`app/projects/[id]/changes/[changeId]/phase-review.test.ts`
- 修改测试：`app/projects/[id]/changes/[changeId]/stage-frame.test.ts`

- [ ] **步骤 1：添加 UI 结构测试**

测试每个 selected phase 的 StageFrame/PhaseStageShell 都包含 Git 工具入口。

断言形态：

```ts
assert.match(src, /<StageGitPanel/);
assert.match(src, /projectId=\{projectId\}/);
assert.match(src, /selectedPhase=\{activeSelectedPhase\}/);
```

- [ ] **步骤 2：添加显式刷新按钮测试**

测试每个阶段的 Git 面板都有显式刷新按钮，而不是只靠轮询。

断言形态：

```ts
assert.match(src, /刷新|Refresh/);
assert.match(src, /loadStatus/);
assert.match(src, /\/api\/projects\/\$\{projectId\}\/git\/workspace/);
```

刷新失败时，只能显示 Git 面板错误，不得写入 pipeline action error：

```ts
assert.match(src, /setResult\(/);
assert.doesNotMatch(src, /setActionError\(/);
```

- [ ] **步骤 3：抽取可复用 Git 面板**

现有 `app/projects/[id]/git-workspace-panel.tsx` 已支持 commit/push。将其整理为可在 change 页面复用的组件，或新增轻量 wrapper：

```tsx
<StageGitPanel
  projectId={projectId}
  phase={activeSelectedPhase}
  blockingMode={activeSelectedPhase === "Merge" ? "merge" : "none"}
/>
```

`blockingMode="none"` 时只显示 Git 状态和操作结果，不产生 pipeline blocker。

- [ ] **步骤 4：实现显式刷新按钮**

`StageGitPanel` / `GitWorkspacePanel` 必须提供手动“刷新”按钮，调用已有状态接口：

```ts
fetch(`/api/projects/${projectId}/git/workspace`)
```

刷新失败时：

```ts
setResult("刷新 Git 状态失败")
```

或等价 Git 面板局部错误；不得调用 pipeline action 的 error setter。

- [ ] **步骤 5：所有阶段渲染 Git 工具**

在 change detail 页面中，无论当前是 Intake、PRD、Spec、TechSpec、Plan、TestPlan、Build、Review、Fix、Check、Merge、Retro，都渲染 Git 工具入口。

可以放在 StageFrame 的侧栏、工具区或折叠面板中，但不能挤占主要 action 区导致流程按钮不可用。

- [ ] **步骤 6：Git 操作只调用 Git API，不调用 pipeline action contract**

Git 面板的 commit/push 继续调用：

```ts
POST /api/projects/${projectId}/git
```

允许 action：

```ts
"commit_changes"
"push"
```

Git 操作完成后刷新 Git 状态和当前阶段状态，但不得改变当前 phase action 的 enabled/disabled 规则。Merge 前即使 commit/push 失败，也不能禁用 Build/Review/Fix/QA 的继续按钮。

- [ ] **步骤 7：支持选择文件 commit**

当前 `GitWorkspacePanel` 有 `selectedPaths`，但 `handleCommit` 需要把 paths 传给 API：

```ts
body: JSON.stringify({
  action: "commit_changes",
  message: commitMsg,
  paths: Array.from(selectedPaths),
})
```

确保用户可以在任意阶段选择部分文件 commit。

- [ ] **步骤 8：Git 操作失败不阻塞流程**

添加测试：commit/push 返回错误时，页面显示错误，但 Build/Review/QA 等 pipeline action 仍按原 action contract 渲染。

断言形态：

```ts
assert.match(src, /setResult\(`提交失败:/);
assert.doesNotMatch(src, /setActionError\(`提交失败:/);
```

如果代码使用不同状态名，保持语义：Git 错误不得写入 pipeline action error。

- [ ] **步骤 9：Merge 页面显示 Git 是硬 gate**

Merge 阶段的 Git 面板可以显示更强提示，例如：

```ts
"Merge 前必须清理主仓 Git 状态。"
```

但真正的阻塞来源仍必须是 `merge` action contract / `assertCanMerge`，不是 UI 本地判断。

- [ ] **步骤 10：验证**

运行：

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/phase-review.test.ts')"
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/stage-frame.test.ts')"
```

预期：每阶段都有 Git 工具入口，且 Git 操作错误不会污染 pipeline action 状态。

## 任务 7：Build 页面 Git 状态只作为提示

**文件：**
- 修改：`app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- 修改测试：`app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`

- [ ] **步骤 1：更新 UI 测试**

替换“dirty Base Camp 禁用 Build absorb”的测试。

新断言：

```ts
assert.doesNotMatch(componentSource, /const canApproveAbsorb = approveAbsorbAction\?\.enabled === true && absorbBaseCampReason === null/);
assert.match(componentSource, /baseCamp\.warnings/);
```

- [ ] **步骤 2：修改 UI 行为**

Build approve 按钮只看 action contract：

```ts
const canApproveAbsorb = approveAbsorbAction?.enabled === true;
```

禁止：

```ts
const canApproveAbsorb = approveAbsorbAction?.enabled === true && absorbBaseCampReason === null;
```

- [ ] **步骤 3：修改提示文案**

把“需清理后才能收编 Build”改为：

```ts
"主仓 Git 状态仅在 Merge 阶段强制；当前阶段可继续。"
```

- [ ] **步骤 4：验证**

运行：

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-sandbox.test.ts')"
```

预期：通过，dirty Git 不再禁用 Build approval。

## 任务 8：全量验证

**文件：**
- 无新增代码；仅验证。

- [ ] **步骤 1：后端聚焦测试**

运行：

```bash
pnpm exec tsx --test --test-name-pattern "Build absorb|approveBuildAbsorb|approveFixAbsorb|Review requires|QA source|Merge|dirty|approved Build|git" server/services/action-contract-service.test.ts server/services/pipeline-service.test.ts server/services/review-run-service.test.ts server/services/review-center-service.test.ts server/services/qa-run-service.test.ts server/services/pipeline-routes.test.ts server/services/merge-readiness-service.test.ts
```

另外运行 Git 后端选择文件测试：

```bash
pnpm exec tsx --test --test-name-pattern "commitWithMessage|selected paths|commit_changes" server/services/git-service.test.ts server/services/project-service.test.ts
```

- [ ] **步骤 2：前端聚焦测试**

运行：

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-sandbox.test.ts')"
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/phase-review.test.ts')"
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/stage-frame.test.ts')"
```

- [ ] **步骤 3：类型检查**

运行：

```bash
pnpm exec tsc --noEmit
```

## 审核清单

- Build/Fix approval 不再应用 patch 到主仓。
- Review/QA 不再依赖主仓已应用 patch。
- Review/QA action contract 不因主仓 dirty 被禁用。
- QA 不再 Merge 前 auto commit 或记录主仓 delivery HEAD。
- 每个阶段都有手动 Git 工具入口。
- 每个阶段 Git 工具都有显式刷新按钮。
- selected paths commit 不会错误 fallback 到全量提交，且支持删除/重命名文件。
- Git commit/push 失败只影响 Git 面板，不影响 pipeline action contract。
- Merge 是唯一强制 Git clean/HEAD 未漂移的阶段。
- Merge route 在启动异步任务前同步拒绝 dirty Git。
- Merge 成功应用 patch 后才把 BuildRun 标记为 `adopted`。
