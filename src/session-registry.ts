/**
 * Maps DSH sessions to their live Claude sessions and follows each session log to know
 * where DSH turns begin and end. Holds no framework state, so `index.ts` stays wiring.
 * Turn tracking follows dsh-ccgui.
 * @module tavlo-plugins-claude/session-registry
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ClaudeSession, PermissionAsk } from './claude-session.ts'
import { MIRROR_TOOL_NAME, PROVIDER } from './constants.ts'
import type { ToolOutcome } from './sdk-events.ts'

/** What a new Claude session inherits from the one it replaces. */
export interface SessionStart {
  readonly sentMessageIds: ReadonlySet<string>
  /** Settles once the previous process has stopped. */
  readonly after: Promise<void>
}

/** DSH facilities the registry uses. */
export interface RegistryDeps {
  getAgent(sessionId: string): Agent | undefined
  ask(agent: Agent, request: PermissionAsk, signal: AbortSignal): Promise<ApprovalOutcome>
  warn(message: string): void
  createSession(agent: Agent, sessionId: string, cwd: string, start: SessionStart): ClaudeSession
}

/** The fields of a session log event the registry reads. */
export interface ObservedEvent {
  readonly type: string
  readonly data?: unknown
}

/** Human or goal-round sources observed in the session's currently open turn. */
export interface GoalTurnSource {
  readonly kind: string
  readonly goalId?: string
  readonly revision?: number
  readonly round?: number
}

const NO_MESSAGES: ReadonlySet<string> = new Set()
const NO_SOURCES: readonly GoalTurnSource[] = []

function goalTurnSource(value: unknown): GoalTurnSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  if (source.kind === 'user') return { kind: 'user' }
  if (source.kind !== 'goal') return { kind: String(source.kind ?? '') }
  if (typeof source.goalId !== 'string' || source.goalId.trim().length === 0 || source.goalId !== source.goalId.trim()
    || !Number.isSafeInteger(source.revision)
    || typeof source.revision !== 'number' || source.revision < 1
    || !Number.isSafeInteger(source.round) || typeof source.round !== 'number' || source.round < 1) {
    return undefined
  }
  return { kind: 'goal', goalId: source.goalId, revision: source.revision, round: source.round }
}

/** Owns every live Claude session in this process. */
export class SessionRegistry {
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly turnMessages = new Map<string, Set<string>>()
  private readonly turnSources = new Map<string, Map<string, GoalTurnSource>>()

  constructor(private readonly deps: RegistryDeps) {}

  /** Whether a provider route is this plugin's. */
  isOwnRoute(provider: string): boolean {
    return provider === PROVIDER
  }

  /**
   * Follow one session log event. Only messages logged since the latest `turn/start`
   * count as new, which keeps a prompt from being sent twice after a failed turn,
   * a replaced process or a restart.
   */
  observeEvent(sessionId: string, event: ObservedEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.turnMessages.set(sessionId, new Set())
        this.turnSources.set(sessionId, new Map())
        return
      case 'user/message': {
        const data = event.data as { id?: unknown; source?: unknown } | undefined
        const id = data?.id
        if (typeof id === 'string') {
          this.turnMessages.get(sessionId)?.add(id)
          const source = goalTurnSource(data?.source)
          if (source !== undefined) this.turnSources.get(sessionId)?.set(id, source)
        }
        return
      }
      case 'turn/end':
        this.turnMessages.delete(sessionId)
        this.turnSources.delete(sessionId)
        this.sessions.get(sessionId)?.abandonTurn()
        return
      default:
    }
  }

  /** Ids of the user messages in a session's open turn; empty outside a turn. */
  currentTurnMessageIds(sessionId: string): ReadonlySet<string> {
    return this.turnMessages.get(sessionId) ?? NO_MESSAGES
  }

  /** Human and admitted goal-round sources for the open session turn. */
  currentTurnSources(sessionId: string): readonly GoalTurnSource[] {
    const sources = this.turnSources.get(sessionId)
    return sources === undefined ? NO_SOURCES : [...sources.values()]
  }

  /**
   * Find or create the Claude session for a DSH session.
   * @returns a session; a dead one is returned until its failure has been read.
   */
  resolveSession(sessionId: string): ClaudeSession {
    const agent = this.deps.getAgent(sessionId)
    if (agent === undefined) throw new LlmError(`找不到会话 ${sessionId}。`, 'CLAUDE_START_FAILED')
    const current = this.sessions.get(sessionId)
    if (current !== undefined && !current.replaceable) return current
    this.stopSession(sessionId)
    const { cwd } = agent.session.header
    if (cwd === undefined) throw new LlmError('Claude Code 需要工作目录，但这个会话没有。', 'CLAUDE_START_FAILED')
    const session = this.deps.createSession(agent, sessionId, cwd, {
      sentMessageIds: current?.sentMessageIds ?? NO_MESSAGES,
      after: this.stopping.get(sessionId) ?? Promise.resolve(),
    })
    this.sessions.set(sessionId, session)
    return session
  }

  /** Body of the mirror tool: wait for Claude's result of the call `exec` mirrors. */
  waitForTool(exec: ToolRunContext): Promise<ToolOutcome> {
    const { agent, callId, signal } = exec
    const session = agent === undefined ? undefined : this.sessions.get(agent.id)
    if (agent === undefined || session === undefined) {
      return Promise.reject(new Error(`${MIRROR_TOOL_NAME} 只记录 Claude Code 发出的调用，不能直接使用。`))
    }
    return session.waitForTool(callId, (request, askSignal) => this.deps.ask(agent, request, askSignal), signal)
  }

  /** Forget a DSH session and stop its Claude. */
  disposeSession(sessionId: string): void {
    this.turnMessages.delete(sessionId)
    this.turnSources.delete(sessionId)
    this.stopSession(sessionId)
  }

  /** Stop every Claude; `reason` is shown to any turn this cuts off. */
  disposeAll(reason?: string): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      this.turnMessages.delete(sessionId)
      this.turnSources.delete(sessionId)
      this.stopSession(sessionId, reason)
    }
    return Promise.all(this.stopping.values()).then(() => undefined)
  }

  /** Stop the process only; the DSH session and its open turn carry on. */
  private stopSession(sessionId: string, reason?: string): void {
    const live = this.sessions.get(sessionId)
    if (live === undefined) return
    this.sessions.delete(sessionId)
    const stoppedSelf = live.dispose(reason).catch((error: unknown) => {
      this.deps.warn(`failed to stop Claude Code: ${String(error)}`)
    })
    // Chained so quick replacements still wait for the oldest process.
    const stopped: Promise<void> = Promise.all([this.stopping.get(sessionId), stoppedSelf]).then(() => {
      if (this.stopping.get(sessionId) === stopped) this.stopping.delete(sessionId)
    })
    this.stopping.set(sessionId, stopped)
  }
}
