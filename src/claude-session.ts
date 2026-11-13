/**
 * One DSH session's Claude Code: a long-lived streaming-input `query()`, read one DSH
 * step at a time. A Claude turn spans several DSH steps; each top-level tool use ends a
 * step, and the mirror tool waits for its result before the next step reads on.
 * @module tavlo-plugins-claude/claude-session
 */

import type {
  CanUseTool,
  EffortLevel,
  McpSdkServerConfigWithInstance,
  ModelInfo,
  PermissionResult,
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { AsyncQueue, abortReason } from './async-queue.ts'
import { DEFAULT_MODEL_ID, MIRROR_TOOL_NAME } from './constants.ts'
import { DENY_CANCELLED, DENY_OUTSIDE_TURN, permissionReason, permissionResult } from './permissions.ts'
import type { PendingPermission } from './permissions.ts'
import { nativeReplayState, readNativeSession, unseenUserInput } from './request-input.ts'
import type { ImageRef, InputBlock, UserInput } from './request-input.ts'
import { SdkTranslator } from './sdk-events.ts'
import type { SessionEvent, ToolOutcome } from './sdk-events.ts'
import { StepBlocks } from './stream-blocks.ts'
import { mirrorArgs } from './mirror-args.ts'
import { isEffortLevel } from './models.ts'
import { isContextWindow, resultContextWindow } from './context-window.ts'

/** What a session asks DSH's approval card. */
export interface PermissionAsk {
  readonly reason: string
  /** Set when the request belongs to the mirrored call being waited on. */
  readonly callId?: string
}

/** Answers a permission request through DSH. */
export type AskFn = (request: PermissionAsk, signal: AbortSignal) => Promise<ApprovalOutcome>

/** Parameters for starting the SDK query. */
export interface QueryStart {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly resume: string | undefined
  readonly model: string | undefined
  readonly effort: EffortLevel | undefined
  readonly canUseTool: CanUseTool
  readonly abortController: AbortController
  readonly goalServer: McpSdkServerConfigWithInstance | undefined
}

/** Host facilities a session uses. */
export interface ClaudeSessionDeps {
  readonly dshSessionId: string
  readonly provider: string
  readonly sentMessageIds: ReadonlySet<string>
  readonly cancelGraceMs: number
  /** Settles once the process this session replaces has stopped. */
  readonly after: Promise<void>
  startQuery(start: QueryStart): Query
  createGoalServer(): McpSdkServerConfigWithInstance | undefined
  readImage(ref: ImageRef, signal: AbortSignal): Promise<Uint8Array>
  /** Learns the actual context capacity reported by Claude for this route. */
  onContextWindow(model: string, contextWindow: number): void
  onModels(models: readonly ModelInfo[]): void
  /** Answers questions Claude asks the user (AskUserQuestion); undefined when DSH cannot. */
  askQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, string> | undefined>
  warn(message: string): void
}

/** One DSH step's request. */
export interface StepRequest {
  readonly messages: readonly RequestMessage[]
  readonly signal: AbortSignal | undefined
  readonly model: string
  readonly reasoningEffort: string | undefined
  readonly currentTurnMessageIds: ReadonlySet<string>
}

type ReaderEvent = SessionEvent | { readonly type: 'failure'; readonly error: Error }
type ToolUseEvent = Extract<SessionEvent, { type: 'tool-use' }>

function isToolUse(event: ReaderEvent): event is ToolUseEvent {
  return event.type === 'tool-use'
}

/** Push-driven input stream for the SDK's streaming-input mode. */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue = new AsyncQueue<SDKUserMessage | undefined>()
  private readonly closer = new AbortController()

  push(message: SDKUserMessage): void {
    this.queue.push(message)
  }

  close(): void {
    this.queue.push(undefined)
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = await this.queue.next(this.closer.signal)
      if (next === undefined) return
      yield next
    }
  }
}

