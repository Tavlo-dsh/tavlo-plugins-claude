import { describe, expect, it, vi } from 'vitest'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { createGoalMcpServer, createGoalToolHandlers } from '../src/goal-tools.ts'
import type { GoalOperations, GoalToolDeps } from '../src/goal-tools.ts'
import type { GoalTurnSource } from '../src/session-registry.ts'

function currentGoal(roundsStarted = 3, phase: GoalView['phase'] = 'active'): GoalView {
  return {
    id: 'goal-1' as GoalView['id'],
    revision: 2,
    objective: 'Finish the migration',
    phase,
    roundsStarted,
    maxGoalRounds: 10,
    createdAt: 1,
    updatedAt: 2,
    activation: phase === 'active' ? 'armed' : 'disarmed',
  }
}

function resultValue(result: { content: readonly [{ text: string }] }): unknown {
  return JSON.parse(result.content[0].text)
}

function setup(options: {
  sources?: readonly GoalTurnSource[]
  goal?: GoalView | undefined
  blockedAfterRounds?: number
} = {}) {
  let goal = 'goal' in options ? options.goal : currentGoal()
  let sources = options.sources ?? []
  const operations = {
    get: vi.fn(() => goal),
    create: vi.fn(() => goal as GoalView),
    edit: vi.fn(() => goal as GoalView),
    pause: vi.fn(() => goal as GoalView),
    resume: vi.fn(() => goal as GoalView),
    complete: vi.fn(() => {
      goal = currentGoal(goal?.roundsStarted, 'complete')
      return goal
    }),
    block: vi.fn(() => goal as GoalView),
  } satisfies GoalOperations
  const assertActiveRootTurn = vi.fn()
  const deps: GoalToolDeps = {
    goals: operations,
    currentTurnSources: () => sources,
    assertActiveRootTurn,
    ...(options.blockedAfterRounds === undefined ? {} : { blockedAfterRounds: options.blockedAfterRounds }),
  }
  return {
    handlers: createGoalToolHandlers(deps), operations, assertActiveRootTurn, deps,
    nextRound(round: number, revision = 2) {
      goal = { ...currentGoal(round), revision }
      sources = [{ kind: 'goal', goalId: 'goal-1', revision, round }]
    },
  }
}

