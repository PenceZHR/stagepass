# StagePass Card Native Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `stagepass-card` 插件改成与 StagePass 主系统一致的 A「紧凑原生」卡片，并在新 Codex Desktop 常驻任务中重新证明工具调用与卡片渲染。

**Architecture:** 保持现有 MCP server、工具名、资源 URI 和消息通道不变，只替换内嵌卡片的视觉结构与局部状态反馈。个人插件源码仍位于 `~/plugins/stagepass-card`，通过 cachebuster 生成新版本并从 Personal marketplace 重装；验证使用 StagePass App Server 与 Desktop follower 创建全新任务。

**Tech Stack:** MCP JSON-RPC、MCP Apps HTML、原生 CSS/JavaScript、Node.js test runner、Codex plugin CLI、StagePass Desktop bridge。

---

## File Map

- Modify: `/Users/zhanghr/plugins/stagepass-card/scripts/server.mjs` — 卡片 HTML、CSS 与本地状态反馈。
- Modify: `/Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs` — 视觉契约与交互回归。
- Modify: `/Users/zhanghr/plugins/stagepass-card/.codex-plugin/plugin.json` — cachebuster 仅由官方更新脚本写入。
- Modify: `scripts/probe-codex-desktop-plugin-card.ts` — 输出插件版本和渲染证据路径。
- Create: `.stagepass/verification/codex-desktop-plugin-card-${CARD_RUN_ID}.json` — 新 Desktop 任务证据；`CARD_RUN_ID` 在 Task 3 中生成。

### Task 1: Lock the native visual contract

**Files:**
- Modify: `/Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs`
- Test: `/Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs`

- [ ] **Step 1: Add a failing system-token test**

Add this test after the current server exposure test:

```js
test("card uses the StagePass native visual contract", () => {
  assert.match(source, /oklch\\(0\\.175 0\\.035 295/);
  assert.match(source, /oklch\\(0\\.79 0\\.085 73/);
  assert.match(source, /font-family:\\s*Georgia/);
  assert.match(source, /border-left:\\s*2px solid/);
  assert.match(source, /data-role="task-diagnostics"/);
  assert.doesNotMatch(source, /#6d5ef7|rgba\\(109,94,247/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test /Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs
```

Expected: one failure because the old purple styles and always-visible diagnostic rows remain.

- [ ] **Step 3: Add a failing compact hierarchy test**

Add:

```js
test("compact hierarchy keeps only project and turn in the primary facts", () => {
  const primaryFacts = source.match(
    /<div class="facts">([\\s\\S]*?)<\\/div>\\s*<details/,
  )?.[1] ?? "";
  assert.match(primaryFacts, /id="project"/);
  assert.match(primaryFacts, /id="turn"/);
  assert.doesNotMatch(primaryFacts, /id="task"|id="thread"/);
});
```

- [ ] **Step 4: Run the focused tests and retain the red output**

Run:

```bash
node --test --test-name-pattern="native visual|compact hierarchy" \
  /Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs
```

Expected: both new tests fail before implementation.

### Task 2: Implement A “Compact Native”

**Files:**
- Modify: `/Users/zhanghr/plugins/stagepass-card/scripts/server.mjs`
- Test: `/Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs`

- [ ] **Step 1: Replace the visual tokens**

Replace the old purple-based `:root`, `.card`, heading, badge, input, action and footer rules with this token set:

```css
:root {
  color-scheme: dark;
  --sp-bg: var(--color-background-primary, oklch(0.175 0.035 295));
  --sp-surface: var(--color-background-secondary, oklch(0.22 0.035 295 / 64%));
  --sp-surface-strong: oklch(0.175 0.035 295 / 68%);
  --sp-text: var(--color-text-primary, oklch(0.94 0.022 74));
  --sp-muted: var(--color-text-secondary, oklch(0.79 0.025 75 / 72%));
  --sp-primary: oklch(0.79 0.085 73);
  --sp-primary-text: oklch(0.205 0.035 295);
  --sp-success: oklch(0.66 0.065 145);
  --sp-error: oklch(0.64 0.115 31);
  --sp-border: oklch(0.89 0.025 75 / 17%);
  font-family: var(--font-sans, "Geist", "PingFang SC", ui-sans-serif, system-ui, sans-serif);
  background: transparent;
  color: var(--sp-text);
}
.card {
  overflow: hidden;
  border: 1px solid var(--sp-border);
  border-left: 2px solid color-mix(in oklch, var(--sp-primary) 72%, transparent);
  border-radius: 12px;
  background: var(--sp-surface);
  box-shadow: 0 22px 80px oklch(0.08 0.03 290 / 24%);
  backdrop-filter: blur(18px);
}
h1 {
  margin: 5px 0 0;
  font-family: Georgia, "Times New Roman", "Songti SC", serif;
  font-size: 18px;
  font-weight: 400;
}
.eyebrow {
  color: color-mix(in oklch, var(--sp-primary) 92%, transparent);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .2em;
  text-transform: uppercase;
}
```

