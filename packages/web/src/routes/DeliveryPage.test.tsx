import { ApolloClient, ApolloLink, InMemoryCache, Observable } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { print } from 'graphql';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { DELIVERY_PROJECTS_QUERY, DeliveryPage, type DeliveryResult } from './DeliveryPage';
import { readStoredTeamKey } from '../board/utils';

vi.mock('../board/utils', () => ({ readStoredTeamKey: vi.fn(() => 'INV') }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(readStoredTeamKey).mockReturnValue('INV');
});
const start = '2026-03-01T00:00:00.000Z';
const end = '2026-04-01T00:00:00.000Z';
const metric = { sampleCount: 5, p50Ms: 3_600_000, p90Ms: 7_200_000, emptyReason: null, coverage: { missingCount: 0 } };
function fixture(overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return {
    definitionVersion: '1', repository: null, window: { start, end },
    leadTime: metric, cycleTime: metric, reviewWait: metric,
    coverage: { workCount: 5, noHistoryCount: 0, openEpisodeCount: 2, closedWithoutAcceptanceCount: 0, unknownEpisodeCount: 0 },
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, ...overrides,
  };
}
function work(id: string, count = 1, ageMs: number | null = 3_600_000) {
  return { id, identifier: `INV-${id}`, title: `Work ${id}`, repository: 'acme/a', state: { name: 'In Review', type: 'REVIEW' }, sampleEpisodeCount: count,
    episodes: [{ outcome: 'OPEN', ageMs }], runs: { wallClockSumMs: 3_600_000, wallClockUnionMs: 1_800_000 } };
}
type Reply = (variables: Record<string, unknown>) => Promise<DeliveryResult>;
function SwitchProject() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/delivery?from=${start}&to=${end}&project=acme/b`)}>Switch project</button>;
}
const defaultProjects = [
  { repository: 'acme/a', name: 'Project A', identifier: 'INV-100', totalCount: 7 },
  { repository: 'acme/b', name: 'Project B', identifier: 'INV-200', totalCount: 12 },
];
function mount(reply: Reply, sample = '', projects = defaultProjects, milestones: { id: string; identifier: string; title: string }[] = []) {
  const requests: Record<string, unknown>[] = [];
  const client = new ApolloClient({ cache: new InMemoryCache(), link: new ApolloLink((operation) => new Observable((observer) => {
    if (operation.operationName === 'DeliveryProjects') {
      const totalCount = projects.reduce((sum, project) => sum + project.totalCount, 0) + 3;
      observer.next({ data: { projectSummary: { totalCount, noRepositoryCount: 3, projects } } }); observer.complete(); return;
    }
    if (operation.operationName === 'BurndownMilestones') {
      observer.next({ data: { issues: { nodes: milestones, pageInfo: { hasNextPage: false, endCursor: null } } } }); observer.complete(); return;
    }
    if (operation.operationName === 'DeliveryMilestoneBurndown') {
      observer.next({ data: { milestoneBurndown: {
        definitionVersion: '1', milestone: { id: operation.variables.milestoneId, identifier: 'INV-10' },
        window: { from: '2026-03-01', to: '2026-03-31', timeZone: 'UTC', start, end },
        coverage: { status: 'FULL', baseline: start, memberCount: 0, unknownWorkCount: 0, backfilledEventCount: 0, gaps: [] },
        emptyReason: 'NO_MEMBERS', points: [],
      } } }); observer.complete(); return;
    }
    requests.push(operation.variables);
    void reply(operation.variables).then((data) => { observer.next({ data: { deliveryLatency: data } }); observer.complete(); }, (error) => observer.error(error));
  })) });
  render(<ApolloProvider client={client}><MemoryRouter initialEntries={[`/delivery?from=${start}&to=${end}${sample ? `&sample=${sample}` : ''}`]}><SwitchProject /><DeliveryPage /></MemoryRouter></ApolloProvider>);
  return requests;
}

it('shows loading without invented values', () => {
  mount(() => new Promise(() => {}));
  expect(screen.getByText('Loading delivery latency…')).toBeInTheDocument();
  expect(screen.queryByLabelText('Completed sample latency')).not.toBeInTheDocument();
});
it('offers projects beyond the first hundred using the unpaginated project summary', async () => {
  const projects = Array.from({ length: 120 }, (_, index) => ({
    repository: `acme/project-${index}`,
    name: `Project ${index}`,
    identifier: `INV-${index}`,
    totalCount: index + 1,
  }));
  const requests = mount(async () => fixture(), '', projects);
  await screen.findByLabelText('Completed sample latency');
  fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }));
  fireEvent.change(screen.getByPlaceholderText('Filter projects...'), { target: { value: 'project-119' } });
  fireEvent.click(screen.getByRole('option', { name: /acme\/project-119/ }));
  await waitFor(() => expect(requests.at(-1)?.repository).toBe('acme/project-119'));
  expect(print(DELIVERY_PROJECTS_QUERY)).toContain('projectSummary');
  expect(print(DELIVERY_PROJECTS_QUERY)).not.toContain('first: 100');
});
it('shows actual project, all-project and no-repository counts from the board summary', async () => {
  mount(async () => fixture());
  await screen.findByLabelText('Completed sample latency');
  expect(screen.getByRole('button', { name: 'acme/a' })).toHaveTextContent('7');
  expect(screen.getByRole('button', { name: 'acme/b' })).toHaveTextContent('12');
  fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }));
  expect(screen.getByRole('option', { name: /All Projects/ })).toHaveTextContent('22');
  expect(screen.getByRole('option', { name: /No repository/ })).toHaveTextContent('3');
  const project = screen.getByRole('option', { name: /acme\/b/ });
  expect(project).toHaveTextContent('INV-200');
  expect(project).toHaveTextContent('12');
  fireEvent.click(project);
  expect(screen.getByRole('button', { name: 'Project: acme/b' })).toHaveTextContent('12');
});
it('asks for a team instead of reporting empty metrics when no team is selected', () => {
  vi.mocked(readStoredTeamKey).mockReturnValue(null);
  const requests = mount(async () => fixture());
  expect(screen.getByText('Select a team')).toBeInTheDocument();
  expect(requests).toHaveLength(0);
});
it('shows a readable error', async () => {
  mount(async () => { throw new Error('Delivery API unavailable'); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Delivery API unavailable');
});
it('retries a failed request with the same window and project', async () => {
  const reply = vi.fn<Reply>().mockRejectedValueOnce(new Error('Delivery API unavailable')).mockResolvedValue(fixture());
  const requests = mount(reply);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Could not load delivery latency');
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(screen.getByText('Loading delivery latency…')).toBeInTheDocument();
  expect(await screen.findByLabelText('Completed sample latency')).toHaveTextContent('n=5');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('formats the returned window in the viewer timezone while keeping ISO query parameters', async () => {
  const formatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Los_Angeles' });
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date) {
    return formatter.format(this);
  });
  const window = { start: '2026-03-01T01:00:00.000Z', end: '2026-04-01T01:00:00.000Z' };
  const requests = mount(async () => fixture({ window }));
  const definition = await screen.findByText(/Definition 1/);
  expect(definition).toHaveTextContent(`Definition 1 · ${formatter.format(new Date(window.start))} – ${formatter.format(new Date(window.end))} (end exclusive)`);
  expect(definition).not.toHaveTextContent(window.start);
  fireEvent.click(screen.getByRole('link', { name: /Lead time/ }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toMatchObject({ start, end, sample: 'LEAD_TIME' });
});
it('shows no samples rather than zero duration and explains missing history', async () => {
  const empty = { sampleCount: 0, p50Ms: null, p90Ms: null, emptyReason: 'INSUFFICIENT_HISTORY', coverage: { missingCount: 2 } };
  mount(async () => fixture({ leadTime: empty, cycleTime: empty, reviewWait: empty }));
  const stats = await screen.findByLabelText('Completed sample latency');
  expect(within(stats).getAllByText('No samples')).toHaveLength(3);
  expect(stats).toHaveTextContent('Insufficient history for this metric.');
  expect(stats).not.toHaveTextContent('0m');
  expect(screen.getByText('Low coverage')).toBeInTheDocument();
});
it('flags partial coverage and shows all coverage counts', async () => {
  mount(async () => fixture({ leadTime: { ...metric, sampleCount: 2, coverage: { missingCount: 1 } }, coverage: { workCount: 8, noHistoryCount: 1, openEpisodeCount: 2, closedWithoutAcceptanceCount: 3, unknownEpisodeCount: 1 } }));
  expect(await screen.findByText('Low coverage')).toBeInTheDocument();
  expect(screen.getByText(/Interpret cautiously/)).toHaveTextContent('fewer than 5');
  expect(screen.getByText(/Works: 8/)).toHaveTextContent('No history: 1 · Open: 2 · Closed without acceptance: 3 · Unknown: 1');
});
it('renders full metrics, text equivalent and keyboard-activatable chart buttons', async () => {
  const requests = mount(async () => fixture());
  const bar = await screen.findByRole('button', { name: 'Lead time P50: 1.0h, n=5. Show samples' });
  expect(screen.queryByText('Low coverage')).not.toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'Latency percentiles text equivalent' })).toHaveTextContent('Lead time1.0h2.0h5');
  bar.focus(); expect(bar).toHaveFocus();
  fireEvent.click(bar);
  await waitFor(() => expect(requests.at(-1)?.sample).toBe('LEAD_TIME'));
  expect(requests.at(-1)).toMatchObject({ start, end, repository: null });
  expect(await screen.findByLabelText('Delivery drill-down')).toHaveTextContent('0 items · 0 samples of 5');
  expect(await screen.findByText('No milestones in this project')).toBeInTheDocument();
});
it('loads every drill-down page and reconciles episodes rather than items', async () => {
  mount(async (variables) => fixture({ nodes: variables.after ? [work('2', 3)] : [work('1', 2)], pageInfo: variables.after ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'page-2' } }), 'LEAD_TIME');
  const list = await screen.findByLabelText('Delivery drill-down');
  expect(list).toHaveTextContent('2 items · 5 samples of 5');
  expect(list).toHaveTextContent('Run wall-clock (not work time): sum 1.0h · union 30m');
  expect(list).toHaveTextContent('Human actual time: Unknown · Agent actual time: Unknown');
  const link = within(list).getByRole('link', { name: /INV-1 Work 1/ });
  fireEvent.click(link);
  expect(list).toBeInTheDocument();
});
it('keeps the selected milestone across latency drill-down and window reloads', async () => {
  mount(async () => fixture(), '', defaultProjects, [
    { id: 'm1', identifier: 'INV-10', title: 'First milestone' },
    { id: 'm2', identifier: 'INV-20', title: 'Second milestone' },
  ]);
  const select = await screen.findByRole('combobox', { name: 'Burndown milestone' });
  fireEvent.change(select, { target: { value: 'm2' } });
  fireEvent.click(await screen.findByRole('link', { name: /Lead time/ }));
  await screen.findByLabelText('Delivery drill-down');
  expect(screen.getByRole('combobox', { name: 'Burndown milestone' })).toBe(select);
  expect(select).toHaveValue('m2');
  fireEvent.click(screen.getByRole('button', { name: '7d' }));
  await screen.findByLabelText('Completed sample latency');
  expect(await screen.findByRole('combobox', { name: 'Burndown milestone' })).toHaveValue('m2');
});
it('sorts open items by known age descending and leaves unknown age explicit', async () => {
  mount(async () => fixture({ nodes: [work('1', 1, null), work('2', 1, 9 * 3_600_000), work('3', 1, 3_600_000)] }), 'OPEN');
  const list = await screen.findByLabelText('Delivery drill-down');
  const items = within(list).getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('Work 2In ReviewAge 9.0h');
  expect(items[2]).toHaveTextContent('Age Unknown');
});
it('never renders the older project response under a newly selected project', async () => {
  let resolveOld!: (value: DeliveryResult) => void;
  const old = new Promise<DeliveryResult>((resolve) => { resolveOld = resolve; });
  mount(async (variables) => variables.repository === 'acme/b' ? fixture({ definitionVersion: 'new-project', repository: 'acme/b' }) : old);
  fireEvent.click(screen.getByText('Switch project'));
  expect(await screen.findByText(/Definition new-project/)).toBeInTheDocument();
  resolveOld(fixture({ definitionVersion: 'old-project' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText(/Definition old-project/)).not.toBeInTheDocument();
  expect(screen.getByText(/Definition new-project/)).toBeInTheDocument();
});
