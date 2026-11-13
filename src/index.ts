/**
 * DSH plugin: runs the local Claude Code through the Claude Agent SDK and offers it as
 * the `claude-code` model provider. Claude keeps its own loop, tools, settings, MCP
 * servers, skills, hooks, subagents and compaction; DSH shows the conversation, mirrors
 * each tool call as a card, and answers Claude's permission requests and questions.
 * @module tavlo-plugins-claude
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance, Options, PermissionMode, Query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ClaudeAdapter } from './adapter.ts'
import { AuxiliaryRouter } from './auxiliary.ts'
import type { AuxiliaryConfig } from './auxiliary.ts'
import { ClaudeSession } from './claude-session.ts'
import type { PermissionAsk, QueryStart } from './claude-session.ts'
import { createClaudeTool } from './claude-tool.ts'
import { MIRROR_TOOL_NAME, PLUGIN_HOME, PROVIDER } from './constants.ts'
import { locateClaudeHere } from './executable.ts'
import type { ClaudeExecutable } from './executable.ts'
import { ModelCatalog } from './models.ts'
import { toClaudeAnswers, toDshQuestions } from './questions.ts'
import type { DshAnswer, DshQuestion } from './questions.ts'
import type { ImageRef } from './request-input.ts'
import { SessionRegistry } from './session-registry.ts'
import type { SessionStart } from './session-registry.ts'
import { ManagedClaudeProcess, claudeSpawnSpec } from './spawn.ts'
import { publishContextWindow } from './context-window.ts'
import { hasFullAccess } from './permissions.ts'
import type { PermissionPresets } from './permissions.ts'
import { createGoalMcpServer, GOAL_TOOL_NAMES } from './goal-tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tavloClaude: TavloClaude
    /** Provided by DSH's boot layer. */
    dshHomePath?: (...segments: string[]) => string
    /** DSH's attachment store, narrowed to the one call this plugin makes. */
    attachments?: { readImage(ref: ImageRef, signal?: AbortSignal): Promise<{ data: Uint8Array }> }
    /** DSH's `ctx.userQuestions`, narrowed to the one call this plugin makes. */
    userQuestions?: {
      ask(request: { questions: DshQuestion[]; agent?: Agent; signal?: AbortSignal }): Promise<DshAnswer>
    }
  }
}

/** Shown to turns cut off when this plugin stops or reloads. */
const PLUGIN_STOPPED_REASON = 'tavlo-plugins-claude 已停止或重新加载，这条回复没有完成，请重新发送。'
const MODEL_CACHE_FILE = 'models.json'

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'] as const

const AUXILIARY_ROUTE_SCHEMA = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})

const AUXILIARY_SCHEMA: z<AuxiliaryConfig> = z.object({
  enabled: z.boolean().default(true),
  routes: z.array(AUXILIARY_ROUTE_SCHEMA).default([]),
  discovery: z.boolean().default(true),
})

/** Plugin configuration. */
export interface Config {
  /** Path to `claude`; empty searches PATH and the usual install folders, then uses the SDK's bundled binary. */
  executable: string
  /** Claude's permission mode; empty leaves it to Claude's settings. */
  permissionMode: '' | PermissionMode
  /** Pass the full DSH environment (API keys included) to Claude; otherwise only a scrubbed one plus `env`. */
  inheritCredentials: boolean
  /** Added to Claude's environment. */
  env: Record<string, string>
  /** Time an interrupted Claude turn may take to end before the process is stopped, in milliseconds. */
  cancelGraceMs: number
  /** Signal-escalation grace when stopping Claude, in milliseconds. */
  disposeGraceMs: number
  /** Where titles, summaries and other auxiliary requests go; Claude Code refuses them. */
  auxiliary: AuxiliaryConfig
  /** Minimum consecutive DSH Goal rounds before Claude may report a blocker. */
  goalBlockedAfterConsecutiveRounds: number
}

/** Service behind `ctx.tavloClaude`. */
export default class TavloClaude extends Service {
  static inject = ['llm', 'agents', 'tools', 'subprocess']

