/**
 * Translates Claude Agent SDK messages into the events a DSH step reads. Stateful only
 * per API call: it needs to know which messages were streamed as deltas and to hold a
 * call's tool uses until its usage is known.
 * @module tavlo-plugins-claude/sdk-events
 */

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** What one finished Claude tool call reported. */
export interface ToolOutcome {
  readonly text: string
  readonly isError: boolean
  /** The tool's structured output, when the SDK supplies it. */
  readonly structured?: unknown
}

/** Events consumed by the DSH step reader, in order. */
export type SessionEvent =
  | { readonly type: 'text' | 'reasoning'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'tool-use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'turn-end'; readonly result: SDKResultMessage }

/** Everything a single SDK message can produce. */
export type Translated =
  | SessionEvent
  | { readonly type: 'tool-result'; readonly id: string; readonly outcome: ToolOutcome }
  | { readonly type: 'session'; readonly id: string }

interface ApiUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

interface OpenCall {
  readonly id: string
  usage: ApiUsage
  streamed: boolean
  held: SessionEvent[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mergeUsage(base: ApiUsage, next: unknown): ApiUsage {
  const raw = record(next)
  if (raw === undefined) return base
  const merged: ApiUsage = { ...base }
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const value = num(raw[key])
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/** Anthropic usage → DSH usage. Cache fields are disjoint from uncached input. */
export function toTokenUsage(usage: ApiUsage): TokenUsage {
  const inputTokens = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    // DSH's total is the billed input (all three input buckets) plus output.
    totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/** Text of a tool_result's content, which is a string or a list of blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block: unknown) => {
      const raw = record(block)
      if (raw?.type === 'text' && typeof raw.text === 'string') return [raw.text]
      if (raw?.type === 'image') return ['[image]']
      return []
    })
    .join('\n')
}

/** Per-session translator. */
export class SdkTranslator {
  private call: OpenCall | undefined

  /** Forget the open API call, after an interrupt. */
  reset(): void {
    this.call = undefined
  }

  translate(message: SDKMessage): Translated[] {
    const out: Translated[] = []
    const sessionId = (message as { session_id?: unknown }).session_id
    if (typeof sessionId === 'string' && sessionId.length > 0) out.push({ type: 'session', id: sessionId })
    switch (message.type) {
      case 'stream_event':
        if (message.parent_tool_use_id === null) out.push(...this.streamEvent(message.event))
        break
      case 'assistant':
        if (message.parent_tool_use_id === null) out.push(...this.assistant(message.message))
        break
      case 'user':
        out.push(...this.toolResults(message.message.content, message.tool_use_result))
        break
      case 'result':
        this.call = undefined
        out.push({ type: 'turn-end', result: message })
        break
      default:
    }
    return out
  }

  private streamEvent(event: unknown): SessionEvent[] {
    const raw = record(event)
    switch (raw?.type) {
      case 'message_start': {
        const msg = record(raw.message)
        const id = typeof msg?.id === 'string' ? msg.id : ''
        this.call = { id, usage: mergeUsage({}, msg?.usage), streamed: false, held: [] }
        return []
      }
      case 'content_block_delta': {
        const delta = record(raw.delta)
        if (this.call !== undefined) this.call.streamed = true
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text', text: delta.text }]
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          return [{ type: 'reasoning', text: delta.thinking }]
        }
        return []
      }
      case 'message_delta':
        if (this.call !== undefined) this.call.usage = mergeUsage(this.call.usage, raw.usage)
        return []
      case 'message_stop': {
        const call = this.call
        this.call = undefined
        if (call === undefined) return []
        return [{ type: 'usage', usage: toTokenUsage(call.usage) }, ...call.held]
      }
      default:
        return []
    }
  }

  private assistant(message: { id?: unknown; content?: unknown }): SessionEvent[] {
    const call = this.call !== undefined && this.call.id === message.id ? this.call : undefined
    const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : []
    const out: SessionEvent[] = []
    for (const block of blocks) {
      const raw = record(block)
      if (raw === undefined) continue
      if (raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string') {
        const event: SessionEvent = { type: 'tool-use', id: raw.id, name: raw.name, input: raw.input ?? {} }
        // Held until the call's usage is final, so the DSH step that ends here carries it.
        if (call === undefined) out.push(event)
        else call.held.push(event)
        continue
      }
      // Messages that were not streamed (local command output, synthetic errors) still show.
      if (call?.streamed === true) continue
      if (raw.type === 'text' && typeof raw.text === 'string') out.push({ type: 'text', text: raw.text })
      if (raw.type === 'thinking' && typeof raw.thinking === 'string') out.push({ type: 'reasoning', text: raw.thinking })
    }
    return out
  }

  private toolResults(content: unknown, structured: unknown): Translated[] {
    if (!Array.isArray(content)) return []
    return content.flatMap((block: unknown): Translated[] => {
      const raw = record(block)
      if (raw?.type !== 'tool_result' || typeof raw.tool_use_id !== 'string') return []
      const outcome: ToolOutcome = {
        text: toolResultText(raw.content),
        isError: raw.is_error === true,
        ...(structured === undefined ? {} : { structured }),
      }
      return [{ type: 'tool-result', id: raw.tool_use_id, outcome }]
    })
  }
}
