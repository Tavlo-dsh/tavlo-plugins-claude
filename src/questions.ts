/**
 * Claude's AskUserQuestion ↔ DSH's `ctx.userQuestions`. Claude asks through its
 * permission callback; the answer goes back as `updatedInput.answers`, keyed by
 * question text, which is how Claude Code's own UI returns it.
 * @module tavlo-plugins-claude/questions
 */

/** The fields of a DSH question this plugin sends. */
export interface DshQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** DSH's answer. */
export interface DshAnswer {
  answers: readonly { id: string; selected: readonly string[]; custom?: string }[]
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * Claude's input → DSH questions, ids `q0`, `q1`, ….
 * @returns undefined when the input has no usable question.
 */
export function toDshQuestions(input: Record<string, unknown>): DshQuestion[] | undefined {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : []
  const questions = raw.flatMap((item, index): DshQuestion[] => {
    const { question, header, options, multiSelect } = record(item)
    if (typeof question !== 'string' || question.length === 0) return []
    const choices = (Array.isArray(options) ? (options as unknown[]) : []).flatMap((option) => {
      const { label, description } = record(option)
      if (typeof label !== 'string' || label.length === 0) return []
      return [{ label, ...(typeof description === 'string' && description.length > 0 ? { description } : {}) }]
    })
    return [
      {
        id: `q${index}`,
        question,
        ...(typeof header === 'string' && header.length > 0 ? { header } : {}),
        ...(choices.length > 0 ? { options: choices } : {}),
        ...(multiSelect === true ? { multiSelect: true } : {}),
      },
    ]
  })
  return questions.length === 0 ? undefined : questions
}

/** DSH's answer → Claude's `answers` map. */
export function toClaudeAnswers(questions: readonly DshQuestion[], answer: DshAnswer): Record<string, string> {
  const byId = new Map(answer.answers.map((item) => [item.id, item]))
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const item = byId.get(question.id)
    if (item === undefined) continue
    const parts = [...item.selected, ...(item.custom !== undefined && item.custom.length > 0 ? [item.custom] : [])]
    if (parts.length > 0) answers[question.question] = parts.join(', ')
  }
  return answers
}