describe('DSH goal MCP handlers', () => {
  it('reads the current goal only during an active DSH root turn', () => {
    const { handlers, operations, assertActiveRootTurn } = setup({ goal: undefined })
    expect(resultValue(handlers.getGoal())).toEqual({ goal: null })
    expect(assertActiveRootTurn).toHaveBeenCalledOnce()
    expect(operations.get).toHaveBeenCalledOnce()
  })

  it('creates and edits only from a human-authored turn', () => {
    const { handlers, operations } = setup({ sources: [{ kind: 'user' }] })
    handlers.createGoal({ objective: 'Finish the migration', max_goal_rounds: 12 })
    expect(operations.create).toHaveBeenCalledWith({ objective: 'Finish the migration', maxGoalRounds: 12 })

    handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'edit', objective: 'Finish and verify it' })
    expect(operations.edit).toHaveBeenCalledWith(
      { id: 'goal-1', revision: 2 },
      { objective: 'Finish and verify it' },
    )
  })

  it('rejects human-only changes from an automatic goal round', () => {
    const { handlers, operations } = setup({
      sources: [{ kind: 'goal', goalId: 'goal-1', revision: 2, round: 3 }],
    })
    const result = handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'pause' })
    expect(result.isError).toBe(true)
    expect(operations.pause).not.toHaveBeenCalled()
    expect(handlers.createGoal({ objective: 'Unrequested replacement' }).isError).toBe(true)
    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'edit', objective: 'Changed' }).isError).toBe(true)
    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'resume' }).isError).toBe(true)
    expect(operations.create).not.toHaveBeenCalled()
    expect(operations.edit).not.toHaveBeenCalled()
    expect(operations.resume).not.toHaveBeenCalled()
  })

  it('allows a human turn to pause and resume a paused goal', () => {
    const { handlers, operations } = setup({ sources: [{ kind: 'user' }], goal: currentGoal(3, 'paused') })
    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'resume' }).isError).toBeUndefined()
    expect(operations.resume).toHaveBeenCalledWith({ id: 'goal-1', revision: 2 })
    handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'pause' })
    expect(operations.pause).toHaveBeenCalledWith({ id: 'goal-1', revision: 2 })
  })

  it.each(['paused', 'blocked', 'complete'] as const)('rejects automatic updates after the goal becomes %s', phase => {
    const { handlers, operations } = setup({
      goal: currentGoal(3, phase),
      sources: [{ kind: 'goal', goalId: 'goal-1', revision: 2, round: 3 }],
    })
    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'complete' }).isError).toBe(true)
    expect(operations.complete).not.toHaveBeenCalled()
  })

  it('rejects calls outside an active root turn and from scheduled turns', () => {
    const { handlers, operations, assertActiveRootTurn } = setup({ sources: [{ kind: 'user' }] })
    assertActiveRootTurn.mockImplementation(() => { throw new Error('outside root turn') })
    expect(handlers.getGoal().isError).toBe(true)
    expect(handlers.createGoal({ objective: 'Unauthorized' }).isError).toBe(true)
    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'complete' }).isError).toBe(true)
    expect(operations.get).not.toHaveBeenCalled()
    expect(operations.create).not.toHaveBeenCalled()
    expect(operations.complete).not.toHaveBeenCalled()
    const scheduled = setup({ sources: [{ kind: 'schedule' }] })
    expect(scheduled.handlers.createGoal({ objective: 'Unauthorized' }).isError).toBe(true)
    expect(scheduled.handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'complete' }).isError).toBe(true)
  })

  it('completes only the exact current goal round and revision', () => {
    const { handlers, operations } = setup({
      sources: [{ kind: 'goal', goalId: 'goal-1', revision: 2, round: 3 }],
    })
    handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'complete' })
    expect(operations.complete).toHaveBeenCalledWith({ id: 'goal-1', revision: 2 })

    const stale = setup({ sources: [{ kind: 'goal', goalId: 'goal-1', revision: 1, round: 3 }] })
    expect(stale.handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'complete' }).isError).toBe(true)
    expect(stale.operations.complete).not.toHaveBeenCalled()

    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 1, action: 'complete' }).isError).toBe(true)
    expect(operations.complete).toHaveBeenCalledTimes(1)
  })

  it('counts the same blocker across consecutive rounds rather than the total goal age', () => {
    const fixture = setup({ blockedAfterRounds: 3 })
    const args = { goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: 'Service unavailable' } as const
    fixture.nextRound(20)
    expect(fixture.handlers.updateGoal(args).content[0].text).toContain('1/3')
    expect(fixture.handlers.updateGoal(args).content[0].text).toContain('1/3')
    fixture.nextRound(21)
    expect(fixture.handlers.updateGoal(args).content[0].text).toContain('2/3')
    fixture.nextRound(22)
    expect(fixture.handlers.updateGoal(args).isError).toBeUndefined()
    expect(fixture.operations.block).toHaveBeenCalledOnce()
  })

  it('resets blocker attempts after a gap, reason change, or goal revision change', () => {
    const fixture = setup({ blockedAfterRounds: 3 })
    const args = { goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: 'Service unavailable' } as const
    fixture.nextRound(3)
    expect(fixture.handlers.updateGoal(args).content[0].text).toContain('1/3')
    fixture.nextRound(5)
    expect(fixture.handlers.updateGoal(args).content[0].text).toContain('1/3')
    fixture.nextRound(6)
    expect(fixture.handlers.updateGoal({ ...args, blocked_reason: 'Missing credentials' }).content[0].text).toContain('1/3')
    fixture.nextRound(7, 3)
    expect(fixture.handlers.updateGoal({ ...args, revision: 3, blocked_reason: 'Missing credentials' }).content[0].text).toContain('1/3')
    expect(fixture.operations.block).not.toHaveBeenCalled()
  })

  it('supports a one-round blocker threshold', () => {
    const fixture = setup({ blockedAfterRounds: 1 })
    fixture.nextRound(1)
    expect(fixture.handlers.updateGoal({
      goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: ' Service unavailable ',
    }).isError).toBeUndefined()
    expect(fixture.operations.block).toHaveBeenCalledWith(
      { id: 'goal-1', revision: 2 }, { code: 'model-reported', message: 'Service unavailable' },
    )
  })

  it('enforces the configured minimum before an automatic round can report blocked', () => {
    const { handlers, operations } = setup({
      goal: currentGoal(2),
      sources: [{ kind: 'goal', goalId: 'goal-1', revision: 2, round: 2 }],
      blockedAfterRounds: 3,
    })
    const result = handlers.updateGoal({
      goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: 'A required service is unavailable',
    })
    expect(result.isError).toBe(true)
    expect(operations.block).not.toHaveBeenCalled()
  })

  it('requires a blocker explanation and forwards a valid blocked transition', () => {
    const { handlers, operations } = setup({ sources: [{ kind: 'user' }] })
    expect(handlers.updateGoal({ goal_id: 'goal-1', revision: 2, action: 'blocked' }).isError).toBe(true)
    handlers.updateGoal({
      goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: 'Access is required',
    })
    expect(operations.block).toHaveBeenCalledWith(
      { id: 'goal-1', revision: 2 },
      { code: 'model-reported', message: 'Access is required' },
    )
  })

  it('returns DSH service failures as tool errors', () => {
    const { handlers } = setup({ sources: [{ kind: 'user' }] })
    const failed = setup({ sources: [{ kind: 'user' }] })
    vi.mocked(failed.operations.edit).mockImplementation(() => { throw new Error('stale goal revision') })
    expect(failed.handlers.updateGoal({ goal_id: 'goal-1', revision: 1, action: 'edit', objective: 'New' }))
      .toMatchObject({ isError: true, content: [{ text: 'stale goal revision' }] })
    expect(handlers.getGoal().isError).toBeUndefined()
  })

  it('rechecks the live goal service on each operation instead of caching identity', () => {
    let available = true
    const fixture = setup({ sources: [{ kind: 'user' }] })
    const original = fixture.deps.goals
    const liveGoals: GoalOperations = {
      get: () => available ? original.get() : (() => { throw new Error('service unavailable') })(),
      create: request => original.create(request),
      edit: (ref, request) => original.edit(ref, request),
      pause: ref => original.pause(ref),
      resume: ref => original.resume(ref),
      complete: ref => original.complete(ref),
      block: (ref, reason) => original.block(ref, reason),
    }
    const handlers = createGoalToolHandlers({ ...fixture.deps, goals: liveGoals })
    expect(handlers.getGoal().isError).toBeUndefined()
    available = false
    expect(handlers.getGoal()).toMatchObject({ isError: true, content: [{ text: 'service unavailable' }] })
  })
})

