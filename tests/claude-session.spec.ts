import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CanUseTool, McpSdkServerConfigWithInstance, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AsyncQueue } from '../src/async-queue.ts'
import { ClaudeSession } from '../src/claude-session.ts'
import type { AskFn, QueryStart } from '../src/claude-session.ts'
import type { ImageRef } from '../src/request-input.ts'

const NEVER = new AbortController().signal

/** Stands in for the SDK query: records prompts, replays scripted messages. */
class FakeQuery {
  readonly out = new AsyncQueue<SDKMessage | undefined>()
  readonly inputs: SDKUserMessage[] = []
  interrupts = 0
  private readonly waiting: ((message: SDKUserMessage) => void)[] = []

  constructor(readonly start: QueryStart) {
    void (async () => {
      for await (const message of start.prompt) {
        this.inputs.push(message)
        this.waiting.shift()?.(message)
      }
    })()
  }

  nextInput(): Promise<SDKUserMessage> {
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  emit(...messages: object[]): void {
    for (const message of messages) this.out.push(message as SDKMessage)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      const message = await this.out.next(NEVER)
      if (message === undefined) return
      yield message
    }
  }

  interrupt(): Promise<void> {
    this.interrupts += 1
    return Promise.resolve()
  }

  supportedModels(): Promise<never[]> {
    return Promise.resolve([])
  }

  setModel(_model?: string): Promise<void> {
    return Promise.resolve()
  }

  applyFlagSettings(): Promise<void> {
    return Promise.resolve()
  }

  close(): void {
    this.out.push(undefined)
  }
}

const se = (event: object): object => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'claude-1' })
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  result: 'ok',
  modelUsage: { sonnet: { contextWindow: 200_000 } },
  session_id: 'claude-1',
}

function textReply(id: string, text: string): object[] {
  return [
    se({ type: 'message_start', message: { id, usage: { input_tokens: 3 } } }),
    se({ type: 'content_block_delta', delta: { type: 'text_delta', text } }),
    se({ type: 'message_delta', usage: { output_tokens: 2 } }),
    se({ type: 'message_stop' }),
    result,
  ]
}

function user(id: string, text: string): RequestMessage {
  return { id, role: 'user', content: [{ type: 'text', text }] } as unknown as RequestMessage
}

