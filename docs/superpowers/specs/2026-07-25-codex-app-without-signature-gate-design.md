# Codex App 对话链路移除验签门禁设计

**日期：** 2026-07-25  
**状态：** 已批准方向，待实现  
**范围：** ChatGPT/Codex App 对话链路；Codex CLI 不在本次范围内

## 1. 背景与决策

StagePass 当前通过两条本地 App 边界驱动真实 Codex 任务：

1. `codex app-server` 创建、命名和读取持久 thread；
2. ChatGPT/Codex Desktop follower IPC 打开任务并启动、继续或中断 turn。

现有实现把 macOS 代码签名作为可用性硬门禁：

- `codex-desktop-ipc-discovery.ts` 只有在 App bundle 通过 `codesign` 后才把
  IPC endpoint 标记为 `desktopVerified`；
- `codex-app-server-shell-control.ts` 在启动 app-server 前后再次运行
  `codesign`。

这会造成一个错误结论：App 已经能够创建真实任务并运行 turn，但
StagePass 仍显示 `Desktop unavailable · MCP missing`，并拒绝触发对话。

本次决定：

- App 是否可用，只由真实对话能力决定；
- 不再调用 `codesign` 或 `spctl`，签名不参与 health、启动或验收；
- 保留现有 app-server、持久 thread、Desktop follower IPC 和 turn 观察架构；
- 不修改、启用或迁移 Codex CLI 执行链。

## 2. 方案比较

### 方案 A：移除签名门禁，保留运行态与本地边界校验（采用）

继续识别正在运行的 ChatGPT/Codex App、固定 bundle 内的 app-server、
当前用户拥有的 IPC socket、版本与协议能力，但不读取或验证代码签名。

优点：

- 改动最小；
- 保留现有真实 App task/thread/turn 模型；
- 不需要 CLI fallback；
- 不会因签名状态误判已经可工作的对话。

### 方案 B：StagePass Server 直接调用会话内 `codex_app` 工具（不采用）

`codex_app` 是当前 ChatGPT/Codex 会话宿主提供的工具，不是 StagePass
Node Server 可以导入或调用的后端 API。它适合主 Agent 验收，但不能作为
Web 后端生产依赖。

### 方案 C：迁移到 Codex CLI（明确排除）

CLI 可以触发运行，但用户已明确要求本次只完成 App 链路。现有 CLI
代码、配置、测试和行为全部保持不变。

## 3. 信任与发现边界

移除签名检查不等于接受任意进程或任意二进制。App discovery 仍必须同时
满足：

- IPC 广告来自仍在运行的本地进程；
- 进程 executable 的真实路径属于已支持的 ChatGPT/Codex App 主程序；
- bundle、`Info.plist` 和 `Contents/Resources/codex` 的 `realpath`
  与预期固定路径一致；
- 上述目标不是 symlink，且探测前后文件 identity 不变；
- IPC endpoint 是 socket，不是 symlink；
- socket 与父目录属于当前用户；
- socket 不向 group/other 开放，父目录不允许 group/other 写入；
- 候选 endpoint 必须唯一；
- app-server `--version` 与受支持版本匹配；
- app-server initialize 与所需 thread/model 协议能力探针通过。

删除以下条件：

- App bundle 必须通过 `codesign --verify`；
- bundle 必须由固定 TeamIdentifier 签名；
- 启动 app-server 前后重复验签。

## 4. 组件修改

### 4.1 `codex-desktop-ipc-discovery.ts`

- 删除 `SYSTEM_CODESIGN`、TeamIdentifier 和签名输出解析；
- 将 `desktopVerified` 的含义改为“运行进程、路径、文件 identity、bundle
  metadata 和 app-server runtime 已观察并通过”，或改成不会暗示签名的
  命名；
- discovery 不再执行任何签名命令；
- 保留 bundle metadata，用于协议兼容性指纹，而不是安全验签。

### 4.2 `codex-app-server-shell-control.ts`

- 把 `verifyAttestedAppServerBinary` 收窄为运行态校验；
- 保留固定路径、realpath、非 symlink、regular file、文件 identity、
  精确版本和协议能力检查；
- 移除启动前后所有 `codesign` 调用和 TeamIdentifier 条件；
- client spawn、persistent thread、name、read、model list 行为保持不变。

### 4.3 Health 与 UI

- `ready` 表示：
  - 唯一 App IPC endpoint 可连接；
  - app-server 初始化成功；
  - 必需能力存在；
  - 能创建或读取持久 thread。
- `MCP missing` 只能描述卡片/交互扩展状态，不能阻止创建或启动普通 App
  对话。
- `Start stage in Codex` 的成功标准是返回真实 thread ID 和 turn ID，
  不是签名状态。
- 失败信息按能力边界区分：
  - `app_process_unavailable`
  - `app_ipc_unavailable`
  - `app_server_unavailable`
  - `app_protocol_incompatible`
  - `app_turn_start_failed`

## 5. 数据与兼容性

- 继续复用 `codex_thread_bindings`、logical turn、start attempt、turn
  execution 和 observation 数据；
- 已存在的 thread ID、turn ID、Project 绑定和审计记录不迁移；
- 不新增 provider，不修改 `AiProvider = "codex"`；
- 不修改 Codex CLI engine、CLI 配置或 CLI 测试；
- Desktop follower 与 app-server 的恢复、lease、fencing 和防重复语义保持。

## 6. 测试策略

先修改测试，再修改实现。

必须新增或更新的测试：

1. App bundle 签名不可用时，discovery 不调用签名命令，仍能发现符合其余
   条件的唯一 endpoint；
2. shell control 启动前后不调用签名命令；
3. 错误 executable 路径、realpath 漂移、symlink、文件 identity 漂移、
   非当前用户 socket、宽松 socket 权限和多个候选仍被拒绝；
4. 不支持的 app-server 版本或协议能力仍被拒绝；
5. `MCP missing` 不再使普通对话启动按钮不可用；
6. 已绑定任务能够复用同一 thread，未绑定任务只创建一个持久 thread；
7. start、retry、interrupt 和恢复路径不会重复启动 turn。

真实验收顺序：

1. 浏览器打开 StagePass，记录原始状态；
2. 点击 `Retry`，App health 变为 ready；
3. 点击 `Start stage in Codex`；
4. 在指定 Project 中确认常驻任务名称、thread ID 和真实 turn ID；
5. 等待 turn 完成并读取终态；
6. 用独立 App 任务执行规格审核；
7. 规格通过后，用另一独立 App 任务执行质量审核；
8. 浏览器回归 start/open/retry/interrupt 和门禁状态；
9. 测试、两轮审核和浏览器回归都通过后才允许关闭问题。

## 7. 提交边界

- 保留当前工作树中已有的 Desktop bridge 改动；
- 实现提交只包含本设计范围内的 App discovery、shell control、health/UI
  及对应测试；
- 不包含 `.superpowers/`、临时 probe、插件缓存或 CLI 迁移；
- 不执行、不记录、不再报告任何 `codesign`/`spctl` 结果。

## 8. 验收条件

- StagePass 不调用 `codesign` 或 `spctl`；
- 签名状态不出现在 App health 或启动判定中；
- 真实 App Project 中出现指定名称的持久任务；
- StagePass 启动真实 turn，并保存 thread ID、turn ID 和终态；
- app-server/IPC/path/socket/version/protocol 的非签名校验仍全部有效；
- MCP 卡片缺失不会阻止普通 App 对话；
- Codex CLI 路径零修改；
- 单元、集成、真实 App 双审与浏览器回归全部通过。
