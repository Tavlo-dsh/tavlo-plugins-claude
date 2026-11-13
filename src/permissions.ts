/**
 * Claude Code permission requests, answered through DSH's approval card.
 * @module tavlo-plugins-claude/permissions
 */

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'

/** The permission-preset service, read live so an in-turn selection takes effect. */
export interface PermissionPresets {
  current(session: Session): string
  resolve(name: string): { sandbox: string; approval: string }
}

/** `never` alone means deny prompts; only an explicit full-access bundle grants them. */
export function hasFullAccess(presets: PermissionPresets | undefined, session: Session): boolean {
  if (presets === undefined) return false
  const current = presets.current(session)
  // Auto review has its own decision maker; custom settings carry no preset grant.
  if (current === 'auto' || current === 'custom') return false
  const spec = presets.resolve(current)
  return spec.sandbox === 'danger-full-access' && spec.approval === 'never'
}

/** One `canUseTool` call waiting for an answer. */
export interface PendingPermission {
  readonly toolUseId: string | undefined
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly suggestions: readonly PermissionUpdate[] | undefined
  readonly decisionReason: string | undefined
  readonly resolve: (result: PermissionResult) => void
}

const PREVIEW_LINES = 20

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function preview(text: string): string {
  const lines = text.split('\n')
  return lines.length <= PREVIEW_LINES ? text : `${lines.slice(0, PREVIEW_LINES).join('\n')}\n…`
}

/** What the approval card says about a request. */
export function permissionReason(request: Pick<PendingPermission, 'toolName' | 'input' | 'decisionReason'>): string {
  const { toolName, input, decisionReason } = request
  const parts: string[] = []
  const command = str(input.command)
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  if (toolName === 'ExitPlanMode') {
    parts.push('Claude Code 请求退出计划模式并开始执行：', preview(str(input.plan) ?? ''))
  } else if (command !== undefined) {
    parts.push(`${toolName}: ${command}`)
    const description = str(input.description)
    if (description !== undefined) parts.push(description)
  } else if (path !== undefined) {
    parts.push(`${toolName}: ${path}`)
    const body = str(input.new_string) ?? str(input.content)
    if (body !== undefined) parts.push(preview(body))
  } else {
    const url = str(input.url) ?? str(input.query)
    parts.push(url === undefined ? toolName : `${toolName}: ${url}`)
  }
  if (decisionReason !== undefined) parts.push(`（${decisionReason}）`)
  return parts.join('\n')
}

/**
 * Map DSH's answer onto the SDK's. Approving ExitPlanMode also leaves Claude's
 * read-only mode. Other calls add no rules; a broken approval service fails closed.
 */
export function permissionResult(
  outcome: ApprovalOutcome,
  input: Record<string, unknown>,
  toolName?: string,
): PermissionResult {
  switch (outcome) {
    case 'allowed-once':
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(toolName === 'ExitPlanMode'
          ? { updatedPermissions: [{ type: 'setMode' as const, mode: 'default' as const, destination: 'session' as const }] }
          : {}),
      }
    case 'rejected':
      return { behavior: 'deny', message: 'DSH 未允许这次操作。' }
    case 'cancelled':
      return { behavior: 'deny', message: '用户取消了这次操作。', interrupt: true }
    case 'unavailable':
      return { behavior: 'deny', message: 'DSH 当前无法弹出审批，已拒绝这次操作。' }
  }
}

/** Answer used when no turn is open to ask in. */
export const DENY_OUTSIDE_TURN: PermissionResult = {
  behavior: 'deny',
  message: '当前没有进行中的 DSH 回合，无法审批这次操作。',
}

/** Answer used when the turn is cancelled while a request waits. */
export const DENY_CANCELLED: PermissionResult = {
  behavior: 'deny',
  message: '回合已停止。',
  interrupt: true,
}
