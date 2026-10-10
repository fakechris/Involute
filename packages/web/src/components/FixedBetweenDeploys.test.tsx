import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedBetweenDeploys } from './FixedBetweenDeploys';

const runQuery = vi.fn();
const lazyResult = vi.fn();
const buildSha = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({ data: { serverBuild: { buildSha: buildSha(), serverVersion: '0.0.0' } }, loading: false })),
  useLazyQuery: vi.fn(() => [runQuery, { data: lazyResult(), loading: false, error: undefined }]),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  buildSha.mockReturnValue('9'.repeat(40));
  lazyResult.mockReturnValue(undefined);
});

const renderPanel = () => render(
  <MemoryRouter>
    <FixedBetweenDeploys repositories={['fakechris/Involute', 'fakechris/lumenbox']} />
  </MemoryRouter>,
);

const range = { repository: 'fakechris/Involute', fromSha: '1111111', toSha: '9'.repeat(40), compareStatus: 'ahead' };

describe('FixedBetweenDeploys (INV-1121)', () => {
  it('asks for the bugs fixed from a SHA up to the running build by default', () => {
    renderPanel();
    expect(screen.getByLabelText('To deploy SHA')).toHaveValue('9'.repeat(40));
    expect(screen.getByRole('button', { name: 'List fixes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('From deploy SHA'), { target: { value: 'sha-1111111' } });
    fireEvent.change(screen.getByLabelText('Changelog project'), { target: { value: 'fakechris/lumenbox' } });
    fireEvent.click(screen.getByRole('button', { name: 'List fixes' }));
    expect(runQuery).toHaveBeenCalledWith({ variables: { repository: 'fakechris/lumenbox', fromSha: 'sha-1111111', toSha: '9'.repeat(40) } });
  });

  it('lists the fixed bugs with their fix commit and PR', () => {
    lazyResult.mockReturnValue({ bugsFixedBetween: { ...range, known: true, failureCode: null, message: null, commitCount: 3, bugs: [
      { fixSha: 'b'.repeat(40), prNumber: 11, source: 'MERGE_EVENT', issue: { id: 'i1', identifier: 'INV-11', title: 'Blank page', state: { name: 'In Review', type: 'REVIEW' } } },
    ] } });
    renderPanel();
    const panel = screen.getByLabelText('Bugs fixed between deploys');
    expect(panel).toHaveTextContent('INV-11 Blank page');
    expect(panel).toHaveTextContent('bbbbbbbbbbbb · #11');
    expect(screen.getByRole('link', { name: 'INV-11' })).toHaveAttribute('href', '/issue/INV-11');
  });

  it('shows an unknown range as unknown, with the reason, never as "no fixes"', () => {
    lazyResult.mockReturnValue({ bugsFixedBetween: { ...range, known: false, failureCode: 'UNKNOWN_SHA', message: 'GitHub does not know one of these SHAs.', commitCount: null, bugs: [] } });
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown range: GitHub does not know one of these SHAs. (UNKNOWN_SHA)');
    expect(screen.queryByText(/No bug fix merged/)).toBeNull();
  });

  it('says a known empty range has no fixes', () => {
    lazyResult.mockReturnValue({ bugsFixedBetween: { ...range, known: true, failureCode: null, message: null, commitCount: 2, bugs: [] } });
    renderPanel();
    expect(screen.getByText('No bug fix merged in 2 commit(s) from 1111111 to 999999999999.')).toBeTruthy();
  });
});