/** Resolves waiters whenever session state changes. */
class Changes {
  private waiters: (() => void)[] = []

  notify(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  next(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }
}

const NEVER = new AbortController().signal

function finishFor(result: SDKResultMessage): FinishReason {
  if (result.subtype === 'success' && !result.is_error) {
    return result.stop_reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' }
  }
  const detail = result.subtype === 'success' ? result.result : result.errors.join('\n')
  const message = detail.length > 0 ? detail : `Claude Code 回合失败（${result.subtype}）`
  return { kind: 'error', failure: { message, code: `CLAUDE_${result.subtype.toUpperCase()}` } }
}

function sumUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (a === undefined) return b
  const add = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const cacheRead = add(a.cacheReadTokens, b.cacheReadTokens)
  const cacheWrite = add(a.cacheWriteTokens, b.cacheWriteTokens)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

/** The live Claude Code behind one DSH session. */
export class ClaudeSession {
  private query: Query | undefined
  private contextRequest = 0
  private readonly input = new InputChannel()
  private readonly lifetime = new AbortController()
  private readonly translator = new SdkTranslator()
  private readonly events = new AsyncQueue<ReaderEvent>()
  private readonly changes = new Changes()
  private outcomes = new Map<string, ToolOutcome>()
  private permissions: PendingPermission[] = []
  private pending: UserInput[] = []
  private sent: Set<string>
  private claudeSessionId: string | undefined
  private appliedModel: string | undefined
  private appliedEffort: EffortLevel | undefined
  /** A prompt is with Claude and its `result` has not arrived. */
  private busy = false
  /** Settles when an interrupted turn's `result` arrives. */
  private cancelling: Promise<void> | undefined
  private endCancel: (() => void) | undefined
  private failure: Error | undefined
  private failureRead = false
  private pumpDone: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ClaudeSessionDeps) {
    this.sent = new Set(deps.sentMessageIds)
  }

  /** Ids of user messages already sent, carried over when the process is replaced. */
  get sentMessageIds(): ReadonlySet<string> {
    return this.sent
  }

  /** A dead session is kept until its failure has been shown, then replaced. */
  get replaceable(): boolean {
    return this.failure !== undefined && this.failureRead
  }

  /**
   * Run one DSH step.
   * @yields DSH stream chunks.
   */
  async *stream(request: StepRequest): AsyncGenerator<StreamChunk> {
    const signal = request.signal ?? NEVER
    try {
      signal.throwIfAborted()
      this.throwIfDead()
      if (this.query === undefined) await this.deps.after
      signal.throwIfAborted()
      this.ensureStarted(request)
      const input = unseenUserInput(request.messages, this.sent, request.currentTurnMessageIds)
      if (input.ids.length > 0 || input.blocks.length > 0) await this.submit(input, request, signal)
      signal.throwIfAborted()
      if (!this.busy && this.events.size === 0) {
        // Nothing to read: DSH re-ran a step after the turn already ended.
        yield { type: 'finish', reason: { kind: 'stop' }, ...this.replay() }
        return
      }
      yield* this.readStep(signal)
    } catch (error: unknown) {
      if (!signal.aborted) throw error
      // Preparation can be cancelled before readStep installs its abort listener.
      this.abandonTurn()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已停止', code: 'ABORTED' } } }
    }
  }