  static Config: z<Config> = z.object({
    executable: z.string().default(''),
    permissionMode: z.union(['', ...PERMISSION_MODES]).default(''),
    inheritCredentials: z.boolean().default(true),
    env: z.dict(z.string()).default({}),
    cancelGraceMs: z.natural().min(1).default(10_000),
    disposeGraceMs: z.natural().min(1).default(3_000),
    auxiliary: AUXILIARY_SCHEMA.default({}),
    goalBlockedAfterConsecutiveRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  })

  private readonly registry: SessionRegistry
  private readonly catalog: ModelCatalog
  private readonly executable: ClaudeExecutable | undefined

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'tavloClaude')
    // Fails loud on a configured path that does not exist.
    this.executable = locateClaudeHere(config.executable.length > 0 ? config.executable : undefined)
    if (this.executable === undefined) ctx.logger.info('claude not found locally; using the SDK bundled binary')
    else ctx.logger.info(`using claude at ${this.executable.path}`)

    this.catalog = new ModelCatalog(
      PROVIDER,
      this.homePath(PLUGIN_HOME, MODEL_CACHE_FILE),
      () => ctx.emit('llm/models-updated', PROVIDER),
      (message) => ctx.logger.warn(message),
    )
    void this.catalog.restore()

    this.registry = new SessionRegistry({
      getAgent: (sessionId) => ctx.agents.get(sessionId as SessionId),
      ask: (agent, request, signal) => this.ask(agent, request, signal),
      warn: (message) => ctx.logger.warn(message),
      createSession: (agent, sessionId, cwd, start) => this.createSession(agent, sessionId, cwd, start),
    })

    const auxiliary = new AuxiliaryRouter(ctx.llm, config.auxiliary, PROVIDER)
    ctx.on('llm/adapters-updated', () => {
      auxiliary.reset()
    })

    ctx.llm.registerAdapter(
      [PROVIDER],
      new ClaudeAdapter({
        catalog: this.catalog,
        auxiliary,
        resolveSession: (sessionId) => this.registry.resolveSession(sessionId),
        currentTurnMessageIds: (sessionId) => this.registry.currentTurnMessageIds(sessionId),
      }),
    )
    // Admitted only for steps Claude runs, so no other model ever sees this tool.
    ctx.tools.register(createClaudeTool({ waitForTool: (exec) => this.registry.waitForTool(exec) }), {
      when: ({ modelSelection }) => this.registry.isOwnRoute(modelSelection.provider),
    })

    ctx.on('session/event', (session, event) => this.registry.observeEvent(session.id, event))
    ctx.on('agent/disposed', ({ agent }) => this.registry.disposeSession(agent.id))
    ctx.effect(
      () => () => {
        void this.registry.disposeAll(PLUGIN_STOPPED_REASON)
      },
      'tavloClaude.sessions()',
    )
  }

  /** DSH's home, or `~/.dsh` when it does not say. */
  private homePath(...segments: string[]): string {
    const resolveHome = this.ctx.get('dshHomePath') ?? ((...parts: string[]) => join(homedir(), '.dsh', ...parts))
    return resolveHome(...segments)
  }

  private ask(agent: Agent, { reason, callId }: PermissionAsk, signal: AbortSignal): Promise<ApprovalOutcome> {
    if (signal.aborted) return Promise.resolve('cancelled')
    const presets = this.ctx.get('permissionPresets') as PermissionPresets | undefined
    if (hasFullAccess(presets, agent.session)) return Promise.resolve('allowed-once')
    const approval = this.ctx.get('approval')
    if (approval === undefined) return Promise.resolve('unavailable')
    return approval.request({
      agent,
      toolName: MIRROR_TOOL_NAME,
      reason,
      signal,
      ...(callId === undefined ? {} : { callId: callId as ToolRunContext['callId'] }),
    })
  }

  private async askQuestion(
    agent: Agent,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    const service = this.ctx.get('userQuestions')
    const questions = toDshQuestions(input)
    if (service === undefined || questions === undefined) return undefined
    const answer = await service.ask({ questions, agent, signal })
    return toClaudeAnswers(questions, answer)
  }

  /** Looked up on each read: the attachment service can come and go. */
  private async readImage(ref: ImageRef, signal: AbortSignal): Promise<Uint8Array> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new Error('attachment service is not available')
    const { data } = await attachments.readImage(ref, signal)
    return data
  }

  private environment(): Record<string, string | undefined> {
    const base = this.config.inheritCredentials ? process.env : scrubbedParentEnv()
    return { ...base, ...this.config.env }
  }

  private startQuery(cwd: string, start: QueryStart): Query {
    const { executable, config, ctx } = this
    const options: Options = {
      cwd,
      abortController: start.abortController,
      canUseTool: start.canUseTool,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      env: this.environment(),
      ...(start.goalServer === undefined ? {} : {
        mcpServers: { tavlo_dsh_goal: start.goalServer },
        allowedTools: [...GOAL_TOOL_NAMES],
      }),
      ...(start.resume === undefined ? {} : { resume: start.resume }),
      ...(start.model === undefined ? {} : { model: start.model }),
      ...(start.effort === undefined ? {} : { effort: start.effort }),
      ...(config.permissionMode === '' ? {} : { permissionMode: config.permissionMode }),
      ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable.path }),
      spawnClaudeCodeProcess: (spawn) =>
        new ManagedClaudeProcess(ctx.subprocess.spawn(claudeSpawnSpec(spawn, config.disposeGraceMs)), (line) =>
          ctx.logger.debug(`claude: ${line}`),
        ),
    }
    return query({ prompt: start.prompt, options })
  }

  private createSession(agent: Agent, sessionId: string, cwd: string, start: SessionStart): ClaudeSession {
    return new ClaudeSession({
      dshSessionId: sessionId,
      provider: PROVIDER,
      sentMessageIds: start.sentMessageIds,
      after: start.after,
      cancelGraceMs: this.config.cancelGraceMs,
      startQuery: (queryStart) => this.startQuery(cwd, queryStart),
      createGoalServer: () => {
        const getGoals = (): GoalService | undefined => this.ctx.get('goals') as GoalService | undefined
        if (getGoals() === undefined || agent.session.header.origin === 'subagent') return undefined
        return createGoalMcpServer({
          goals: {
            get: () => getGoals()?.get(agent) ?? undefined,
            create: request => {
              const goals = getGoals()
              if (goals === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
              return goals.create(agent, request)
            },
            edit: (ref, request) => {
              const goals = getGoals()
              if (goals === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
              return goals.edit(agent, ref, request)
            },
            pause: ref => {
              const goals = getGoals()
              if (goals === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
              return goals.pause(agent, ref)
            },
            resume: ref => {
              const goals = getGoals()
              if (goals === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
              return goals.resume(agent, ref)
            },
            complete: ref => {
              const goals = getGoals()
              if (goals === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
              return goals.complete(agent, ref)
            },
            block: (ref, reason) => {
              const goals = getGoals()
              if (goals === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
              return goals.block(agent, ref, reason)
            },
          },
          currentTurnSources: () => this.registry.currentTurnSources(sessionId),
          assertActiveRootTurn: () => {
            if (getGoals() === undefined) throw new Error('DSH goal service is no longer available; restart the Claude session')
            if (this.ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
              || agent.session.header.origin === 'subagent'
              || this.ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq === null) {
              throw new Error('DSH goal tools require the active root session turn')
            }
          },
          blockedAfterRounds: this.config.goalBlockedAfterConsecutiveRounds,
        })
      },
      readImage: (ref, signal) => this.readImage(ref, signal),
      onContextWindow: (model, contextWindow) => {
        this.catalog.updateContextWindow(model, contextWindow)
        if (this.ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== null) {
          publishContextWindow(agent.session, PROVIDER, model, contextWindow)
        }
      },
      onModels: (models) => this.catalog.update(models),
      askQuestion: (input, signal) => this.askQuestion(agent, input, signal),
      warn: (message) => this.ctx.logger.warn(`claude: ${message}`),
    })
  }
}
