# DSH Goal 与子代理状态接入

状态：阶段一 Goal 桥接已实现，待 DSH 实机组合验收；阶段二子代理状态接入待实施。

最后更新：2026-11-13。

## 背景

Claude 插件保留 Claude Code 自己的 agent loop 和原生工具。本任务建立时，DSH Goal 自动续行消息不会转发给 Claude，Claude 也不能调用 DSH 的 goal 工具。阶段一通过本地 MCP 桥接解决这两项缺口。Claude 原生 Task / Agent 可以运行，但子代理生命周期仍不属于 DSH 的子代理树，因此 DSH 无法可靠显示、取消或等待这些任务。

相关实现：

- [`src/request-input.ts`](../../src/request-input.ts)：筛选发给 Claude 的 DSH 消息来源。
- [`src/sdk-events.ts`](../../src/sdk-events.ts)：将 Claude SDK 事件转换成插件事件。
- [`src/claude-session.ts`](../../src/claude-session.ts)：管理 Claude 会话、镜像工具结果和取消。
- [`src/index.ts`](../../src/index.ts)：配置 SDK query 与 DSH 服务。
- [`src/goal-tools.ts`](../../src/goal-tools.ts)：会话级 Goal MCP 工具与来源、revision、连续阻塞轮次检查。
- [`src/session-registry.ts`](../../src/session-registry.ts)：记录当前 DSH 回合的消息和来源，回合结束后撤销权限。

## 阶段与后续顺序

### 阶段一：Goal 最小闭环

- [x] 仅将带有效 id、revision、正数 round 且属于当前回合的 Goal 消息转发给 Claude，保留去重；普通用户和有效定时消息保持原行为。
- [x] 用 Claude Agent SDK 本地 MCP server 提供 `get_goal`、`create_goal`、`update_goal`，通过可选 `ctx.goals` 操作 DSH 原状态与持久日志。
- [x] 每次调用检查 DSH 根会话、活动回合和服务实例；创建、编辑、暂停、恢复仅限用户来源回合；自动轮次只能更新其当前匹配目标的完成或阻塞状态。
- [x] 自动阻塞要求逐轮报告同一原因，同轮重试不累加；默认 3 轮，可配置。跳轮、原因或 revision 变化时重置，Claude 进程重建后从头计数，不把临时尝试伪装成持久记录。
- [x] 补消息筛选、来源撤销、目标操作与错误、阻塞边界、真实 SDK MCP 协议、ClaudeSession 多轮转发测试。
- [x] 补 README 配置、可选服务加载条件与边界说明；将 `zod` 放入运行依赖并更新 lockfile。
- [ ] 在启用 Goal 续行驱动器的实际 DSH 组合中，验证 Claude 结束目标后不再续行、用户暂停与恢复、重启后的显式恢复、目标状态历史保留。

本阶段保留 Claude 原生 Task / Agent，不接管其执行、后台任务等待或子代理生命周期。工具的用户授权由当前 DSH 回合来源约束；用户是否明确请求具体操作还依赖模型遵守工具指引。

### 阶段二：子代理状态接入（保留任务，尚未实施）

1. 先限定镜像结果表：仅保存已登记顶层工具的结果，补嵌套 `tool_result` 与取消后的清理测试，防止无人消费的结果积累。
2. 核对当前 SDK Task / Agent 的开始、进度、完成、失败、取消及后台任务事件，建立稳定的 Claude task id 与 DSH 父子任务 id 映射。
3. 确定 DSH 可持久记录这些外部任务的原生接口，记录父会话、父工具调用、任务名称、状态及最终结果；不要仅保存在内存或 UI 卡片。
4. 把父会话取消、进程退出、插件卸载与恢复后的未知状态收敛到明确终态，避免遗留“运行中”记录。
5. 将这些任务纳入 DSH 树等待，再验证后台任务仍活动时 Goal Round 不会提前自动续行。

子代理阶段的完成标准仍以本记录下方的整体验收条件为准，不能因为 Goal 桥接上线就将整项任务标记完成。

