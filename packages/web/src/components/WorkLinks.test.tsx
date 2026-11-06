import { MockedProvider } from '@apollo/client/testing/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WORK_LINKS_QUERY, WorkLinks, linkSource } from './WorkLinks';

const mock = (runs: unknown[], evidence: unknown[], repository: string | null = 'fakechris/lumenbox') => [
  {
    request: { query: WORK_LINKS_QUERY, variables: { id: 'w1' } },
    result: { data: { workContext: { __typename: 'WorkContext', work: { __typename: 'Issue', id: 'w1', repository }, runs, evidence } } },
  },
];

const run = (extra: Record<string, unknown>) => ({
  __typename: 'WorkRunRecord',
  id: 'r1',
  publicId: 'RUN-981',
  status: 'COMPLETED',
  repository: 'fakechris/lumenbox',
  commitSha: null,
  pullRequestNumber: null,
  externalUrl: null,
  startedAt: '2026-11-04T01:00:00.000Z',
  ...extra,
});

const evidence = (extra: Record<string, unknown>) => ({
  __typename: 'WorkEvidenceRecord',
  id: 'e1',
  runId: null,
  kind: 'ARTIFACT',
  url: 'https://example.com',
  summary: null,
  createdAt: '2026-11-04T02:00:00.000Z',
  retractedAt: null,
  verifications: [],
  ...extra,
});

describe('WorkLinks (INV-1673)', () => {
  afterEach(cleanup);

  it('links the commit and PR of a run to GitHub', async () => {
    render(
      <MockedProvider mocks={mock([run({ commitSha: '8c0750adffca2e5d62c6dfeb1bb9595c99b4c091', pullRequestNumber: 510 })], [])}>
        <WorkLinks workId="w1" />
      </MockedProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Commits & links · 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'commit 8c0750a' })).toHaveAttribute('href', 'https://github.com/fakechris/lumenbox/commit/8c0750adffca2e5d62c6dfeb1bb9595c99b4c091');
    expect(screen.getByRole('link', { name: 'PR #510' })).toHaveAttribute('href', 'https://github.com/fakechris/lumenbox/pull/510');
  });

  it('does not repeat the PR the webhook attached, and groups outside links by source', async () => {
    render(
      <MockedProvider
        mocks={mock(
          [run({ pullRequestNumber: 510 })],
          [
            evidence({ id: 'e-pr', kind: 'PR', url: 'https://github.com/fakechris/lumenbox/pull/510', summary: 'GitHub PR #510 (Merged in 8c0750a)' }),
            evidence({ id: 'e-sentry', url: 'https://acme.sentry.io/issues/42/', summary: 'Crash in policy gate' }),
            evidence({ id: 'e-gone', url: 'https://acme.sentry.io/issues/7/', summary: 'Wrong issue', retractedAt: '2026-11-05T00:00:00.000Z' }),
          ],
        )}
      >
        <WorkLinks workId="w1" />
      </MockedProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Commits & links · 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /PR #510/ })).toHaveLength(1);
    const sentry = screen.getByRole('list', { name: 'Sentry' });
    expect(within(sentry).getByRole('link', { name: 'Crash in policy gate' })).toHaveAttribute('href', 'https://acme.sentry.io/issues/42/');
    expect(screen.queryByText('Wrong issue')).not.toBeInTheDocument();
  });

  it('says plainly when nothing was recorded', async () => {
    render(
      <MockedProvider mocks={mock([run({})], [])}>
        <WorkLinks workId="w1" />
      </MockedProvider>,
    );
    expect(await screen.findByText(/No commit, pull request or link recorded yet for fakechris\/lumenbox/)).toBeInTheDocument();
  });

  it('names common sources', () => {
    expect(linkSource('https://acme.sentry.io/issues/1')).toBe('Sentry');
    expect(linkSource('https://grafana.example.com/d/x')).toBe('Grafana');
    expect(linkSource('file:///tmp/shot.png')).toBe('Local file');
    expect(linkSource('https://www.example.org/a')).toBe('example.org');
  });
});
