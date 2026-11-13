/**
 * Reads what Claude Code still needs from a DSH model request. Claude keeps its own
 * conversation, so only new user input and the native session id matter here.
 * Selection rules follow dsh-ccgui, which proved them against DSH's turn model.
 * @module tavlo-plugins-claude/request-input
 */

import type { ReplayEnvelope, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Reference to an image in DSH's attachment store. */
export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  /** Exact encoded byte length, required by the attachment store for integrity checks. */
  readonly bytes: number
  /** Intrinsic image width in pixels. */
  readonly width: number
  /** Intrinsic image height in pixels. */
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

/** One block of user input, before images are read. */
export type InputBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly ref: ImageRef }

/** User input Claude has not received yet. */
export interface UserInput {
  readonly ids: readonly string[]
  readonly blocks: readonly InputBlock[]
}

/**
 * Sources written by a person. DSH also uses the user role for reminders meant for
 * its own model; forwarded, they would start Claude turns nobody asked for.
 */
const FORWARDED_KINDS: ReadonlySet<string> = new Set(['user', 'schedule'])

/** DSH's note about a schedule edit: same source kind as a real reminder, needs no action. */
const SCHEDULE_NOTICE_PREFIX = '[SCHEDULE CHANGE]'

function messagesAfterLastReply(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  const lastReply = messages.findLastIndex((message) => message.role === 'assistant' || message.role === 'tool')
  return messages.slice(lastReply + 1)
}

function imageRefOf(attachment: unknown): ImageRef | undefined {
  if (typeof attachment !== 'object' || attachment === null) return undefined
  const { attachmentId, mediaType, bytes, width, height } = attachment as Record<string, unknown>
  if (
    typeof attachmentId !== 'string' ||
    typeof mediaType !== 'string' ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 0 ||
    !Number.isSafeInteger(width) ||
    (width as number) <= 0 ||
    !Number.isSafeInteger(height) ||
    (height as number) <= 0
  ) {
    return undefined
  }
  // Keep the host-created reference object intact. The attachment service verifies
  // every metadata field against the stored bytes, so rebuilding it from only the
  // id and media type makes an otherwise valid image fail as corrupt.
  return attachment as ImageRef
}

function inputBlocks(message: RequestMessage): InputBlock[] {
  return message.content.flatMap((block): InputBlock[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') {
      const ref = imageRefOf(block.attachment)
      return ref === undefined ? [] : [{ type: 'image', ref }]
    }
    return []
  })
}

function isScheduleNotice(message: RequestMessage): boolean {
  const [first] = message.content
  return first?.type === 'text' && first.text.startsWith(SCHEDULE_NOTICE_PREFIX)
}

function isForwarded(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  // Producers extend this union; compare it as a plain string.
  const kind: string | undefined = message.source?.kind
  if (kind === 'schedule' && isScheduleNotice(message)) return false
  if (kind === 'goal') {
    const source = message.source as { goalId?: unknown; revision?: unknown; round?: unknown }
    return typeof source.goalId === 'string'
      && source.goalId.trim().length > 0 && source.goalId === source.goalId.trim()
      && message.id !== undefined
      && Number.isSafeInteger(source.revision) && (source.revision as number) > 0
      && Number.isSafeInteger(source.round) && (source.round as number) > 0
  }
  return kind === undefined || FORWARDED_KINDS.has(kind)
}

/**
 * Collect the user input still owed to Claude: messages after the last assistant or
 * tool message, from the current turn, not sent yet. A tail ending in a tool result
 * yields nothing, which is how a continuation step is told apart from a new prompt.
 * @param messages - the derived request history.
 * @param seen - ids already sent.
 * @param currentTurn - ids of the user messages in the open DSH turn.
 */
export function unseenUserInput(
  messages: readonly RequestMessage[],
  seen: ReadonlySet<string>,
  currentTurn: ReadonlySet<string>,
): UserInput {
  const fresh = messagesAfterLastReply(messages).filter(
    (message) =>
      isForwarded(message) && (message.id === undefined || (!seen.has(message.id) && currentTurn.has(message.id))),
  )
  return {
    ids: fresh.flatMap((message) => (message.id === undefined ? [] : [message.id])),
    blocks: fresh.flatMap(inputBlocks),
  }
}

/** What `finish.replayState` carries. */
interface NativeSession {
  readonly claudeSessionId: string
  readonly dshSessionId: string
}

/** Envelope tying a DSH session to its Claude Code session. */
export function nativeReplayState(claudeSessionId: string, dshSessionId: string): ReplayEnvelope {
  const response: NativeSession = { claudeSessionId, dshSessionId }
  return { response }
}

function parseNative(replayState: unknown): NativeSession | undefined {
  if (typeof replayState !== 'object' || replayState === null) return undefined
  const { response } = replayState as { response?: unknown }
  if (typeof response !== 'object' || response === null) return undefined
  const { claudeSessionId, dshSessionId } = response as Record<string, unknown>
  return typeof claudeSessionId === 'string' && typeof dshSessionId === 'string'
    ? { claudeSessionId, dshSessionId }
    : undefined
}

/**
 * Find the Claude session to resume, from the latest assistant message. The owner check
 * keeps a fork (which inherits its parent's messages under a new id) from writing into
 * the parent's Claude session; the provider check skips other routes' replay state.
 */
export function readNativeSession(
  messages: readonly RequestMessage[],
  dshSessionId: string,
  provider: string,
): string | undefined {
  const latest = messages.findLast((message) => message.role === 'assistant')
  if (latest === undefined || latest.role !== 'assistant') return undefined
  const source: unknown = latest.source
  if (typeof source !== 'object' || source === null) return undefined
  const { provider: owner, replayState } = source as { provider?: unknown; replayState?: unknown }
  if (owner !== provider) return undefined
  const native = parseNative(replayState)
  return native?.dshSessionId === dshSessionId ? native.claudeSessionId : undefined
}

/** Whether the history holds replies this provider gave without a Claude session to resume. */
export function hasOrphanReplies(messages: readonly RequestMessage[], provider: string): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant') return false
    const source: unknown = message.source
    return typeof source === 'object' && source !== null && (source as { provider?: unknown }).provider === provider
  })
}
