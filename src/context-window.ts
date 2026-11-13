/** Claude-owned context capacity and the DSH display snapshot. */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Session } from '@deepseek-ai/dsh-session'

export function isContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Older CLIs may lack getContextUsage. Never guess between several model totals. */
export function resultContextWindow(result: SDKResultMessage | undefined, model: string): number | undefined {
  if (result?.modelUsage === undefined || result.modelUsage === null) return undefined
  const entries = Object.entries(result.modelUsage)
  const selected = entries.find(([id]) => id === model)?.[1]
    ?? entries.find(([, usage]) => usage?.canonicalModel === model)?.[1]
    ?? (entries.length === 1 ? entries[0]?.[1] : undefined)
  return isContextWindow(selected?.contextWindow) ? selected.contextWindow : undefined
}

/** Publish newly learned capacity immediately, without changing the request header or transcript. */
export function publishContextWindow(
  session: Pick<Session, 'requestContext' | 'append'>,
  provider: string,
  model: string,
  contextWindow: number,
): void {
  if (!isContextWindow(contextWindow)) return
  const previous = session.requestContext()
  // A late SDK reply must not overwrite a route selected since that query ran.
  if (previous?.provider !== provider || previous.model !== model || previous.contextWindow === contextWindow) return
  session.append('request/context', { ...previous, contextWindow })
}