## 验证记录

2026-11-13：已对本地 SDK 0.3.322 和 DSH Goal 0.2.2-rc.1 核对类型，并通过 SDK MCP transport 进行 `initialize`、`tools/list`、`tools/call` 测试。

- `pnpm install`：通过，lockfile 已更新。
- `pnpm typecheck`：通过。
- `pnpm test`：9 个测试文件、81 项测试通过。
- `pnpm build`：通过。
- 构建后的入口导入与配置解析：通过，默认阻塞阈值为 3。
- `npm pack --dry-run --json --ignore-scripts`：通过，包含 Goal 桥接的构建产物。
- 实机日志复现并定位：Claude 已拿到 `mcp__tavlo_dsh_goal__get_goal`，但每次调用都返回 `DSH goal service is no longer available`。原因是 Cordis 的 `ctx.get('goals')` 读取值不能用于跨调用做对象身份比较；修复为每次操作动态解析并只检查服务是否仍可用。

修复后的构建尚未在当前已运行的 DSH 进程中热加载；需要重新加载插件或重启当前 Claude 会话后，再执行真实 Claude 模型与 DSH Goal 续行驱动器的联合实机测试，不能将本地测试结果等同于完整 DSH 组合已验收。

## 目标

1. 将经过授权的 DSH Goal Round 提示准确转发到 Claude；普通 DSH 内部消息仍不得意外启动 Claude 回合。
2. 提供 Claude 可调用的 DSH goal 查询与更新能力，使 Claude 能读取、编辑、暂停、恢复、完成或阻塞当前会话的 goal，并遵守 DSH 的状态和 revision 规则。
3. 将 Claude SDK 的 Task / Agent 生命周期映射为可持久记录的 DSH 子任务状态，包括父子关系、开始、进度、完成、失败和取消。
4. 让 DSH 的取消和树等待能覆盖由 Claude 原生 Task / Agent 启动的活动任务。
5. 只为已登记的顶层镜像工具调用保存结果；未镜像的子代理内部工具结果不能无限留在会话结果表中。

## 验收条件

- 正数 Goal Round 能被 Claude 接收；非 goal 的内部消息不会因此被当作用户请求转发。
- Claude 可以通过 DSH 侧工具读取并更新 goal；完成、暂停或阻塞后不会再错误地自动续行。
- 原生 Claude Task / Agent 仍按 Claude Code 的配置和行为运行；DSH 能在会话记录与界面中关联其任务状态及最终结果。
- 父会话取消或释放时，关联的活动子任务会收敛到明确终态；Goal Round 驱动器会等待这些子任务结束后再续行。
- 子代理内部工具事件不会伪装成顶层 DSH 工具卡片，也不会留下无人消费的结果记录。
- 单元测试覆盖消息来源筛选、goal 工具映射、嵌套任务事件、取消与结果清理；DSH 实际插件组合测试覆盖 goal 完成和子任务等待。

## 范围边界

- 保留 Claude 原生 Task / Agent 执行方式；本任务不把所有 Claude 委派替换成 DSH 的 Claude 子代理提供方。
- 只向 Claude 暴露完成 DSH Goal 所需的状态、操作和指引；不把所有 DSH 系统提示、任意 DSH 工具或其他 agent 插件自动注入 Claude。
- 本任务不声称 DSH 沙箱能隔离 Claude Code 进程。沙箱隔离仍由 Claude 自身运行设置和宿主进程环境决定，应继续作为单独限制披露。

## 当前已知风险

- [`src/sdk-events.ts`](../../src/sdk-events.ts) 会接收嵌套 user `tool_result`，但相应子代理工具调用不会生成 DSH 镜像调用；这些结果可能无法被消费。
- 子代理内部文本、工具活动和任务生命周期目前没有映射到 DSH 子任务记录。
- Goal 消息转发和工具桥接已具备，但尚不能据此声称 DSH 的树等待可以覆盖 Claude 后台子代理。