- [ ] **Step 2: Replace the main card hierarchy**

Use exactly this structure inside `<main class="card">`:

```html
<header>
  <div>
    <p class="eyebrow">Execution surface</p>
    <h1 id="task-title">StagePass Desktop</h1>
    <p class="subtitle">完整推演保留在 Codex；卡片只显示当前门禁事实并提交下一轮。</p>
  </div>
  <span class="badge"><span class="dot"></span><span id="bridge-state">正在检测</span></span>
</header>
<section class="content">
  <div class="facts">
    <div class="fact"><span class="label">Project</span><span class="value" id="project">stagepass</span></div>
    <div class="fact"><span class="label">Turn</span><span class="value" id="turn">等待提交</span></div>
  </div>
  <label for="prompt">发送给当前 Codex 任务</label>
  <textarea id="prompt">STAGEPASS_CARD_TURN_OK：这条消息来自 StagePass Card 插件。请只回复“卡片 turn 已运行”。</textarea>
  <div class="actions">
    <button id="mcp-button">发送并启动 turn</button>
    <button id="openai-button" class="secondary">兼容桥</button>
  </div>
  <details data-role="task-diagnostics">
    <summary>任务诊断</summary>
    <dl>
      <div><dt>Task</dt><dd id="task">当前 Codex 任务</dd></div>
      <div><dt>Thread</dt><dd id="thread">由 Desktop 宿主绑定</dd></div>
    </dl>
  </details>
</section>
<footer id="result">正在检测 Codex Desktop MCP App 宿主能力…</footer>
```

- [ ] **Step 3: Synchronize the visible status**

Update `applyContext`, initialize success/failure and both click handlers:

```js
setText("task-title", value.taskName);
setText("task", value.taskName);

function setBridgeState(text, kind) {
  setText("bridge-state", text);
  document.querySelector(".badge").dataset.state = kind;
}
```

On initialize success call `setBridgeState("已连接", "success")`; on failure call `setBridgeState("连接失败", "error")`; while submitting disable the primary button and set its text to `正在启动 turn…`.

- [ ] **Step 4: Add narrow-width and reduced-motion rules**

Add:

```css
@media (max-width: 420px) {
  body { padding: 10px; }
  header { flex-direction: column; }
  .actions { grid-template-columns: 1fr; }
  .secondary { justify-self: start; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
  }
}
```

- [ ] **Step 5: Run all plugin tests**

Run:

```bash
node --test /Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs
```

Expected: all existing interaction tests and both new visual tests pass.

### Task 3: Validate and preview in a real browser

**Files:**
- Modify: none
- Test: `/Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs`

- [ ] **Step 1: Run syntax and plugin validation**

Run:

```bash
node --check /Users/zhanghr/plugins/stagepass-card/scripts/server.mjs
/usr/bin/python3 \
  /Users/zhanghr/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  /Users/zhanghr/plugins/stagepass-card
```

Expected: no syntax output and `Plugin validation passed`.

- [ ] **Step 2: Read the UI resource through the actual MCP server**

Set `CARD_RUN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"`。Start the server and send `initialize`, `tools/list`, and `resources/read` JSON-RPC requests. Save the returned HTML to `/private/tmp/stagepass-card-preview-${CARD_RUN_ID}.html`; do not modify repository files.

- [ ] **Step 3: Inspect desktop and narrow layouts**

Use a real browser at 720×760 and 390×760. Verify:

