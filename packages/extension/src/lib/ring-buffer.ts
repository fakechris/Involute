/**
 * A fixed-size buffer that keeps the newest entries (INV-1147): the context
 * recorder must never grow without bound on a page that logs in a loop.
 */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private dropped = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('RingBuffer capacity must be a positive integer.');
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  /** How many entries fell out because the buffer was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.items.length = 0;
    this.dropped = 0;
  }
}

/** Cut text to a limit, marking the cut. */
export function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
