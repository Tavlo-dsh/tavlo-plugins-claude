/**
 * Names shared by the adapter, the mirror tool and the session registry.
 * @module tavlo-plugins-claude/constants
 */

/** Provider route under which Claude Code appears in DSH's model menu. */
export const PROVIDER = 'claude-code'

/** Display name of the provider. */
export const PROVIDER_LABEL = 'Claude Code'

/** The record-only tool that mirrors Claude Code's own tool calls into DSH. */
export const MIRROR_TOOL_NAME = 'claude_tool'

/** Model id meaning "whatever Claude Code's own settings choose". */
export const DEFAULT_MODEL_ID = 'default'

/** Directory under the DSH home where this plugin keeps its files. */
export const PLUGIN_HOME = 'tavlo-claude'
