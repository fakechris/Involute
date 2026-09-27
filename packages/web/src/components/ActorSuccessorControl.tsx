import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';

import { ACTOR_SET_SUCCESSOR_MUTATION, AGENT_OWNER_CANDIDATES_QUERY } from '../board/queries';
import type { UserSummary } from '../board/types';

interface CandidatesData {
  users: { nodes: Array<Pick<UserSummary, 'id' | 'name' | 'email' | 'actorKind' | 'deactivatedAt'>> };
}

/**
 * Who takes over when this actor stops answering (INV-794). The expiry notice
 * for an unanswered request names this successor, so people know who to ask.
 */
export function ActorSuccessorControl({
  actor,
  onChanged,
}: {
  actor: { id: string; successorActor?: { id: string; name?: string | null; handle?: string | null } | null };
  onChanged?: () => Promise<unknown> | void;
}) {
  const [successorId, setSuccessorId] = useState(actor.successorActor?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const candidates = useQuery<CandidatesData>(AGENT_OWNER_CANDIDATES_QUERY);
  const [runSet, state] = useMutation<
    { actorSetSuccessor: { success: boolean; message?: string | null } },
    { id: string; successorId: string | null }
  >(ACTOR_SET_SUCCESSOR_MUTATION);
  const options = (candidates.data?.users.nodes ?? []).filter((user) => !user.deactivatedAt && user.id !== actor.id);

  async function save(next: string) {
    const previous = successorId;
    setError(null);
    setSuccessorId(next);
    try {
      const result = await runSet({ variables: { id: actor.id, successorId: next || null } });
      if (!result.data?.actorSetSuccessor.success) {
        // Refused: nothing changed, so show what is still set.
        setSuccessorId(previous);
        setError(result.data?.actorSetSuccessor.message ?? 'Could not set the successor.');
        return;
      }
      await onChanged?.();
    } catch {
      setError('Could not set the successor.');
    }
  }

  return (
    <label className="field-stack">
      <span>Successor</span>
      <select aria-label="Successor" value={successorId} disabled={state?.loading} onChange={(event) => void save(event.target.value)}>
        <option value="">None declared</option>
        {options.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name ?? user.email ?? user.id}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </label>
  );
}