function setup(options: {
  createGoalServer?: () => McpSdkServerConfigWithInstance | undefined
  readImage?: (ref: ImageRef, signal: AbortSignal) => Promise<Uint8Array>
  onContextWindow?: (model: string, contextWindow: number) => void
  getContextUsage?: Query['getContextUsage']
  warn?: (message: string) => void
} = {}): { session: ClaudeSession; fake: () => Promise<FakeQuery> } {
  let started: (query: FakeQuery) => void = () => undefined
  const ready = new Promise<FakeQuery>((resolve) => {
    started = resolve
  })
  const session = new ClaudeSession({
    dshSessionId: 'dsh-1',
    provider: 'claude-code',
    sentMessageIds: new Set(),
    cancelGraceMs: 1_000,
    after: Promise.resolve(),
    createGoalServer: options.createGoalServer ?? (() => undefined),
    startQuery: (start) => {
      const fake = new FakeQuery(start)
      if (options.getContextUsage !== undefined) Object.assign(fake, { getContextUsage: options.getContextUsage })
      started(fake)
      return fake as unknown as Query
    },
    readImage: (ref, signal) => options.readImage?.(ref, signal) ?? Promise.resolve(new Uint8Array()),
    onContextWindow: options.onContextWindow ?? (() => undefined),
    onModels: () => undefined,
    askQuestion: () => Promise.resolve(undefined),
    warn: options.warn ?? (() => undefined),
  })
  return {
    session,
    fake: () => ready,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function step(messages: RequestMessage[], turn: string[]) {
  return { messages, signal: undefined, model: 'default', reasoningEffort: undefined, currentTurnMessageIds: new Set(turn) }
}

describe('ClaudeSession', () => {
  it('forwards each automatic goal round once and attaches its session-scoped MCP server', async () => {
    const goalServer = { type: 'sdk', name: 'tavlo_dsh_goal' } as McpSdkServerConfigWithInstance
    const createGoalServer = vi.fn(() => goalServer)
    const { session, fake: started } = setup({ createGoalServer })
    const round = (number: number): RequestMessage => ({
      ...user(`round-${number}`, `Continue goal round ${number}`),
      source: { kind: 'goal', goalId: 'goal-1', revision: 2, round: number },
    }) as RequestMessage
    try {
      const reading = collect(session.stream(step([round(1)], ['round-1'])))
      const q = await started()
      expect(q.start.goalServer).toBe(goalServer)
      expect((await q.nextInput()).message.content).toEqual([{ type: 'text', text: 'Continue goal round 1' }])
      q.emit(...textReply('goal-reply-1', 'More work needed'))
      await reading
      expect((await collect(session.stream(step([round(1)], ['round-1'])))).at(-1))
        .toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(q.inputs).toHaveLength(1)
      const input = q.nextInput()
      const next = collect(session.stream(step([round(2)], ['round-2'])))
      expect((await input).message.content).toEqual([{ type: 'text', text: 'Continue goal round 2' }])
      q.emit(...textReply('goal-reply-2', 'Verified and completed'))
      await next
      expect(q.inputs).toHaveLength(2)
      expect(createGoalServer).toHaveBeenCalledOnce()
    } finally { await session.dispose() }
  })

  it('sends a prompt once and finishes with the native session id', async () => {
    const { session, fake: started } = setup()
    const reading = collect(session.stream(step([user('m1', 'hi')], ['m1'])))
    const q = await started()
    expect(q.start.goalServer).toBeUndefined()
    const input = await q.nextInput()
    expect(input.message.content).toEqual([{ type: 'text', text: 'hi' }])
    q.emit(...textReply('a1', 'hello'))
    const chunks = await reading
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } })
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { claudeSessionId: 'claude-1', dshSessionId: 'dsh-1' } },
    })
    expect(session.sentMessageIds.has('m1')).toBe(true)
  })

  it.each(['same-model', 'previous-model'] as const)('retries unsent messages after model selection fails using %s without replaying earlier input', async (retryModel) => {
    const { session, fake: started } = setup()
    try {
      const firstMessage = user('first', 'First prompt')
      const first = collect(session.stream(step([firstMessage], ['first'])))
      const q = await started()
      await q.nextInput()
      q.emit(...textReply('first-reply', 'done'))
      await first

      const setModel = vi.spyOn(q, 'setModel')
        .mockRejectedValueOnce(new Error('model unavailable'))
        .mockRejectedValueOnce(new Error('model unavailable'))
        .mockResolvedValue(undefined)
      const messages = [user('second', 'Second prompt'), user('third', 'Additional detail')]
      const request = { ...step(messages, ['second', 'third']), model: 'sonnet' }
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(collect(session.stream(request))).rejects.toMatchObject({ code: 'CLAUDE_MODEL_FAILED' })
        expect(session.sentMessageIds.has('second')).toBe(false)
        expect(session.sentMessageIds.has('third')).toBe(false)
        expect(session.sentMessageIds.has('first')).toBe(true)
        expect(q.inputs).toHaveLength(1)
      }
      expect(setModel.mock.calls).toEqual([['sonnet'], ['sonnet']])

      const nextInput = q.nextInput()
      const retryRequest = { ...request, model: retryModel === 'same-model' ? 'sonnet' : 'default' }
      const retried = collect(session.stream(retryRequest))
      expect((await nextInput).message.content).toEqual([
        { type: 'text', text: 'Second prompt' },
        { type: 'text', text: 'Additional detail' },
      ])
      q.emit(...textReply('retry-reply', 'received'))
      expect((await retried).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(q.inputs).toHaveLength(2)
      expect(session.sentMessageIds).toEqual(new Set(['first', 'second', 'third']))
      expect(setModel.mock.calls).toEqual(retryModel === 'same-model' ? [['sonnet'], ['sonnet'], ['sonnet']] : [['sonnet'], ['sonnet']])

      // Once committed, replaying the same DSH step must not resubmit the prompt.
      expect((await collect(session.stream(retryRequest))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(q.inputs).toHaveLength(2)
    } finally {
      await session.dispose()
    }
  })

  it('accumulates disjoint cache buckets across API calls in one DSH step', async () => {
    const { session, fake: started } = setup()
    const reading = collect(session.stream(step([user('m1', 'hello')], ['m1'])))
    const q = await started()
    await q.nextInput()
    q.emit(
      se({ type: 'message_start', message: { id: 'cached-1', usage: {
        input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100,
      } } }),
      se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } }),
      se({ type: 'message_delta', usage: { output_tokens: 50 } }),
      se({ type: 'message_stop' }),
      se({ type: 'message_start', message: { id: 'cached-2', usage: {
        input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
      } } }),
      se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } }),
      se({ type: 'message_delta', usage: { output_tokens: 10 } }),
      se({ type: 'message_stop' }),
      result,
    )
    const chunks = await reading
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([{
      type: 'usage',
      usage: { inputTokens: 120, cacheReadTokens: 1800, cacheWriteTokens: 100, outputTokens: 60, totalTokens: 2080 },
    }])
  })

  it('reads a complete attachment reference and sends an inline image block', async () => {
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')
    const ref: ImageRef = {
      attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: 1,
      height: 1,
      name: 'screenshot.png',
      originalDimensions: { width: 2, height: 2 },
    }
    // Match the host reader's integrity checks so truncated refs cannot pass.
    const readImage = vi.fn(async (actual: ImageRef) => {
      if (actual.attachmentId !== ref.attachmentId || actual.mediaType !== ref.mediaType
        || actual.bytes !== data.byteLength || actual.width !== 1 || actual.height !== 1) {
        throw new Error('ATTACHMENT_CORRUPT')
      }
      return data
    })
    const { session, fake: started } = setup({ readImage })
    const reading = collect(
      session.stream(
        step(
          [{ id: 'm1', role: 'user', content: [
            { type: 'text', text: 'Describe this screenshot.' },
            { type: 'image', attachment: ref },
          ] } as unknown as RequestMessage],
          ['m1'],
        ),
      ),
    )
    const q = await started()
    const input = await q.nextInput()
    expect(readImage).toHaveBeenCalledOnce()
    expect(readImage.mock.calls[0]?.[0]).toBe(ref)
    expect(input.message.content).toEqual([
      { type: 'text', text: 'Describe this screenshot.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } },
    ])
    q.emit(...textReply('a-image', 'seen'))
    await reading
  })

  it.each(['rejects', 'resolves'] as const)('does not send a cancelled image prompt when its reader %s late, and permits retry', async (settlement) => {
    const image = Promise.withResolvers<Uint8Array>()
    const readingImage = Promise.withResolvers<void>()
    const warn = vi.fn()
    const readImage = vi.fn(() => {
      readingImage.resolve()
      return image.promise
    })
    const { session, fake: started } = setup({ readImage, warn })
    const controller = new AbortController()
    const request = step([{ id: 'cancel-image', role: 'user', content: [
      { type: 'text', text: 'Inspect the image' },
      { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      { type: 'image', attachment: { attachmentId: 'later-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ] } as unknown as RequestMessage], ['cancel-image'])
    try {
      const reading = collect(session.stream({ ...request, signal: controller.signal }))
      const q = await started()
      await readingImage.promise
      controller.abort()
      if (settlement === 'rejects') image.reject(controller.signal.reason)
      else image.resolve(new Uint8Array([1]))
      expect((await reading).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
      expect(q.inputs).toHaveLength(0)
      expect(q.interrupts).toBe(0) // No prompt was submitted, so there is no native turn to interrupt.
      expect(readImage).toHaveBeenCalledOnce()
      expect(warn).not.toHaveBeenCalled()
      expect(session.sentMessageIds.has('cancel-image')).toBe(false)

      readImage.mockImplementation(() => Promise.resolve(new Uint8Array([1])))
      const retryInput = q.nextInput()
      const retry = collect(session.stream(request))
      expect((await retryInput).message.content).toEqual([
        { type: 'text', text: 'Inspect the image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQ==' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQ==' } },
      ])
      q.emit(...textReply('retried-image', 'seen'))
      expect((await retry).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(q.inputs).toHaveLength(1)
    } finally {
      await session.dispose()
    }
  })

  it('interrupts when stopped immediately after submitting, before the reply reader starts', async () => {
    const { session, fake: started } = setup()
    const controller = new AbortController()
    try {
      const reading = collect(session.stream({ ...step([user('early-stop', 'go')], ['early-stop']), signal: controller.signal }))
      const q = await started()
      await q.nextInput()
      controller.abort()
      expect((await reading).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
      expect(q.inputs).toHaveLength(1)
      expect(q.interrupts).toBe(1)
      // Already submitted input must stay marked, avoiding replay after interruption.
      expect(session.sentMessageIds.has('early-stop')).toBe(true)
      q.emit(result)
    } finally {
      await session.dispose()
    }
  })

  it('keeps the image-failure placeholder for ordinary read errors and continues the reply', async () => {
    const warn = vi.fn()
    const { session, fake: started } = setup({
      readImage: () => Promise.reject(new Error('ATTACHMENT_CORRUPT')),
      warn,
    })
    try {
      const reading = collect(session.stream(step([{ id: 'bad-image', role: 'user', content: [
        { type: 'text', text: 'Inspect the image' },
        { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      ] } as unknown as RequestMessage], ['bad-image'])))
      const q = await started()
      expect((await q.nextInput()).message.content).toEqual([
        { type: 'text', text: 'Inspect the image' },
        { type: 'text', text: '[图片读取失败，未发送]' },
      ])
      q.emit(...textReply('bad-image-reply', 'Please upload again'))
      expect((await reading).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      await session.dispose()
    }
  })

  it('learns the context window from Claude model usage', async () => {
    const windows: Array<{ model: string; contextWindow: number }> = []
    const { session, fake: started } = setup({ onContextWindow: (model, contextWindow) => windows.push({ model, contextWindow }) })
    const reading = collect(session.stream(step([user('m1', 'hi')], ['m1'])))
    const q = await started()
    await q.nextInput()
    q.emit(...textReply('a-context', 'hello'))
    await reading
    expect(windows).toEqual([{ model: 'default', contextWindow: 200_000 }])
  })

  it('prefers the native auto-compact window and publishes it before ending the turn', async () => {
    let endContext: (usage: Awaited<ReturnType<Query['getContextUsage']>>) => void = () => undefined
    const summary = { rawMaxTokens: 200_000 } as Awaited<ReturnType<Query['getContextUsage']>>
    const second = new Promise<Awaited<ReturnType<Query['getContextUsage']>>>(resolve => { endContext = resolve })
    const getContextUsage = vi.fn<Query['getContextUsage']>()
      .mockResolvedValueOnce(summary)
      .mockReturnValueOnce(second)
    const published = vi.fn()
    const { session, fake: started } = setup({ getContextUsage, onContextWindow: published })
    let finished = false
    const reading = collect(session.stream(step([user('m1', 'hello')], ['m1']))).then(chunks => {
      finished = true
      return chunks
    })
    const q = await started()
    await q.nextInput()
    await vi.waitFor(() => expect(published).toHaveBeenCalledWith('default', 200_000))
    q.emit({ ...result, modelUsage: { sonnet: { contextWindow: 1_000_000 } } })
    await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(2))
    expect(finished).toBe(false)
    endContext(summary)
    expect((await reading).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(published).toHaveBeenLastCalledWith('default', 200_000)
    expect(getContextUsage.mock.calls).toEqual([[{ detail: 'summary' }], [{ detail: 'summary' }]])
  })

  it('continues the reply and falls back to result capacity when context telemetry fails', async () => {
    const published = vi.fn()
    const warn = vi.fn()
    const { session, fake: started } = setup({
      getContextUsage: () => Promise.reject(new Error('unsupported control request')),
      onContextWindow: published,
      warn,
    })
    const reading = collect(session.stream(step([user('m1', 'hello')], ['m1'])))
    const q = await started()
    await q.nextInput()
    q.emit(...textReply('context-fallback', 'hello'))
    expect((await reading).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(published).toHaveBeenCalledWith('default', 200_000)
    expect(warn).toHaveBeenCalled()
  })

  it('mirrors a tool call, answers its permission request, and continues the turn', async () => {
    const { session, fake: started } = setup()
    const first = collect(session.stream(step([user('m1', 'list')], ['m1'])))
    const q = await started()
    await q.nextInput()
    q.emit(
      se({ type: 'message_start', message: { id: 'a1', usage: { input_tokens: 1 } } }),
      { type: 'assistant', parent_tool_use_id: null, session_id: 'claude-1', message: { id: 'a1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
      se({ type: 'message_stop' }),
    )
    const chunks = await first
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', id: 'tu1', name: 'claude_tool' }))

    const asked: (string | undefined)[] = []
    const ask: AskFn = (request) => {
      asked.push(request.callId)
      return Promise.resolve('allowed-once')
    }
    const waiting = session.waitForTool('tu1', ask, NEVER)
    const canUseTool: CanUseTool = q.start.canUseTool
    const decision = await canUseTool('Bash', { command: 'ls' }, { signal: NEVER, toolUseID: 'tu1' } as Parameters<CanUseTool>[2])
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(asked).toEqual(['tu1'])
    q.emit({ type: 'user', parent_tool_use_id: null, session_id: 'claude-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] } })
    expect(await waiting).toEqual({ text: 'a.txt', isError: false })

    // The continuation step carries no new user input.
    const second = collect(session.stream(step([user('m1', 'list'), { role: 'tool' } as unknown as RequestMessage], ['m1'])))
    q.emit(...textReply('a2', 'done'))
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(q.inputs).toHaveLength(1)
  })

  it('interrupts Claude when the DSH turn is abandoned', async () => {
    const { session, fake: started } = setup()
    const controller = new AbortController()
    const reading = collect(session.stream({ ...step([user('m1', 'go')], ['m1']), signal: controller.signal }))
    const q = await started()
    await q.nextInput()
    controller.abort()
    const chunks = await reading
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(q.interrupts).toBe(1)
    // The interrupted turn's late output is dropped; its result ends the cancel.
    q.emit(se({ type: 'message_start', message: { id: 'late' } }), result)
    const next = collect(session.stream(step([user('m1', 'go'), user('m2', 'again')], ['m2'])))
    await q.nextInput()
    q.emit(...textReply('a3', 'fresh'))
    const after = await next
    expect(after).toContainEqual({ type: 'text-delta', index: 0, text: 'fresh' })
  })

  it('approves ExitPlanMode through the mirror, leaves plan mode, then continues implementation', async () => {
    const { session, fake: started } = setup()
    const first = collect(session.stream(step([user('plan', 'implement')], ['plan'])))
    const q = await started()
    await q.nextInput()
    const input = { plan: 'Create the approved file', planFilePath: '/plan.md' }
    q.emit({ type: 'assistant', parent_tool_use_id: null, session_id: 'claude-1', message: {
      id: 'plan-response', content: [{ type: 'tool_use', id: 'exit-plan', name: 'ExitPlanMode', input }],
    } })
    expect((await first).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const ask = vi.fn<AskFn>(() => Promise.resolve('allowed-once'))
    const waiting = session.waitForTool('exit-plan', ask, NEVER)
    const decision = await q.start.canUseTool('ExitPlanMode', input, {
      signal: NEVER, toolUseID: 'exit-plan',
      // Unrelated suggestions must never be applied by an allow-once decision.
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }],
    } as Parameters<CanUseTool>[2])
    expect(ask).toHaveBeenCalledWith({
      callId: 'exit-plan', reason: 'Claude Code 请求退出计划模式并开始执行：\nCreate the approved file',
    }, NEVER)
    expect(decision).toEqual({
      behavior: 'allow', updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
    q.emit({ type: 'user', parent_tool_use_id: null, session_id: 'claude-1', message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'exit-plan', content: 'Plan approved' }],
    } })
    expect(await waiting).toEqual({ text: 'Plan approved', isError: false })
    const second = collect(session.stream(step([user('plan', 'implement')], ['plan'])))
    q.emit(...textReply('implemented', 'Implementation can proceed'))
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(q.inputs).toHaveLength(1)
    await session.dispose()
  })

  it('reports a failed turn as an error finish', async () => {
    const { session, fake: started } = setup()
    const request = step([user('m1', 'x')], ['m1'])
    const reading = collect(session.stream(request))
    const q = await started()
    await q.nextInput()
    q.emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], session_id: 'claude-1' })
    expect((await reading).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CLAUDE_ERROR_MAX_TURNS' } } })
    expect(session.sentMessageIds.has('m1')).toBe(true)
    expect((await collect(session.stream(request))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(q.inputs).toHaveLength(1)
    await session.dispose()
  })
})
