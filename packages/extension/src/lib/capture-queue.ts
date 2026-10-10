/**
 * One queue for chrome.tabs.captureVisibleTab (INV-1147). Chrome allows two
 * captures per second per window and fails the third; every capture goes
 * through here, one at a time, spaced by at least `minGapMs`.
 */
export class CaptureQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly minGapMs = 550,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.last + this.minGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await job();
      } finally {
        this.last = this.now();
      }
    });
    // A failed capture must not stop the next one.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
