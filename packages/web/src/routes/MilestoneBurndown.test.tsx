import { ApolloClient, ApolloLink, InMemoryCache, Observable } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { print } from 'graphql';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { burndownWindow, MILESTONE_BURNDOWN_QUERY, MilestoneBurndown, type BurndownResult } from './MilestoneBurndown';

afterEach(cleanup);
const start = '2026-03-01T00:00:00.000Z';
const end = '2026-03-05T00:00:00.000Z';
const milestones = [
  { id: 'm1', identifier: 'INV-10', title: 'First milestone' },
  { id: 'm2', identifier: 'INV-20', title: 'Second milestone' },
];
function fixture(overrides: Partial<BurndownResult> = {}): BurndownResult {
  return {
    definitionVersion: '1', milestone: { id: 'm1', identifier: 'INV-10' },
    window: { from: '2026-03-01', to: '2026-03-04', timeZone: 'UTC', start, end },
    coverage: { status: 'FULL', baseline: start, memberCount: 5, unknownWorkCount: 0, backfilledEventCount: 0, gaps: [] },
    emptyReason: null,
    points: [5, 4, 3, 0].map((remaining, index) => ({ date: `2026-03-0${index + 1}`, at: `2026-03-0${index + 2}T00:00:00.000Z`, scope: 5, remaining })),
    ...overrides,
  };
}
type Request = { name: string; variables: Record<string, any> };
type Reply = (request: Request) => Promise<Record<string, unknown>>;
const defaultReply: Reply = async request => request.name === 'BurndownMilestones'
  ? { issues: { nodes: milestones, pageInfo: { hasNextPage: false, endCursor: null } } }
  : { milestoneBurndown: fixture() };
function mount(reply: Reply = defaultReply) {
  const requests: Request[] = [];
  const client = new ApolloClient({ cache: new InMemoryCache(), link: new ApolloLink(operation => new Observable(observer => {
    const request = { name: operation.operationName!, variables: operation.variables };
    requests.push(request);
    void reply(request).then(data => { observer.next({ data }); observer.complete(); }, error => observer.error(error));
  })) });
  function Harness() {
    const [repository, setRepository] = useState('acme/a');
    const [to, setTo] = useState(end);
    return <>
      <button onClick={() => setRepository('acme/b')}>Switch project</button>
      <button onClick={() => setRepository('__none__')}>No repository</button>
      <button onClick={() => setTo('2026-03-03T00:00:00.000Z')}>Change window</button>
      <MilestoneBurndown key={repository} teamKey="INV" repository={repository} start={start} end={to} />
    </>;
  }
  render(<ApolloProvider client={client}><MemoryRouter><Harness /></MemoryRouter></ApolloProvider>);
  return requests;
}
async function values() {
  await screen.findByRole('img', { name: /Milestone burndown/ });
  fireEvent.click(screen.getByText('Daily values (text equivalent)'));
  return screen.getByRole('table', { name: 'Burndown daily values' });
}

