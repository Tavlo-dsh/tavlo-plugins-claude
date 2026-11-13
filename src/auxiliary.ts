/**
 * Routes auxiliary model requests (titles, summaries) away from Claude Code.
 *
 * Claude Code refuses those requests on purpose: they expect a stateless model,
 * and running them through the user's real Claude conversation would pollute it.
 * This router hands the same request to another registered DSH provider instead:
 * configured routes first, then automatic discovery, with one cached winner.
 * @module tavlo-plugins-claude/auxiliary
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One provider/model pair an auxiliary request may use. */
export interface AuxiliaryRoute {
  /** Registered DSH provider route, for example `deepseek-official` or `clim`. */
  readonly provider: string
  /** Model id that provider serves, for example `deepseek-flash`. */
  readonly model: string
}

/** Plugin configuration for auxiliary request routing. */
export interface AuxiliaryConfig {
  /** `false` restores Claude Code's refusal of auxiliary requests. */
  enabled: boolean
  /** Explicit routes tried before automatic discovery, in order. */
  routes: AuxiliaryRoute[]
  /** Try the other registered providers when the explicit routes do not answer. */
  discovery: boolean
}

/** The slice of the DSH LLM runtime this router reads. */
export interface AuxiliaryLlm {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly { id: string; inputModalities?: readonly string[] }[]>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** How long a failed route stays out of rotation before it is retried. */
const FAILURE_TTL_MS = 60_000

/** One route's opening attempt: either a started stream or the failure before any output. */
type Attempt =
  | { readonly ok: true; readonly iterator: AsyncIterator<StreamChunk>; readonly first: IteratorResult<StreamChunk> }
  | { readonly ok: false; readonly error: unknown }

/** Stable identity for one route, used to deduplicate and to remember failures. */
function routeKey(route: AuxiliaryRoute): string {
  return `${route.provider}\u0000${route.model}`
}

/** The refusal Claude Code used before auxiliary routing existed. */
function refusal(purpose: string | undefined): LlmError {
  return new LlmError(`Claude Code 不处理辅助模型请求（${String(purpose)}）。`, 'UNSUPPORTED_OPTION')
}

/** Resolves one auxiliary request onto the first provider route that answers. */
export class AuxiliaryRouter {
  private cached: AuxiliaryRoute | undefined
  private readonly failures = new Map<string, number>()

  /**
   * @param llm - DSH LLM runtime used to discover routes and forward the call.
   * @param config - plugin configuration for auxiliary routing.
   * @param ownProvider - this plugin's provider route; never a candidate.
   * @throws when an explicit route names this plugin's own provider.
   */
  constructor(
    private readonly llm: AuxiliaryLlm,
    private readonly config: AuxiliaryConfig,
    private readonly ownProvider: string,
  ) {
    for (const route of config.routes) {
      if (route.provider.length === 0 || route.model.length === 0) {
        throw new Error('auxiliary routes need a non-empty provider and model')
      }
      if (route.provider === ownProvider) {
        throw new Error(
          `auxiliary route "${route.provider}/${route.model}" names this plugin's own provider;`
          + ' auxiliary requests cannot run on Claude Code',
        )
      }
    }
  }

  /** Forget the cached route and failure memory after the provider registry changes. */
  reset(): void {
    this.cached = undefined
    this.failures.clear()
  }

