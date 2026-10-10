// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { RECORDER_CAPACITY, RECORDER_KEY, installRecorder } from './recorder-core';

type TestWindow = Window & typeof globalThis;

function freshWindow(fetchImpl: typeof fetch): TestWindow {
  // A window-like object over jsdom's: own console, fetch and event target.
  const target = Object.create(window) as TestWindow;
  const listeners = new EventTarget();
  Object.assign(target, {
    console: { error: vi.fn(() => 'page-error-result'), warn: vi.fn(), log: vi.fn() },
    fetch: fetchImpl,
    addEventListener: listeners.addEventListener.bind(listeners),
    dispatchEvent: listeners.dispatchEvent.bind(listeners),
    XMLHttpRequest: undefined,
  });
  return target;
}

describe('installRecorder', () => {
  it('calls the page console first, passes its result through, and records errors and warnings', () => {
    const target = freshWindow(vi.fn());
    const originalError = target.console.error;
    const recorder = installRecorder(target);
    expect(target.console.error('boom', { id: 1 }, new Error('bad'))).toBe('page-error-result');
    target.console.warn('careful');
    expect(originalError).toHaveBeenCalledWith('boom', { id: 1 }, expect.any(Error));
    const { consoleErrors } = recorder.snapshot();
    expect(consoleErrors.map((entry) => entry.level)).toEqual(['error', 'warn']);
    expect(consoleErrors[0]!.message).toBe('boom {"id":1} Error: bad');
  });

  it('is bounded and truncates long messages', () => {
    const target = freshWindow(vi.fn());
    const recorder = installRecorder(target);
    for (let n = 0; n < RECORDER_CAPACITY + 25; n += 1) target.console.error(`e${n}`, 'x'.repeat(2000));
    const { consoleErrors } = recorder.snapshot();
    expect(consoleErrors).toHaveLength(RECORDER_CAPACITY);
    expect(consoleErrors[0]!.message.startsWith(`e25 `)).toBe(true);
    expect(consoleErrors.every((entry) => entry.message.length <= 500)).toBe(true);
  });

  it('records failed and rejected fetches without bodies or headers, and returns the page its own promise', async () => {
    const responses = [new Response('secret body', { status: 500 }), new Response('ok', { status: 200 })];
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new TypeError('Failed to fetch');
      return next;
    }) as unknown as typeof fetch;
    const target = freshWindow(fetchImpl);
    const recorder = installRecorder(target);
    const first = await target.fetch('https://api.example.com/a', { method: 'post', headers: { authorization: 'Bearer x' }, body: 'password=1' });
    expect(first.status).toBe(500);
    await target.fetch('https://api.example.com/b');
    await expect(target.fetch('https://api.example.com/c')).rejects.toThrow('Failed to fetch');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { failedRequests } = recorder.snapshot();
    expect(failedRequests.map(({ method, url, status }) => ({ method, url, status }))).toEqual([
      { method: 'POST', url: 'https://api.example.com/a', status: 500 },
      { method: 'GET', url: 'https://api.example.com/c', status: null },
    ]);
    const serialized = JSON.stringify(failedRequests);
    expect(serialized).not.toContain('secret body');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('password');
  });

  it('records uncaught errors and unhandled rejections', () => {
    const target = freshWindow(vi.fn());
    const recorder = installRecorder(target);
    target.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: x is undefined', filename: 'https://app/x.js', lineno: 3, colno: 9 }));
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('nope');
    target.dispatchEvent(rejection);
    expect(recorder.snapshot().consoleErrors.map((entry) => [entry.level, entry.message])).toEqual([
      ['uncaught', 'Uncaught TypeError: x is undefined (https://app/x.js:3:9)'],
      ['unhandledrejection', 'Error: nope'],
    ]);
  });

  it('never breaks the page when an argument cannot be described', () => {
    const target = freshWindow(vi.fn());
    const recorder = installRecorder(target);
    const hostile = { toJSON() { throw new Error('no'); }, toString() { throw new Error('no'); } };
    expect(() => target.console.error(hostile)).not.toThrow();
    expect(recorder.snapshot().consoleErrors).toHaveLength(1);
  });

  it('installs once and exposes the snapshot under its key', () => {
    const target = freshWindow(vi.fn());
    const first = installRecorder(target);
    expect(installRecorder(target)).toBe(first);
    expect((target as unknown as Record<string, unknown>)[RECORDER_KEY]).toBe(first);
  });
});
