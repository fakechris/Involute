import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Badge } from './status';

export const WORK_COVERAGE_HINTS_QUERY = gql`
  query WorkCoverageHints($id: String!) { workCoverageHints(id: $id) {
    status criteria { id text judgment sources { id url summary origin } codeFindings { evidenceId message } }
  } }
`;
interface Hints {
  status: string;
  criteria: Array<{ id: string; text: string; judgment: string;
    sources: Array<{ id: string; url: string; summary: string | null; origin: string }>;
    codeFindings: Array<{ evidenceId: string; message: string }> }>;
}
export function CoverageHints({ workId }: { workId: string }) {
  const { data, error } = useQuery<{ workCoverageHints: Hints }>(WORK_COVERAGE_HINTS_QUERY, { variables: { id: workId }, fetchPolicy: 'network-only' });
  if (error || !data) return null;
  const hints = data.workCoverageHints;
  if (!hints) return null;
  if (!['advice', 'abstained'].includes(hints.status) || !Array.isArray(hints.criteria)) return null;
  return <section className="work-context__section" aria-label="Evidence gap hints">
    <h2>Evidence gap hints</h2>
    <p>Advisory — not verification. A test description cannot prove a real deployment. Human acceptance is unchanged.</p>
    {hints.criteria.map(criterion => <div key={criterion.id} className="card">
      <Badge>{criterion.judgment}</Badge>
      <MarkdownRenderer content={criterion.text} />
      <p>Source evidence considered</p>
      <ul>{criterion.sources.map(source => <li key={source.id}>
        <a href={/^https:\/\//.test(source.url) ? source.url : undefined} target="_blank" rel="noreferrer">{source.id}</a> · {source.origin}
        {source.summary ? <MarkdownRenderer content={source.summary} /> : null}
        {criterion.codeFindings.filter(f => f.evidenceId === source.id).map((finding, i) => <p key={i}>{finding.message}</p>)}
      </li>)}</ul>
    </div>)}
  </section>;
}
