/**
 * Presents Claude Code to DSH as a model provider: it appears in the model menu and the
 * DSH agent loop drives it step by step, while the real work happens inside Claude.
 * @module tavlo-plugins-claude/adapter
 */

import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AuxiliaryRouter } from './auxiliary.ts'
import type { ClaudeSession } from './claude-session.ts'
import { PROVIDER_LABEL } from './constants.ts'
import type { ModelCatalog } from './models.ts'

/**
 * DSH 0.2 has no per-provider external-compaction flag. Its compaction backend
 * calls resolveModel(), while the UI reads the prepared request's context.
 * Keep the existing host guard here; prepareCall() publishes only Claude's
 * reported capacity, so this guard never becomes the displayed denominator.
 */
const HOST_COMPACTION_GUARD = 1_000_000_000

/** A retry would resend a prompt Claude may already have acted on. */
const NO_RETRY: ResolvedRetryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'tavlo-plugins-claude')

/** What the adapter needs from the plugin. */
export interface AdapterDeps {
  readonly catalog: ModelCatalog
  /** Routes auxiliary requests Claude Code refuses to another provider. */
  readonly auxiliary: AuxiliaryRouter
  /** The live Claude session for a DSH session; throws when it cannot run. */
  resolveSession(sessionId: string): ClaudeSession
  /** Ids of the user messages in the session's open turn. */
  currentTurnMessageIds(sessionId: string): ReadonlySet<string>
}

/** Routes DSH model requests to Claude sessions. */
export class ClaudeAdapter extends LlmAdapter {
  constructor(private readonly deps: AdapterDeps) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_LABEL }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return NO_RETRY
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.deps.catalog.list())
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const reasoning = this.deps.catalog.reasoning(model)
    return Promise.resolve({
      provider,
      id: model,
      name: this.deps.catalog.name(model),
      inputModalities: ['text', 'image'],
      context: { contextWindow: HOST_COMPACTION_GUARD },
      ...(reasoning === undefined ? {} : { reasoning }),
    })
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const { context: _guard, ...info } = await this.resolveModel(provider, model)
    signal?.throwIfAborted()
    const contextWindow = this.deps.catalog.contextWindow(model)
    return {
      model: { ...info, ...(contextWindow === undefined ? {} : { context: { contextWindow } }) },
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Run one DSH step on the session's Claude. Auxiliary requests (titles, summaries)
   * expect a stateless model; sending one here would land in the user's real Claude
   * conversation, so the auxiliary router hands it to another provider instead.
   * @yields stream chunks.
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const { model, reasoningEffort, sessionId, messages, signal, purpose } = options
    if (purpose !== undefined) {
      yield* this.deps.auxiliary.stream(options)
      return
    }
    if (sessionId === undefined) {
      throw new LlmError('Claude Code 只能在会话里使用，不支持一次性模型请求。', 'UNSUPPORTED_OPTION')
    }
    const session = this.deps.resolveSession(sessionId)
    yield* session.stream({
      messages,
      signal,
      model,
      reasoningEffort,
      currentTurnMessageIds: this.deps.currentTurnMessageIds(sessionId),
    })
  }
}
