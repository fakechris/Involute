import { useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { COMMENT_CREATE_MUTATION } from '../board/queries';
import type { CommentCreateMutationVariables } from '../board/types';

/**
 * Answer an agent that asked for a decision (INV-794): the reply is a comment
 * that mentions the agent, which opens a request the agent picks up — the
 * same path as an @mention anywhere else, so nothing new to learn or poll.
 */
export function RespondToAgent({ workId, agent }: { workId: string; agent: { id: string; handle: string | null; name: string | null } }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [runComment, state] = useMutation<{ commentCreate: { success: boolean } }, CommentCreateMutationVariables>(COMMENT_CREATE_MUTATION, {
    refetchQueries: ['WorkContextPage'],
  });
  if (!agent.handle) return null;

  async function send() {
    setError(null);
    setSent(false);
    try {
      const result = await runComment({ variables: { input: { issueId: workId, body: `@${agent.handle} ${body.trim()}` } } });
      if (!result.data?.commentCreate.success) {
        setError('Could not send the reply.');
        return;
      }
      setBody('');
      setSent(true);
    } catch {
      setError('Could not send the reply.');
    }
  }

  return (
    <div className="request-actions">
      <textarea
        aria-label={`Respond to @${agent.handle}`}
        placeholder={`Your decision for @${agent.handle}; it gets a request to act on`}
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <button type="button" className="ui-action ui-action--accent" disabled={!body.trim() || state?.loading} onClick={() => void send()}>
        Respond to the agent
      </button>
      {sent ? <span role="status">Sent to @{agent.handle}.</span> : null}
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
