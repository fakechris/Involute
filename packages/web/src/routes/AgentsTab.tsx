import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';

import { Btn } from '../components/Primitives';
import { readStoredTeamKey } from '../board/utils';

const AGENT_SCOPES = ['read', 'propose', 'claim', 'report', 'update', 'link'] as const;

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: 'Search, read context, list ready work',
  propose: 'Create candidate work',
  claim: 'Claim committed work',
  report: 'Report runs and attach evidence',
  update: 'Update non-contract fields',
  link: 'Create typed work links',
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

const AGENTS_QUERY = gql`
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

  const { data, loading, refetch } = useQuery<AgentsQueryData>(AGENTS_QUERY, {
    variables: { teamId: effectiveKey },
    skip: !effectiveKey,
  });
  const [runCreate] = useMutation<
    { agentCredentialCreate: { success: boolean; token: string | null; credential: { id: string; name: string; scopes: string[] } | null } },
    { input: { team: string; name: string; email?: string; scopes: string[]; expiresAt?: string } }
  >(AGENT_CREATE_MUTATION);
  const [runRevoke] = useMutation<{ agentCredentialRevoke: { success: boolean } }, { id: string }>(AGENT_REVOKE_MUTATION);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'propose', 'claim', 'report']);
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const credentials = useMemo(() => data?.agentCredentials ?? [], [data]);

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
            ...(email.trim() ? { email: email.trim() } : {}),
            scopes,
            ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
          },
        },
      });
      const payload = result.data?.agentCredentialCreate;
      if (!payload?.success || !payload?.token) {
        setError('Could not issue the credential. Only team owners can manage agents.');
        return;
      }
      setFreshToken(payload.token);
      setName('');
      setEmail('');
      await refetch();
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

      {freshToken && (
        <div style={{
          border: '1px solid var(--border-warning, var(--border))', borderRadius: 'var(--r-3)',
          padding: '12px 14px', marginBottom: 20, background: 'var(--bg-raised)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Copy this token now — it will not be shown again.</div>
          <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }}>{freshToken}</div>
          <div style={{ marginTop: 10 }}>
            <Btn variant="subtle" size="md" onClick={() => { void navigator.clipboard?.writeText(freshToken); }}>Copy token</Btn>
            {' '}
            <Btn variant="ghost" size="md" onClick={() => setFreshToken(null)}>Done</Btn>
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
        <input style={inputStyle} placeholder="Agent name (e.g. Codex review)" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={inputStyle} placeholder="Email (optional, generated if blank)" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          <Btn variant="primary" size="md" disabled={!name.trim() || pending || !effectiveKey} onClick={() => void handleCreate()}>
            {pending ? 'Issuing…' : 'Issue credential'}
          </Btn>
        </div>
      </div>
    </>
  );
}
