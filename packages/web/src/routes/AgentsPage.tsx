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
    receipts: AgentReceiptEntry[];
    timeline: AgentTimelineEntry[];
  } | null;
}

interface ReceiptReference { kind: string; ref: string; version: string | null; digest: string | null; excerpt: string | null; preserved: boolean }
interface AgentReceiptEntry {
  auditId: string;
  surface: string | null;
  work: { id: string; identifier: string; title: string };
  receipt: {
    id: string; reasoning: string; runtime: string | null; sessionId: string | null; contractRevision: number; createdAt: string;
    actor: { id: string; name: string | null; handle: string | null; actorKind: string };
    evidence: ReceiptReference[]; inputs: ReceiptReference[];
  };
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
              <span className="agent-directory__meta">
                {agent.owner
                  ? `owner: ${agent.owner.name ?? agent.owner.handle ?? agent.owner.id}`
                  : 'no owner recorded — nobody is accountable for this actor'}
                {agent.deactivatedAt ? ' · deactivated' : ''}
              </span>
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

  const { actor, counts, credentials, receipts, timeline } = profile;

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
        <p className="agent-directory__meta">
          {actor.owner
            ? `Accountable owner: ${actor.owner.name ?? actor.owner.handle ?? actor.owner.id}`
            : 'No owner recorded.'}
          {actor.deactivatedAt ? ` · Deactivated ${formatStamp(actor.deactivatedAt)}` : ''}
        </p>
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
        <span className="issue-panel__label">Decision receipts</span>
        <p className="discussion-empty" style={{ marginTop: 0 }}>
          The actor's own account of what it knew and why it decided — a claim by the actor, bound to the audited write it explains. Not verified by the system.
        </p>
        {receipts.length === 0 ? (
          <p className="discussion-empty">No receipts recorded.</p>
        ) : (
          <ul className="agent-directory__list">
            {receipts.map((entry) => (
              <li key={entry.receipt.id} className="agent-directory__row" id={`receipt-${entry.receipt.id}`}>
                <details className="decision-receipt" style={{ marginTop: 0 }}>
                  <summary>
                    <strong>Claimed by {entry.receipt.actor.handle ? `@${entry.receipt.actor.handle}` : entry.receipt.actor.name}</strong>
                    {entry.receipt.sessionId ? ` in session ${entry.receipt.sessionId}` : ' (no session recorded)'}
                    {entry.receipt.runtime ? ` on ${entry.receipt.runtime}` : ''}
                    {` at ${formatStamp(entry.receipt.createdAt)}`}
                    {' · '}
                    <button type="button" className="actor-badge__name--link" onClick={() => navigate(`/issue/${entry.work.identifier}`)}>{entry.work.identifier}</button>
                    {entry.surface ? <span className="agent-directory__meta"> · {entry.surface}</span> : null}
                    {' · '}
                    <button type="button" className="actor-badge__name--link" onClick={() => navigate(`/work/${entry.work.id}#audit-${entry.auditId}`)}>audit</button>
                    <span className="agent-directory__meta"> · contract rev {entry.receipt.contractRevision}</span>
                    {' — '}
                    <span>{entry.receipt.reasoning.length > 160 ? `${entry.receipt.reasoning.slice(0, 160)}…` : entry.receipt.reasoning}</span>
                  </summary>
                  <p className="decision-receipt__reasoning">{entry.receipt.reasoning}</p>
                  {([['Relied on (evidence)', entry.receipt.evidence], ['Read (inputs)', entry.receipt.inputs]] as const).map(([label, refs]) =>
                    refs.length > 0 ? (
                      <div key={label} className="decision-receipt__refs">
                        <strong>{label}</strong>
                        <ul>
                          {refs.map((ref, index) => (
                            <li key={`${ref.kind}-${ref.ref}-${index}`}>
                              <span className="mono">{ref.kind}</span> {ref.ref}
                              {ref.version ? ` @ ${ref.version}` : ''}
                              {ref.digest ? ` (${ref.digest})` : ''}
                              {' · '}
                              <span className="agent-directory__meta">{ref.preserved ? 'preserved' : 'pointer only — not frozen'}</span>
                              {ref.excerpt ? <blockquote>{ref.excerpt}</blockquote> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null,
                  )}
                </details>
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
                <span className="agent-timeline__kind" title={entry.kind === 'decided' ? "The actor's own claim (decision receipt), not a verified fact" : undefined}>
                  {entry.kind === 'decided' ? 'claimed' : entry.kind}
                </span>
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