- StagePass sand-gold primary and dark violet-gray surface.
- Georgia task title.
- Project and Turn are the only primary facts.
- Task and Thread remain available under diagnostics.
- Primary action fits without horizontal scrolling.
- Focus outline and status text remain readable.

- [ ] **Step 4: Re-run interaction tests after visual inspection**

Run:

```bash
node --test /Users/zhanghr/plugins/stagepass-card/scripts/server.test.mjs
```

Expected: all tests pass without snapshot-specific exceptions.

### Task 4: Cachebust and reinstall

**Files:**
- Modify: `/Users/zhanghr/plugins/stagepass-card/.codex-plugin/plugin.json`

- [ ] **Step 1: Update the version with the official helper**

Run from the plugin-creator skill root:

```bash
python3 scripts/update_plugin_cachebuster.py \
  /Users/zhanghr/plugins/stagepass-card
```

Expected: the helper prints a version beginning with `0.1.0+codex.` and containing its generated UTC cachebuster.

- [ ] **Step 2: Validate the cachebusted source**

Run:

```bash
/usr/bin/python3 scripts/validate_plugin.py /Users/zhanghr/plugins/stagepass-card
python3 scripts/read_marketplace_name.py
```

Expected: validation passes and marketplace name is `personal`.

- [ ] **Step 3: Reinstall from Personal marketplace**

Run:

```bash
'/Applications/ChatGPT.app/Contents/Resources/codex' \
  plugin add stagepass-card@personal
```

Expected: installed root reports the new cachebuster version.

- [ ] **Step 4: Prove cache identity**

Run SHA-256 over source and installed `plugin.json`, `server.mjs`, `server.test.mjs`, and `SKILL.md`. Expected: each source/cache pair matches.

### Task 5: Verify in a new real Codex Desktop task

**Files:**
- Modify: `scripts/probe-codex-desktop-plugin-card.ts`
- Create: `.stagepass/verification/codex-desktop-plugin-card-${CARD_RUN_ID}.json`

- [ ] **Step 1: Extend probe evidence**

Include `pluginVersion`, `resourceUri`, and the exact log cursor timestamp in the final JSON output:

```ts
pluginVersion,
resourceUri: "ui://stagepass/desktop-bridge-card",
logObservedAfter: probeStartedAt,
```

- [ ] **Step 2: Run the terminal-driven Desktop probe**

Run:

```bash
pnpm exec tsx scripts/probe-codex-desktop-plugin-card.ts
```

Expected:

- a new visible task named `[PLUGIN CARD ${CARD_RUN_ID}] StagePass Desktop`;
- two real turns: materialization and plugin prompt;
- `stagepass-card/show_stagepass_card` completed.

- [ ] **Step 3: Verify render evidence**

Read `/tmp/stagepass-card.log` after the recorded cursor. Require:

- `resources/read` for `ui://stagepass/desktop-bridge-card`;
- `ui/probe` via `window.openai.callTool`;
- `ui/probe` via `mcp-apps-tools-call`;
- record the Stable `hostCapabilities` fields that are present. MCP Apps 2026-01-26
  defines only `experimental`, `openLinks`, `serverTools`, `serverResources`,
  `logging`, and `sandbox`; `message` is not a Stable capability field;
- prove `ui/message` independently with a real JSON-RPC request carrying an `id`,
  a matching Host success/error response, and—after a success response—a newly
  observed turn in the same Codex Desktop task;
- if a Host reports a `message` capability as a private or legacy extension,
  record it only as an optional interoperability signal and never use it as a
  Stable pass/fail gate.

- [ ] **Step 4: Save the verification report**

Write the exact Project, task name, thread ID, originating turn ID, resulting
turn ID, plugin version, tool call, resource read, probe routes,
`ui/message` request ID and matching Host response, test commands, and
limitations to
`.stagepass/verification/codex-desktop-plugin-card-${CARD_RUN_ID}.json`.

- [ ] **Step 5: Commit repository-owned probe changes**

Stage only:

```bash
git add scripts/probe-codex-desktop-plugin-card.ts \
  .stagepass/verification/codex-desktop-plugin-card-${CARD_RUN_ID}.json
git commit -m "test(codex): verify native StagePass card"
```

If `.stagepass/verification` is intentionally ignored, commit only the probe and record the report path without forcing ignored evidence into Git.