describe('DSH goal server over the real SDK MCP transport', () => {
  it('advertises valid schemas and dispatches all three tools without a Claude process', async () => {
    const fixture = setup({ sources: [{ kind: 'user' }] })
    const server = createGoalMcpServer(fixture.deps)
    type Transport = Parameters<typeof server.instance.connect>[0]
    type Message = Parameters<Transport['send']>[0]
    const pending = new Map<number, (message: Message) => void>()
    const transport: Transport = {
      start: async () => undefined,
      send: async message => {
        if ('id' in message && typeof message.id === 'number') pending.get(message.id)?.(message)
      },
      close: async () => { transport.onclose?.() },
    }
    let nextId = 0
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId
      const reply = Promise.withResolvers<Message>()
      pending.set(id, reply.resolve)
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params })
      try { return await reply.promise } finally { pending.delete(id) }
    }
    try {
      await server.instance.connect(transport)
      expect(await request('initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'goal-test', version: '1.0.0' },
      })).toMatchObject({ result: { instructions: expect.stringContaining('direct human turn') } })
      transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(await request('tools/list')).toMatchObject({ result: { tools: [
        expect.objectContaining({ name: 'get_goal', inputSchema: expect.objectContaining({ type: 'object', properties: {} }) }),
        expect.objectContaining({ name: 'create_goal', inputSchema: expect.objectContaining({ required: ['objective'] }) }),
        expect.objectContaining({ name: 'update_goal', inputSchema: expect.objectContaining({ required: ['goal_id', 'revision', 'action'] }) }),
      ] } })
      expect(await request('tools/call', { name: 'get_goal', arguments: {} }))
        .toMatchObject({ result: { content: [{ type: 'text', text: expect.stringContaining('goal-1') }] } })
      await request('tools/call', { name: 'create_goal', arguments: { objective: 'Finish the migration' } })
      expect(fixture.operations.create).toHaveBeenCalledWith({ objective: 'Finish the migration' })
      await request('tools/call', { name: 'update_goal', arguments: { goal_id: 'goal-1', revision: 2, action: 'complete' } })
      expect(fixture.operations.complete).toHaveBeenCalledWith({ id: 'goal-1', revision: 2 })

      expect(await request('tools/call', { name: 'create_goal', arguments: { objective: '' } }))
        .toMatchObject({ result: { isError: true } })
      expect(fixture.operations.create).toHaveBeenCalledTimes(1)
    } finally {
      await server.instance.close()
    }
  })
})
