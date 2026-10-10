import { useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { NEED_INFO_REQUEST_MUTATION, NEED_INFO_WITHDRAW_MUTATION } from '../board/queries';
import type { AgentRequestSummary, UserSummary } from '../board/types';
import type { SessionViewer } from '../lib/session';

// Needs you drops a needinfo once it is answered or withdrawn.
const REFETCH = ['IssuePage', 'WorkContextPage', 'AttentionPage'];
const OPEN = new Set(['SUBMITTED', 'WORKING', 'INPUT_REQUIRED', 'submitted', 'working', 'input-required']);

type Person = Pick<UserSummary, 'id' | 'name' | 'email' | 'actorKind'>;

/**
 * Ask a named person — the reporter, a teammate, an agent — for information
 * on this work (needinfo, INV-1119). It waits in their Needs you (or an
 * agent's agent_inbox) until they answer or write any comment here; while it
 * waits on a bug's reporter the bug SLA is paused.
 */
export function NeedInfoControl({
  issueId,
  people,
  viewer,
  onChanged,
}: {
  issueId: string;
  people: Person[];
  viewer: SessionViewer | null;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [run, state] = useMutation<
    { needInfoRequest: { success: boolean; message?: string | null } },
    { input: { workId: string; targetId: string; question: string } }
  >(NEED_INFO_REQUEST_MUTATION, { refetchQueries: REFETCH });

  if (!viewer) return null;
  const choices = people.filter((person) => person.id !== viewer.id && person.actorKind !== 'SERVICE');

  if (!open) {
    return (
      <button type="button" className="ui-action" onClick={() => setOpen(true)}>
        Ask for info
      </button>
    );
  }

  async function submit() {
    setError(null);
    try {
      const result = (await run({ variables: { input: { workId: issueId, targetId, question: question.trim() } } })).data?.needInfoRequest;
      if (!result?.success) {
        setError(result?.message ?? 'Could not ask.');
        return;
      }
      setOpen(false);
      setQuestion('');
      setTargetId('');
      onChanged?.();
    } catch {
      setError('Could not ask.');
    }
  }

  return (
    <div className="request-actions" role="group" aria-label="Ask for info">
      <select aria-label="Who should answer" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
        <option value="">Choose who should answer</option>
        {choices.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name ?? person.email ?? person.id}
            {person.actorKind === 'AGENT' ? ' (agent)' : ''}
          </option>
        ))}
      </select>
      <textarea
        aria-label="What do you need to know"
        placeholder="What do you need to know? Their next comment here answers it."
        rows={2}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <button type="button" className="ui-action" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <button
        type="button"
        className="ui-action ui-action--accent"
        disabled={!targetId || !question.trim() || Boolean(state?.loading)}
        onClick={() => void submit()}
      >
        Send needinfo
      </button>
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Whoever raised an open needinfo takes it back; an admin may, with a reason (INV-1119). */
export function NeedInfoWithdrawButton({
  request,
  viewer,
  onChanged,
}: {
  request: AgentRequestSummary;
  viewer: SessionViewer | null;
  onChanged?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [run, state] = useMutation<
    { needInfoWithdraw: { success: boolean; message?: string | null } },
    { requestId: string; reason?: string | null }
  >(NEED_INFO_WITHDRAW_MUTATION, { refetchQueries: REFETCH });

  if (!viewer || !request.needInfo || !OPEN.has(request.state)) return null;
  const mine = request.requestedByActor?.id === viewer.id;
  if (!mine && viewer.globalRole !== 'ADMIN') return null;

  async function withdraw() {
    setError(null);
    const reason = mine ? null : window.prompt('Why are you withdrawing someone else\'s needinfo?')?.trim() || null;
    if (!mine && !reason) return;
    try {
      const result = (await run({ variables: { requestId: request.id, reason } })).data?.needInfoWithdraw;
      if (!result?.success) {
        setError(result?.message ?? 'Could not withdraw it.');
        return;
      }
      onChanged?.();
    } catch {
      setError('Could not withdraw it.');
    }
  }

  return (
    <>
      <button type="button" className="ui-action" disabled={Boolean(state?.loading)} onClick={() => void withdraw()}>
        Withdraw needinfo
      </button>
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </>
  );
}
