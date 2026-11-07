import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PullRequestLink } from '../board/types';
import { PullRequestBadge, PullRequestList } from './PullRequestLinks';

const pr = (number: number, state: PullRequestLink['state'], extra: Partial<PullRequestLink> = {}): PullRequestLink => ({
  repository: 'fakechris/Involute',
  number,
  url: `https://github.com/fakechris/Involute/pull/${number}`,
  title: `Change ${number}`,
  state,
  mergeSha: null,
  updatedAt: '2026-11-07T02:00:00.000Z',
  ...extra,
});

describe('pull requests on work (INV-1703)', () => {
  afterEach(cleanup);

  it('lists each PR with its state, opens GitHub, and links the merge commit', () => {
    render(<PullRequestList repository="fakechris/Involute" pullRequests={[pr(315, 'MERGED', { mergeSha: 'bf6fdc2' }), pr(316, 'OPEN'), pr(317, 'LINKED', { title: null })]} />);
    expect(screen.getByRole('link', { name: /#315/ })).toHaveAttribute('href', 'https://github.com/fakechris/Involute/pull/315');
    expect(screen.getByRole('link', { name: 'bf6fdc2' })).toHaveAttribute('href', 'https://github.com/fakechris/Involute/commit/bf6fdc2');
    expect(screen.getByText('merged')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('linked')).toBeInTheDocument();
  });

  it('says there is no pull request for code work, and nothing for work outside a repository', () => {
    const { rerender } = render(<PullRequestList repository="fakechris/Involute" pullRequests={[]} />);
    expect(screen.getByText('No pull request')).toBeInTheDocument();
    rerender(<PullRequestList repository={null} pullRequests={[]} />);
    expect(screen.queryByText('No pull request')).not.toBeInTheDocument();
  });

  it('puts the newest PR on a board card without opening the card', () => {
    const open = vi.fn();
    render(
      <div onClick={open}>
        <PullRequestBadge pullRequests={[pr(315, 'MERGED'), pr(314, 'MERGED')]} />
      </div>,
    );
    const badge = screen.getByRole('link', { name: 'Pull request #315 merged' });
    expect(badge).toHaveAttribute('href', 'https://github.com/fakechris/Involute/pull/315');
    expect(badge).toHaveTextContent('#315 +1');
    fireEvent.click(badge);
    expect(open).not.toHaveBeenCalled();
  });

  it('shows nothing on a card with no PR', () => {
    const { container } = render(<PullRequestBadge pullRequests={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
