import { ExecutorPanel } from './ExecutorPanel';
import './delivery.css';
import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

type Work = { id: string; identifier: string; title: string; revision: number; acceptance: string | null; repository: string | null; assignee?: { id: string } | null; team?: { memberships: { nodes: Array<{ user: { id: string; name: string; actorKind: string } }> } }; supersededBy?: { id: string; identifier: string } | null };
type Policy = { environments: string[]; units: Array<{ key: string; title: string; executorActorId?: string; maxAttempts?: number; criteria: number[]; paths: string[]; actions: string[]; dependsOn: string[]; checks: Array<{ workflowId: number; job: string }> }> };
type Result = { success: boolean; message?: string | null };
const CONTEXT = gql`query DeliveryPanel($id: String!) { deliveryContext(id: $id) { viewerCanWrite work { id identifier title revision acceptance repository supersededBy { id identifier } } grant { revision policyJson } authorizationValid authorizationMessage units { issue { id identifier title deliveryUnitKey state { name } } technicalReady } } }`;
const AGENTS = gql`query DeliveryExecutors { agents { id name } }`;
const PROPOSE = gql`mutation DeliveryProposal($workId: String!, $expectedRevision: Int!, $reason: String!, $changesJson: String!) { deliveryChangePropose(workId: $workId, expectedRevision: $expectedRevision, reason: $reason, changesJson: $changesJson) { success message } }`;
const CREATE = gql`mutation DeliveryExecution($workId: String!, $unitKey: String!, $expectedGrantRevision: Int!) { deliveryExecutionCreate(workId: $workId, unitKey: $unitKey, expectedGrantRevision: $expectedGrantRevision) { success message issue { id } } }`;
const QUEUE = gql`query DeliveryQueue($after: String, $repository: String, $noRepository: Boolean, $teamKey: String, $bugsOnly: Boolean) { deliveryChanges(first: 30, after: $after, repository: $repository, noRepository: $noRepository, teamKey: $teamKey, bugsOnly: $bugsOnly) { nodes { id viewerCanDecide reason changesJson beforeJson work { id identifier title revision acceptance repository assignee { id } team { memberships { nodes { user { id name actorKind } } } } } } pageInfo { hasNextPage endCursor } } }`;
const DECIDE = gql`mutation DeliveryDecision($id: String!, $approve: Boolean!, $note: String, $ownerId: String) { deliveryChangeDecide(id: $id, approve: $approve, note: $note, ownerId: $ownerId) { success message } }`;

function parseObject<T>(raw: string): T | null {
  try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as T : null; } catch { return null; }
}
function parsePolicy(raw: string): Policy | null {
  const value = parseObject<Policy>(raw);
  return value && Array.isArray(value.environments) && Array.isArray(value.units) && value.units.every((unit) => unit && Array.isArray(unit.criteria) && Array.isArray(unit.paths) && Array.isArray(unit.actions) && Array.isArray(unit.dependsOn) && Array.isArray(unit.checks)) ? value : null;
}

