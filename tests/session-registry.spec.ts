import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../src/session-registry.ts'

function setup() {
  return new SessionRegistry({
    getAgent: () => undefined,
    ask: async () => 'unavailable',
    warn: () => undefined,
    createSession: () => { throw new Error('turn tracking must not start a Claude process') },
  })
}

describe('SessionRegistry goal turn provenance', () => {
  it('tracks each source only inside the owning open turn', () => {
    const registry = setup()
    registry.observeEvent('s1', { type: 'user/message', data: { id: 'old', source: { kind: 'user' } } })
    expect(registry.currentTurnSources('s1')).toEqual([])
    registry.observeEvent('s1', { type: 'turn/start' })
    registry.observeEvent('s1', { type: 'user/message', data: { id: 'human', source: { kind: 'user' } } })
    expect(registry.currentTurnSources('s1')).toEqual([{ kind: 'user' }])
    expect(registry.currentTurnSources('s2')).toEqual([])
    registry.observeEvent('s1', { type: 'turn/end' })
    expect(registry.currentTurnSources('s1')).toEqual([])
    expect(registry.currentTurnMessageIds('s1').size).toBe(0)

    registry.observeEvent('s1', { type: 'turn/start' })
    const source = { kind: 'goal', goalId: 'goal-1', revision: 2, round: 1 }
    registry.observeEvent('s1', { type: 'user/message', data: { id: 'round-1', source } })
    expect(registry.currentTurnSources('s1')).toEqual([source])
    expect(registry.currentTurnMessageIds('s1')).toEqual(new Set(['round-1']))
    registry.disposeSession('s1')
    expect(registry.currentTurnSources('s1')).toEqual([])
  })

  it('does not grant goal authority to malformed or round-zero sources', () => {
    const registry = setup()
    registry.observeEvent('s1', { type: 'turn/start' })
    for (const [id, source] of [
      ['zero', { kind: 'goal', goalId: 'goal-1', revision: 2, round: 0 }],
      ['blank', { kind: 'goal', goalId: '', revision: 2, round: 1 }],
      ['stale', { kind: 'goal', goalId: 'goal-1', revision: 0, round: 1 }],
      ['missing', undefined],
    ]) registry.observeEvent('s1', { type: 'user/message', data: { id, source } })
    expect(registry.currentTurnSources('s1')).toEqual([])
  })

  it('drops human authority when the next automatic turn starts', () => {
    const registry = setup()
    registry.observeEvent('s1', { type: 'turn/start' })
    registry.observeEvent('s1', { type: 'user/message', data: { id: 'human', source: { kind: 'user' } } })
    registry.observeEvent('s1', { type: 'turn/start' })
    const source = { kind: 'goal', goalId: 'goal-1', revision: 2, round: 1 }
    registry.observeEvent('s1', { type: 'user/message', data: { id: 'round', source } })
    expect(registry.currentTurnSources('s1')).toEqual([source])
  })
})
