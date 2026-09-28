import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  ADMIN_MEMBERS_QUERY,
  ADMIN_TEAMS_QUERY,
  TEAM_ARCHIVE_MUTATION,
  TEAM_CREATE_MUTATION,
  TEAM_UNARCHIVE_MUTATION,
  USER_INVITE_MUTATION,
  USER_INVITE_REVOKE_MUTATION,
  USER_REACTIVATE_MUTATION,
  USER_SUSPEND_MUTATION,
  WORKSPACE_SECURITY_QUERY,
  WORKSPACE_SETTINGS_UPDATE_MUTATION,
} from '../board/queries';
import { USER_SET_GLOBAL_ROLE_MUTATION, type Refusable } from './settings-queries';
import { NoticeLine, attempt, inputStyle, rowStyle, type Notice } from './WorkspaceSettingsTabs';

// Settings → Administration (INV-849, docs/permissions.md §7). Admins only;
// the server refuses everyone else, so these tabs are shown to admins.

type WorkspaceRole = 'ADMIN' | 'USER' | 'GUEST';
type TeamRole = 'VIEWER' | 'EDITOR' | 'OWNER';

const ROLE_LABEL: Record<WorkspaceRole, string> = { ADMIN: 'Admin', USER: 'Member', GUEST: 'Guest' };
const TEAM_ROLE_LABEL: Record<TeamRole, string> = { VIEWER: 'Viewer', EDITOR: 'Member', OWNER: 'Owner' };
const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', PENDING: 'Pending invite', SUSPENDED: 'Suspended' };

interface AdminPerson {
  id: string;
  name: string | null;
  email: string | null;
  actorKind: 'HUMAN' | 'AGENT' | 'SERVICE';
  globalRole: WorkspaceRole;
  accessStatus: 'ACTIVE' | 'PENDING' | 'SUSPENDED';
  lastSeenAt: string | null;
  invitedAt: string | null;
  teamMemberships: Array<{ role: TeamRole; team: { id: string; key: string; name: string } }>;
}

interface TeamOption { id: string; key: string; name: string }

function sectionIntro(title: string, text: string) {
  return (
    <>
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 4px' }}>{title}</h2>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: '0 0 12px' }}>{text}</p>
    </>
  );
}

function formatDate(iso: string | null): string {
  return iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso)) : '—';
}

// --- Members ---------------------------------------------------------------

