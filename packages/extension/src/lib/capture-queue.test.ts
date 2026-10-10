import { describe, expect, it } from 'vitest';

import { CaptureQueue } from './capture-queue';

describe('CaptureQueue', () => {
  it('runs one capture at a time, spaced by the minimum gap, and survives a failure', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const queue = new CaptureQueue(550, () => clock, async (ms) => {
      sleeps.push(ms);
      clock += ms;
    });
    const order: string[] = [];
    let running = 0;
    const job = (name: string, fails = false) => queue.run(async () => {
      running += 1;
      expect(running).toBe(1);
      order.push(`${name}@${clock}`);
      clock += 10;
      running -= 1;
      if (fails) throw new Error(`${name} failed`);
      return name;
    });
    const results = await Promise.allSettled([job('a'), job('b', true), job('c')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(order).toEqual(['a@0', 'b@560', 'c@1120']);
    expect(sleeps).toEqual([550, 550]);
  });
});
