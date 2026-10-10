import { useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { AGENT_REQUEST_ANSWER_MUTATION, AGENT_REQUEST_REPLY_MUTATION } from '../board/queries';
import type { SessionViewer } from '../lib/session';
import type { WorkContextRequest } from '../work/types';

const OPEN = new Set(['SUBMITTED', 'WORKING', 'submitted', 'working']);
const ASKED_BACK = new Set(['INPUT_REQUIRED', 'input-required']);
// The Needs you queue drops a request once it is replied to or answered (INV-1092).
const REFETCH = ['WorkContextPage', 'IssuePage', 'AttentionPage'];

type AnswerState = 'completed' | 'failed' | 'input-required';

/**
 * What a person can do with a request on the work page itself (INV-794):
 * the person it is addressed to answers it (done, cannot do it, or ask back);
 * the person who asked replies when it was asked back. An admin can act for
 * either, saying why. Nothing here for anyone else.
 */
export function AgentRequestActions({ request, viewer }: { request: WorkContextRequest; viewer: SessionViewer | null }) {
  const [body, setBody] = useState('');
  const [state, setState] = useState<AnswerState>('completed');
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runAnswer, answerState] = useMutation<
    { agentRequestAnswer: { success: boolean; message?: string | null } },
    { input: { requestId: string; body: string; state: AnswerState; overrideReason?: string | null } }
  >(AGENT_REQUEST_ANSWER_MUTATION, { refetchQueries: REFETCH });
  const [runReply, replyState] = useMutation<
    { agentRequestReply: { success: boolean; message?: string | null } },
    { requestId: string; body: string; overrideReason?: string | null }
  >(AGENT_REQUEST_REPLY_MUTATION, { refetchQueries: REFETCH });

  if (!viewer) return null;
  const isAdmin = viewer.globalRole === 'ADMIN';
  const answering = OPEN.has(request.state) && (request.targetActor.id === viewer.id || isAdmin);
  const replying = ASKED_BACK.has(request.state) && (request.requestedByActor?.id === viewer.id || isAdmin);
  if (!answering && !replying) return null;
  const onBehalf = answering ? request.targetActor.id !== viewer.id : request.requestedByActor?.id !== viewer.id;
  const pending = Boolean(answerState?.loading || replyState?.loading);

  async function submit() {
    setError(null);
    const reason = onBehalf ? overrideReason.trim() : null;
    try {
      const ok = answering
        ? (await runAnswer({ variables: { input: { requestId: request.id, body: body.trim(), state, overrideReason: reason } } })).data?.agentRequestAnswer
        : (await runReply({ variables: { requestId: request.id, body: body.trim(), overrideReason: reason } })).data?.agentRequestReply;
      if (!ok?.success) {
        setError(ok?.message ?? 'Could not send it.');
        return;
      }
      setBody('');
    } catch {
      setError('Could not send it.');
    }
  }

  const label = answering ? 'Answer' : 'Reply to agent';
  return (
    <div className="request-actions">
      <textarea
        aria-label={answering ? `Answer request ${request.id}` : `Reply to request ${request.id}`}
        placeholder={answering ? 'Your answer' : 'Answer the question it asked back'}
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {answering ? (
        <select aria-label="Answer as" value={state} onChange={(event) => setState(event.target.value as AnswerState)}>
          <option value="completed">Done</option>
          <option value="failed">Cannot do it</option>
          <option value="input-required">Ask back</option>
        </select>
      ) : null}
      {onBehalf ? (
        <input
          aria-label="Why you are acting on their behalf"
          placeholder="Why you are acting on their behalf"
          value={overrideReason}
          onChange={(event) => setOverrideReason(event.target.value)}
        />
      ) : null}
      <button
        type="button"
        className="ui-action ui-action--accent"
        disabled={!body.trim() || (onBehalf && !overrideReason.trim()) || pending}
        onClick={() => void submit()}
      >
        {onBehalf ? `${label} on their behalf` : label}
      </button>
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
