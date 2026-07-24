# StagePass Card 紧凑原生样式设计

日期：2026-07-24
状态：已选定视觉方向，等待实施

## 目标

把 `stagepass-card` MCP App 从独立的紫色诊断面板调整为 StagePass 系统的原生执行面板。卡片应与现有 `CodexTaskControl`、顶部状态栏和门禁表面使用同一套视觉语言，同时保留真实 Project、任务、线程、turn 和宿主状态的可核验能力。

用户已在视觉对比页选择 A「紧凑原生」。

## 视觉基准

卡片直接采用 `app/globals.css` 中的 StagePass 设计语言：

- 背景：暗紫灰 `oklch(0.175 0.035 295)`，允许宿主主题变量覆盖。
- 表面：半透明 `oklch(0.22 0.035 295 / 54%)`，配合细边框和轻量模糊。
- 主色：沙金 `oklch(0.79 0.085 73)`，用于 kicker、焦点和主按钮。
- 成功状态：`oklch(0.66 0.065 145)`，使用小圆点和克制光晕。
- 标题：Georgia / Times New Roman，与 `.stagepass-serif` 一致。
- 正文与控件：宿主 `--font-sans`，回退到 Geist / PingFang SC / system-ui。
- 标识与诊断值：宿主 `--font-mono`。
- 圆角：卡片 12px，输入框与按钮 8px。
- 结构强调：左侧 2px 沙金门禁线，不使用紫色渐变装饰。

## 信息层级

卡片按以下顺序展示：

1. `Execution surface` kicker。
2. 当前任务名称；未知时显示 `StagePass Desktop`。
3. 一句说明：完整推演保留在 Codex，卡片只展示门禁事实并提交下一轮。
4. 右上角 Desktop/MCP 连接状态。
5. 两个高频事实：Project 与 Turn。
6. 提示词输入框。
7. 主操作 `发送并启动 turn`。
8. 次级文字操作 `兼容桥`；宿主不支持时隐藏或禁用。
9. 底部连接状态文本。
10. Task 与 Thread 保留在折叠诊断区域，不与主操作争夺注意力。

## 状态设计

- 检测中：状态圆点使用沙金，底部显示正在检测 MCP App 宿主能力。
- 已连接：状态圆点使用绿色并带轻微光晕，主按钮可用。
- 提交中：主按钮禁用并显示 `正在启动 turn…`。
- 已提交：Turn 文本更新为 `已提交，等待 Desktop 执行`，底部使用成功色。
- 连接失败：状态使用破坏性色，保留明确错误文本；不伪装成已连接。
- 兼容桥不可用：次级操作禁用或隐藏，标准 MCP `ui/message` 主路径保持可用。

## 交互

- 页面加载不得自动提交消息。
- 主按钮继续发送标准 MCP Apps `ui/message`。
- 兼容入口继续调用 `window.openai.sendFollowUpMessage`。
- 卡片从 `window.openai.toolOutput` 读取真实 Project、Task、Thread、Turn 和预填提示词。
- 成功提交后只更新卡片本地状态；真实新 turn 仍必须从 Codex Desktop 任务记录独立核验。
- 支持键盘焦点、窄宽度布局与 `prefers-reduced-motion`。

## 实现边界

本次只修改个人插件：

- `/Users/zhanghr/plugins/stagepass-card/scripts/server.mjs`
- 对应卡片交互测试
- 插件缓存版本与重新安装状态

不修改 StagePass 主应用设计系统，不改变 MCP 工具输入输出协议，不增加新的后端权限，也不把卡片渲染等同于 turn 已运行。

## 验证

实施后必须完成：

1. MCP server 协议与交互单元测试全部通过。
2. 插件结构校验通过。
3. 本地浏览器分别检查桌面宽度和窄宽度。
4. 使用 cachebuster 更新插件版本并从 Personal marketplace 重新安装。
5. 创建新的 StagePass Project Codex Desktop 常驻任务。
6. 在真实 turn 中调用 `stagepass-card/show_stagepass_card`。
7. 记录 task/thread ID、turn ID、工具调用、`resources/read` 和卡片初始化探针。
8. 若无法自动点击 Codex 自身卡片，不得伪造后续 turn；必须明确记录限制。

## 非目标

- 不在本次加入新的业务操作。
- 不把完整 Phase 0 认证流程塞进视觉卡片。
- 不使用外部字体或网络图片。
- 不关闭任何尚未完成双重 Codex 审核和浏览器回归的业务问题。
