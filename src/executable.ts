/**
 * Finds the Claude Code executable installed on this machine, so the SDK runs the
 * same `claude` (version, settings, login) the user runs in a terminal.
 * @module tavlo-plugins-claude/executable
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** A runnable Claude Code entry point. */
export interface ClaudeExecutable {
  /** Absolute path handed to the SDK as `pathToClaudeCodeExecutable`. */
  readonly path: string
  /** A native binary runs directly; a script needs Node. */
  readonly kind: 'native' | 'script'
  /** How it was found, for logs. */
  readonly source: 'config' | 'path' | 'well-known'
}

/** Inputs, injectable for tests. */
export interface LocateOptions {
  readonly configured?: string | undefined
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly home: string
}

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.cjs', '.mjs'])

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function classify(path: string, source: ClaudeExecutable['source']): ClaudeExecutable {
  const kind = SCRIPT_EXTENSIONS.has(extname(path).toLowerCase()) ? 'script' : 'native'
  return { path, kind, source }
}

/**
 * Read the program an npm / pnpm `.cmd` shim runs. Shims name it relative to their own
 * directory through `%dp0%` or `%~dp0`; the last quoted `.exe` or script path wins,
 * because the interpreter (`node.exe`) comes before the script it runs.
 */
export function shimTarget(shimPath: string, content: string): string | undefined {
  const dir = dirname(shimPath)
  const quoted = [...content.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
  const candidates = quoted
    .filter((text) => /%~?dp0%?/i.test(text))
    .map((text) => resolve(dir, text.replace(/%~?dp0%?\\?/gi, '')))
    .filter((path) => {
      const ext = extname(path).toLowerCase()
      return ext === '.exe' || SCRIPT_EXTENSIONS.has(ext)
    })
  return candidates.findLast((path) => isFile(path))
}

function windowsCandidates(dir: string, env: NodeJS.ProcessEnv): string[] {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
  return exts.map((ext) => join(dir, `claude${ext.toLowerCase()}`))
}

function resolveFound(path: string, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    const ext = extname(path).toLowerCase()
    if (ext === '.exe') return path
    if (ext === '.cmd' || ext === '.bat') return shimTarget(path, readFileSync(path, 'utf8'))
    return undefined
  }
  // npm links `claude` to the package's real entry; follow it so a script is recognised.
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function searchPath(options: LocateOptions): string | undefined {
  const pathValue = options.env.PATH ?? options.env.Path ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue
    const names = options.platform === 'win32' ? windowsCandidates(dir, options.env) : [join(dir, 'claude')]
    for (const name of names) {
      if (!isFile(name)) continue
      const target = resolveFound(name, options.platform)
      if (target !== undefined) return target
    }
  }
  return undefined
}

function wellKnown(options: LocateOptions): string | undefined {
  const exe = options.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [join(options.home, '.local', 'bin', exe), join(options.home, '.claude', 'local', exe)]
  return candidates.find((path) => isFile(path))
}

/**
 * Find the local Claude Code.
 * @returns the executable, or undefined to let the SDK use its bundled binary.
 * @throws when a configured path does not exist: silently running another Claude would hide the mistake.
 */
export function locateClaude(options: LocateOptions): ClaudeExecutable | undefined {
  const { configured } = options
  if (configured !== undefined && configured.length > 0) {
    const path = isAbsolute(configured) ? configured : resolve(configured)
    if (!existsSync(path)) throw new Error(`配置的 Claude Code 路径不存在：${path}`)
    const target = resolveFound(path, options.platform) ?? path
    return classify(target, 'config')
  }
  const onPath = searchPath(options)
  if (onPath !== undefined) return classify(onPath, 'path')
  const known = wellKnown(options)
  return known === undefined ? undefined : classify(known, 'well-known')
}

/** Locate with the real process environment. */
export function locateClaudeHere(configured?: string): ClaudeExecutable | undefined {
  return locateClaude({ configured, platform: process.platform, env: process.env, home: homedir() })
}
