import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isChunkLoadError, loadWithReload, RouteErrorBoundary } from './lazy-route';

function memoryDeps(now: number) {
  const store = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    reload: vi.fn(),
    now: vi.fn(() => now),
    store,
  };
}

const stale = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://x/assets/CandidatesPage-OLD.js'));

describe('stale chunk recovery (INV-763)', () => {
  it('recognises the browsers\' chunk failures and nothing else', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once on a stale chunk and does not resolve meanwhile', async () => {
    const deps = memoryDeps(100_000);
    let settled = false;
    void loadWithReload(stale, deps).then(() => (settled = true), () => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });

  it('throws instead of reloading again within 30 seconds, so an outage cannot loop', async () => {
    const deps = memoryDeps(100_000);
    deps.store.set('involute.chunkReloadAt', String(100_000 - 5_000));
    await expect(loadWithReload(stale, deps)).rejects.toThrow(/dynamically imported module/);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('passes other errors through and clears the guard after a successful load', async () => {
    const deps = memoryDeps(100_000);
    await expect(loadWithReload(() => Promise.reject(new Error('boom')), deps)).rejects.toThrow('boom');
    expect(deps.reload).not.toHaveBeenCalled();
    deps.store.set('involute.chunkReloadAt', '99999');
    await expect(loadWithReload(() => Promise.resolve('module'), deps)).resolves.toBe('module');
    expect(deps.store.has('involute.chunkReloadAt')).toBe(false);
  });

  it('shows a reload prompt instead of a blank page when a view fails', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = () => {
      throw new TypeError('Failed to fetch dynamically imported module: /x.js');
    };
    render(
      <RouteErrorBoundary resetKey="/candidates">
        <Broken />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('A new version of Involute is available.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    errors.mockRestore();
  });
});
