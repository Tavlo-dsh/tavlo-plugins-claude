import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ClaudeAdapter } from '../src/adapter.ts'
import { AuxiliaryRouter } from '../src/auxiliary.ts'
import { ModelCatalog } from '../src/models.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'session-title': true
  }
}

/** A second provider the auxiliary router is expected to reach. */
class StubAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'stub' }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: `${options.provider}/${options.model}` }
    })()
  }
}

describe('auxiliary routing through the real LLM runtime', () => {
  const contexts: Context[] = []
  afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

  it('forwards a title request from the Claude route to another provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)

    const stub = new StubAdapter()
    ctx.llm.registerAdapter(['stub'], stub)
    const catalog = new ModelCatalog('claude-code', 'unused-auxiliary-test-cache', () => undefined, () => undefined)
    ctx.llm.registerAdapter(['claude-code'], new ClaudeAdapter({
      catalog,
      auxiliary: new AuxiliaryRouter(
        ctx.llm,
        { enabled: true, routes: [{ provider: 'stub', model: 'small' }], discovery: false },
        'claude-code',
      ),
      resolveSession: () => { throw new Error('auxiliary requests must not start a Claude process') },
      currentTurnMessageIds: () => new Set(),
    }))

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-code',
      model: 'cc-ds/deepseek-v4.1-flash[1m]',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Name this conversation' }] }],
      purpose: 'session-title',
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'stub/small' }])
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ provider: 'stub', model: 'small', purpose: 'session-title' })
  })
})