it('maps exact instant windows to touched UTC dates without adding an exclusive-end day', () => {
  expect(burndownWindow(start, end)).toEqual({ from: '2026-03-01', to: '2026-03-04', timeZone: 'UTC' });
  expect(burndownWindow('2026-03-01T23:00:00-08:00', '2026-03-03T00:15:00Z')).toMatchObject({ from: '2026-03-02', to: '2026-03-03' });
  expect(burndownWindow('invalid', end)).toBeNull();
  expect(burndownWindow(end, start)).toBeNull();
  expect(print(MILESTONE_BURNDOWN_QUERY)).not.toContain('idealStart');
});
it('shows loading without invented counts', () => {
  mount(() => new Promise(() => {}));
  expect(screen.getByText('Loading milestones…')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
it('renders server values, zeros, definition and boundary semantics with a keyboard-accessible text equivalent', async () => {
  const requests = mount();
  const table = await values();
  expect(table).toHaveTextContent('2026-03-0450');
  expect(screen.getByText(/Definition 1/)).toHaveTextContent('2026-03-01 – 2026-03-04 inclusive · UTC');
  expect(screen.getByText(/Daily snapshots at/)).toHaveTextContent('end exclusive');
  expect(screen.getByText(/calendar days touched/)).toBeInTheDocument();
  expect(requests[0]?.variables.filter).toEqual({ kind: 'MILESTONE', commitmentStatus: 'COMMITTED', team: { key: { eq: 'INV' } }, repository: { eq: 'acme/a' } });
  expect(requests[1]?.variables).toEqual({ milestoneId: 'm1', from: '2026-03-01', to: '2026-03-04', timeZone: 'UTC' });
  screen.getByLabelText('Burndown milestone').focus();
  expect(screen.getByRole('combobox')).toHaveFocus();
});
it('breaks both curves at unknown days, shows gap reasons, and never replaces null with zero', async () => {
  const full = fixture();
  mount(async request => request.name === 'BurndownMilestones' ? defaultReply(request) : { milestoneBurndown: fixture({
    coverage: { ...full.coverage, status: 'PARTIAL', unknownWorkCount: 1, backfilledEventCount: 2, gaps: [{ start: null, end: start, workId: 'w1', reason: 'Missing creation audit' }] },
    points: full.points.map((point, index) => index === 1 ? { ...point, scope: null, remaining: null } : point),
  }) });
  const table = await values();
  expect(within(table).getAllByText('Unknown')).toHaveLength(2);
  expect(screen.getByText(/1 unknown days/)).toBeInTheDocument();
  const chart = screen.getByRole('img', { name: /Milestone burndown/ });
  expect(chart.querySelectorAll('.burndown-chart__gap')).toHaveLength(1);
  expect(chart.querySelectorAll('polyline')).toHaveLength(4);
  fireEvent.click(screen.getByText('History gaps (1)'));
  expect(screen.getByText(/Unbounded start.*Missing creation audit/)).toBeInTheDocument();
});
it('keeps all days unknown when there is no history rather than drawing a zero line', async () => {
  const full = fixture();
  mount(async request => request.name === 'BurndownMilestones' ? defaultReply(request) : { milestoneBurndown: fixture({
    emptyReason: 'NO_HISTORY', coverage: { ...full.coverage, status: 'NONE', baseline: null, unknownWorkCount: 5 },
    points: full.points.map(point => ({ ...point, scope: null, remaining: null })),
  }) });
  const table = await values();
  expect(within(table).getAllByText('Unknown')).toHaveLength(8);
  expect(screen.getByText('No recorded scope history')).toBeInTheDocument();
  expect(document.querySelectorAll('polyline')).toHaveLength(0);
});
it('distinguishes no milestones from a milestone with no members', async () => {
  mount(async request => request.name === 'BurndownMilestones' ? defaultReply(request) : { milestoneBurndown: fixture({ emptyReason: 'NO_MEMBERS' }) });
  expect(await screen.findByText('No milestone members in this window')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  cleanup();
  mount(async () => ({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }));
  expect(await screen.findByText('No milestones in this project')).toBeInTheDocument();
});
it('paginates milestones beyond the first hundred and supports no-repository scope', async () => {
  const requests = mount(async request => request.name === 'BurndownMilestones' ? {
    issues: { nodes: [milestones[request.variables.after ? 1 : 0]], pageInfo: { hasNextPage: !request.variables.after, endCursor: request.variables.after ? null : 'next' } },
  } : defaultReply(request));
  await screen.findByRole('combobox');
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(requests[1]?.variables.after).toBe('next');
  fireEvent.click(screen.getByText('No repository'));
  await waitFor(() => expect(requests.some(request => request.variables.filter?.repository?.isNull)).toBe(true));
});
it.each(['BurndownMilestones', 'DeliveryMilestoneBurndown'])('retries a failed %s without retaining an error', async failing => {
  let failed = false;
  const reply = vi.fn<Reply>(async request => {
    if (request.name === failing && !failed) { failed = true; throw new Error('API unavailable'); }
    return defaultReply(request);
  });
  mount(reply);
  expect(await screen.findByRole('alert')).toHaveTextContent('API unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry burndown' }));
  await values();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('discards older milestone and window responses', async () => {
  let resolveOld!: (data: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { resolveOld = resolve; });
  const requests = mount(async request => request.name === 'BurndownMilestones' ? defaultReply(request)
    : request.variables.milestoneId === 'm1' ? pending : { milestoneBurndown: fixture({ definitionVersion: request.variables.to, milestone: { id: 'm2', identifier: 'INV-20' } }) });
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'm2' } });
  await screen.findByText(/Definition 2026-03-04/);
  fireEvent.click(screen.getByText('Change window'));
  expect(screen.queryByText(/Definition 2026-03-04/)).not.toBeInTheDocument();
  await screen.findByText(/Definition 2026-03-02/);
  resolveOld({ milestoneBurndown: fixture({ definitionVersion: 'stale' }) });
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(screen.queryByText(/Definition stale/)).not.toBeInTheDocument();
});
it('retries the selected milestone with the same window rather than reverting to the first milestone', async () => {
  let failed = false;
  const requests = mount(async request => {
    if (request.name === 'DeliveryMilestoneBurndown' && request.variables.milestoneId === 'm2' && !failed) {
      failed = true;
      throw new Error('Second milestone unavailable');
    }
    return defaultReply(request);
  });
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'm2' } });
  await screen.findByRole('alert');
  const failedRequest = requests.at(-1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry burndown' }));
  await screen.findByRole('img', { name: /Milestone burndown/ });
  expect(requests.at(-1)).toEqual(failedRequest);
  expect(screen.getByRole('combobox')).toHaveValue('m2');
});
it('never shows the previous project after a project switch', async () => {
  let resolveOld!: (data: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { resolveOld = resolve; });
  let listCount = 0;
  mount(async request => {
    if (request.name === 'BurndownMilestones') {
      listCount++;
      return { issues: { nodes: [milestones[listCount === 1 ? 0 : 1]], pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    return request.variables.milestoneId === 'm1' ? pending : { milestoneBurndown: fixture({ definitionVersion: 'new-project' }) };
  });
  await screen.findByRole('combobox');
  fireEvent.click(screen.getByText('Switch project'));
  await screen.findByText(/Definition new-project/);
  resolveOld({ milestoneBurndown: fixture({ definitionVersion: 'old-project' }) });
  await waitFor(() => expect(screen.queryByText(/Definition old-project/)).not.toBeInTheDocument());
});
