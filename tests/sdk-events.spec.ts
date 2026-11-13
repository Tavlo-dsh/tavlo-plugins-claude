import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { SdkTranslator, toTokenUsage, toolResultText } from '../src/sdk-events.ts'

const msg = (value: object): SDKMessage => value as SDKMessage
const stream = (event: object): SDKMessage =>
  msg({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's1', uuid: 'u' })

describe('SdkTranslator', () => {
  it('streams text and holds tool uses until the call usage is final', () => {
    const t = new SdkTranslator()
    expect(t.translate(stream({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10 } } }))).toEqual([
      { type: 'session', id: 's1' },
    ])
    expect(t.translate(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }))).toContainEqual({
      type: 'text',
      text: 'hi',
    })
    const assistant = t.translate(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 's1',
        message: {
          id: 'm1',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    )
    // Streamed text is not repeated; the tool use waits for message_stop.
    expect(assistant).toEqual([{ type: 'session', id: 's1' }])
    t.translate(stream({ type: 'message_delta', usage: { output_tokens: 5 } }))
    expect(t.translate(stream({ type: 'message_stop' })).slice(1)).toEqual([
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: 'tool-use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
    ])
  })

  it('ignores subagent stream events but reports every tool result', () => {
    const t = new SdkTranslator()
    const nested = msg({
      type: 'stream_event',
      parent_tool_use_id: 'task1',
      session_id: 's1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
    })
    expect(t.translate(nested)).toEqual([{ type: 'session', id: 's1' }])
    const result = t.translate(
      msg({
        type: 'user',
        parent_tool_use_id: null,
        session_id: 's1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] },
      }),
    )
    expect(result[1]).toEqual({ type: 'tool-result', id: 'tu1', outcome: { text: 'ok', isError: false } })
  })

  it('reports cached usage once with the final streamed output count', () => {
    const t = new SdkTranslator()
    const usage = { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 0 }
    const messages = [
      stream({ type: 'message_start', message: { id: 'cached', usage } }),
      stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }),
      stream({ type: 'message_delta', usage: { output_tokens: 20 } }),
      msg({
        type: 'assistant', parent_tool_use_id: null, session_id: 's1',
        message: { id: 'cached', usage: { ...usage, output_tokens: 50 }, content: [{ type: 'text', text: 'hello' }] },
      }),
      stream({ type: 'message_delta', usage: { output_tokens: 50 } }),
      stream({ type: 'message_stop' }),
      msg({ type: 'result', subtype: 'success', usage: { ...usage, output_tokens: 50 }, session_id: 's1' }),
    ]
    const events = messages.flatMap(message => t.translate(message))
    expect(events.filter(event => event.type === 'usage')).toEqual([{
      type: 'usage',
      usage: { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 50, totalTokens: 1050 },
    }])
  })

  it('shows assistant text that was not streamed', () => {
    const t = new SdkTranslator()
    const out = t.translate(
      msg({ type: 'assistant', parent_tool_use_id: null, session_id: 's1', message: { id: 'x', content: [{ type: 'text', text: 'local' }] } }),
    )
    expect(out).toContainEqual({ type: 'text', text: 'local' })
  })
})

describe('helpers', () => {
  it('keeps cached tokens separate from uncached input', () => {
    expect(toTokenUsage({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 })).toEqual({
      inputTokens: 1,
      outputTokens: 4,
      totalTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    })
  })

  it('flattens tool result blocks', () => {
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\n[image]\nb')
  })
})
