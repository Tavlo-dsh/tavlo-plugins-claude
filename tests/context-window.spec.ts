import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ClaudeAdapter } from '../src/adapter.ts'
import { AuxiliaryRouter } from '../src/auxiliary.ts'
import { publishContextWindow, resultContextWindow } from '../src/context-window.ts'
import { ModelCatalog } from '../src/models.ts'

const result = (modelUsage: object): SDKResultMessage => ({ type: 'result', modelUsage }) as SDKResultMessage

describe('Claude context capacity', () => {
  it('chooses the requested model rather than the first subagent usage entry', () => {
    const usage = result({
      subagent: { contextWindow: 1_000_000 },
      'main-route': { contextWindow: 200_000 },
    })
    expect(resultContextWindow(usage, 'main-route')).toBe(200_000)
    expect(resultContextWindow(usage, 'unknown-alias')).toBeUndefined()
  })

  it('resolves canonical aliases and a single default model without inventing capacity', () => {
    expect(resultContextWindow(result({ route: { canonicalModel: 'sonnet', contextWindow: 200_000 } }), 'sonnet')).toBe(200_000)
    expect(resultContextWindow(result({ route: { contextWindow: 200_000 } }), 'default')).toBe(200_000)
    for (const value of [0, -1, 1.5, Infinity, '200000']) {
      expect(resultContextWindow(result({ route: { contextWindow: value } }), 'default')).toBeUndefined()
    }
  })

  it('updates the real Session capacity in the same turn without duplicating unchanged records', () => {
    const session = Session.create(SessionId('context-display'))
    session.append('turn/start', { turn: 1 })
    session.append('request/context', { provider: 'claude-code', model: 'default' })
    const before = session.seq
    publishContextWindow(session, 'claude-code', 'default', 200_000)
    expect(session.requestContext()).toEqual({ provider: 'claude-code', model: 'default', contextWindow: 200_000 })
    expect(session.seq).toBe(before + 1)
    publishContextWindow(session, 'claude-code', 'default', 200_000)
    expect(session.seq).toBe(before + 1)
  })

  it('does not let a late capacity report overwrite a different active route', () => {
    const session = Session.create(SessionId('switched-context'))
    session.append('turn/start', { turn: 1 })
    session.append('request/context', { provider: 'other', model: 'default', contextWindow: 128_000 })
    const before = session.seq
    publishContextWindow(session, 'claude-code', 'default', 200_000)
    expect(session.seq).toBe(before)
    session.append('request/context', { provider: 'claude-code', model: 'next' })
    publishContextWindow(session, 'claude-code', 'previous', 200_000)
    expect(session.requestContext()).toEqual({ provider: 'claude-code', model: 'next' })
  })
})

describe('DSH context integration', () => {
  const contexts: Context[] = []
  afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

  it('keeps Claude in charge of compaction while actual prepared requests expose real capacity', async () => {
    const updated = vi.fn()
    const catalog = new ModelCatalog('claude-code', 'unused-context-test-cache', updated, () => undefined)
    const adapter = new ClaudeAdapter({
      catalog,
      auxiliary: new AuxiliaryRouter(
        { listProviders: () => [], listModels: () => Promise.resolve([]), stream: () => (async function* () {})() },
        { enabled: true, routes: [], discovery: true },
        'claude-code',
      ),
      resolveSession: () => { throw new Error('Preparing metadata must not start a Claude process') },
      currentTurnMessageIds: () => new Set(),
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['claude-code'], adapter)

    const unknown = await ctx.llm.prepareCall({ provider: 'claude-code', model: 'default' })
    expect(unknown.context).toBeUndefined()
    catalog.updateContextWindow('default', 200_000)
    catalog.updateContextWindow('default', 200_000)
    catalog.updateContextWindow('default', 0)
    expect(updated).toHaveBeenCalledOnce()

    // This is the metadata lookup used by the host's compaction backend.
    const compaction = await ctx.llm.resolveModelInfo('claude-code', 'default')
    expect(compaction.context?.contextWindow).toBe(1_000_000_000)
    // This is the separate registration-bound path used by agent-loop and UI.
    const prepared = await ctx.llm.prepareCall({ provider: 'claude-code', model: 'default' })
    expect(prepared.context?.contextWindow).toBe(200_000)
    const changed = await ctx.llm.prepareCall({ provider: 'claude-code', model: 'another-model' })
    expect(changed.context).toBeUndefined()
    catalog.updateContextWindow('default', 128_000)
    expect(prepared.context?.contextWindow).toBe(200_000)
    expect((await ctx.llm.prepareCall({ provider: 'claude-code', model: 'default' })).context?.contextWindow).toBe(128_000)
  })
})
