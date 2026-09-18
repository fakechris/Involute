import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { AGENTS_QUERY, AGENT_OWNER_CANDIDATES_QUERY } from '../board/queries';
import type { UserSummary } from '../board/types';

import { Btn } from '../components/Primitives';
import { readStoredTeamKey } from '../board/utils';

// Mirrors the server's AGENT_SCOPES; `answer` was missing here, so UI-issued agents could not reply to requests (INV-606).
const AGENT_SCOPES = ['read', 'propose', 'claim', 'report', 'update', 'link', 'answer'] as const;

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deriveHandle(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: 'Search, read context, list ready work',
  propose: 'Create candidate work',
  claim: 'Claim committed work',
  report: 'Report runs and attach evidence',
  update: 'Update non-contract fields',
  link: 'Create typed work links',
  answer: 'Answer requests addressed to this actor',
};

interface AgentCredentialSummary {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  user: { id: string; name: string; email: string };
}

interface AgentsQueryData {
  teams: { nodes: Array<{ id: string; key: string; name: string }> };
  agentCredentials: AgentCredentialSummary[];
}

const AGENTS_TAB_QUERY = gql`
  query AgentsTab($teamId: String!) {
    teams {
      nodes {
        id
        key
        name
      }
    }
    agentCredentials(teamId: $teamId) {
      id
      name
      scopes
      createdAt
      expiresAt
      revokedAt
      user {
        id
        name
        email
      }
    }
  }
`;

const AGENT_CREATE_MUTATION = gql`
  mutation AgentCredentialCreate($input: AgentCredentialCreateInput!) {
    agentCredentialCreate(input: $input) {
      success
      token
      credential {
        id
        name
        scopes
        user { id handle }
      }
    }
  }
`;

const AGENT_REVOKE_MUTATION = gql`
  mutation AgentCredentialRevoke($id: String!) {
    agentCredentialRevoke(id: $id) {
      success
    }
  }
`;

const inputStyle: React.CSSProperties = {
  width: '100%', height: 30, padding: '0 10px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-2)', fontSize: 14.5, color: 'var(--fg)',
};

