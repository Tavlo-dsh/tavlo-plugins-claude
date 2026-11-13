# tavlo-plugins-claude 设计

## 目标

在 DeepSeek Harness（dsh）里使用**本机完整的 Claude Code**：Claude 自己的 agent loop、system prompt、内置工具、
子代理、`~/.claude` 与项目里的 settings / CLAUDE.md / MCP / skills / hooks / plugins、auto-compact、权限规则、登录态。
DSH 只负责展示、记录和审批。

## 为什么是 LLM Provider 而不是替换 agent loop

DSH 的 `ctx.agents` 只有一个全局 `AgentFactory` 插槽（`dsh-agent-loop` 占用），没有按会话选择 loop 的扩展点。
官方的扩展方式是 `ctx.llm.registerAdapter`：把 Claude Code 注册成模型提供方，按会话选择，可以和 DeepSeek 共存。
真正的 loop 跑在 `claude` 进程里，所以替换 factory 不会多出任何能力。

## 和 dsh-ccgui 的区别

| | dsh-ccgui | 本插件 |
| --- | --- | --- |
| 协议 | ACP（`claude-agent-acp` 适配器，npx 拉取约 400MB） | `@anthropic-ai/claude-agent-sdk` 的 `query()` 直连 |
| 可执行文件 | 适配器自带的 SDK | 本机 `claude`（PATH / 配置），找不到才用 SDK 自带 |
| 用量 | 不显示（ACP 只有累计值） | 每次 API 调用的 usage |
| 审批 | ACP `request_permission` | `canUseTool` → 当前 DSH 权限选择；完整访问直接允许，其余走 `ctx.approval` |
| 恢复 | ACP `session/resume` | SDK `resume: <claude session id>` |

## 运行模型

- 每个 DSH 会话对应一个常驻的 `query()`（streaming input 模式），也就是一个 `claude` 进程。
  会话关闭、插件停止或 DSH 退出时结束。
- 一轮 Claude 回合跨越多个 DSH 步骤：
  - 文本 / 思考流式输出为 `text-delta` / `reasoning-delta`。
  - 遇到顶层 `tool_use` 时，把它镜像成一次 `claude_tool` 调用，然后 `finish: tool-calls` 结束这一步。
  - DSH 执行 `claude_tool`：它什么都不跑，只等 Claude 上报这次调用的 `tool_result`，期间根据 DSH 当前权限选择回答 `canUseTool`。
  - 下一步接着读同一个 Claude 回合，直到 `result` 消息到来，以 `finish: stop` 结束。
- 用户消息只发一次：只转发「最后一条 assistant/tool 之后、属于当前 DSH 回合、还没发过」的用户消息（沿用 ccgui 的回合追踪）。
  `retry` 关闭，因为重试可能让 Claude 把同一件事做两遍。
- 准备输入时先预留消息 id，避免重复入队。模型切换等提交前步骤失败时撤销本次预留，已提交的历史消息标记保持不变；用户可重试同一模型，或切回可用模型后重试。提交后收到的 Claude 错误仍保留发送标记，不自动重放请求。
- Claude 回合进行中又来的消息排队，在这一轮结束后发送。
- 图片读取期间取消时，取消结果直接结束准备流程，不转成读图失败占位文字，也不提交部分消息。提交前再次检查取消状态；被取消且未提交的消息可重新发送。`busy` 从向 Claude 输入队列提交消息时开始，已提交的回合继续通过 `interrupt()` 停止。
- `finish.replayState` 里带上 `{ claudeSessionId, dshSessionId }`。DSH 重启后，从最后一条 assistant 消息里读出它，用 `resume` 接回。
- 上下文容量在进程启动和每轮结束时通过 `query.getContextUsage({ detail: 'summary' })` 获取；此调用不发起 token-count API 请求。
  使用 `rawMaxTokens`，与 Claude 自己的 `/context` 一致（可能低于模型硬上限的自动压缩窗口）。旧 CLI 不支持时，回退到可确定归属的 `result.modelUsage.contextWindow`，不会从多个模型中随意取第一项。