  /**
   * Stream one auxiliary request through the first route that produces output.
   *
   * A route that fails before its first chunk falls through to the next one; once
   * a chunk has been yielded the request is committed, because a partially
   * delivered stream cannot be replayed. The winning route is cached until the
   * provider registry changes or it fails.
   * @param options - the original auxiliary request from the title/summary caller.
   * @yields the chosen route's stream chunks unchanged.
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (!this.config.enabled) throw refusal(options.purpose)
    const tried = new Set<string>()
    let lastError: unknown
    const cached = this.cached
    if (cached !== undefined && this.available(cached)) {
      tried.add(routeKey(cached))
      const attempt = await this.attempt(cached, options)
      if (attempt.ok) {
        this.failures.delete(routeKey(cached))
        yield* this.drain(attempt.iterator, attempt.first)
        return
      }
      if (options.signal?.aborted === true) throw attempt.error
      this.failures.set(routeKey(cached), Date.now() + FAILURE_TTL_MS)
      this.cached = undefined
      lastError = attempt.error
    }
    for (const route of await this.candidates()) {
      const key = routeKey(route)
      if (tried.has(key)) continue
      tried.add(key)
      if (!this.available(route)) continue
      options.signal?.throwIfAborted()
      const attempt = await this.attempt(route, options)
      if (!attempt.ok) {
        if (options.signal?.aborted === true) throw attempt.error
        this.failures.set(key, Date.now() + FAILURE_TTL_MS)
        lastError = attempt.error
        continue
      }
      // A route that produced its first chunk is committed: replaying the
      // request elsewhere would duplicate already-delivered output.
      this.cached = route
      this.failures.delete(key)
      yield* this.drain(attempt.iterator, attempt.first)
      return
    }
    if (lastError !== undefined) throw lastError
    throw new LlmError(
      '没有可用于辅助请求的模型路由。请在 tavlo-claude 的 auxiliary.routes 里配置一条，或启用其他模型供应商。',
      'NO_ADAPTER',
    )
  }

  /** Whether a route has not failed within the retry window. */
  private available(route: AuxiliaryRoute): boolean {
    const failedAt = this.failures.get(routeKey(route))
    return failedAt === undefined || failedAt <= Date.now()
  }

  /** Open one route; a failure here means nothing has been delivered yet. */
  private async attempt(route: AuxiliaryRoute, options: GenerateOptions): Promise<Attempt> {
    let iterator: AsyncIterator<StreamChunk> | undefined
    try {
      iterator = this.open(route, options)
      return { ok: true, iterator, first: await iterator.next() }
    } catch (error) {
      await iterator?.return?.(undefined).catch(() => undefined)
      return { ok: false, error }
    }
  }

  /** Yield a committed stream to the caller and always close it. */
  private async *drain(
    iterator: AsyncIterator<StreamChunk>,
    first: IteratorResult<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    try {
      if (first.done === true) return
      yield first.value
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        yield next.value
      }
    } finally {
      await iterator.return?.(undefined)
    }
  }

  /**
   * Dispatch one route without dropping the caller's request metadata.
   * Reasoning effort is dropped because it was chosen for the Claude route and
   * may exceed what the auxiliary model supports.
   */
  private open(route: AuxiliaryRoute, options: GenerateOptions): AsyncIterator<StreamChunk> {
    const { reasoningEffort: _effort, ...rest } = options
    const forwarded: GenerateOptions = {
      ...rest,
      provider: route.provider,
      model: route.model,
    }
    return this.llm.stream(forwarded)[Symbol.asyncIterator]()
  }

  /** Cached route, explicit routes, then the first text model of every other provider. */
  private async candidates(): Promise<AuxiliaryRoute[]> {
    const out: AuxiliaryRoute[] = []
    if (this.cached !== undefined) out.push(this.cached)
    for (const route of this.config.routes) out.push(route)
    if (!this.config.discovery) return out
    for (const provider of this.llm.listProviders()) {
      if (provider.id === this.ownProvider) continue
      if (out.some(route => route.provider === provider.id)) continue
      let models: readonly { id: string; inputModalities?: readonly string[] }[]
      try {
        models = await this.llm.listModels(provider.id)
      } catch {
        continue
      }
      const model = models.find(candidate =>
        candidate.inputModalities === undefined || candidate.inputModalities.includes('text'))
      if (model !== undefined) out.push({ provider: provider.id, model: model.id })
    }
    return out
  }
}