  /**
   * Body of the mirror tool: wait for Claude's result of one call, answering
   * permission requests through DSH meanwhile.
   */
  async waitForTool(callId: string, ask: AskFn, signal: AbortSignal): Promise<ToolOutcome> {
    const onAbort = (): void => this.abandonTurn()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        const outcome = this.outcomes.get(callId)
        if (outcome !== undefined) {
          this.outcomes.delete(callId)
          return outcome
        }
        if (this.failure !== undefined) throw this.failure
        const request = this.permissions.shift()
        if (request !== undefined) {
          request.resolve(await this.answer(request, callId, ask, signal))
          continue
        }
        if (!this.busy) throw new Error('Claude Code 的这一轮已结束，没有返回这次调用的结果。')
        await this.changes.next(signal)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Stop Claude's current turn: called when DSH's turn ends or its step is aborted.
   * No-op when Claude is idle.
   */
  abandonTurn(): void {
    this.pending = []
    this.events.clear()
    this.translator.reset()
    for (const request of this.permissions) request.resolve(DENY_CANCELLED)
    this.permissions = []
    if (!this.busy || this.cancelling !== undefined || this.query === undefined) {
      this.changes.notify()
      return
    }
    const query = this.query
    this.cancelling = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.die(new Error('Claude Code 停止回合超时，已结束进程。'))
        resolve()
      }, this.deps.cancelGraceMs)
      this.endCancel = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    query.interrupt().catch((error: unknown) => this.deps.warn(`interrupt failed: ${String(error)}`))
    this.changes.notify()
  }

  /** End the Claude process. */
  async dispose(reason?: string): Promise<void> {
    this.die(new LlmError(reason ?? 'Claude Code 会话已关闭。', 'CLAUDE_STOPPED'))
    this.input.close()
    this.query?.close()
    await this.pumpDone
  }

  private throwIfDead(): void {
    if (this.failure === undefined) return
    this.failureRead = true
    throw this.failure
  }

  private ensureStarted(request: StepRequest): void {
    if (this.query !== undefined) return
    const resume = readNativeSession(request.messages, this.deps.dshSessionId, this.deps.provider)
    const model = request.model === DEFAULT_MODEL_ID ? undefined : request.model
    this.appliedModel = request.model
    this.appliedEffort = isEffortLevel(request.reasoningEffort) ? request.reasoningEffort : undefined
    this.claudeSessionId = resume
    this.query = this.deps.startQuery({
      prompt: this.input,
      resume,
      model,
      effort: isEffortLevel(request.reasoningEffort) ? request.reasoningEffort : undefined,
      canUseTool: (toolName, input, options) =>
        this.requestPermission({
          toolUseId: options.toolUseID,
          toolName,
          input,
          suggestions: options.suggestions,
          decisionReason: options.decisionReason,
        }, options.signal),
      abortController: this.lifetime,
      goalServer: this.deps.createGoalServer(),
    })
    this.pumpDone = this.pump(this.query)
    void this.refreshContextWindow()
    this.query.supportedModels().then(
      (models) => this.deps.onModels(models),
      (error: unknown) => this.deps.warn(`could not list models: ${String(error)}`),
    )
  }

  private async pump(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        for (const item of this.translator.translate(message)) {
          switch (item.type) {
            case 'session':
              this.claudeSessionId = item.id
              break
            case 'tool-result':
              this.outcomes.set(item.id, item.outcome)
              break
            case 'turn-end':
              await this.onTurnEnd(item)
              break
            default:
              if (this.cancelling === undefined) this.events.push(item)
          }
        }
        this.changes.notify()
      }
      this.die(new LlmError('Claude Code 进程已退出。', 'CLAUDE_EXITED'))
    } catch (error: unknown) {
      const cause = error instanceof Error ? error : new Error(String(error))
      this.die(new LlmError(`Claude Code 出错：${cause.message}`, 'CLAUDE_FAILED', { cause }))
    }
  }

  private async refreshContextWindow(result?: SDKResultMessage): Promise<void> {
    const model = this.appliedModel
    const query = this.query
    if (model === undefined || query === undefined) return
    const request = ++this.contextRequest
    let contextWindow = resultContextWindow(result, model)
    try {
      if (typeof query.getContextUsage === 'function') {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const usage = await Promise.race([
            // Summary uses the last response and local estimates; no token-count API calls.
            query.getContextUsage({ detail: 'summary' }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('context metadata timed out')), 10_000)
              timer.unref()
            }),
          ])
          if (isContextWindow(usage.rawMaxTokens)) contextWindow = usage.rawMaxTokens
        } finally {
          clearTimeout(timer)
        }
      }
    } catch (error: unknown) {
      // This is optional telemetry. Older CLIs can still report capacity in result.
      if (!this.lifetime.signal.aborted) this.deps.warn(`could not read context capacity: ${String(error)}`)
    }
    if (request !== this.contextRequest || model !== this.appliedModel || this.lifetime.signal.aborted) return
    if (contextWindow !== undefined) {
      try {
        this.deps.onContextWindow(model, contextWindow)
      } catch (error: unknown) {
        this.deps.warn(`could not publish context capacity: ${String(error)}`)
      }
    }
  }

  private async onTurnEnd(event: Extract<SessionEvent, { type: 'turn-end' }>): Promise<void> {
    if (this.cancelling !== undefined) {
      this.busy = false
      this.cancelling = undefined
      this.endCancel?.()
      return
    }
    // request/context is turn-scoped. Finish the metadata refresh before DSH
    // can close this turn, rather than attempting a late append while idle.
    await this.refreshContextWindow(event.result)
    if (this.cancelling !== undefined) {
      this.busy = false
      this.cancelling = undefined
      this.endCancel?.()
      return
    }
    const next = this.pending.shift()
    if (next !== undefined) {
      // A message typed during the turn: send it now and keep the DSH turn going.
      void this.send(next, NEVER)
      return
    }
    this.busy = false
    this.events.push(event)
  }

  private die(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.busy = false
    this.endCancel?.()
    for (const request of this.permissions) request.resolve(DENY_CANCELLED)
    this.permissions = []
    this.events.push({ type: 'failure', error })
    this.lifetime.abort(error)
    this.changes.notify()
  }

  private async submit(input: UserInput, request: StepRequest, signal: AbortSignal): Promise<void> {
    // Reserve ids during preparation so another step cannot enqueue them twice.
    for (const id of input.ids) this.sent.add(id)
    try {
      // A turn being interrupted drops queued input, so wait for it to end first.
      await this.cancelling
      signal.throwIfAborted()
      this.throwIfDead()
      if (this.busy) {
        this.pending.push(input)
        return
      }
      await this.applySelection(request)
      await this.send(input, signal)
    } catch (error: unknown) {
      // Any preparation failure precedes submission, including a failed model
      // switch. Release only these ids so the user can retry the unsent input.
      for (const id of input.ids) this.sent.delete(id)
      throw error
    }
  }

  private async applySelection(request: StepRequest): Promise<void> {
    const query = this.query
    if (query === undefined) return
    if (request.model !== this.appliedModel) {
      try {
        await query.setModel(request.model === DEFAULT_MODEL_ID ? undefined : request.model)
        this.appliedModel = request.model
      } catch (error: unknown) {
        throw new LlmError(`切换 Claude 模型失败：${String(error)}`, 'CLAUDE_MODEL_FAILED', { cause: error })
      }
    }
    const effort = request.reasoningEffort
    if (isEffortLevel(effort) && effort !== this.appliedEffort) {
      try {
        await query.applyFlagSettings({ effortLevel: effort })
        this.appliedEffort = effort
      } catch (error: unknown) {
        // Keep Claude's own level rather than failing the message.
        this.deps.warn(`could not set effort ${request.reasoningEffort}: ${String(error)}`)
      }
    }
  }

  private async send(input: UserInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const content = await this.contentOf(input.blocks, signal)
    signal.throwIfAborted()
    this.throwIfDead()
    // busy means a native turn exists; attachment preparation is still cancellable.
    this.busy = true
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId ?? '',
    } as SDKUserMessage)
  }

  private async contentOf(blocks: readonly InputBlock[], signal: AbortSignal): Promise<unknown[]> {
    const content: unknown[] = []
    for (const block of blocks) {
      signal.throwIfAborted()
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
        continue
      }
      try {
        const data = await this.deps.readImage(block.ref, signal)
        signal.throwIfAborted()
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: block.ref.mediaType, data: Buffer.from(data).toString('base64') },
        })
      } catch (error: unknown) {
        if (signal.aborted) throw abortReason(signal)
        this.deps.warn(`could not read image ${block.ref.attachmentId}: ${String(error)}`)
        content.push({ type: 'text', text: '[图片读取失败，未发送]' })
      }
    }
    return content
  }

  private async *readStep(signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const blocks = new StepBlocks()
    let usage: TokenUsage | undefined
    const onAbort = (): void => this.abandonTurn()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        let event: ReaderEvent
        try {
          event = await this.events.next(signal)
        } catch (error: unknown) {
          if (!signal.aborted) throw error
          yield* blocks.close()
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已停止', code: 'ABORTED' } } }
          return
        }
        switch (event.type) {
          case 'text':
          case 'reasoning':
            yield* blocks.delta(event.type, event.text)
            break
          case 'usage':
            usage = sumUsage(usage, event.usage)
            break
          case 'tool-use': {
            // Tool uses of one API response arrive together: put them in one step.
            for (let use: ToolUseEvent | undefined = event; use !== undefined; use = this.events.takeIf(isToolUse)) {
              yield* blocks.toolCall({
                id: ToolCallId(use.id),
                name: MIRROR_TOOL_NAME,
                arguments: JSON.stringify(mirrorArgs(use.name, use.input)),
              })
            }
            if (usage !== undefined) yield { type: 'usage', usage }
            yield { type: 'finish', reason: { kind: 'tool-calls' }, ...this.replay() }
            return
          }
          case 'turn-end':
            yield* blocks.close()
            if (usage !== undefined) yield { type: 'usage', usage }
            yield { type: 'finish', reason: finishFor(event.result), ...this.replay() }
            return
          case 'failure':
            this.failureRead = true
            throw event.error
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private replay(): { replayState?: ReturnType<typeof nativeReplayState> } {
    const id = this.claudeSessionId
    return id === undefined || id.length === 0 ? {} : { replayState: nativeReplayState(id, this.deps.dshSessionId) }
  }

  private requestPermission(
    request: Omit<PendingPermission, 'resolve'>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (!this.busy || this.cancelling !== undefined) return Promise.resolve(DENY_OUTSIDE_TURN)
    return new Promise<PermissionResult>((resolve) => {
      const entry: PendingPermission = {
        ...request,
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
      }
      const onAbort = (): void => {
        this.permissions = this.permissions.filter((candidate) => candidate !== entry)
        resolve(DENY_CANCELLED)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.permissions.push(entry)
      this.changes.notify()
    })
  }

  private async answer(
    request: PendingPermission,
    callId: string,
    ask: AskFn,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (request.toolName === 'AskUserQuestion') {
      try {
        const answers = await this.deps.askQuestion(request.input, signal)
        return answers === undefined
          ? { behavior: 'deny', message: 'DSH 当前无法向用户展示这个问题，请在回复里直接提问。' }
          : { behavior: 'allow', updatedInput: { ...request.input, answers } }
      } catch (error: unknown) {
        if (signal.aborted) return DENY_CANCELLED
        this.deps.warn(`user question failed: ${String(error)}`)
        return { behavior: 'deny', message: '向用户提问失败，请在回复里直接提问。' }
      }
    }
    const mine = request.toolUseId === callId
    try {
      const outcome = await ask(
        { reason: permissionReason(request), ...(mine ? { callId } : {}) },
        signal,
      )
      return signal.aborted ? DENY_CANCELLED : permissionResult(outcome, request.input, request.toolName)
    } catch (error: unknown) {
      if (signal.aborted) return DENY_CANCELLED
      this.deps.warn(`approval failed: ${String(error)}`)
      return permissionResult('unavailable', request.input)
    }
  }
}
