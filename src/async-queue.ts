/**
 * A single-consumer queue whose reader can wait for the next item.
 * @module tavlo-plugins-claude/async-queue
 */

/** FIFO queue with an abortable `next()`. */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiter: ((item: T) => void) | undefined

  /** Add an item, handing it straight to a waiting reader if there is one. */
  push(item: T): void {
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter(item)
      return
    }
    this.items.push(item)
  }

  /** Drop everything still queued. */
  clear(): void {
    this.items = []
  }

  /** Whether an item is ready without waiting. */
  get size(): number {
    return this.items.length
  }

  /** Take the first item if it is already queued and matches. */
  takeIf<S extends T>(match: (item: T) => item is S): S | undefined {
    if (this.items.length === 0) return undefined
    const [first] = this.items as [T, ...T[]]
    if (!match(first)) return undefined
    this.items = this.items.slice(1)
    return first
  }

  /**
   * Take the next item, waiting for one if the queue is empty.
   * @param signal - rejects the wait when aborted.
   */
  next(signal: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const [first] = this.items.splice(0, 1) as [T]
      return Promise.resolve(first)
    }
    if (signal.aborted) return Promise.reject(abortReason(signal))
    if (this.waiter !== undefined) return Promise.reject(new Error('AsyncQueue supports one reader at a time'))
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiter = undefined
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiter = (item) => {
        signal.removeEventListener('abort', onAbort)
        resolve(item)
      }
    })
  }
}

/** The signal's reason as an Error, so callers can always rethrow it. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' ? reason : 'aborted')
  error.name = 'AbortError'
  return error
}
