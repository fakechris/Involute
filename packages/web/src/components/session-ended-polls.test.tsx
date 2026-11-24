import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// INV-2146: background polls stop while the session has ended; every request would be refused.
const state = vi.hoisted(() => ({ sessionEnded: false, options: [] as Array<{ pollInterval?: number }> }));
vi.mock('@apollo/client/react', () => ({
  useQuery: (_document: unknown, options: { pollInterval?: number }) => { state.options.push(options); return { data: undefined, error: undefined, refetch: vi.fn() }; },
  useMutation: () => [vi.fn(), { loading: false }],
}));
vi.mock('../lib/apollo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/apollo')>()),
  useAuthenticationFailure: () => state.sessionEnded,
}));

import { ExecutorPanel } from './ExecutorPanel';
import { WorkLinks } from './WorkLinks';

describe('polls while the session has ended', () => {
  afterEach(() => { state.options = []; state.sessionEnded = false; });

  it.each([
    ['WorkLinks', () => <WorkLinks workId="w-1" />, 60_000],
    ['ExecutorPanel', () => <ExecutorPanel workId="w-1" />, 5000],
  ] as const)('%s polls while signed in and stops after the session ends', (_name, element, interval) => {
    render(<MemoryRouter>{element()}</MemoryRouter>);
    expect(state.options.at(-1)?.pollInterval).toBe(interval);
    state.options = [];
    state.sessionEnded = true;
    render(<MemoryRouter>{element()}</MemoryRouter>);
    expect(state.options.at(-1)?.pollInterval).toBe(0);
  });
});