function Plan({ policy, acceptance }: { policy: Policy; acceptance: string | null }) {
  const criteria = (acceptance ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return <div><p>Deployment environments: {policy.environments.join(', ') || 'None approved'}</p>{policy.units.map((unit) => <article key={unit.key} className="observation-card">
    <strong>{unit.title} ({unit.key})</strong>
    <p>Acceptance: {unit.criteria.map((index) => criteria[index] ?? `Missing criterion ${index + 1}`).join('; ')}</p>
    <p>Paths: {unit.paths.join(', ')} · Actions: {unit.actions.join(', ')}</p>
    <p>Executor: {unit.executorActorId ?? 'Not delegated'} · Attempt budget: {unit.maxAttempts ?? 1}</p>
    <p>Predecessors: {unit.dependsOn.join(', ') || 'None'}</p>
    <p>Required CI: {unit.checks.map((check) => `workflow ${check.workflowId} / ${check.job}`).join('; ') || 'Final delivery evidence'}</p>
  </article>)}</div>;
}

const list = (value: string) => value.split(',').map((part) => part.trim()).filter(Boolean);
function PolicyEditor({ value, onChange, acceptance }: { value: Policy; onChange: (policy: Policy) => void; acceptance: string | null }) {
  const { data: agentData } = useQuery<{ agents: Array<{ id: string; name: string }> }>(AGENTS);
  const criteria = (acceptance ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  function update(index: number, patch: Partial<Policy['units'][number]>) { onChange({ ...value, units: value.units.map((unit, position) => position === index ? { ...unit, ...patch } : unit) }); }
  return <fieldset><legend>Implementation authority</legend>
    <label>Deployment environments (comma separated)<input defaultValue={value.environments.join(', ')} onBlur={(event) => onChange({ ...value, environments: list(event.target.value) })} /></label>
    {value.units.map((unit, index) => <fieldset key={index}><legend>Implementation {index + 1}</legend>
      <label>Key<input value={unit.key} onChange={(event) => update(index, { key: event.target.value })} /></label>
      <label>Title<input value={unit.title} onChange={(event) => update(index, { title: event.target.value })} /></label>
      <label>Repository paths (comma separated)<input defaultValue={unit.paths.join(', ')} onBlur={(event) => update(index, { paths: list(event.target.value) })} /></label>
      <div>Existing acceptance criteria{criteria.map((criterion, criterionIndex) => <label key={criterionIndex}><input type="checkbox" checked={unit.criteria.includes(criterionIndex)} onChange={(event) => update(index, { criteria: event.target.checked ? [...unit.criteria, criterionIndex] : unit.criteria.filter((item) => item !== criterionIndex) })} />{criterion}</label>)}</div>
      <div>Allowed actions{['edit', 'test', 'pull_request', 'merge', 'deploy'].map((action) => <label key={action}><input type="checkbox" checked={unit.actions.includes(action)} onChange={(event) => update(index, { actions: event.target.checked ? [...unit.actions, action] : unit.actions.filter((item) => item !== action) })} />{action}</label>)}</div>
      <label>Executor (explicit delegation)<select value={unit.executorActorId ?? ''} onChange={(event) => { const { executorActorId: _id, maxAttempts: _max, ...rest } = unit; onChange({ ...value, units: value.units.map((item, position) => position === index ? event.target.value ? { ...unit, executorActorId: event.target.value, maxAttempts: unit.maxAttempts ?? 1 } : rest : item) }); }}><option value="">Not delegated</option>{agentData?.agents?.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      {unit.executorActorId ? <label>Maximum execution attempts<input type="number" min="1" max="10" step="1" value={unit.maxAttempts ?? 1} onChange={(event) => update(index, { maxAttempts: Number(event.target.value) })} /></label> : null}
      <label>Predecessor keys (comma separated)<input defaultValue={unit.dependsOn.join(', ')} onBlur={(event) => update(index, { dependsOn: list(event.target.value) })} /></label>
      {unit.checks.map((check, checkIndex) => <div key={checkIndex}><label>GitHub workflow ID<input type="number" min="1" step="1" value={check.workflowId || ''} onChange={(event) => update(index, { checks: unit.checks.map((item, position) => position === checkIndex ? { ...item, workflowId: Number(event.target.value) } : item) })} /></label><label>Exact CI job name<input value={check.job} onChange={(event) => update(index, { checks: unit.checks.map((item, position) => position === checkIndex ? { ...item, job: event.target.value } : item) })} /></label><button type="button" onClick={() => update(index, { checks: unit.checks.filter((_, position) => position !== checkIndex) })}>Remove check</button></div>)}
      <button type="button" onClick={() => update(index, { checks: [...unit.checks, { workflowId: 0, job: '' }] })}>Add CI check</button>
      <button type="button" onClick={() => onChange({ ...value, units: value.units.filter((_, position) => position !== index) })}>Remove implementation</button>
    </fieldset>)}
    <button type="button" onClick={() => onChange({ ...value, units: [...value.units, { key: `unit-${value.units.length + 1}`, title: '', paths: [], actions: ['edit', 'test'], criteria: [], dependsOn: [], checks: [] }] })}>Add implementation</button>
  </fieldset>;
}

export function DeliveryPanel({ workId }: { workId: string }) {
  const { data, error, refetch } = useQuery<{ deliveryContext: { viewerCanWrite: boolean; work: Work; grant: { revision: number; policyJson: string } | null; authorizationValid: boolean; authorizationMessage: string; units: Array<{ issue: { id: string; identifier: string; title: string; deliveryUnitKey?: string; state: { name: string } }; technicalReady: boolean }> } }>(CONTEXT, { variables: { id: workId } });
  const [propose, proposing] = useMutation<{ deliveryChangePropose: Result }>(PROPOSE);
  const [create, creating] = useMutation<{ deliveryExecutionCreate: Result }>(CREATE);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [sources, setSources] = useState('');
  const [otherContract, setOtherContract] = useState<Record<string, string>>({});
  const [draftPolicy, setDraftPolicy] = useState<Policy | null>(null);
  const [message, setMessage] = useState('');
  const context = data?.deliveryContext;
  if (error) return <p role="alert">Delivery authorization could not be loaded: {error.message}</p>;
  if (!context) return null;
  const policy = context.grant ? parsePolicy(context.grant.policyJson) : null;
  if (context.grant && !policy) return <p role="alert">The delivery policy could not be read. Refresh or ask an administrator to inspect the record.</p>;
  const invalidChecks = draftPolicy?.units.some((unit) => unit.checks.some((check) => !Number.isSafeInteger(check.workflowId) || check.workflowId < 1 || !check.job.trim())) ?? false;
  return <section className="work-context__section delivery-panel"><h2>Delivery authorization</h2>
    <p>{context.authorizationMessage}</p>{context.work.supersededBy ? <p>Consolidated into <Link to={`/work/${context.work.supersededBy.id}`}>{context.work.supersededBy.identifier}</Link>. History and evidence are retained.</p> : null}<p>Repository: {context.work.repository ?? 'Not set'}</p>
    {policy ? <><Plan policy={policy} acceptance={context.work.acceptance} />{context.viewerCanWrite ? policy.units.map((unit) => <button key={unit.key} type="button" disabled={!context.authorizationValid || creating.loading} onClick={async () => {
      try { const result = (await create({ variables: { workId: context.work.id, unitKey: unit.key, expectedGrantRevision: context.grant!.revision } })).data?.deliveryExecutionCreate; setMessage(result?.success ? 'Implementation task is available.' : result?.message ?? 'Could not create task.'); await refetch(); } catch (failure) { setMessage(String(failure)); }
    }}>Create implementation: {unit.title}</button>) : null}</> : null}
    <ExecutorPanel workId={context.work.id} />
    {context.units.map(({ issue, technicalReady }) => <div key={issue.id}><p><Link to={`/work/${issue.id}`}>{issue.identifier} {issue.title}</Link> · {issue.state.name} · {technicalReady ? 'CI verified' : 'CI proof pending'}</p></div>)}
    {context.viewerCanWrite ? <details><summary>Propose delivery change</summary><p>Changes return to Candidates for approval. Existing authorization is not expanded by this proposal.</p>
      <label>Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <label>Replacement scope (leave blank to keep)<textarea value={scope} onChange={(event) => setScope(event.target.value)} /></label>
      <label>Replacement acceptance (leave blank to keep)<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} /></label>
      {['outcome', 'constraints', 'verification'].map((field) => <label key={field}>Replacement {field} (leave blank to keep)<textarea value={otherContract[field] ?? ''} onChange={(event) => setOtherContract({ ...otherContract, [field]: event.target.value })} /></label>)}
      <label><input type="checkbox" checked={draftPolicy !== null} onChange={(event) => setDraftPolicy(event.target.checked ? policy ?? { units: [], environments: [] } : null)} />Propose implementation authority</label>
      {draftPolicy ? <PolicyEditor value={draftPolicy} onChange={setDraftPolicy} acceptance={acceptance.trim() || context.work.acceptance} /> : null}
      {invalidChecks ? <p role="alert">Each CI check needs a positive whole workflow ID and an exact job name.</p> : null}
      <label>Issues to consolidate (identifiers separated by commas)<input value={sources} onChange={(event) => setSources(event.target.value)} /></label>
      <button type="button" disabled={proposing.loading || invalidChecks || !reason.trim() || (!scope.trim() && !acceptance.trim() && !sources.trim() && !draftPolicy && !Object.values(otherContract).some((value) => value.trim()))} onClick={async () => {
        try { const result = (await propose({ variables: { workId: context.work.id, expectedRevision: context.work.revision, reason, changesJson: JSON.stringify({ ...(draftPolicy ? { policy: draftPolicy } : {}), contract: { ...Object.fromEntries(Object.entries(otherContract).filter(([, value]) => value.trim())), ...(scope.trim() ? { scope } : {}), ...(acceptance.trim() ? { acceptance } : {}) }, mergeSourceIds: sources.split(',').map((id) => id.trim()).filter(Boolean) }) } })).data?.deliveryChangePropose; setMessage(result?.success ? 'Proposed. Review this change in Candidates.' : result?.message ?? 'Could not propose change.'); await refetch(); } catch (failure) { setMessage(String(failure)); }
      }}>Propose delivery change</button>
    </details> : null}{message ? <p role="status">{message}</p> : null}
  </section>;
}

type Change = { viewerCanDecide: boolean; id: string; reason: string; changesJson: string; beforeJson: string; work: Work };
function ChangeCard({ change, refresh }: { change: Change; refresh: () => Promise<unknown> }) {
  const [decide, { loading }] = useMutation<{ deliveryChangeDecide: Result }>(DECIDE);
  const [note, setNote] = useState('');
  const [ownerId, setOwnerId] = useState(change.work.assignee?.id ?? '');
  const [message, setMessage] = useState('');
  const proposal = parseObject<{ contract: Record<string, string | null>; policy?: Policy; mergeSourceIds: string[] }>(change.changesJson);
  const before = parseObject<{ policy?: Policy | null; contracts: Record<string, Record<string, string | null>> }>(change.beforeJson);
  if (!proposal || !before || !proposal.contract || !before.contracts || !Array.isArray(proposal.mergeSourceIds) || (proposal.policy && !parsePolicy(JSON.stringify(proposal.policy))) || (before.policy && !parsePolicy(JSON.stringify(before.policy)))) return <p role="alert">This delivery change could not be read. Refresh or ask an administrator to inspect the record.</p>;
  async function submit(approve: boolean) {
    try { const result = (await decide({ variables: { id: change.id, approve, note, ownerId: ownerId || null } })).data?.deliveryChangeDecide; if (result?.success) await refresh(); else setMessage(result?.message ?? 'Could not save decision.'); } catch (failure) { setMessage(String(failure)); }
  }
  return <article className="observation-card"><h3><Link to={`/work/${change.work.id}`}>{change.work.identifier} {change.work.title}</Link></h3>
    <p>{change.reason}</p><p>Repository: {change.work.repository ?? 'Not set'}</p>
    {Object.entries(proposal.contract).map(([field, value]) => <div key={field}><strong>{field}</strong><p style={{ whiteSpace: 'pre-wrap' }}>Before: {before.contracts[change.work.id]?.[field] ?? 'Empty'}</p><p style={{ whiteSpace: 'pre-wrap' }}>After: {value ?? 'Empty'}</p></div>)}
    {before.policy ? <details><summary>Previously approved authority</summary><Plan policy={before.policy} acceptance={before.contracts[change.work.id]?.acceptance ?? change.work.acceptance} /></details> : null}
    {proposal.policy ? <Plan policy={proposal.policy} acceptance={proposal.contract.acceptance ?? change.work.acceptance} /> : null}
    {proposal.mergeSourceIds.length ? <div><p>Consolidate these issues; preserve their history and evidence:</p>{proposal.mergeSourceIds.map((id) => <p key={id}><Link to={`/work/${id}`}>{id}</Link></p>)}</div> : null}
    {change.viewerCanDecide ? <><label>Human owner<select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">Use current owner or reviewer</option>{change.work.team?.memberships.nodes.filter(({ user }) => user.actorKind === 'HUMAN').map(({ user }) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label>Decision note (required to decline)<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" disabled={loading} onClick={() => void submit(true)}>Approve delivery change</button>
    <button type="button" disabled={loading || !note.trim()} onClick={() => void submit(false)}>Decline delivery change</button></> : <p>Read-only access</p>}
    {message ? <p role="alert">{message}</p> : null}
  </article>;
}

export function DeliveryChangeQueue({ repository, noRepository, teamKey, bugsOnly }: { repository?: string | undefined; noRepository?: boolean | undefined; teamKey?: string | null | undefined; bugsOnly?: boolean | undefined }) {
  const { data, error, refetch, fetchMore, loading } = useQuery<{ deliveryChanges: { nodes: Change[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(QUEUE, { variables: { repository: repository || null, noRepository: noRepository ?? false, teamKey: teamKey ?? null, bugsOnly: bugsOnly ?? false }, notifyOnNetworkStatusChange: true });
  if (error) return <p role="alert">Delivery changes could not be loaded: {error.message}</p>;
  const queue = data?.deliveryChanges;
  if (!queue?.nodes.length) return null;
  return <section className="work-context__section delivery-panel"><h2>Delivery changes</h2><p>Approve the business contract and implementation authority together. Final acceptance remains a separate human decision.</p>
    {queue.nodes.map((change) => <ChangeCard key={change.id} change={change} refresh={() => refetch()} />)}
    {queue.pageInfo.hasNextPage ? <button type="button" disabled={loading} onClick={() => void fetchMore({ variables: { after: queue.pageInfo.endCursor }, updateQuery: (previous, { fetchMoreResult }) => ({ deliveryChanges: { ...fetchMoreResult.deliveryChanges, nodes: [...previous.deliveryChanges.nodes, ...fetchMoreResult.deliveryChanges.nodes] } }) })}>Load more delivery changes</button> : null}
  </section>;
}