export function AdminMembersTab() {
  const { data, loading, error, refetch } = useQuery<{ users: { nodes: AdminPerson[] }; teams: { nodes: TeamOption[] }; viewer: { id: string } | null }>(ADMIN_MEMBERS_QUERY);
  const [runInvite] = useMutation<{ userInvite: Refusable<object> }>(USER_INVITE_MUTATION);
  const [runRevoke] = useMutation<{ userInviteRevoke: Refusable<object> }>(USER_INVITE_REVOKE_MUTATION);
  const [runSuspend] = useMutation<{ userSuspend: Refusable<object> }>(USER_SUSPEND_MUTATION);
  const [runReactivate] = useMutation<{ userReactivate: Refusable<object> }>(USER_REACTIVATE_MUTATION);
  const [runSetRole] = useMutation<{ userSetGlobalRole: Refusable<object> }>(USER_SET_GLOBAL_ROLE_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('USER');
  const [inviteTeams, setInviteTeams] = useState<Record<string, TeamRole | ''>>({});

  const people = useMemo(
    () => (data?.users.nodes ?? [])
      .filter((user) => user.actorKind === 'HUMAN')
      .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '')),
    [data],
  );
  const teams = data?.teams.nodes ?? [];
  const viewerId = data?.viewer?.id ?? null;

  if (error) return <p role="alert">Could not load people: {error.message}</p>;
  if (loading && !data) return <p role="status">Loading…</p>;

  const who = (user: AdminPerson) => user.name ?? user.email ?? 'this person';
  const refreshOn = (ok: boolean) => { if (ok) void refetch(); };

  function changeRole(user: AdminPerson, role: WorkspaceRole) {
    const reason = window.prompt(`Why make ${who(user)} ${ROLE_LABEL[role].toLowerCase() === 'admin' ? 'an admin' : `a ${ROLE_LABEL[role].toLowerCase()}`}?`);
    if (reason === null) return;
    void attempt(
      () => runSetRole({ variables: { userId: user.id, role, reason: reason.trim() || null } }),
      (d) => d.userSetGlobalRole,
      `${who(user)} is now ${ROLE_LABEL[role]}.`,
      setNotice,
    ).then(refreshOn);
  }

  function suspend(user: AdminPerson) {
    const reason = window.prompt(`Why suspend ${who(user)}? They are signed out now and cannot sign in until reactivated.`);
    if (reason === null) return;
    void attempt(() => runSuspend({ variables: { id: user.id, reason: reason.trim() || null } }), (d) => d.userSuspend, `${who(user)} is suspended.`, setNotice).then(refreshOn);
  }

  function reactivate(user: AdminPerson) {
    void attempt(() => runReactivate({ variables: { id: user.id } }), (d) => d.userReactivate, `${who(user)} can sign in again.`, setNotice).then(refreshOn);
  }

  function revoke(user: AdminPerson) {
    if (!window.confirm(`Revoke the invite for ${user.email}?`)) return;
    void attempt(() => runRevoke({ variables: { id: user.id } }), (d) => d.userInviteRevoke, `The invite for ${user.email} is revoked.`, setNotice).then(refreshOn);
  }

  function invite() {
    const email = inviteEmail.trim();
    if (!email) return;
    const chosen = Object.entries(inviteTeams)
      .filter((entry): entry is [string, TeamRole] => Boolean(entry[1]))
      .map(([teamId, role]) => ({ role, teamId }));
    void attempt(
      () => runInvite({ variables: { input: { email, role: inviteRole, teams: chosen } } }),
      (d) => d.userInvite,
      `${email} is invited. They can sign in with Google using that address.`,
      setNotice,
    ).then((ok) => {
      if (!ok) return;
      setInviteEmail('');
      setInviteTeams({});
      void refetch();
    });
  }

  return (
    <section aria-label="Members">
      {sectionIntro('Members', 'Everyone in the workspace. Only invited people and approved domains can sign in; suspended people are signed out and refused. Each change is recorded with who made it.')}
      <NoticeLine notice={notice} />

      <div className="admin-invite" aria-label="Invite">
        <h3 style={{ fontSize: 15, fontWeight: 500, margin: '0 0 8px' }}>Invite</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inputStyle, flex: 1, minWidth: 220 }} aria-label="Invite email" placeholder="name@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <select style={inputStyle} aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}>
            <option value="USER">Member</option>
            <option value="GUEST">Guest</option>
            <option value="ADMIN">Admin</option>
          </select>
          <button type="button" className="ui-action ui-action--primary" disabled={!inviteEmail.trim()} onClick={invite}>Send invite</button>
        </div>
        {teams.length > 0 ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8, fontSize: 13.5, color: 'var(--fg-dim)' }}>
            <span>Add to teams:</span>
            {teams.map((team) => (
              <label key={team.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                {team.key}
                <select
                  aria-label={`Role in ${team.key}`}
                  style={{ ...inputStyle, height: 24 }}
                  value={inviteTeams[team.id] ?? ''}
                  onChange={(e) => setInviteTeams((current) => ({ ...current, [team.id]: e.target.value as TeamRole | '' }))}
                >
                  <option value="">—</option>
                  <option value="VIEWER">Viewer</option>
                  <option value="EDITOR">Member</option>
                  {inviteRole !== 'GUEST' ? <option value="OWNER">Owner</option> : null}
                </select>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div role="table" aria-label="People" style={{ marginTop: 16 }}>
        {people.map((user) => (
          <div key={user.id} role="row" style={{ ...rowStyle, flexWrap: 'wrap' }}>
            <span role="cell" style={{ flex: '1 1 200px', minWidth: 0 }}>
              <span style={{ fontSize: 14.5 }}>{user.name ?? user.email}</span>
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--fg-dim)' }}>{user.email}</span>
            </span>
            <span role="cell" style={{ flex: '1 1 140px', fontSize: 12.5, color: 'var(--fg-dim)' }}>
              {user.teamMemberships.length === 0
                ? 'No team'
                : user.teamMemberships.map((m) => `${m.team.key} · ${TEAM_ROLE_LABEL[m.role]}`).join(', ')}
            </span>
            <span role="cell" style={{ width: 110, fontSize: 12.5, color: user.accessStatus === 'ACTIVE' ? 'var(--fg-dim)' : 'var(--warning, #b45309)' }}>
              {STATUS_LABEL[user.accessStatus] ?? user.accessStatus}
              <span style={{ display: 'block', color: 'var(--fg-dim)' }}>
                {user.accessStatus === 'PENDING' ? `invited ${formatDate(user.invitedAt)}` : `seen ${formatDate(user.lastSeenAt)}`}
              </span>
            </span>
            <span role="cell">
              <select
                aria-label={`Workspace role for ${who(user)}`}
                style={inputStyle}
                value={user.globalRole}
                disabled={user.id === viewerId}
                title={user.id === viewerId ? 'Another admin changes your role.' : undefined}
                onChange={(e) => changeRole(user, e.target.value as WorkspaceRole)}
              >
                <option value="ADMIN">Admin</option>
                <option value="USER">Member</option>
                <option value="GUEST">Guest</option>
              </select>
            </span>
            <span role="cell" style={{ width: 120, textAlign: 'right' }}>
              {user.accessStatus === 'PENDING' ? (
                <button type="button" className="ui-action ui-action--subtle" onClick={() => revoke(user)}>Revoke invite</button>
              ) : user.accessStatus === 'SUSPENDED' ? (
                <button type="button" className="ui-action ui-action--subtle" onClick={() => reactivate(user)}>Reactivate</button>
              ) : user.id !== viewerId ? (
                <button type="button" className="ui-action ui-action--subtle" onClick={() => suspend(user)}>Suspend</button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// --- Teams -----------------------------------------------------------------

interface AdminTeam {
  id: string;
  key: string;
  name: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  archivedAt: string | null;
  memberships: { nodes: Array<{ role: TeamRole; user: { id: string; name: string | null; email: string | null } }> };
}

export function AdminTeamsTab() {
  const { data, loading, error, refetch } = useQuery<{ teams: { nodes: AdminTeam[] } }>(ADMIN_TEAMS_QUERY);
  const [runCreate] = useMutation<{ teamCreate: Refusable<object> }>(TEAM_CREATE_MUTATION);
  const [runArchive] = useMutation<{ teamArchive: Refusable<object> }>(TEAM_ARCHIVE_MUTATION);
  const [runUnarchive] = useMutation<{ teamUnarchive: Refusable<object> }>(TEAM_UNARCHIVE_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'PUBLIC'>('PRIVATE');

  if (error) return <p role="alert">Could not load teams: {error.message}</p>;
  if (loading && !data) return <p role="status">Loading…</p>;
  const teams = data?.teams.nodes ?? [];
  const refreshOn = (ok: boolean) => { if (ok) void refetch(); };

  function create() {
    void attempt(
      () => runCreate({ variables: { input: { key: key.trim(), name: name.trim(), visibility } } }),
      (d) => d.teamCreate,
      `Team ${key.trim().toUpperCase()} is created; you are its owner.`,
      setNotice,
    ).then((ok) => {
      if (!ok) return;
      setKey('');
      setName('');
      void refetch();
    });
  }

  return (
    <section aria-label="Teams">
      {sectionIntro('Teams', 'Every team, including private and archived ones. The key is the prefix of every identifier and cannot change; teams are archived, never deleted.')}
      <NoticeLine notice={notice} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }} aria-label="Create team">
        <input style={{ ...inputStyle, width: 90 }} aria-label="Team key" placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} />
        <input style={{ ...inputStyle, flex: 1, minWidth: 180 }} aria-label="Team name" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
        <select style={inputStyle} aria-label="Team visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'PRIVATE' | 'PUBLIC')}>
          <option value="PRIVATE">Private</option>
          <option value="PUBLIC">Public</option>
        </select>
        <button type="button" className="ui-action ui-action--primary" disabled={!key.trim() || !name.trim()} onClick={create}>Create team</button>
      </div>

      <div role="table" aria-label="Team list">
        {teams.map((team) => {
          const owners = team.memberships.nodes.filter((m) => m.role === 'OWNER').map((m) => m.user.name ?? m.user.email);
          return (
            <div key={team.id} role="row" style={{ ...rowStyle, opacity: team.archivedAt ? 0.6 : 1 }}>
              <span role="cell" style={{ width: 60 }} className="mono">{team.key}</span>
              <span role="cell" style={{ flex: 1 }}>
                {team.name}
                <span style={{ display: 'block', fontSize: 12.5, color: 'var(--fg-dim)' }}>
                  {team.visibility === 'PUBLIC' ? 'Public' : 'Private'} · {team.memberships.nodes.length} member{team.memberships.nodes.length === 1 ? '' : 's'}
                  {owners.length > 0 ? ` · owner ${owners.join(', ')}` : ' · no owner'}
                  {team.archivedAt ? ` · archived ${formatDate(team.archivedAt)}` : ''}
                </span>
              </span>
              <Link to={`/members?team=${encodeURIComponent(team.key)}`} style={{ fontSize: 13.5 }}>Members</Link>
              {team.archivedAt ? (
                <button type="button" className="ui-action ui-action--subtle" onClick={() => void attempt(() => runUnarchive({ variables: { teamId: team.id } }), (d) => d.teamUnarchive, `${team.key} is active again.`, setNotice).then(refreshOn)}>Unarchive</button>
              ) : (
                <button
                  type="button"
                  className="ui-action ui-action--subtle"
                  onClick={() => {
                    if (!window.confirm(`Archive ${team.key}? It becomes read-only and leaves the sidebar. Nothing is deleted.`)) return;
                    void attempt(() => runArchive({ variables: { teamId: team.id } }), (d) => d.teamArchive, `${team.key} is archived.`, setNotice).then(refreshOn);
                  }}
                >Archive</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Security --------------------------------------------------------------

interface SecurityData {
  workspaceSettings: { approvedDomains: string[]; defaultTeams: Array<{ id: string }>; membersCanInvite: boolean; membersCanCreateTeams: boolean };
  teams: { nodes: TeamOption[] };
}

export function AdminSecurityTab() {
  const { data, loading, error, refetch } = useQuery<SecurityData>(WORKSPACE_SECURITY_QUERY);
  if (error) return <p role="alert">Could not load security settings: {error.message}</p>;
  if (loading || !data) return <p role="status">Loading…</p>;
  return <SecurityForm key={JSON.stringify(data.workspaceSettings)} data={data} onSaved={() => void refetch()} />;
}

function SecurityForm({ data, onSaved }: { data: SecurityData; onSaved: () => void }) {
  const [runUpdate] = useMutation<{ workspaceSettingsUpdate: Refusable<object> }>(WORKSPACE_SETTINGS_UPDATE_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [domains, setDomains] = useState(data.workspaceSettings.approvedDomains.join('\n'));
  const [defaultTeamIds, setDefaultTeamIds] = useState<string[]>(data.workspaceSettings.defaultTeams.map((team) => team.id));
  const [membersCanInvite, setMembersCanInvite] = useState(data.workspaceSettings.membersCanInvite);
  const [membersCanCreateTeams, setMembersCanCreateTeams] = useState(data.workspaceSettings.membersCanCreateTeams);

  function save() {
    const approvedDomains = domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
    void attempt(
      () => runUpdate({ variables: { input: { approvedDomains, defaultTeamIds, membersCanCreateTeams, membersCanInvite } } }),
      (d) => d.workspaceSettingsUpdate,
      'Security settings saved.',
      setNotice,
    ).then((ok) => { if (ok) onSaved(); });
  }

  return (
    <section aria-label="Security">
      {sectionIntro('Security', 'Who can get into the workspace. Sign-in is invite-only: besides invited people, only the domains below are admitted.')}
      <NoticeLine notice={notice} />
      <label style={{ display: 'block', marginBottom: 16 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Approved email domains</span>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--fg-dim)', marginBottom: 6 }}>
          Anyone with a verified Google account on these domains can sign in and joins as a Member. One per line, e.g. company.com.
        </span>
        <textarea aria-label="Approved email domains" rows={3} style={{ ...inputStyle, width: '100%', height: 'auto', padding: 8 }} value={domains} onChange={(e) => setDomains(e.target.value)} />
      </label>
      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
        <legend style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Default teams</legend>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--fg-dim)', marginBottom: 6 }}>People who join by domain are added to these teams as Members.</span>
        {data.teams.nodes.map((team) => (
          <label key={team.id} style={{ display: 'inline-flex', gap: 4, marginRight: 12, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={defaultTeamIds.includes(team.id)}
              onChange={(e) => setDefaultTeamIds((ids) => (e.target.checked ? [...ids, team.id] : ids.filter((id) => id !== team.id)))}
            />
            {team.key} · {team.name}
          </label>
        ))}
      </fieldset>
      <label style={{ display: 'flex', gap: 6, fontSize: 14, marginBottom: 8 }}>
        <input type="checkbox" checked={membersCanInvite} onChange={(e) => setMembersCanInvite(e.target.checked)} />
        Members can invite people (as Members or Guests)
      </label>
      <label style={{ display: 'flex', gap: 6, fontSize: 14, marginBottom: 16 }}>
        <input type="checkbox" checked={membersCanCreateTeams} onChange={(e) => setMembersCanCreateTeams(e.target.checked)} />
        Members can create teams
      </label>
      <button type="button" className="ui-action ui-action--primary" onClick={save}>Save security settings</button>
    </section>
  );
}
