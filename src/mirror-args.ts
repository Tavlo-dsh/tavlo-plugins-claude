/**
 * What a mirrored Claude Code tool call records in DSH: enough to draw its card and
 * to read the session log later, without re-deriving anything from Claude's input.
 * @module tavlo-plugins-claude/mirror-args
 */

import type { FileDiff, ToolCallKind } from '@deepseek-ai/dsh-tools'

/** Arguments of the `claude_tool` mirror call. */
export interface MirrorArgs {
  /** Claude's tool name, e.g. `Bash`, `Edit`, `mcp__server__tool`. */
  readonly tool: string
  readonly title: string
  readonly kind: ToolCallKind
  /** The shell command, for Bash. */
  readonly command?: string
  /** File edits, for Edit / MultiEdit / Write. */
  readonly diffs?: readonly FileDiff[]
  /** The file or directory the call is about. */
  readonly path?: string
  /** Claude's raw input. */
  readonly input: unknown
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function editDiffs(path: string, edits: unknown): FileDiff[] {
  if (!Array.isArray(edits)) return []
  return edits.flatMap((edit: unknown) => {
    const { old_string: oldText, new_string: newText } = record(edit)
    return typeof oldText === 'string' && typeof newText === 'string' ? [{ path, oldText, newText }] : []
  })
}

/** Shorten long one-line titles such as prompts or commands. */
function clip(text: string, max = 120): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > max || line.length < text.length ? `${line.slice(0, max)}…` : line
}

function withPath(title: string, kind: ToolCallKind, path: string | undefined, input: unknown, tool: string): MirrorArgs {
  return { tool, title, kind, ...(path === undefined ? {} : { path }), input }
}

/**
 * Describe one Claude tool call.
 * @param tool - Claude's tool name.
 * @param raw - Claude's input for it.
 */
export function mirrorArgs(tool: string, raw: unknown): MirrorArgs {
  const input = record(raw)
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  switch (tool) {
    case 'Bash': {
      const command = str(input.command) ?? ''
      return { tool, title: str(input.description) ?? clip(command), kind: 'execute', command, input: raw }
    }
    case 'Edit': {
      const file = path ?? ''
      const diffs = editDiffs(file, [input])
      return { tool, title: `Edit ${file}`, kind: 'edit', diffs, path: file, input: raw }
    }
    case 'MultiEdit': {
      const file = path ?? ''
      return { tool, title: `Edit ${file}`, kind: 'edit', diffs: editDiffs(file, input.edits), path: file, input: raw }
    }
    case 'Write': {
      const file = path ?? ''
      const content = typeof input.content === 'string' ? input.content : ''
      return { tool, title: `Write ${file}`, kind: 'edit', diffs: [{ path: file, oldText: null, newText: content }], path: file, input: raw }
    }
    case 'NotebookEdit':
      return withPath(`Edit ${path ?? 'notebook'}`, 'edit', path, raw, tool)
    case 'Read':
      return withPath(`Read ${path ?? ''}`.trim(), 'read', path, raw, tool)
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern) ?? ''
      return withPath(`${tool} ${clip(pattern)}${path === undefined ? '' : ` in ${path}`}`, 'search', path, raw, tool)
    }
    case 'WebFetch':
      return withPath(`Fetch ${str(input.url) ?? ''}`.trim(), 'fetch', undefined, raw, tool)
    case 'WebSearch':
      return withPath(`Search ${clip(str(input.query) ?? '')}`.trim(), 'fetch', undefined, raw, tool)
    case 'Task':
    case 'Agent': {
      const kind = str(input.subagent_type)
      const description = str(input.description) ?? clip(str(input.prompt) ?? '')
      return withPath(kind === undefined ? description : `${kind}: ${description}`, 'other', undefined, raw, tool)
    }
    case 'TodoWrite':
      return withPath('Update todos', 'other', undefined, raw, tool)
    case 'ExitPlanMode':
      return withPath('Exit plan mode', 'other', undefined, raw, tool)
    case 'AskUserQuestion':
      return withPath('Ask user', 'other', undefined, raw, tool)
    default:
      return withPath(tool.startsWith('mcp__') ? tool.slice(5).replace('__', ' · ') : tool, 'other', path, raw, tool)
  }
}
