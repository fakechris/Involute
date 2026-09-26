import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';

import { TEAM_TRIAGE_QUERY, TEAM_TRIAGE_ROTATION_MUTATION } from '../board/queries';
import type {
  TeamTriageQueryData,
  TeamTriageRotationMutationData,
  TeamTriageRotationMutationVariables,
  TriagePerson,
} from '../board/types';
import { readStoredTeamKey } from '../board/utils';

const personName = (person: TriagePerson) => person.name ?? person.email ?? person.id;

/**
 * Weekly bug triage rotation (Bug route v1, INV-750): who looks at new bug
 * reports that have no place yet. The rotation advances one person a week from
 * the start date; triage reports and SLA reminders go to the person on duty.
 */
export function BugTriageTab() {
  const teamKey = readStoredTeamKey() ?? 'INV';
  const { data, loading, error, refetch } = useQuery<TeamTriageQueryData, { teamKey: string }>(TEAM_TRIAGE_QUERY, {
    variables: { teamKey },
  });
  const [runUpdate, updateState] = useMutation<TeamTriageRotationMutationData, TeamTriageRotationMutationVariables>(
    TEAM_TRIAGE_ROTATION_MUTATION,
  );
  const team = data?.teams.nodes[0] ?? null;
  const [order, setOrder] = useState<string[]>([]);
  const [startsOn, setStartsOn] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!team) return;
    setOrder(team.triageRotation?.users.map((user) => user.id) ?? []);
    setStartsOn(team.triageRotation ? team.triageRotation.startsAt.slice(0, 10) : new Date().toISOString().slice(0, 10));
  }, [team]);

  if (error) return <p role="alert">Could not load the triage rotation: {error.message}</p>;
  if (loading && !team) return <p role="status">Loading…</p>;
  if (!team) return <p>No team selected.</p>;

  const humans = team.memberships.nodes.map((membership) => membership.user).filter((user) => user.actorKind !== 'AGENT' && user.actorKind !== 'SERVICE');
  const byId = new Map(humans.map((user) => [user.id, user]));
  const available = humans.filter((user) => !order.includes(user.id));
  const move = (index: number, delta: number) =>
    setOrder((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });

  async function save() {
    setMessage(null);
    const result = await runUpdate({
      variables: { input: { teamId: team!.id, userIds: order, ...(order.length ? { startsAt: new Date(`${startsOn}T00:00:00`).toISOString() } : {}) } },
    });
    const payload = result.data?.teamTriageRotationUpdate;
    if (!payload?.success) {
      setMessage({ ok: false, text: payload?.message ?? 'Could not save the rotation.' });
      return;
    }
    setMessage({ ok: true, text: order.length ? 'Rotation saved.' : 'Rotation cleared.' });
    await refetch();
  }

  return (
    <section aria-label="Bug triage rotation">
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 4px' }}>Bug triage — {team.name}</h2>
      <p className="observation-hint" style={{ margin: '0 0 16px' }}>
        One person a week looks at bug reports that were sent to triage and gets the SLA reminders with the bug&apos;s owner.
        Bugs are fixed or declined with a reason; they never wait in the backlog.
      </p>
      <p role="status">
        On duty this week: <strong>{team.currentTriager ? personName(team.currentTriager) : 'nobody (no rotation)'}</strong>
      </p>

      <ol className="triage-rotation" aria-label="Rotation order">
        {order.map((id, index) => {
          const person = byId.get(id);
          const label = person ? personName(person) : id;
          return (
            <li key={id}>
              <span>
                Week {index + 1}: {label}
              </span>
              <button type="button" className="ui-action" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                ↑
              </button>
              <button type="button" className="ui-action" aria-label={`Move ${label} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>
                ↓
              </button>
              <button type="button" className="ui-action" aria-label={`Remove ${label}`} onClick={() => setOrder((current) => current.filter((item) => item !== id))}>
                Remove
              </button>
            </li>
          );
        })}
      </ol>

      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', margin: '12px 0' }}>
        <label className="field-stack">
          <span>Add a member</span>
          <select
            aria-label="Add to rotation"
            value=""
            onChange={(event) => event.target.value && setOrder((current) => [...current, event.target.value])}
          >
            <option value="">{available.length ? 'Choose…' : 'Everyone is in the rotation'}</option>
            {available.map((user) => (
              <option key={user.id} value={user.id}>
                {personName(user)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          <span>First week starts</span>
          <input type="date" aria-label="Rotation start" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
        </label>
        <button type="button" className="ui-action ui-action--accent" disabled={updateState?.loading} onClick={() => void save()}>
          Save rotation
        </button>
      </div>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} style={{ color: message.ok ? 'var(--fg-dim)' : 'var(--danger)' }}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