export function AgentsTab() {
  const teamsQuery = useQuery<{ teams: AgentsQueryData['teams'] }>(gql`
    query AgentsTeams {
      teams {
        nodes {
          id
          key
          name
        }
      }
    }
  `);
  const teams = teamsQuery.data?.teams.nodes ?? [];
  const storedKey = readStoredTeamKey();
  const [teamKey, setTeamKey] = useState(storedKey ?? teams[0]?.key ?? '');
  const effectiveKey = teamKey || storedKey || teams[0]?.key || '';

  const { data, loading, refetch } = useQuery<AgentsQueryData>(AGENTS_TAB_QUERY, {
    variables: { teamId: effectiveKey },
    skip: !effectiveKey,
  });
  const [runCreate] = useMutation<
    { agentCredentialCreate: { success: boolean; token: string | null; credential: { id: string; name: string; scopes: string[]; user: { id: string; handle: string | null } } | null } },
    { input: { team: string; name: string; email?: string; scopes: string[]; expiresAt?: string; handle?: string; ownerId?: string; runtime?: string; description?: string; agentCardUrl?: string } }
  >(AGENT_CREATE_MUTATION);
  // What already exists, so the form can say "this handle is taken" or
  // "this will add a credential to X" before the server has to.
  const directory = useQuery<{ agents: UserSummary[] }>(AGENTS_QUERY, { variables: { teamKey: null } });
  const owners = useQuery<{ viewer: { id: string } | null; users: { nodes: Array<Pick<UserSummary, 'id' | 'name' | 'email' | 'actorKind' | 'deactivatedAt'>> } }>(AGENT_OWNER_CANDIDATES_QUERY);
  const viewerId = owners.data?.viewer?.id ?? null;
  const [runRevoke] = useMutation<{ agentCredentialRevoke: { success: boolean } }, { id: string }>(AGENT_REVOKE_MUTATION);

  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [runtime, setRuntime] = useState('');
  const [description, setDescription] = useState('');
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'propose', 'claim', 'report', 'answer']);
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; handle: string | null } | null>(null);

  const credentials = useMemo(() => data?.agentCredentials ?? [], [data]);
  const agents = useMemo(() => directory.data?.agents ?? [], [directory.data]);
  const humans = useMemo(
    () => (owners.data?.users.nodes ?? []).filter((user) => user.actorKind === 'HUMAN' && !user.deactivatedAt),
    [owners.data],
  );
  const effectiveOwnerId = ownerId || viewerId || '';
  const effectiveHandle = handleTouched ? handle.trim().toLowerCase() : deriveHandle(name);
  const trimmedEmail = email.trim().toLowerCase();
  const existingByEmail = trimmedEmail ? agents.find((agent) => agent.email?.toLowerCase() === trimmedEmail) ?? null : null;
  const handleOwner = effectiveHandle ? agents.find((agent) => agent.handle === effectiveHandle) ?? null : null;
  const handleTaken = Boolean(handleOwner && (!existingByEmail || handleOwner.id !== existingByEmail.id));
  const handleInvalid = Boolean(effectiveHandle) && !HANDLE_PATTERN.test(effectiveHandle);
  const emailInvalid = Boolean(trimmedEmail) && !EMAIL_SHAPE.test(trimmedEmail);
  const canSubmit = Boolean(name.trim() && effectiveKey && !pending && !handleTaken && !handleInvalid && !emailInvalid);

  function toggleScope(scope: string) {
    if (scope === 'read') return;
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function handleCreate() {
    if (!name.trim() || !effectiveKey) return;
    setError(null);
    setPending(true);
    try {
      const result = await runCreate({
        variables: {
          input: {
            team: effectiveKey,
            name: name.trim(),
            ...(trimmedEmail ? { email: trimmedEmail } : {}),
            ...(effectiveHandle ? { handle: effectiveHandle } : {}),
            ...(effectiveOwnerId ? { ownerId: effectiveOwnerId } : {}),
            ...(runtime.trim() ? { runtime: runtime.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(agentCardUrl.trim() ? { agentCardUrl: agentCardUrl.trim() } : {}),
            scopes,
            ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
          },
        },
      });
      const payload = result.data?.agentCredentialCreate;
      if (!payload?.success || !payload?.token) {
        setError('Could not issue the credential. Check the handle and email, and that you may manage this team.');
        return;
      }
      setFresh({ token: payload.token, handle: payload.credential?.user.handle ?? null });
      setName('');
      setHandle('');
      setHandleTouched(false);
      setEmail('');
      setRuntime('');
      setDescription('');
      setAgentCardUrl('');
      await Promise.all([refetch(), directory.refetch()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not issue the credential.');
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!window.confirm('Revoke this credential? Connected agents lose access immediately.')) return;
    setError(null);
    try {
      await runRevoke({ variables: { id } });
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke the credential.');
    }
  }

  return (
    <>
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 4px', color: 'var(--fg)' }}>Agents</h2>
      <p style={{ fontSize: 14.5, color: 'var(--fg-dim)', margin: '0 0 24px' }}>
        Issue revocable MCP tokens for AI agents. Tokens are shown once and work on
        <span className="mono"> /mcp </span> only. Only team owners can manage them.
      </p>

      {teams.length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 13.5, color: 'var(--fg-dim)', display: 'block', marginBottom: 6 }}>Team</label>
          <select value={effectiveKey} onChange={(e) => setTeamKey(e.target.value)} style={inputStyle}>
            {teams.map((t) => (
              <option key={t.id} value={t.key}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {fresh && (
        <div style={{
          border: '1px solid var(--border-warning, var(--border))', borderRadius: 'var(--r-3)',
          padding: '12px 14px', marginBottom: 20, background: 'var(--bg-raised)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Copy this token now — it will not be shown again.</div>
          <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }}>{fresh.token}</div>
          {fresh.handle ? (
            <div style={{ marginTop: 8, fontSize: 13.5, color: 'var(--fg-dim)' }}>
              Mention as <span className="mono">@{fresh.handle}</span> · <Link to={`/agents/${fresh.handle}`}>open its page</Link>
            </div>
          ) : null}
          <div style={{ marginTop: 10 }}>
            <Btn variant="subtle" size="md" onClick={() => { void navigator.clipboard?.writeText(fresh.token); }}>Copy token</Btn>
            {' '}
            <Btn variant="ghost" size="md" onClick={() => setFresh(null)}>Done</Btn>
          </div>
        </div>
      )}

      {error && <div style={{ color: 'var(--fg-danger, #f87171)', fontSize: 14, marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div style={{ padding: 20, color: 'var(--fg-dim)', fontSize: 14 }}>Loading agents…</div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-3)', overflow: 'hidden', marginBottom: 24 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 220px 90px', padding: '8px 12px',
            background: 'var(--bg-sunken)', fontSize: 13, color: 'var(--fg-dim)', fontWeight: 500,
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <div>Agent</div>
            <div>Scopes</div>
            <div />
          </div>
          {credentials.length === 0 && (
            <div style={{ padding: '14px 12px', fontSize: 14, color: 'var(--fg-dim)' }}>No agent credentials yet.</div>
          )}
          {credentials.map((cred, i) => (
            <div key={cred.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 220px 90px', padding: '10px 12px',
              alignItems: 'center', fontSize: 14.5,
              borderBottom: i < credentials.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              opacity: cred.revokedAt ? 0.55 : 1,
            }}>
              <div>
                <div style={{ color: 'var(--fg)' }}>{cred.name}</div>
                <div style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{cred.user.email}</div>
              </div>
              <div className="mono" style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>{cred.scopes.join(', ')}</div>
              <div style={{ textAlign: 'right' }}>
                {!cred.revokedAt && <Btn variant="ghost" size="md" onClick={() => void handleRevoke(cred.id)}>Revoke</Btn>}
                {cred.revokedAt && <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>revoked</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: 15, fontWeight: 500, margin: '0 0 12px', color: 'var(--fg)' }}>Issue a credential</h3>
      <div style={{ display: 'grid', gap: 12, maxWidth: 460 }}>
        <input style={inputStyle} aria-label="Agent name" placeholder="Agent name (e.g. Codex review)" value={name} onChange={(e) => setName(e.target.value)} />
        <div>
          <input
            style={inputStyle}
            aria-label="Handle"
            placeholder="Handle (mention as @handle)"
            value={effectiveHandle}
            onChange={(e) => { setHandleTouched(true); setHandle(e.target.value); }}
          />
          {handleTaken ? (
            <div role="alert" style={{ fontSize: 13, color: 'var(--danger)', marginTop: 4 }}>
              @{effectiveHandle} already belongs to {handleOwner?.name ?? handleOwner?.email ?? 'another actor'}. Pick another handle.
            </div>
          ) : handleInvalid ? (
            <div role="alert" style={{ fontSize: 13, color: 'var(--danger)', marginTop: 4 }}>
              Handles are 1–32 characters of a-z, 0-9, _ or -.
            </div>
          ) : null}
        </div>
        <div>
          <input style={inputStyle} aria-label="Email" placeholder="Email (optional, generated if blank)" value={email} onChange={(e) => setEmail(e.target.value)} />
          {emailInvalid ? (
            <div role="alert" style={{ fontSize: 13, color: 'var(--danger)', marginTop: 4 }}>That is not an email address.</div>
          ) : existingByEmail ? (
            <div style={{ fontSize: 13, color: 'var(--fg-dim)', marginTop: 4 }}>
              This adds a credential to the existing actor {existingByEmail.name ?? existingByEmail.email}
              {existingByEmail.handle ? ` (@${existingByEmail.handle})` : ''}; no new actor is created.
            </div>
          ) : null}
        </div>
        <div>
          <label style={{ fontSize: 13.5, color: 'var(--fg-dim)', display: 'block', marginBottom: 6 }} htmlFor="agent-owner">Accountable owner</label>
          <select id="agent-owner" style={inputStyle} value={effectiveOwnerId} onChange={(e) => setOwnerId(e.target.value)}>
            {humans.length === 0 ? <option value="">{owners.loading ? 'Loading people…' : 'You'}</option> : null}
            {humans.map((user) => (
              <option key={user.id} value={user.id}>{user.name ?? user.email ?? user.id}{user.id === viewerId ? ' (you)' : ''}</option>
            ))}
          </select>
        </div>
        <input style={inputStyle} aria-label="Runtime" placeholder="Runtime (e.g. codex, claude-code)" value={runtime} onChange={(e) => setRuntime(e.target.value)} />
        <input style={inputStyle} aria-label="Description" placeholder="What this agent does (shown in the directory)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input style={inputStyle} aria-label="Agent card URL" placeholder="Agent card URL (optional)" value={agentCardUrl} onChange={(e) => setAgentCardUrl(e.target.value)} />
        <div>
          <div style={{ fontSize: 13.5, color: 'var(--fg-dim)', marginBottom: 6 }}>Scopes (Linear-style; read is always granted)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {AGENT_SCOPES.map((scope) => (
              <label key={scope} title={SCOPE_DESCRIPTIONS[scope]} style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5,
                padding: '4px 10px', borderRadius: 'var(--r-2)',
                border: '1px solid var(--border)', cursor: scope === 'read' ? 'default' : 'pointer',
                opacity: scope === 'read' ? 0.7 : 1,
              }}>
                <input type="checkbox" checked={scopes.includes(scope)} disabled={scope === 'read'} onChange={() => toggleScope(scope)} />
                <span className="mono">{scope}</span>
              </label>
            ))}
          </div>
        </div>
        <input style={inputStyle} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Expiry date (optional)" />
        <div>
          <Btn variant="primary" size="md" disabled={!canSubmit} onClick={() => void handleCreate()}>
            {pending ? 'Issuing…' : 'Issue credential'}
          </Btn>
        </div>
      </div>
    </>
  );
}
