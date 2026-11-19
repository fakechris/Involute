import { gql } from '@apollo/client';
import { useApolloClient } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import { Field, Select } from '../components/controls';
import { DataTable } from '../components/DataTable';
import { Btn } from '../components/Primitives';
import { Badge, EmptyState, LoadingState } from '../components/status';
import { WorkReference } from '../components/WorkReference';

export const BURNDOWN_MILESTONES_QUERY = gql`
  query BurndownMilestones($filter: IssueFilter!, $after: String) {
    issues(first: 100, after: $after, filter: $filter) {
      nodes { id identifier title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const MILESTONE_BURNDOWN_QUERY = gql`
  query DeliveryMilestoneBurndown($milestoneId: String!, $from: String!, $to: String!, $timeZone: String!) {
    milestoneBurndown(milestoneId: $milestoneId, from: $from, to: $to, timeZone: $timeZone) {
      definitionVersion
      milestone { id identifier }
      window { from to timeZone start end }
      coverage {
        status baseline memberCount unknownWorkCount backfilledEventCount
        gaps { start end workId reason }
      }
      emptyReason
      points { date at scope remaining }
    }
  }
`;

type Milestone = { id: string; identifier: string; title: string };
type Point = { date: string; at: string; scope: number | null; remaining: number | null };
export type BurndownResult = {
  definitionVersion: string;
  milestone: { id: string; identifier: string };
  window: { from: string; to: string; timeZone: string; start: string; end: string };
  coverage: {
    status: 'FULL' | 'PARTIAL' | 'NONE'; baseline: string | null; memberCount: number;
    unknownWorkCount: number; backfilledEventCount: number;
    gaps: { start: string | null; end: string | null; workId: string; reason: string }[];
  };
  emptyReason: string | null;
  points: Point[];
};
type Connection = { nodes: Milestone[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export function burndownWindow(start: string, end: string) {
  const first = new Date(start).getTime();
  const last = new Date(end).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last) || first >= last) return null;
  return { from: new Date(first).toISOString().slice(0, 10), to: new Date(last - 1).toISOString().slice(0, 10), timeZone: 'UTC' };
}

function Chart({ points }: { points: Point[] }) {
  const max = Math.max(1, ...points.flatMap(point => [point.scope ?? 0, point.remaining ?? 0]));
  const x = (index: number) => points.length === 1 ? 398 : 48 + index * 700 / Math.max(1, points.length - 1);
  const y = (value: number) => 230 - value / max * 200;
  function segments(key: 'scope' | 'remaining') {
    const result: string[] = [];
    let segment: string[] = [];
    points.forEach((point, index) => {
      if (point[key] === null) {
        if (segment.length) result.push(segment.join(' '));
        segment = [];
      } else segment.push(`${x(index)},${y(point[key])}`);
    });
    if (segment.length) result.push(segment.join(' '));
    return result;
  }
  return (
    <svg className="burndown-chart" viewBox="0 0 800 275" role="img" aria-label="Milestone burndown: scope and remaining issue counts. Shaded days are unknown; see daily values below.">
      {points.map((point, index) => point.scope === null || point.remaining === null ? (
        <rect key={point.date} className="burndown-chart__gap" x={index === 0 ? 48 : (x(index - 1) + x(index)) / 2} y="30" width={(index === points.length - 1 ? 748 : (x(index) + x(index + 1)) / 2) - (index === 0 ? 48 : (x(index - 1) + x(index)) / 2)} height="200" />
      ) : null)}
      <path className="burndown-chart__axis" d="M48 30V230H748" />
      <text x="38" y="34" textAnchor="end">{max}</text>
      <text x="38" y="234" textAnchor="end">0</text>
      <text x="48" y="260">{points[0]?.date}</text>
      {points.length > 1 ? <text x="748" y="260" textAnchor="end">{points.at(-1)?.date}</text> : null}
      {(['scope', 'remaining'] as const).map(key => (
        <g key={key} className={`burndown-chart__${key}`}>
          {segments(key).map((segment, index) => <polyline key={index} points={segment} />)}
          {points.map((point, index) => point[key] !== null ? <circle key={point.date} cx={x(index)} cy={y(point[key])} r="3" /> : null)}
        </g>
      ))}
    </svg>
  );
}

function BurndownValues({ data }: { data: BurndownResult }) {
  const unknownDays = data.points.filter(point => point.scope === null || point.remaining === null).length;
  return (
    <>
      <p><WorkReference reference={data.milestone.identifier} /> · Definition {data.definitionVersion} · {data.window.from} – {data.window.to} inclusive · {data.window.timeZone}</p>
      <p>Daily snapshots at the next midnight, end exclusive. Scope counts committed issues, excluding canceled; remaining also excludes completed. Counts are not effort or a forecast.</p>
      <p><Badge tone={data.coverage.status === 'FULL' ? 'success' : 'warn'}>{data.coverage.status} history coverage</Badge>{' '}
        {data.coverage.memberCount} candidate members · {data.coverage.unknownWorkCount} with unknown history · {data.coverage.backfilledEventCount} backfilled events
      </p>
      {data.coverage.status !== 'FULL' || unknownDays > 0 ? (
        <p>{unknownDays} unknown days. Shading and breaks mean unknown, not zero. Missing history and snapshots not reached yet are never interpolated.</p>
      ) : null}
      {data.coverage.gaps.length ? (
        <details><summary>History gaps ({data.coverage.gaps.length})</summary>
          <ul>{data.coverage.gaps.map((gap, index) => <li key={index}>{gap.start ?? 'Unbounded start'} – {gap.end ?? 'Unbounded end'}: {gap.reason}</li>)}</ul>
        </details>
      ) : null}
      {data.emptyReason === 'NO_MEMBERS' ? <EmptyState size="inline" title="No milestone members in this window" /> : (
        <>
          {data.emptyReason === 'NO_HISTORY' ? <EmptyState size="inline" title="No recorded scope history" body="Daily counts remain Unknown until history is available." /> : null}
          <p className="burndown-legend"><span className="burndown-legend__scope">Scope (dashed)</span> · <span className="burndown-legend__remaining">Remaining (solid)</span> · Shading: Unknown</p>
          <Chart points={data.points} />
          <details><summary>Daily values (text equivalent)</summary>
            <DataTable label="Burndown daily values" rows={data.points} rowKey={point => point.date} columns={[
              { key: 'date', header: 'Date (UTC)', render: point => point.date },
              { key: 'scope', header: 'Scope', render: point => point.scope ?? 'Unknown' },
              { key: 'remaining', header: 'Remaining', render: point => point.remaining ?? 'Unknown' },
            ]} />
          </details>
        </>
      )}
    </>
  );
}

export function MilestoneBurndown({ teamKey, repository, start, end }: { teamKey: string; repository: string; start: string; end: string }) {
  const client = useApolloClient();
  const [milestones, setMilestones] = useState<Milestone[] | null>(null);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState('');
  const [listAttempt, setListAttempt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: BurndownResult; error?: string } | null>(null);
  const window = useMemo(() => burndownWindow(start, end), [start, end]);
  const variables = useMemo(() => window ? { milestoneId: selected, ...window } : null, [selected, window]);
  const requestKey = JSON.stringify(variables);
  useEffect(() => {
    let active = true;
    setMilestones(null);
    setListError('');
    async function load() {
      try {
        let after: string | null = null;
        const nodes: Milestone[] = [];
        do {
          const response = await client.query<{ issues: Connection }>({
            query: BURNDOWN_MILESTONES_QUERY,
            variables: { after, filter: { kind: 'MILESTONE', commitmentStatus: 'COMMITTED', team: { key: { eq: teamKey } },
              ...(repository ? { repository: repository === '__none__' ? { isNull: true } : { eq: repository } } : {}) } },
            fetchPolicy: 'no-cache',
          });
          if (!active) return;
          if (!response.data) throw new Error('No milestone response.');
          const page: Connection = response.data.issues;
          nodes.push(...page.nodes);
          after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        } while (after);
        if (active) {
          setMilestones(nodes);
          setSelected(previous => nodes.some(node => node.id === previous) ? previous : nodes[0]?.id ?? '');
        }
      } catch (error) { if (active) setListError(error instanceof Error ? error.message : 'Could not load milestones.'); }
    }
    void load();
    return () => { active = false; };
  }, [client, teamKey, repository, listAttempt, window]);
  useEffect(() => {
    if (!selected || !variables) return;
    let active = true;
    void client.query<{ milestoneBurndown: BurndownResult }>({ query: MILESTONE_BURNDOWN_QUERY, variables, fetchPolicy: 'no-cache' })
      .then(response => {
        if (!response.data) throw new Error('No burndown response.');
        if (active) setResult({ key: requestKey, data: response.data.milestoneBurndown });
      }).catch((error: unknown) => { if (active) setResult({ key: requestKey, error: error instanceof Error ? error.message : 'Could not load burndown.' }); });
    return () => { active = false; };
  }, [client, selected, variables, requestKey, attempt]);
  const current = result?.key === requestKey ? result : null;
  function retry() {
    setResult(null);
    setListAttempt(value => value + 1);
    setAttempt(value => value + 1);
  }
  return (
    <section aria-label="Burndown">
      <h2>Burndown</h2>
      <p>Daily UTC snapshots cover the calendar days touched by the selected latency window; latency above uses exact instants.</p>
      {!window ? <EmptyState size="inline" title="Choose a valid delivery window" /> : listError ? (
        <div role="alert"><EmptyState size="inline" title="Could not load burndown" body={listError} action={<Btn variant="subtle" onClick={retry}>Retry burndown</Btn>} /></div>
      ) : !milestones ? <LoadingState>Loading milestones…</LoadingState> : milestones.length === 0 ? (
        <EmptyState size="inline" title="No milestones in this project" body="Choose another project to view milestone burndown." />
      ) : (
        <>
          <Field label="Burndown milestone"><Select value={selected} onChange={event => setSelected(event.target.value)}>
            {milestones.map(milestone => <option key={milestone.id} value={milestone.id}>{milestone.identifier} · {milestone.title}</option>)}
          </Select></Field>
          {current?.error ? (
            <div role="alert"><EmptyState size="inline" title="Could not load burndown" body={current.error} action={<Btn variant="subtle" onClick={retry}>Retry burndown</Btn>} /></div>
          ) : current?.data ? <BurndownValues data={current.data} /> : <LoadingState>Loading burndown…</LoadingState>}
        </>
      )}
    </section>
  );
}
