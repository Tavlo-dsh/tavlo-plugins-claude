/** Exposes the current DSH session goal to Claude through an in-process MCP server. */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { CreateGoalRequest, EditGoalRequest, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import type { GoalTurnSource } from './session-registry.ts'

const SERVER_NAME = 'tavlo_dsh_goal'
const BLOCKED_AFTER_ROUNDS = 3

/** Fully qualified Claude SDK tool names admitted without a second approval prompt. */
export const GOAL_TOOL_NAMES = [
  `mcp__${SERVER_NAME}__get_goal`,
  `mcp__${SERVER_NAME}__create_goal`,
  `mcp__${SERVER_NAME}__update_goal`,
] as const

/** Calls are accepted only while this exact DSH root agent owns an open turn. */
export interface GoalOperations {
  get(): GoalView | undefined
  create(request: CreateGoalRequest): GoalView
  edit(ref: GoalRef, request: EditGoalRequest): GoalView
  pause(ref: GoalRef): GoalView
  resume(ref: GoalRef): GoalView
  complete(ref: GoalRef): GoalView
  block(ref: GoalRef, reason: { readonly code: string; readonly message: string }): GoalView
}

/** Live goal operations and turn authority for one DSH session. */
export interface GoalToolDeps {
  readonly goals: GoalOperations
  readonly currentTurnSources: () => readonly GoalTurnSource[]
  readonly assertActiveRootTurn: () => void
  readonly blockedAfterRounds?: number
}

export type GoalToolResult = {
  readonly content: [{ readonly type: 'text'; readonly text: string }]
  readonly isError?: true
}

type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

interface CreateGoalArgs {
  readonly objective: string
  readonly max_goal_rounds?: number
}

interface UpdateGoalArgs {
  readonly goal_id: string
  readonly revision: number
  readonly action: GoalAction
  readonly objective?: string
  readonly max_goal_rounds?: number
  readonly blocked_reason?: string
}

export interface GoalToolHandlers {
  getGoal(): GoalToolResult
  createGoal(args: CreateGoalArgs): GoalToolResult
  updateGoal(args: UpdateGoalArgs): GoalToolResult
}

/** Guidance presented with the DSH-owned MCP tool set. */
function instructions(blockedAfterRounds: number): string {
  return 'These tools manage the current DeepSeek Harness session goal. Create a goal only '
    + 'when the user explicitly requests one for a long-running objective. Read the current goal before '
    + 'updating it and copy its exact id and revision. Create, edit, pause, and resume require '
    + 'a direct human turn and the user\'s request for that operation; the host checks turn provenance. '
    + 'During an automatic goal round, complete '
    + 'only after verifying the objective. Report blocked only after the same concrete blocking '
    + `condition persists for at least ${blockedAfterRounds} consecutive goal rounds. `
    + 'Call update_goal with action blocked and the same blocked_reason on each affected round; '
    + 'the host records the attempt and rejects the transition until the threshold is met. '
    + 'Retrying in the same round does not advance the count. The count resets after a process restart '
    + 'or a goal revision change. A paused goal can only be resumed at the user\'s request.'
}

/** Compact tool response matching DSH's model-facing goal tools. */
function goalValue(goal: GoalView | undefined): unknown {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
    },
    activation: goal.activation,
  }
}

function success(value: unknown): GoalToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function failure(error: unknown): GoalToolResult {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  }
}

function run(operation: () => unknown): GoalToolResult {
  try {
    return success(operation())
  } catch (error: unknown) {
    return failure(error)
  }
}

function goalRef(goalId: string, revision: number): GoalRef {
  if (goalId.trim().length === 0 || goalId !== goalId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('goal_id must be non-empty and revision must be a positive safe integer')
  }
  return { id: goalId as GoalRef['id'], revision }
}

function hasHumanTurn(sources: readonly GoalTurnSource[]): boolean {
  return sources.some(source => source.kind === 'user')
}

function isCurrentGoalRound(sources: readonly GoalTurnSource[], goal: GoalView): boolean {
  return goal.phase === 'active' && goal.activation === 'armed'
    && sources.some(source => source.kind === 'goal'
    && source.goalId === goal.id
    && source.revision === goal.revision
    && source.round === goal.roundsStarted
    && source.round > 0)
}

function requireHumanTurn(sources: readonly GoalTurnSource[]): void {
  if (!hasHumanTurn(sources)) throw new Error('this goal operation requires a direct human turn')
}

