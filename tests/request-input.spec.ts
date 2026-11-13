import { describe, expect, it } from 'vitest'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { unseenUserInput } from '../src/request-input.ts'

const message = (content: readonly object[]): RequestMessage =>
  ({ id: 'm1', role: 'user', content, source: { kind: 'user' } }) as unknown as RequestMessage

describe('unseenUserInput image references', () => {
  it('preserves the complete attachment reference for the reader', () => {
    const ref = {
      attachmentId: 'sha256:image',
      mediaType: 'image/png',
      bytes: 69,
      width: 1,
      height: 1,
      name: 'screenshot.png',
      originalDimensions: { width: 2, height: 2 },
    }
    const input = unseenUserInput([message([{ type: 'image', attachment: ref }])], new Set(), new Set(['m1']))
    expect(input.blocks).toEqual([{ type: 'image', ref }])
    expect(input.blocks[0]).toHaveProperty('ref', ref)
    expect(input.ids).toEqual(['m1'])
  })

  it('drops a reference without integrity metadata', () => {
    expect(
      unseenUserInput(
        [message([{ type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png' } }])],
        new Set(),
        new Set(['m1']),
      ).blocks,
    ).toEqual([])
  })
})

describe('unseenUserInput goal-round sources', () => {
  it('forwards an admitted positive goal round in the current DSH turn', () => {
    const goal = {
      ...message([{ type: 'text', text: '<goal_round>Continue the objective.</goal_round>' }]),
      source: { kind: 'goal', goalId: 'goal-1', revision: 2, round: 3 },
    } as RequestMessage
    expect(unseenUserInput([goal], new Set(), new Set(['m1']))).toEqual({
      ids: ['m1'],
      blocks: [{ type: 'text', text: '<goal_round>Continue the objective.</goal_round>' }],
    })
  })

  it.each([
    { kind: 'goal', goalId: 'goal-1', revision: 2, round: 0 },
    { kind: 'goal', goalId: 'goal-1', revision: 0, round: 1 },
    { kind: 'goal', goalId: '', revision: 2, round: 1 },
    { kind: 'goal', goalId: ' goal-1 ', revision: 2, round: 1 },
    { kind: 'tool-goal' },
    { kind: 'system' },
  ])('does not forward other or malformed internal sources: %j', (source) => {
    const internal = {
      ...message([{ type: 'text', text: 'internal context' }]),
      source,
    } as RequestMessage
    expect(unseenUserInput([internal], new Set(), new Set(['m1']))).toEqual({ ids: [], blocks: [] })
  })

  it('requires goal-round message identity and membership in the open turn', () => {
    const goal = {
      ...message([{ type: 'text', text: 'Continue' }]),
      source: { kind: 'goal', goalId: 'goal-1', revision: 2, round: 1 },
    } as RequestMessage
    expect(unseenUserInput([goal], new Set(), new Set())).toEqual({ ids: [], blocks: [] })
    expect(unseenUserInput([{ ...goal, id: undefined } as unknown as RequestMessage], new Set(), new Set(['m1'])))
      .toEqual({ ids: [], blocks: [] })
  })

  it('keeps real scheduled requests and excludes schedule-change notices', () => {
    const scheduled = {
      ...message([{ type: 'text', text: 'Scheduled reminder' }]),
      source: { kind: 'schedule' },
    } as RequestMessage
    expect(unseenUserInput([scheduled], new Set(), new Set(['m1'])).ids).toEqual(['m1'])
    expect(unseenUserInput([
      { ...scheduled, content: [{ type: 'text', text: '[SCHEDULE CHANGE] Updated' }] },
    ], new Set(), new Set(['m1']))).toEqual({ ids: [], blocks: [] })
  })
})
