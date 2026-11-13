/**
 * Runs Claude Code under DSH's subprocess owner instead of the SDK's own spawn, so the
 * process is tracked and stopped with the rest of DSH's children. Modelled on DSH's
 * `subagent-claude-code` process adapter.
 * @module tavlo-plugins-claude/spawn
 */

import { EventEmitter } from 'node:events'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Lines of stderr kept for error messages. */
const STDERR_TAIL_LINES = 40

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
type ErrorListener = (error: Error) => void

/**
 * Encode the SDK's complete child environment as a subprocess overlay: explicit values,
 * plus tombstones for inherited names the SDK chose to drop.
 */
export function sdkEnvironmentOverlay(env: SpawnOptions['env']): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

/** Translate one SDK spawn request to DSH's subprocess spec. */
export function claudeSpawnSpec(options: SpawnOptions, graceMs: number): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('tavlo-plugins-claude: SDK spawn request omitted its working directory')
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env),
  }
}

/** Keeps the last lines of a stream. */
export class TailBuffer {
  private lines: string[] = []
  private partial = ''

  constructor(private readonly max = STDERR_TAIL_LINES) {}

  push(chunk: string): string[] {
    const parts = (this.partial + chunk).split(/\r?\n/)
    this.partial = parts.pop() ?? ''
    this.lines = [...this.lines, ...parts].slice(-this.max)
    return parts
  }

  text(): string {
    return [...this.lines, ...(this.partial.length > 0 ? [this.partial] : [])].join('\n')
  }
}

/** The SDK's view of one DSH-managed process. */
export class ManagedClaudeProcess implements SpawnedProcess {
  readonly stdin
  readonly stdout
  readonly stderrTail = new TailBuffer()
  private readonly events = new EventEmitter()
  private outcomeValue: SubprocessOutcome | undefined
  private killRequested = false

  constructor(
    private readonly child: SubprocessHandle,
    onStderrLine?: (line: string) => void,
  ) {
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('tavlo-plugins-claude: Claude Code was started without piped stdio')
    }
    this.stdin = child.stdin
    this.stdout = child.stdout
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of this.stderrTail.push(chunk)) if (line.length > 0) onStderrLine?.(line)
    })
    // `error` throws without a listener; the SDK adds its own right after spawn returns.
    this.events.on('error', () => {})
    void child.done.then(
      (outcome) => {
        this.outcomeValue = outcome
        this.events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        this.events.emit('error', error instanceof Error ? error : new Error(String(error)))
      },
    )
  }

  get killed(): boolean {
    return this.killRequested
  }

  get exitCode(): number | null {
    return this.outcomeValue?.exitCode ?? null
  }

  get signalCode(): NodeJS.Signals | null {
    return this.outcomeValue?.signal ?? null
  }

  /** DSH owns the escalation ladder, so the SDK's chosen signal is not used. */
  kill(_signal: NodeJS.Signals): boolean {
    if (this.killRequested || this.outcomeValue !== undefined) return false
    this.killRequested = true
    this.child.terminate()
    return true
  }

  on(event: 'exit', listener: ExitListener): void
  on(event: 'error', listener: ErrorListener): void
  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.on(event, listener)
  }

  once(event: 'exit', listener: ExitListener): void
  once(event: 'error', listener: ErrorListener): void
  once(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.once(event, listener)
  }

  off(event: 'exit', listener: ExitListener): void
  off(event: 'error', listener: ErrorListener): void
  off(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.off(event, listener)
  }
}
