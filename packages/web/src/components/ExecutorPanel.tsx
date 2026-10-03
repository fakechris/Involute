import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
const CONTEXT = gql`query ExecutorPanel($id: String!) { executorContextJson(id: $id) }`;
const UPDATE = gql`mutation ExecutorAction($workId: String!, $operation: String!, $detailsJson: String) { executorUpdate(workId: $workId, operation: $operation, detailsJson: $detailsJson) { success message resultJson } }`;
type Receipt = { id: string; final?: boolean; generation: number; payload: { commitSha: string; pullRequestNumber: number | null; mergedSha?: string | null; environment: string | null; deployedSha: string | null; health: string; behavior: string; evidenceUrls: string[] }; assessment: { versionMatches: boolean | null } };
type Effect = { id: string; generation: number; action: string; environment: string | null; commitSha: string; state: string; resolution?: { outcome: string; reason: string; evidenceUrl: string; observedSha?: string } | null };
type Dispatch = { id: string; workId: string; revision: number; generation: number; visibleState: string; executorActorId: string; checkpoint: string | null; feedback: string | null; receipts: Receipt[]; effects?: Effect[] };
type Context = { protocolVersion: number; viewerCanWrite: boolean; viewerCanReconcile?: boolean; dispatches: Dispatch[] };
export function ExecutorPanel({ workId, canDispatch = false }: { workId: string; canDispatch?: boolean }) {
  const { data, error, refetch } = useQuery<{ executorContextJson: string }>(CONTEXT, { variables: { id: workId }, pollInterval: 5000 });
  const [update, { loading }] = useMutation<{ executorUpdate: { success: boolean; message: string | null } }>(UPDATE);
  const [message, setMessage] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, { outcome: string; reason: string; evidenceUrl: string; observedSha: string }>>({});
  let context: Context | null = null;
  try { if (data) context = JSON.parse(data.executorContextJson) as Context; } catch { /* explicit error below */ }
  if (error || data && (!context || context.protocolVersion !== 1 || !Array.isArray(context.dispatches))) return <p role="alert">Executor status is unavailable or uses an unsupported protocol.</p>;
  if (!context || !context.dispatches.length && !canDispatch) return null;
  async function act(operation: string, dispatch?: Dispatch, extra: Record<string, unknown> = {}) {
    try {
      const result = (await update({ variables: { workId: dispatch?.workId ?? workId, operation, detailsJson: JSON.stringify(dispatch ? { expectedRevision: dispatch.revision, generation: dispatch.generation, ...extra } : extra) } })).data?.executorUpdate;
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
      {context.viewerCanWrite && ['STOPPED', 'UNKNOWN'].includes(dispatch.visibleState) && !(dispatch.effects ?? []).some((effect) => effect.state === 'STARTED') ? <button type="button" disabled={loading} onClick={() => void act('recover', dispatch)}>Recover within approved budget</button> : null}
      {(dispatch.effects ?? []).filter((effect) => effect.state === 'STARTED' || effect.resolution).map((effect) => {
        const resolution = resolutions[effect.id] ?? { outcome: 'FAILED', reason: '', evidenceUrl: '', observedSha: '' };
        return <div key={effect.id}><h4>{effect.action} effect · {effect.environment ?? 'repository'} · {effect.state}</h4>
          <p>Requested version: <code>{effect.commitSha}</code></p>
          {effect.resolution ? <p>Reconciled: {effect.resolution.outcome} · {effect.resolution.reason} · <a href={effect.resolution.evidenceUrl}>Reconciliation evidence</a></p> : null}
          {context.viewerCanReconcile && effect.state === 'STARTED' ? <details><summary>Reconcile external effect</summary>
            <p>Inspect the external system and release any active implementation claim first. This records an observation; it does not accept the delivery.</p>
            <label>Observed result<select value={resolution.outcome} onChange={(event) => setResolutions({ ...resolutions, [effect.id]: { ...resolution, outcome: event.target.value } })}><option value="FAILED">Did not complete</option><option value="COMPLETED">Completed</option></select></label>
            <label>Reconciliation reason<textarea value={resolution.reason} onChange={(event) => setResolutions({ ...resolutions, [effect.id]: { ...resolution, reason: event.target.value } })} /></label>
            <label>Evidence URL<input type="url" value={resolution.evidenceUrl} onChange={(event) => setResolutions({ ...resolutions, [effect.id]: { ...resolution, evidenceUrl: event.target.value } })} /></label>
            <label>Observed SHA (optional)<input value={resolution.observedSha} onChange={(event) => setResolutions({ ...resolutions, [effect.id]: { ...resolution, observedSha: event.target.value } })} /></label>
            <button type="button" disabled={loading || !resolution.reason.trim() || !resolution.evidenceUrl.trim()} onClick={() => void act('reconcile', dispatch, { effectId: effect.id, resolution: { outcome: resolution.outcome, reason: resolution.reason, evidenceUrl: resolution.evidenceUrl, ...(resolution.observedSha ? { observedSha: resolution.observedSha } : {}) } })}>Record reconciliation</button>
          </details> : null}
        </div>;
      })}
      {dispatch.receipts.map((receipt) => <div key={receipt.id}><h4>{receipt.final === false ? 'Effect observation' : 'Delivery receipt'} · attempt {receipt.generation}</h4>
        <p>PR: {receipt.payload.pullRequestNumber ?? 'Not reported'} · PR commit: <code>{receipt.payload.commitSha}</code></p>
        {receipt.payload.mergedSha ? <p>Merge commit: <code>{receipt.payload.mergedSha}</code></p> : null}
        <p>Environment: {receipt.payload.environment ?? 'No deployment reported'} · Deployed version: <code>{receipt.payload.deployedSha ?? 'Unknown'}</code></p>
        {receipt.assessment.versionMatches === false ? <p role="alert">The deployed version differs from the authorized release.</p> : null}
        <p>Reported health: {receipt.payload.health} · Reported behavior: {receipt.payload.behavior}</p>
        {receipt.payload.evidenceUrls.map((url) => <p key={url}><a href={url} target="_blank" rel="noreferrer">View delivery evidence</a></p>)}
      </div>)}
    </article>)}{message ? <p role="status">{message}</p> : null}
  </section>;
}
