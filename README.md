# tavlo-plugins-claude

DeepSeek Harness（DSH）插件：通过 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 运行**本机的 Claude Code**，把它作为模型提供方 `claude-code` 接入 DSH。

与 [dsh-ccgui](https://github.com/zhukunpenglinyutong/dsh-ccgui) 走 ACP 不同，这里直接用官方 SDK 驱动 Claude Code 进程。Claude 的完整 harness 都保留在 Claude 一侧，包括 agent loop、内置工具、`settings.json`、MCP、skills、hooks、subagents、自动压缩以及 slash 命令。DSH 负责展示对话、把每次工具调用显示成卡片、处理权限审批与提问。

设计说明见 [docs/design.md](docs/design.md)。本插件只做服务端接入；前端界面由统一的 UI 插件（`tavlo-plugins-ui`）提供。

## 安装

```bash
pnpm install
pnpm build
dsh plugin --profile web add F:/github/tavlo-dsh-plugins/tavlo-plugins-claude
```

安装后在模型菜单里选择 **Claude Code**。

## 运行方式

| 方面 | 行为 |
| --- | --- |
| 可执行文件 | 依次查找：配置的 `executable`、PATH（Windows 下会解析 `claude.cmd` 指向的 `claude.exe`）、`~/.local/bin/claude`、`~/.claude/local/claude`。都没找到时用 SDK 自带的二进制。 |
| 进程 | 每个 DSH 会话对应一个常驻的 Claude Code 进程（流式输入的 `query()`），由 DSH 的 subprocess 服务管理。 |
| 工具调用 | Claude 的每个顶层工具调用会镜像成一次 `claude_tool` 调用：Bash 显示为终端卡片，Edit/Write/MultiEdit 显示为 diff 卡片，其余显示为通用卡片。工具实际由 Claude 执行，镜像工具只负责等待 Claude 返回结果。 |
| 权限 | Claude 的 `canUseTool` 请求跟随 DSH 当前权限选择：“完全访问”（完整文件访问且不询问）直接允许；其他设置转到 DSH 审批卡片。拒绝则告诉 Claude 未获允许；取消则同时中断本回合。 |
| AskUserQuestion | 转到 DSH 的 `ctx.userQuestions` 提问卡片，回答再交回给 Claude。 |
| ExitPlanMode | 按当前权限选择直接允许或展示计划审批卡片；获准后将 Claude 切回普通执行模式，不添加永久放行规则。 |
| 恢复会话 | Claude 的 session id 写在 assistant 消息的 `replayState` 里。DSH 或插件重启后会自动 `resume`。fork 出来的会话不会写回父会话。 |
| 停止 | 图片读取等准备阶段取消时不提交消息，可重新发送；已提交的回合调用 `query.interrupt()`。超过 `cancelGraceMs` 仍未结束则结束进程。 |
| 上下文 | 显示 Claude SDK 报告的有效窗口容量；占用量由 DSH 根据最近一次输入用量与后续消息估算。容量尚未获取时不显示百分比。自动压缩仍交给 Claude。 |
| 模型 | 菜单先显示 `default / opus / sonnet / haiku` 别名。第一次会话启动后，换成 Claude 报告的模型列表，并缓存到 DSH home 下的 `tavlo-claude/models.json`。切换模型失败时保留未发送消息的重试资格，可重试原模型或切回可用模型后重试。 |
| Goal | 若 DSH 提供 `ctx.goals`，通过会话级本地 MCP server 暴露 `get_goal`、`create_goal`、`update_goal`；DSH 准入的正数 Goal Round 会作为新输入转发给 Claude。状态和历史仍由 DSH 保存。 |

## 配置

在 DSH 的 cordis 配置里修改 `tavlo-claude` 条目：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `executable` | `''` | `claude` 的路径；为空时自动查找。 |
| `permissionMode` | `''` | `default` / `acceptEdits` / `plan` / `dontAsk` / `auto` / `bypassPermissions`；为空时由 Claude 自己的设置决定。 |
| `inheritCredentials` | `true` | 是否把 DSH 的完整环境变量（含 API key 等）传给 Claude。设为 `false` 时只传过滤后的环境加上 `env`。 |
| `env` | `{}` | 追加给 Claude 的环境变量，例如 `ANTHROPIC_BASE_URL`。 |
| `cancelGraceMs` | `10000` | 中断回合时等待 Claude 结束的时长，超时则结束进程。 |
| `disposeGraceMs` | `3000` | 结束进程时的信号升级间隔。 |
| `goalBlockedAfterConsecutiveRounds` | `3` | 自动 Goal Round 连续报告同一阻塞原因达到此轮数后，才允许转为 `blocked`；必须是正安全整数。同轮重试不累加，跳轮、原因或 goal revision 变化、Claude 进程重建都会重新计数。 |
| `auxiliary` | 见下 | 标题、摘要这类辅助请求走哪条模型路由。 |

### Goal 目标模式

DSH 组合需要先启用 Goal 服务及其续行驱动器；仅安装本插件或仅提供 Goal 存储服务不会自动调度下一轮。`@deepseek-ai/dsh-goal` 是可选 peer：Claude 进程启动时若没有 `ctx.goals`，不会注入 Goal MCP 工具。启用或重新加载 Goal 服务后，需要重建对应的 Claude 进程（例如重新加载本插件）才能挂接新服务；已有工具在原服务卸载后会拒绝调用。

Claude 通过 `tavlo_dsh_goal` server 的三个工具读写当前 DSH 会话目标。`update_goal` 支持 `edit`、`pause`、`resume`、`complete` 和 `blocked`，更新时必须带查询得到的 `goal_id` 与 `revision`。目标变更交给 DSH Goal 服务提交到原会话日志；插件不另存一份目标状态，也不绕过 DSH 的 revision、阶段转换或轮数上限校验。暂停、恢复、清除等操作仍可使用 DSH 自己的 Goal 界面或命令。

- 创建、编辑、暂停和恢复要求当前 DSH 回合有直接用户来源；工具指引要求用户明确请求对应操作，普通定时消息不授予这些权限。
- 自动 Goal Round 仅允许完成或报告阻塞，且其 goal id、revision、round 必须匹配当前已启用续行的目标。消息重复投递不会重复提交给 Claude；其他内部消息和 round 为零的消息不会因此被转发。
- 自动报告阻塞时，Claude 每个受阻回合需以相同的 `blocked_reason` 调用 `update_goal`。不足阈值会返回工具错误并记录本轮尝试，达到阈值才交给 DSH 提交 `blocked`。该尝试计数只保存在本次 Claude 进程内；用户回合直接要求标记阻塞时不受自动轮次阈值约束。

Goal 工具目前只服务于正在运行的 DSH 根会话。Claude 原生 Task / Agent 的任务树、后台任务等待与取消尚未映射到 DSH，使用后台子代理的 Goal 工作流仍需等待后续兼容，详见[任务记录](docs/tasks/dsh-goal-and-subagent-integration.md)。

### 辅助请求（标题、摘要）

Claude Code 不处理 `purpose` 非空的辅助请求（它们会污染用户真实的 Claude 会话）。插件默认把这些请求转发给 DSH 里其他已注册的模型供应商：先试 `auxiliary.routes` 里配置的路由，再自动发现。成功的那条会被记住，供应商列表变化或它失败时重新选择。

不需要任何配置就能工作。要固定或限制路由时：

```yaml
- id: tavlo-claude
  config:
    auxiliary:
      # 优先尝试的路由，按顺序；留空则直接自动发现。
      routes:
        - provider: jianzhi
          model: gpt-5.6-sol
        - provider: clim
          model: gpt-5.6-luna
      # 配置的路由都失败后，是否继续尝试其他已注册供应商（默认 true）。
      discovery: true
      # false 则恢复为直接拒绝辅助请求（默认 true）。
      enabled: true
```

自动发现会跳过 `claude-code` 自己，按供应商注册顺序取每条路由的第一个文本模型。失败的路由 60 秒内不再重试；一旦某条路由已经产出第一个分片就不再换路，避免把同一次请求发到两个模型上。

## 限制

- DSH 自己的压缩、沙箱、fork 编辑历史对 Claude 不起作用。Claude 只读取自己的会话记录。
- 只有 Claude 自己的工具调用会显示成卡片；subagent 内部的工具调用只体现在 Task 卡片的结果里。
- Goal 桥接已实现本地 MCP 工具与回合转发；DSH 实机组合验收、subagent 状态与树等待等后续事项记录在 [docs/tasks/dsh-goal-and-subagent-integration.md](docs/tasks/dsh-goal-and-subagent-integration.md)。
- 标题、摘要这类辅助模型请求会转发给其他供应商（见上面的 `auxiliary`）；如果没有任何可用路由，标题会退回 DSH 的兜底命名，并记录一条 warning。
- DSH 审批卡片只提供“允许一次”，不会写入 Claude 的“始终允许”规则；需要长期放行的规则请写在 Claude 的 `settings.json` 里。

## 开发

```bash
pnpm typecheck
pnpm test
pnpm build
```
