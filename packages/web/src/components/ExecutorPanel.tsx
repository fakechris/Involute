import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
const CONTEXT = gql`query ExecutorPanel($id: String!) { executorContextJson(id: $id) }`;
const UPDATE = gql`mutation ExecutorAction($workId: String!, $operation: String!, $detailsJson: String) { executorUpdate(workId: $workId, operation: $operation, detailsJson: $detailsJson) { success message resultJson } }`;
type Receipt = { id: string; generation: number; payload: { commitSha: string; pullRequestNumber: number | null; environment: string | null; deployedSha: string | null; health: string; behavior: string; evidenceUrls: string[] }; assessment: { versionMatches: boolean | null } };
type Dispatch = { id: string; workId: string; revision: number; generation: number; visibleState: string; executorActorId: string; checkpoint: string | null; feedback: string | null; receipts: Receipt[] };
type Context = { protocolVersion: number; viewerCanWrite: boolean; dispatches: Dispatch[] };
export function ExecutorPanel({ workId, canDispatch = false }: { workId: string; canDispatch?: boolean }) {
  const { data, error, refetch } = useQuery<{ executorContextJson: string }>(CONTEXT, { variables: { id: workId }, pollInterval: 5000 });
  const [update, { loading }] = useMutation<{ executorUpdate: { success: boolean; message: string | null } }>(UPDATE);
  const [message, setMessage] = useState('');
  let context: Context | null = null;
  try { if (data) context = JSON.parse(data.executorContextJson) as Context; } catch { /* explicit error below */ }
  if (error || data && (!context || context.protocolVersion !== 1 || !Array.isArray(context.dispatches))) return <p role="alert">Executor status is unavailable or uses an unsupported protocol.</p>;
  if (!context || !context.dispatches.length && !canDispatch) return null;
  async function act(operation: string, dispatch?: Dispatch) {
    try {
      const result = (await update({ variables: { workId: dispatch?.workId ?? workId, operation, detailsJson: JSON.stringify(dispatch ? { expectedRevision: dispatch.revision, generation: dispatch.generation } : {}) } })).data?.executorUpdate;
      setMessage(result?.success ? 'Executor request recorded.' : result?.message ?? 'The executor request failed.');
      await refetch();
    } catch (failure) { setMessage(String(failure)); }
  }
  return <section className="work-context__section"><h2>External execution</h2>
    <p>Receipts are reported by the executor. CI verification and final human acceptance are separate.</p>
    {context.viewerCanWrite && canDispatch && !context.dispatches.length ? <button type="button" disabled={loading} onClick={() => void act('dispatch')}>Dispatch approved executor</button> : null}
    {context.dispatches.map((dispatch) => <article key={dispatch.id} className="observation-card">
      <h3><Link to={`/work/${dispatch.workId}`}>Implementation</Link> · {dispatch.visibleState} · attempt {dispatch.generation}</h3>
      <p>Executor: {dispatch.executorActorId}</p>
      {dispatch.visibleState === 'UNKNOWN' ? <p role="status">No current acknowledgement. The executor may still be running; inspect external effects before recovery.</p> : null}
      {dispatch.feedback ? <p>Requested changes: {dispatch.feedback}</p> : null}
      {dispatch.checkpoint ? <p style={{ whiteSpace: 'pre-wrap' }}>Checkpoint: {dispatch.checkpoint}</p> : null}
      {context.viewerCanWrite && !['STOPPED', 'DELIVERED', 'EXHAUSTED'].includes(dispatch.visibleState) ? <button type="button" disabled={loading} onClick={() => void act('stop', dispatch)}>Stop executor</button> : null}
      {context.viewerCanWrite && ['STOPPED', 'UNKNOWN'].includes(dispatch.visibleState) ? <button type="button" disabled={loading} onClick={() => void act('recover', dispatch)}>Recover within approved budget</button> : null}
      {dispatch.receipts.map((receipt) => <div key={receipt.id}><h4>Delivery receipt · attempt {receipt.generation}</h4>
        <p>PR: {receipt.payload.pullRequestNumber ?? 'Not reported'} · PR commit: <code>{receipt.payload.commitSha}</code></p>
        <p>Environment: {receipt.payload.environment ?? 'No deployment reported'} · Deployed version: <code>{receipt.payload.deployedSha ?? 'Unknown'}</code></p>
        {receipt.assessment.versionMatches === false ? <p role="alert">The deployed version differs from the authorized release.</p> : null}
        <p>Reported health: {receipt.payload.health} · Reported behavior: {receipt.payload.behavior}</p>
        {receipt.payload.evidenceUrls.map((url) => <p key={url}><a href={url} target="_blank" rel="noreferrer">View delivery evidence</a></p>)}
      </div>)}
    </article>)}{message ? <p role="status">{message}</p> : null}
  </section>;
}
