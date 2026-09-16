import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AGENTS_QUERY, AGENT_PROFILE_QUERY } from '../board/queries';
import type { UserSummary } from '../board/types';
import { ActorBadge } from '../components/ActorBadge';

interface AgentTimelineEntry {
  at: string;
  kind: string;
  detail: string | null;
  workIdentifier: string | null;
}

interface AgentProfileData {
  agentProfile: {
    actor: UserSummary;
    counts: {
      proposedWork: number;
      openRequests: number;
      answeredRequests: number;
      runs: number;
      evidence: number;
    };
    credentials: AgentCredentialSummary[];
    timeline: AgentTimelineEntry[];
  } | null;
}

interface AgentCredentialSummary {
  id: string;
  name: string;
  scopes: string[];
  teamKey: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/**
 * The directory, and one agent's page.
 *
 * Until this existed the only way to see which agents are in the system was to
 * read the credential list in Settings, which answers "what tokens exist" and
 * not "who can I ask".
 */
export function AgentsPage() {
  const { handle } = useParams<{ handle?: string }>();

  return handle ? <AgentProfile handle={handle} /> : <AgentList />;
}

function AgentList() {
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<{ agents: UserSummary[] }>(AGENTS_QUERY, {
    variables: { teamKey: null },
  });

  const agents = useMemo(() => data?.agents ?? [], [data]);

  if (loading) {
    return <div className="page-shell"><p>Loading agents…</p></div>;
  }

  if (error) {
    return <div className="page-shell"><p>Could not load agents: {error.message}</p></div>;
  }

  return (
    <div className="page-shell">
      <header className="page-shell__header">
        <h1>Agents</h1>
        <p className="agent-directory__meta">
          {agents.length} actor{agents.length === 1 ? '' : 's'}. Only agents with a handle can be
          mentioned.
        </p>
      </header>

      {agents.length === 0 ? (
        <p className="discussion-empty">No agent actors yet.</p>
      ) : (
        <ul className="agent-directory__list">
          {agents.map((agent) => (
            <li key={agent.id} className="agent-directory__row">
              <ActorBadge
                actor={agent}
                onSelect={(picked) => navigate(`/agents/${picked}`)}
              />
              {agent.description ? (
                <span className="agent-directory__meta">{agent.description}</span>
              ) : null}
              {!agent.handle ? (
                <span className="agent-directory__meta">
                  No handle — cannot be mentioned. Re-issue its credential with --handle.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatStamp(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

function AgentProfile({ handle }: { handle: string }) {
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<AgentProfileData>(AGENT_PROFILE_QUERY, {
    variables: { handle },
  });

  if (loading) {
    return <div className="page-shell"><p>Loading @{handle}…</p></div>;
  }

  if (error) {
    return <div className="page-shell"><p>Could not load @{handle}: {error.message}</p></div>;
  }

  const profile = data?.agentProfile;

  if (!profile) {
    return (
      <div className="page-shell">
        <p>No agent with handle @{handle}.</p>
        <button type="button" className="ui-action ui-action--subtle" onClick={() => navigate('/agents')}>
          Back to agents
        </button>
      </div>
    );
  }

  const { actor, counts, credentials, timeline } = profile;

  return (
    <div className="page-shell">
      <header className="page-shell__header">
        <button type="button" className="ui-action ui-action--subtle" onClick={() => navigate('/agents')}>
          ← Agents
        </button>
        <h1>
          <ActorBadge actor={actor} />
        </h1>
        {actor.description ? (
          <p className="agent-directory__meta">{actor.description}</p>
        ) : null}
        {actor.agentCardUrl ? (
          <p className="agent-directory__meta">
            Agent card: <code>{actor.agentCardUrl}</code>
          </p>
        ) : null}
      </header>

      <div className="agent-directory__counts" aria-label="Activity counts">
        <span>proposed {counts.proposedWork}</span>
        <span>open requests {counts.openRequests}</span>
        <span>answered {counts.answeredRequests}</span>
        <span>runs {counts.runs}</span>
        <span>evidence {counts.evidence}</span>
      </div>

      <section className="issue-panel__section">
        <span className="issue-panel__label">Origin</span>
        {credentials.length === 0 ? (
          <p className="discussion-empty">
            No credential on record — this actor cannot authenticate, so it can never answer.
          </p>
        ) : (
          <ul className="agent-directory__list">
            {credentials.map((credential) => (
              <li key={credential.id} className="agent-directory__row">
                <span>
                  <strong>{credential.name}</strong>
                  {credential.teamKey ? <span className="actor-badge__handle"> {credential.teamKey}</span> : null}
                  {credential.revokedAt ? <span className="actor-badge__kind"> REVOKED</span> : null}
                </span>
                <span className="agent-directory__meta">
                  created {formatStamp(credential.createdAt)}
                  {credential.expiresAt ? ` · expires ${formatStamp(credential.expiresAt)}` : ''}
                </span>
                <span className="agent-directory__meta">scopes: {credential.scopes.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="issue-panel__section">
        <span className="issue-panel__label">Recent activity</span>
        {timeline.length === 0 ? (
          <p className="discussion-empty">Nothing recorded yet.</p>
        ) : (
          <ol className="agent-timeline">
            {timeline.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="agent-timeline__entry">
                <span className="agent-timeline__kind">{entry.kind}</span>
                {entry.workIdentifier ? (
                  <button
                    type="button"
                    className="actor-badge__name--link"
                    onClick={() => navigate(`/issue/${entry.workIdentifier}`)}
                  >
                    {entry.workIdentifier}
                  </button>
                ) : null}
                <span>{entry.detail}</span>
                <time dateTime={entry.at}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }).format(new Date(entry.at))}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
