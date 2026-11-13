/**
 * The mirror tool. Claude Code runs its own tools; DSH can only show and log calls that
 * go through a registered tool, so each Claude call is recorded as a `claude_tool` call
 * whose body runs nothing and waits for Claude to report the result.
 * @module tavlo-plugins-claude/claude-tool
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type {
  FileDiff,
  ToolCallView,
  ToolDefinition,
  ToolResult,
  ToolResultView,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { MIRROR_TOOL_NAME } from './constants.ts'
import type { MirrorArgs } from './mirror-args.ts'
import type { ToolOutcome } from './sdk-events.ts'

/** What the tool needs from the plugin. */
export interface ClaudeToolDeps {
  waitForTool(exec: ToolRunContext): Promise<ToolOutcome>
}

const DIFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    oldText: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    newText: { type: 'string', required: true },
  },
} as const

function diffsOf(args: MirrorArgs): FileDiff[] {
  return (args.diffs ?? []).map((diff) => ({ ...diff }))
}

function presentCall(args: MirrorArgs): ToolCallView {
  if (args.command !== undefined) {
    return {
      card: 'terminal',
      title: args.command,
      ...(args.title === args.command ? {} : { description: args.title }),
    }
  }
  const locations = args.path === undefined ? undefined : [{ path: args.path }]
  const diffs = diffsOf(args)
  if (diffs.length > 0) return { card: 'diff', title: args.title, diffs, ...(locations === undefined ? {} : { locations }) }
  return {
    card: 'generic',
    title: args.title,
    kind: args.kind,
    rawInput: args.input,
    ...(locations === undefined ? {} : { locations }),
  }
}

function resultText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function presentResult(args: MirrorArgs, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  if (args.command !== undefined) return { card: 'terminal', output: resultText(result) }
  const diffs = diffsOf(args)
  return diffs.length > 0 ? { card: 'diff', diffs } : undefined
}

/** DSH aborts with a plain object, which would be logged as `[object Object]`. */
async function waitForOutcome(deps: ClaudeToolDeps, exec: ToolRunContext): Promise<ToolOutcome> {
  try {
    return await deps.waitForTool(exec)
  } catch (error: unknown) {
    if (!exec.signal.aborted) throw error
    const aborted = new HarnessError('tool call aborted', TOOL_ABORTED, { cause: error })
    aborted.name = 'AbortError'
    throw aborted
  }
}

/** Build the `claude_tool` definition. */
export function createClaudeTool(deps: ClaudeToolDeps): ToolDefinition {
  return defineTool({
    name: MIRROR_TOOL_NAME,
    description: 'Records a tool call made by Claude Code. It runs nothing itself.',
    parameters: {
      tool: { type: 'string', required: true, description: "Claude Code's tool name." },
      title: { type: 'string', required: true, description: 'What the call does.' },
      kind: { type: 'string', required: true, description: 'The tool kind.' },
      command: { type: 'string', description: 'The shell command, for Bash.' },
      diffs: { type: 'array', items: DIFF_SCHEMA },
      path: { type: 'string', description: 'The file the call is about.' },
      input: { type: 'json', description: "Claude Code's raw input." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const outcome = await waitForOutcome(deps, exec)
      if (outcome.isError) throw new Error(outcome.text.length > 0 ? outcome.text : 'Claude Code 报告这次调用失败。')
      return { text: outcome.text }
    },
    presentCall: (args) => presentCall(args as unknown as MirrorArgs),
    presentResult: (args, result) => presentResult(args as unknown as MirrorArgs, result),
  })
}
