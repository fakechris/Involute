import { RingBuffer, truncate } from './ring-buffer';
import type { ConsoleEntry, FailedRequest, RecorderSnapshot } from './types';

export const RECORDER_KEY = '__involuteCaptureRecorder';
export const RECORDER_CAPACITY = 50;
const MESSAGE_LIMIT = 500;
const URL_LIMIT = 2000;

/** One console argument as text: never more than the message limit, never throws. */
export function describe(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value === undefined) return 'undefined';
    if (typeof value === 'object' && value !== null) {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    }
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function message(args: readonly unknown[]): string {
  let text = '';
  for (const arg of args) {
    if (text.length >= MESSAGE_LIMIT) break;
    text += (text ? ' ' : '') + truncate(describe(arg), MESSAGE_LIMIT);
  }
  return truncate(text, MESSAGE_LIMIT);
}

function absoluteUrl(target: Window, value: unknown): string {
  try {
    const raw = typeof value === 'string' ? value : value instanceof URL ? value.href : (value as { url?: string })?.url ?? String(value);
    return truncate(new URL(raw, target.location.href).href, URL_LIMIT);
  } catch {
    return '';
  }
}

export interface Recorder {
  snapshot(): RecorderSnapshot;
}

/**
 * Install the hooks. The page's own functions always run first and their
 * results pass through untouched; every hook body is in try/catch, so a bug
 * here can lose an entry but never break the page.
 */
export function installRecorder(target: Window & typeof globalThis): Recorder {
  const existing = (target as unknown as Record<string, unknown>)[RECORDER_KEY] as Recorder | undefined;
  if (existing && typeof existing.snapshot === 'function') return existing;

  const consoleErrors = new RingBuffer<ConsoleEntry>(RECORDER_CAPACITY);
  const failedRequests = new RingBuffer<FailedRequest>(RECORDER_CAPACITY);
  const now = () => Date.now();
  const record = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* never let recording break the page */
    }
  };

  for (const level of ['error', 'warn'] as const) {
    const original = target.console[level];
    if (typeof original !== 'function') continue;
    target.console[level] = function (this: Console, ...args: unknown[]) {
      const result = original.apply(this, args);
      record(() => consoleErrors.push({ level, message: message(args), time: now() }));
      return result;
    } as Console['error'];
  }

  target.addEventListener('error', (event: ErrorEvent) => {
    record(() => {
      if (!(event instanceof target.ErrorEvent)) return; // resource load errors carry no message
      const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
      consoleErrors.push({ level: 'uncaught', message: truncate(`${event.message || describe(event.error)}${where}`, MESSAGE_LIMIT), time: now() });
    });
  });
  target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    record(() => consoleErrors.push({ level: 'unhandledrejection', message: message([event.reason]), time: now() }));
  });

  const originalFetch = target.fetch;
  if (typeof originalFetch === 'function') {
    target.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      let started = 0;
      let method = 'GET';
      let url = '';
      record(() => {
        started = target.performance.now();
        const [input, init] = args;
        method = (init?.method ?? (input instanceof target.Request ? input.method : 'GET')).toUpperCase();
        url = absoluteUrl(target, input);
      });
      const promise = originalFetch.apply(this, args);
      promise.then(
        (response) => record(() => {
          if (!response.ok) failedRequests.push({ method, url, status: response.status, durationMs: target.performance.now() - started });
        }),
        () => record(() => failedRequests.push({ method, url, status: null, durationMs: target.performance.now() - started })),
      );
      return promise;
    } as typeof fetch;
  }

  const xhr = target.XMLHttpRequest?.prototype;
  if (xhr) {
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; started: number }>();
    xhr.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      record(() => meta.set(this, { method: String(args[0] ?? 'GET').toUpperCase(), url: absoluteUrl(target, args[1]), started: 0 }));
      return (originalOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof xhr.open;
    xhr.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      record(() => {
        const entry = meta.get(this);
        if (!entry) return;
        entry.started = target.performance.now();
        this.addEventListener('loadend', () => record(() => {
          if (this.status === 0 || this.status >= 400) {
            failedRequests.push({ method: entry.method, url: entry.url, status: this.status || null, durationMs: target.performance.now() - entry.started });
          }
        }));
      });
      return (originalSend as (...a: unknown[]) => void).apply(this, args);
    };
  }

  const recorder: Recorder = {
    snapshot: () => ({ consoleErrors: consoleErrors.toArray(), failedRequests: failedRequests.toArray() }),
  };
  try {
    Object.defineProperty(target, RECORDER_KEY, { value: recorder, configurable: false, enumerable: false, writable: false });
  } catch {
    /* a page that froze window still works; the capture just has no context */
  }
  return recorder;
}