/** Create handlers whose authority is checked against the live turn on every call. */
export function createGoalToolHandlers(deps: GoalToolDeps): GoalToolHandlers {
  const blockedAfterRounds = deps.blockedAfterRounds ?? BLOCKED_AFTER_ROUNDS
  if (!Number.isSafeInteger(blockedAfterRounds) || blockedAfterRounds < 1) {
    throw new TypeError('blockedAfterRounds must be a positive safe integer')
  }
  let blocker: { id: string; revision: number; reason: string; round: number; count: number } | undefined
  return {
    getGoal: () => run(() => {
      deps.assertActiveRootTurn()
      return goalValue(deps.goals.get())
    }),
    createGoal: args => run(() => {
      deps.assertActiveRootTurn()
      requireHumanTurn(deps.currentTurnSources())
      const goal = deps.goals.create({
        objective: args.objective,
        ...(args.max_goal_rounds === undefined || args.max_goal_rounds === 0
          ? {} : { maxGoalRounds: args.max_goal_rounds }),
      })
      return goalValue(goal)
    }),
    updateGoal: args => run(() => {
      deps.assertActiveRootTurn()
      const sources = deps.currentTurnSources()
      const ref = goalRef(args.goal_id, args.revision)
      if (args.action === 'edit') {
        requireHumanTurn(sources)
        const goal = deps.goals.edit(ref, {
          ...(args.objective === undefined || args.objective.length === 0 ? {} : { objective: args.objective }),
          ...(args.max_goal_rounds === undefined || args.max_goal_rounds === 0
            ? {} : { maxGoalRounds: args.max_goal_rounds }),
        })
        return goalValue(goal)
      }
      if (args.action === 'pause' || args.action === 'resume') {
        requireHumanTurn(sources)
        return goalValue(args.action === 'pause'
          ? deps.goals.pause(ref)
          : deps.goals.resume(ref))
      }

      const current = deps.goals.get()
      const goalRound = current !== undefined && isCurrentGoalRound(sources, current)
      if (!hasHumanTurn(sources) && !goalRound) {
        throw new Error('complete and blocked require a direct human turn or the current goal round')
      }
      if (current === undefined || ref.id !== current.id || ref.revision !== current.revision) {
        throw new Error('goal_id and revision must match the current goal')
      }
      if (args.action === 'complete') return goalValue(deps.goals.complete(ref))
      if (args.action !== 'blocked') throw new Error('unsupported goal action')

      if (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0) {
        throw new Error('blocked_reason is required with action blocked')
      }
      const reason = args.blocked_reason.trim()
      if (!hasHumanTurn(sources)) {
        const same = blocker?.id === current.id && blocker.revision === current.revision && blocker.reason === reason
        const count = same && blocker !== undefined
          ? (blocker.round === current.roundsStarted ? blocker.count
            : blocker.round === current.roundsStarted - 1 ? blocker.count + 1 : 1)
          : 1
        blocker = { id: current.id, revision: current.revision, reason, round: current.roundsStarted, count }
        if (count < blockedAfterRounds) {
          throw new Error(`blocker recorded for ${count}/${blockedAfterRounds} consecutive goal rounds; continue working and report the same blocker in the next round if it persists`)
        }
      }
      return goalValue(deps.goals.block(ref, {
        code: 'model-reported',
        message: reason,
      }))
    }),
  }
}

function goalTools(deps: GoalToolDeps) {
  const handlers = createGoalToolHandlers(deps)
  return [
    tool(
      'get_goal',
      'Read the current DSH session goal, including the exact id and revision for updates.',
      {},
      async () => handlers.getGoal(),
      { annotations: { readOnlyHint: true, openWorldHint: false }, alwaysLoad: true },
    ),
    tool(
      'create_goal',
      'Create a persisted DSH goal for a long-running objective in this session.',
      {
        objective: z.string().min(1),
        max_goal_rounds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      },
      async (args) => handlers.createGoal(args),
      { annotations: { openWorldHint: false }, alwaysLoad: true },
    ),
    tool(
      'update_goal',
      'Edit, pause, resume, complete, or block the current DSH goal.',
      {
        goal_id: z.string().min(1),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        action: z.enum(['edit', 'pause', 'resume', 'complete', 'blocked']),
        objective: z.string().optional(),
        max_goal_rounds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        blocked_reason: z.string().optional(),
      },
      async (args) => handlers.updateGoal(args),
      { annotations: { openWorldHint: false }, alwaysLoad: true },
    ),
  ]
}

/** Build the session-scoped SDK MCP server; absent DSH goal support disables the bridge. */
export function createGoalMcpServer(deps: GoalToolDeps): McpSdkServerConfigWithInstance {
  const blockedAfterRounds = deps.blockedAfterRounds ?? BLOCKED_AFTER_ROUNDS
  if (!Number.isSafeInteger(blockedAfterRounds) || blockedAfterRounds < 1) {
    throw new TypeError('blockedAfterRounds must be a positive safe integer')
  }
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    instructions: instructions(blockedAfterRounds),
    tools: goalTools(deps),
  })
}
