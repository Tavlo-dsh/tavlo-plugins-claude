/**
 * Turns Claude Code's output into DSH stream chunks. Pure apart from the small block
 * state each DSH step owns.
 * @module tavlo-plugins-claude/stream-blocks
 */

import type { StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'

type TextKind = 'text' | 'reasoning'

/** Block numbering and the open text/reasoning block of one DSH step. */
export class StepBlocks {
  private nextIndex = 0
  private open: { kind: TextKind; index: number; text: string } | undefined

  /** Whether anything was emitted in this step. */
  get started(): boolean {
    return this.nextIndex > 0
  }

  /** Append streamed text or reasoning, opening a block when the kind changes. */
  delta(kind: TextKind, text: string): StreamChunk[] {
    if (text.length === 0) return []
    const chunks: StreamChunk[] = []
    if (this.open?.kind !== kind) {
      chunks.push(...this.close())
      this.open = { kind, index: this.nextIndex++, text: '' }
      chunks.push({ type: 'block-start', index: this.open.index, blockType: kind })
    }
    this.open.text += text
    chunks.push(
      kind === 'text'
        ? { type: 'text-delta', index: this.open.index, text }
        : { type: 'reasoning-delta', index: this.open.index, text },
    )
    return chunks
  }

  /** End the open text/reasoning block, if any. */
  close(): StreamChunk[] {
    const open = this.open
    if (open === undefined) return []
    this.open = undefined
    return [{ type: 'block-end', index: open.index, block: { type: open.kind, text: open.text } }]
  }

  /** A complete tool-call block. */
  toolCall(block: Omit<ToolCallBlock, 'type'>): StreamChunk[] {
    const index = this.nextIndex++
    return [
      ...this.close(),
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments },
      { type: 'block-end', index, block: { type: 'tool-call', ...block } },
    ]
  }
}
