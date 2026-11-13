import { describe, expect, it } from 'vitest'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AuxiliaryRouter } from '../src/auxiliary.ts'
import type { AuxiliaryLlm } from '../src/auxiliary.ts'

const chunk = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text })

const request: GenerateOptions = {
  provider: 'claude-code',
  model: 'cc-ds/deepseek-v4.1-flash[1m]',
  messages: [],
  reasoningEffort: ReasoningEffortId('xhigh'),
}

interface ProviderSpec {
  readonly id: string
  readonly models?: readonly { id: string; inputModalities?: readonly string[] }[]
  /** Simulates a provider whose model list cannot be read. */
  readonly broken?: boolean
}

interface Outcome {
  readonly chunks?: readonly StreamChunk[]
  readonly error?: Error
}

/** LLM runtime stand-in: records forwarded requests and answers from a fixed script. */
class FakeLlm implements AuxiliaryLlm {
  readonly calls: GenerateOptions[] = []
  constructor(
    private readonly providers: readonly ProviderSpec[],
    private readonly behavior: (options: GenerateOptions) => Outcome,
  ) {}

  listProviders(): readonly { id: string }[] {
    return this.providers.map(provider => ({ id: provider.id }))
  }

  async listModels(provider: string): Promise<readonly { id: string; inputModalities?: readonly string[] }[]> {
    const entry = this.providers.find(candidate => candidate.id === provider)
    if (entry?.broken === true) throw new Error(`cannot list ${provider}`)
    return entry?.models ?? []
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const outcome = this.behavior(options)
    return (async function* () {
      yield* (outcome.chunks ?? [])
      if (outcome.error !== undefined) throw outcome.error
    })()
  }
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const item of iterable) out.push(item)
  return out
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the router to reject')
}

describe('auxiliary routing', () => {
  it('uses the configured route and drops the Claude reasoning effort', async () => {
    const llm = new FakeLlm([{ id: 'clim', models: [{ id: 'gpt-5.6-luna' }] }], () => ({ chunks: [chunk('clim')] }))
    const router = new AuxiliaryRouter(
      llm,
      { enabled: true, routes: [{ provider: 'clim', model: 'gpt-5.6-luna' }], discovery: false },
      'claude-code',
    )
    expect(await collect(router.stream(request))).toEqual([chunk('clim')])
    expect(llm.calls).toHaveLength(1)
    const [call] = llm.calls
    expect(call).toMatchObject({ provider: 'clim', model: 'gpt-5.6-luna' })
    expect(call).not.toHaveProperty('reasoningEffort')
  })

  it('falls through to the next route when one fails before its first chunk', async () => {
    const llm = new FakeLlm([{ id: 'alive', models: [{ id: 'm' }] }], (options) =>
      options.provider === 'dead' ? { error: new Error('dead route') } : { chunks: [chunk('alive')] })
    const router = new AuxiliaryRouter(
      llm,
      { enabled: true, routes: [{ provider: 'dead', model: 'x' }], discovery: true },
      'claude-code',
    )
    expect(await collect(router.stream(request))).toEqual([chunk('alive')])
    expect(llm.calls.map(call => call.provider)).toEqual(['dead', 'alive'])
  })

  it('never discovers its own provider', async () => {
    const llm = new FakeLlm(
      [
        { id: 'claude-code', models: [{ id: 'sonnet' }] },
        { id: 'clim', models: [{ id: 'luna' }] },
      ],
      options => ({ chunks: [chunk(options.provider)] }),
    )
    const router = new AuxiliaryRouter(llm, { enabled: true, routes: [], discovery: true }, 'claude-code')
    expect(await collect(router.stream(request))).toEqual([chunk('clim')])
    expect(llm.calls.map(call => call.provider)).toEqual(['clim'])
  })

  it('skips providers whose model list cannot be read', async () => {
    const llm = new FakeLlm(
      [
        { id: 'broken', broken: true },
        { id: 'clim', models: [{ id: 'luna' }] },
      ],
      options => ({ chunks: [chunk(options.provider)] }),
    )
    const router = new AuxiliaryRouter(llm, { enabled: true, routes: [], discovery: true }, 'claude-code')
    expect(await collect(router.stream(request))).toEqual([chunk('clim')])
  })

  it('rejects a configured route that names its own provider', () => {
    const llm = new FakeLlm([], () => ({}))
    expect(() => new AuxiliaryRouter(
      llm,
      { enabled: true, routes: [{ provider: 'claude-code', model: 'sonnet' }], discovery: false },
      'claude-code',
    )).toThrow(/own provider/)
  })

  it('caches the route that answered for the next request', async () => {
    const llm = new FakeLlm(
      [
        { id: 'first', models: [{ id: 'm' }] },
        { id: 'second', models: [{ id: 'm' }] },
      ],
      options => ({ chunks: [chunk(options.provider)] }),
    )
    const router = new AuxiliaryRouter(llm, { enabled: true, routes: [], discovery: true }, 'claude-code')
    await collect(router.stream(request))
    await collect(router.stream(request))
    expect(llm.calls.map(call => call.provider)).toEqual(['first', 'first'])
  })

  it('keeps refusing when auxiliary routing is disabled', async () => {
    const llm = new FakeLlm([], () => ({ chunks: [chunk('x')] }))
    const router = new AuxiliaryRouter(llm, { enabled: false, routes: [], discovery: true }, 'claude-code')
    const error = await rejection(collect(router.stream(request)))
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_OPTION')
    expect(llm.calls).toHaveLength(0)
  })

  it('surfaces the last failure when no route answers', async () => {
    const llm = new FakeLlm([], options => ({ error: new Error(`failed ${options.provider}`) }))
    const router = new AuxiliaryRouter(
      llm,
      {
        enabled: true,
        routes: [{ provider: 'one', model: 'm' }, { provider: 'two', model: 'm' }],
        discovery: false,
      },
      'claude-code',
    )
    const error = await rejection(collect(router.stream(request)))
    expect((error as Error).message).toBe('failed two')
  })

  it('commits after the first chunk instead of replaying on another route', async () => {
    const llm = new FakeLlm(
      [
        { id: 'flaky', models: [{ id: 'm' }] },
        { id: 'healthy', models: [{ id: 'm' }] },
      ],
      options => options.provider === 'flaky'
        ? { chunks: [chunk('partial')], error: new Error('stream broke') }
        : { chunks: [chunk('healthy')] },
    )
    const router = new AuxiliaryRouter(llm, { enabled: true, routes: [], discovery: true }, 'claude-code')
    const seen: StreamChunk[] = []
    const error = await rejection((async () => {
      for await (const item of router.stream(request)) seen.push(item)
    })())
    expect(seen).toEqual([chunk('partial')])
    expect((error as Error).message).toBe('stream broke')
    expect(llm.calls.map(call => call.provider)).toEqual(['flaky'])
  })
})
