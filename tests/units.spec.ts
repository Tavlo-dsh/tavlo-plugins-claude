import { describe, expect, it } from 'vitest'
import { mirrorArgs } from '../src/mirror-args.ts'
import { hasFullAccess, permissionReason, permissionResult } from '../src/permissions.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { toClaudeAnswers, toDshQuestions } from '../src/questions.ts'
import { fromModelInfo, ModelCatalog, parseModelCache } from '../src/models.ts'
import { StepBlocks } from '../src/stream-blocks.ts'
import { AsyncQueue } from '../src/async-queue.ts'

describe('mirrorArgs', () => {
  it('maps Bash to a command', () => {
    expect(mirrorArgs('Bash', { command: 'ls -la', description: 'List files' })).toMatchObject({
      tool: 'Bash',
      title: 'List files',
      kind: 'execute',
      command: 'ls -la',
    })
  })

  it('maps edits to diffs', () => {
    expect(mirrorArgs('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }).diffs).toEqual([
      { path: '/a.ts', oldText: 'x', newText: 'y' },
    ])
    expect(mirrorArgs('Write', { file_path: '/b.ts', content: 'z' }).diffs).toEqual([{ path: '/b.ts', oldText: null, newText: 'z' }])
    expect(
      mirrorArgs('MultiEdit', { file_path: '/c.ts', edits: [{ old_string: '1', new_string: '2' }, { bad: true }] }).diffs,
    ).toEqual([{ path: '/c.ts', oldText: '1', newText: '2' }])
  })

  it('names MCP tools by server and tool', () => {
    expect(mirrorArgs('mcp__github__create_issue', {}).title).toBe('github · create_issue')
  })
})

describe('permissions', () => {
  it('describes a command', () => {
    expect(permissionReason({ toolName: 'Bash', input: { command: 'rm x' }, decisionReason: undefined })).toBe('Bash: rm x')
  })

  it('maps outcomes', () => {
    expect(permissionResult('allowed-once', { a: 1 })).toEqual({ behavior: 'allow', updatedInput: { a: 1 } })
    expect(permissionResult('cancelled', {})).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(permissionResult('rejected', {}).behavior).toBe('deny')
  })

  it('leaves plan mode only after approval and adds no persistent permissions', () => {
    const input = { plan: 'Implement the approved feature' }
    expect(permissionResult('allowed-once', input, 'ExitPlanMode')).toEqual({
      behavior: 'allow', updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
    for (const outcome of ['rejected', 'unavailable', 'cancelled'] as const) {
      expect(permissionResult(outcome, input, 'ExitPlanMode')).toMatchObject({ behavior: 'deny' })
      expect(permissionResult(outcome, input, 'ExitPlanMode')).not.toHaveProperty('updatedPermissions')
    }
    expect(permissionResult('allowed-once', {}, 'Bash')).not.toHaveProperty('updatedPermissions')
  })

  it('grants only a selected full-access bundle, never a bare never policy or auto review', () => {
    const session = {} as Session
    let current = 'workspace-write'
    let spec = { sandbox: 'workspace-write', approval: 'ask' }
    const presets = { current: () => current, resolve: () => spec }
    expect(hasFullAccess(undefined, session)).toBe(false)
    expect(hasFullAccess(presets, session)).toBe(false)
    spec = { sandbox: 'workspace-write', approval: 'never' }
    expect(hasFullAccess(presets, session)).toBe(false)
    current = 'danger-full-access'
    spec = { sandbox: 'danger-full-access', approval: 'never' }
    expect(hasFullAccess(presets, session)).toBe(true)
    for (const value of ['auto', 'custom']) {
      current = value
      expect(hasFullAccess(presets, session)).toBe(false)
    }
  })
})

describe('questions', () => {
  it('round-trips AskUserQuestion', () => {
    const questions = toDshQuestions({
      questions: [
        { question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B' }], multiSelect: true },
        { question: '' },
      ],
    })
    expect(questions).toEqual([
      { id: 'q0', question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B' }], multiSelect: true },
    ])
    expect(toClaudeAnswers(questions ?? [], { answers: [{ id: 'q0', selected: ['A', 'B'], custom: 'C' }] })).toEqual({
      'Which?': 'A, B, C',
    })
  })

  it('returns undefined without questions', () => {
    expect(toDshQuestions({})).toBeUndefined()
  })
})

describe('models', () => {
  it('keeps default first and filters efforts', () => {
    const models = fromModelInfo([
      { value: 'opus', displayName: 'Opus', description: 'big', supportedEffortLevels: ['low', 'max'] },
    ])
    expect(models.map((model) => model.id)).toEqual(['default', 'opus'])
    expect(models[1]?.efforts).toEqual(['low', 'max'])
  })

  it('rejects malformed caches', () => {
    expect(parseModelCache('nope')).toBeUndefined()
    expect(parseModelCache(JSON.stringify({ version: 1, models: [{ id: '' , name: 'x'}] }))).toBeUndefined()
    expect(parseModelCache(JSON.stringify({ version: 1, models: [{ id: 'a', name: 'A' }] }))).toEqual([{ id: 'a', name: 'A' }])
  })
})

describe('StepBlocks', () => {
  it('opens a new block when the kind changes', () => {
    const blocks = new StepBlocks()
    const chunks = [...blocks.delta('reasoning', 'r'), ...blocks.delta('text', 't'), ...blocks.close()]
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end'])
  })
})

describe('AsyncQueue', () => {
  it('delivers undefined items and supports takeIf', async () => {
    const queue = new AsyncQueue<number | undefined>()
    queue.push(undefined)
    queue.push(2)
    expect(await queue.next(new AbortController().signal)).toBeUndefined()
    expect(queue.takeIf((item): item is number => item === 3)).toBeUndefined()
    expect(queue.takeIf((item): item is number => item === 2)).toBe(2)
  })
})
