import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkLinks } from './WorkLinks';

const query = vi.hoisted(() => ({ data: null as unknown, error: undefined as Error | undefined }));
vi.mock('@apollo/client/react', () => ({ useQuery: () => ({ data: query.data, error: query.error }) }));

afterEach(() => {
  cleanup();
  query.data = null;
  query.error = undefined;
});

function evidence(id: string, kind: string, url: string, summary: string) {
  return { id, runId: null, kind, url, summary, createdAt: '2026-11-08T00:00:00.000Z', retractedAt: null, verifications: [] };
}

describe('WorkLinks', () => {
  it('replaces the raw auth error after session expiry without changing other load errors', () => {
    query.error = new Error('Network unavailable');
    const view = render(<WorkLinks workId="work-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Commits and links could not be loaded: Network unavailable');

    query.error = new Error('Not authenticated');
    view.rerender(<WorkLinks workId="work-1" />);
    // Named, so several failed sections of one drawer are told apart (INV-2141).
    expect(screen.getByRole('alert')).toHaveTextContent(/^Commits and links did not load\. Sign in again to see it\.$/);
    expect(screen.queryByText(/Not authenticated/i)).not.toBeInTheDocument();
  });

  it('renders an allowlisted screenshot without an extension, and an image artifact, and leaves an ordinary link as a link', () => {
    query.data = {
      workContext: {
        work: { id: 'work-1', repository: null, pullRequests: [] },
        runs: [],
        evidence: [
          evidence('e1', 'screenshot', 'https://img.qiniucdn.com/shot', 'Qiniu shot'),
          evidence('e2', 'artifact', 'https://bucket.oss-cn-hangzhou.aliyuncs.com/board.png', 'Board picture'),
          evidence('e3', 'artifact', 'https://example.com/notes', 'Notes'),
        ],
      },
    };
    render(<WorkLinks workId="work-1" />);
    expect(screen.getByRole('img', { name: 'screenshot' })).toHaveAttribute('src', 'https://img.qiniucdn.com/shot');
    expect(screen.getByRole('img', { name: 'artifact' })).toHaveAttribute('src', 'https://bucket.oss-cn-hangzhou.aliyuncs.com/board.png');
    fireEvent.click(screen.getByRole('button', { name: 'screenshot' }));
    expect(within(screen.getByRole('dialog', { name: 'screenshot' })).getByRole('img', { name: 'screenshot' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'screenshot' })).toBeNull();
    const notes = screen.getByRole('link', { name: 'Notes' });
    expect(notes).toHaveAttribute('href', 'https://example.com/notes');
    expect(within(notes).queryByRole('img')).toBeNull();
  });
});
