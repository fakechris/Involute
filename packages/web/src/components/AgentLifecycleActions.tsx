import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';

import {
  ACTOR_DEACTIVATE_MUTATION,
  ACTOR_REACTIVATE_MUTATION,
  ACTOR_TRANSFER_OWNER_MUTATION,
  AGENT_OWNER_CANDIDATES_QUERY,
} from '../board/queries';
import type { UserSummary } from '../board/types';
import { Btn } from './Primitives';

type Mode = 'idle' | 'deactivate' | 'transfer';

interface OwnerCandidatesData {
  users: { nodes: Array<Pick<UserSummary, 'id' | 'name' | 'email' | 'actorKind' | 'deactivatedAt'>> };
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 30, padding: '0 10px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-2)', fontSize: 14, color: 'var(--fg)',
};

/**
 * The lifecycle controls for one actor (INV-605): deactivate, reactivate,
 * transfer ownership. The server already gated and audited these; what was
 * missing was any place in the UI to reach them. Every action asks for a
 * reason, because the reason is what the audit row shows to the next person.
 */
export function AgentLifecycleActions({
  actor,
  onChanged,
}: {
  actor: Pick<UserSummary, 'id' | 'deactivatedAt' | 'owner'>;
  onChanged: () => Promise<unknown> | void;
}) {
  const [mode, setMode] = useState<Mode>('idle');
  const [reason, setReason] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [runDeactivate] = useMutation<{ actorDeactivate: { success: boolean } }, { id: string; reason?: string }>(ACTOR_DEACTIVATE_MUTATION);
  const [runReactivate] = useMutation<{ actorReactivate: { success: boolean } }, { id: string; reason?: string }>(ACTOR_REACTIVATE_MUTATION);
  const [runTransfer] = useMutation<{ actorTransferOwner: { success: boolean } }, { id: string; ownerId: string; reason?: string }>(ACTOR_TRANSFER_OWNER_MUTATION);
  const candidates = useQuery<OwnerCandidatesData>(AGENT_OWNER_CANDIDATES_QUERY, { skip: mode !== 'transfer' });

  const humans = (candidates.data?.users.nodes ?? []).filter(
    (user) => user.actorKind === 'HUMAN' && !user.deactivatedAt && user.id !== actor.owner?.id,
  );

  function reset() {
    setMode('idle');
    setReason('');
    setOwnerId('');
    setError(null);
  }

  async function submit(run: () => Promise<{ data?: Record<string, { success: boolean }> | null | undefined }>, key: string) {
    setError(null);
    setPending(true);
    try {
      const result = await run();
      if (!result?.data?.[key]?.success) {
        setError('The server refused the change. Only the accountable owner or an admin may manage an actor.');
        return;
      }
      reset();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not apply the change.');
    } finally {
      setPending(false);
    }
  }

  const reasonField = (label: string) => (
    <input
      style={inputStyle}
      aria-label={label}
      placeholder={label}
      value={reason}
      onChange={(event) => setReason(event.target.value)}
    />
  );

  return (
    <section className="issue-panel__section agent-lifecycle" aria-label="Lifecycle">
      <span className="issue-panel__label">Manage</span>
      {mode === 'idle' ? (
        <div className="agent-lifecycle__actions">
          {actor.deactivatedAt ? (
            <Btn variant="subtle" size="md" onClick={() => setMode('deactivate')}>Reactivate</Btn>
          ) : (
            <Btn variant="subtle" size="md" onClick={() => setMode('deactivate')}>Deactivate</Btn>
          )}
          <Btn variant="ghost" size="md" onClick={() => setMode('transfer')}>Transfer owner</Btn>
        </div>
      ) : null}

      {mode === 'deactivate' && !actor.deactivatedAt ? (
        <div className="agent-lifecycle__form">
          <p className="agent-directory__meta">
            Deactivating keeps the actor's id and history but revokes every credential; it can no longer act or be mentioned. Reactivation later needs a new credential.
          </p>
          {reasonField('Reason for deactivating')}
          <div className="agent-lifecycle__actions">
            <Btn variant="primary" size="md" disabled={pending} onClick={() => void submit(
              () => runDeactivate({ variables: { id: actor.id, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
              'actorDeactivate',
            )}>
              {pending ? 'Deactivating…' : 'Confirm deactivate'}
            </Btn>
            <Btn variant="ghost" size="md" onClick={reset}>Cancel</Btn>
          </div>
        </div>
      ) : null}

      {mode === 'deactivate' && actor.deactivatedAt ? (
        <div className="agent-lifecycle__form">
          <p className="agent-directory__meta">
            Reactivating clears the deactivated flag. Credentials revoked at deactivation stay revoked; issue a new one afterwards.
          </p>
          {reasonField('Reason for reactivating')}
          <div className="agent-lifecycle__actions">
            <Btn variant="primary" size="md" disabled={pending} onClick={() => void submit(
              () => runReactivate({ variables: { id: actor.id, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
              'actorReactivate',
            )}>
              {pending ? 'Reactivating…' : 'Confirm reactivate'}
            </Btn>
            <Btn variant="ghost" size="md" onClick={reset}>Cancel</Btn>
          </div>
        </div>
      ) : null}

      {mode === 'transfer' ? (
        <div className="agent-lifecycle__form">
          <p className="agent-directory__meta">
            The owner is the human accountable for this actor and where its escalations end.
          </p>
          <select style={inputStyle} aria-label="New owner" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
            <option value="">{candidates.loading ? 'Loading people…' : 'Choose a person'}</option>
            {humans.map((user) => (
              <option key={user.id} value={user.id}>{user.name ?? user.email ?? user.id}</option>
            ))}
          </select>
          {reasonField('Reason for transferring')}
          <div className="agent-lifecycle__actions">
            <Btn variant="primary" size="md" disabled={pending || !ownerId} onClick={() => void submit(
              () => runTransfer({ variables: { id: actor.id, ownerId, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
              'actorTransferOwner',
            )}>
              {pending ? 'Transferring…' : 'Confirm transfer'}
            </Btn>
            <Btn variant="ghost" size="md" onClick={reset}>Cancel</Btn>
          </div>
        </div>
      ) : null}

      {error ? <p className="agent-lifecycle__error" role="alert">{error}</p> : null}
    </section>
  );
}