- DSH 0.2 没有按 provider 声明「外部管理压缩」的能力：压缩后端读取 `resolveModel()`，界面读取 `prepareCall()` 的容量。
  因此 `resolveModel()` 保留原来的 1e9 压缩保护；`prepareCall()` 只提供已知真实容量，未知时省略。
  SDK 回报后更新当前路由的 `request/context`，使同一轮结束后就能显示；不会更改请求头或发送给模型的内容。
  这是对当前宿主接口的兼容处理，宿主提供独立的压缩所有权接口后应替换。
- 界面占用量仍是 DSH 的最近一次输入 token（含缓存）加后续消息变化估算，并非会话累计用量。细分项是 DSH 的估算，不是 Claude `/context` 的逐项报告。
- 辅助请求（`purpose` 不为空，比如标题、摘要、auto-review）不写进用户真实的 Claude 会话，而是经 `AuxiliaryRouter` 转发给其他已注册的模型供应商：先试 `auxiliary.routes`，再自动发现，并缓存第一条成功的路由。只有某条路由在产出第一个分片之前失败才会换下一条；已经产出内容后不再重放，避免重复输出。没有可用路由时保留 DSH 的兜底标题并记录 warning。

## 权限与计划模式

- 每次审批读取 `permissionPresets.current(session)` 及其 `resolve()` 结果；只有明确选择的 `danger-full-access` sandbox + `never` approval 组合直接允许。单独的 `never` 仍表示拒绝需要询问的操作；`auto`、`custom` 或没有权限选择服务时保留原审批路径。
- 不能把完整访问请求直接交给 `approval.request()`：DSH 的 `never` 策略会在展示卡片前立即返回 `rejected`。原规划切换失败的会话中，用户选择完整访问后，三次 `ExitPlanMode` 均在这一层被自动拒绝。
- `ExitPlanMode` 获准时返回 `updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }]`，确保退出 Claude 的只读计划模式；不采用工具请求里的其他权限建议，也不写入永久规则。拒绝、不可用和取消均不切换模式。
- 普通“允许一次”只允许本次调用。拒绝结果不再断言由用户点击拒绝产生，因为 DSH 策略也可能直接拒绝。

## Goal 桥接

- `SessionRegistry` 只记录当前打开回合的用户与 Goal 来源，下一回合开始时重置，回合结束或会话释放时清理；来源为 `goal` 的提示必须具有有效的 goal id、revision、正数 round 和当前回合消息 id，才会通过 `unseenUserInput()`，提交后仍按原消息 id 去重。
- Claude query 启动时若存在 `ctx.goals`，注入会话级 `tavlo_dsh_goal` SDK MCP server，并仅为其三个工具加入 `allowedTools`。Goal 工具照常镜像为顶层工具卡片，实际状态变更同步调用 DSH Goal 服务，不维护第二份状态或自建续行循环。
- 每次调用校验原服务仍存在、agent 是注册表中的同一实例、DSH 根会话正在运行且有打开回合。创建、编辑、暂停、恢复要求直接用户来源；自动回合的完成和阻塞要求 id、revision、round 匹配当前 active 且 armed 的目标。用户明确意图由 MCP 指引约束，回合来源由宿主检查。
- 自动阻塞需以相同原因逐轮报告，按 `goalBlockedAfterConsecutiveRounds`（默认 3）累计，同轮不累加，间断、原因或 revision 变化及 Claude 进程重建时重置。阈值前只返回工具错误，达到后才由 Goal 服务持久提交 blocked。
- Goal 是可选服务，未挂载时不提供 MCP 工具；挂载或重载后需重建 Claude 进程才能绑定新服务。Goal 续行仍由 DSH 驱动器负责；子代理树等待尚未接入，完整任务与验收记录见 [`tasks/dsh-goal-and-subagent-integration.md`](tasks/dsh-goal-and-subagent-integration.md)。

## 子代理

Claude 的 Task / Agent 工具作为一次 `claude_tool` 出现。子代理内部的工具（`parent_tool_use_id` 不为空）不单独开 DSH 步骤；
它们的审批请求由当前打开的那个 `claude_tool` 代为询问，不附 `callId`。

## 前端

前端单独做成 `tavlo-plugins-ui` 插件，供 claude / codex / pi 各 agent 插件共用。本插件只做服务端，
模型选择先用 DSH 自带的模型菜单。
