import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  ADMIN_MEMBERS_QUERY,
  TEAM_MEMBERSHIP_REMOVE_MUTATION,
  TEAM_MEMBERSHIP_UPSERT_MUTATION,
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
import { NoticeLine, attempt, type Notice } from './WorkspaceSettingsTabs';
import { Checkbox, Field, Select, TextArea, TextInput } from '../components/controls';
import { DataTable } from '../components/DataTable';
import { Btn } from '../components/Primitives';
import { SettingsSectionHeader } from '../components/SettingsShell';

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
  return <SettingsSectionHeader title={title}>{text}</SettingsSectionHeader>;
}

function formatDate(iso: string | null): string {
  return iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso)) : '—';
}

// --- Members ---------------------------------------------------------------

export function AdminMembersTab() {
  const { data, loading, error, refetch } = useQuery<{ users: { nodes: AdminPerson[] }; teams: { nodes: TeamOption[] }; viewer: { id: string } | null }>(ADMIN_MEMBERS_QUERY);
  const [runInvite] = useMutation<{ userInvite: Refusable<{ emailSent?: boolean | null; emailNote?: string | null; signInUrl?: string | null }> }>(USER_INVITE_MUTATION);
  const [lastInvite, setLastInvite] = useState<{ email: string; emailSent: boolean; emailNote: string | null; signInUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [runRevoke] = useMutation<{ userInviteRevoke: Refusable<object> }>(USER_INVITE_REVOKE_MUTATION);
  const [runSuspend] = useMutation<{ userSuspend: Refusable<object> }>(USER_SUSPEND_MUTATION);
  const [runReactivate] = useMutation<{ userReactivate: Refusable<object> }>(USER_REACTIVATE_MUTATION);
  const [runSetRole] = useMutation<{ userSetGlobalRole: Refusable<object> }>(USER_SET_GLOBAL_ROLE_MUTATION);
  const [runTeamUpsert] = useMutation<{ teamMembershipUpsert: Refusable<object> }>(TEAM_MEMBERSHIP_UPSERT_MUTATION);
  const [runTeamRemove] = useMutation<{ teamMembershipRemove: Refusable<object> }>(TEAM_MEMBERSHIP_REMOVE_MUTATION);
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

  function changeTeamRole(user: AdminPerson, team: { id: string; key: string }, role: TeamRole) {
    void attempt(
      () => runTeamUpsert({ variables: { input: { teamId: team.id, email: user.email ?? '', role } } }),
      (d) => d.teamMembershipUpsert,
      `${who(user)} is now ${TEAM_ROLE_LABEL[role]} in ${team.key}.`,
      setNotice,
    ).then(refreshOn);
  }

  function removeFromTeam(user: AdminPerson, team: { id: string; key: string }) {
    if (!window.confirm(`Remove ${who(user)} from ${team.key}?`)) return;
    void attempt(
      () => runTeamRemove({ variables: { input: { teamId: team.id, userId: user.id } } }),
      (d) => d.teamMembershipRemove,
      `${who(user)} is no longer on ${team.key}.`,
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
    setLastInvite(null);
    setCopied(false);
    void (async () => {
      let payload: { emailSent?: boolean | null; emailNote?: string | null; signInUrl?: string | null } | undefined;
      const ok = await attempt(
        async () => {
          const result = await runInvite({ variables: { input: { email, role: inviteRole, teams: chosen } } });
          payload = result.data?.userInvite ?? undefined;
          return result;
        },
        (d) => d.userInvite,
        `${email} is invited.`,
        setNotice,
      );
      if (!ok) return;
      // Say exactly what happened: an email left the server, or it did not and the link has to be sent by hand.
      setLastInvite({
        email,
        emailNote: payload?.emailNote ?? null,
        emailSent: Boolean(payload?.emailSent),
        signInUrl: payload?.signInUrl ?? window.location.origin,
      });
      setInviteEmail('');
      setInviteTeams({});
      void refetch();
    })();
  }

  return (
    <section aria-label="Members">
      {sectionIntro('Members', 'Everyone in the workspace. Only invited people and approved domains can sign in; suspended people are signed out and refused. An invite lets the address sign in; an email is sent only if this server has mail configured. Each change is recorded with who made it.')}
      <NoticeLine notice={notice} />

      {lastInvite ? (
        <div role="status" className="admin-invite__result">
          {lastInvite.emailSent ? (
            <p>An invitation email was sent to <strong>{lastInvite.email}</strong>.</p>
          ) : (
            <>
              <p><strong>{lastInvite.email}</strong> can now sign in, but {lastInvite.emailNote ?? 'no email was sent.'}</p>
              <p>
                Send them this link and ask them to sign in with Google as {lastInvite.email}:{' '}
                <span className="mono">{lastInvite.signInUrl}</span>{' '}
                <Btn
                  variant="subtle"
                  onClick={() => {
                    void navigator.clipboard?.writeText(`Sign in to Involute with Google as ${lastInvite.email}: ${lastInvite.signInUrl}`);
                    setCopied(true);
                  }}
                >{copied ? 'Copied' : 'Copy invite message'}</Btn>
              </p>
            </>
          )}
        </div>
      ) : null}

      <div className="admin-invite" aria-label="Invite">
        <h3 className="settings-section__title">Invite</h3>
        <div className="inline-form">
          <Field label="Email">
            <TextInput aria-label="Invite email" type="email" placeholder="name@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          </Field>
          <Field label="Workspace role" className="inline-form__narrow">
            <Select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}>
              <option value="USER">Member</option>
              <option value="GUEST">Guest</option>
              <option value="ADMIN">Admin</option>
            </Select>
          </Field>
          <Btn variant="accent" size="md" disabled={!inviteEmail.trim()} onClick={invite}>Send invite</Btn>
        </div>
        <p className="field__hint">
          A team role gives access to all of that team&apos;s work. To give someone a single project only, invite them as
          a <strong>Guest</strong> with no team, then share the project from{' '}
          <Link to="/projects">Projects</Link> → the project → Sharing.
        </p>
        {teams.length > 0 ? (
          <div className="admin-invite__teams">
            <span className="field__label">Add to teams</span>
            {teams.map((team) => (
              <label key={team.id} className="admin-invite__team">
                <span className="mono">{team.key}</span>
                <Select
                  size="sm"
                  aria-label={`Role in ${team.key}`}
                  value={inviteTeams[team.id] ?? ''}
                  onChange={(e) => setInviteTeams((current) => ({ ...current, [team.id]: e.target.value as TeamRole | '' }))}
                >
                  <option value="">—</option>
                  <option value="VIEWER">Viewer</option>
                  <option value="EDITOR">Member</option>
                  {inviteRole !== 'GUEST' ? <option value="OWNER">Owner</option> : null}
                </Select>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <DataTable
        label="People"
        className="admin-members"
        rows={people}
        rowKey={(user) => user.id}
        columns={[
          {
            key: 'person',
            header: 'Person',
            width: 'minmax(160px, 1.2fr)',
            render: (user) => (
              <span className="data-table__primary">
                <span>{user.name ?? user.email}</span>
                <span className="data-table__secondary">{user.email}</span>
              </span>
            ),
          },
          {
            key: 'teams',
            header: 'Teams',
            width: 'minmax(140px, 1fr)',
            render: (user) => (
              <span className="admin-members__teams">
                {user.teamMemberships.length === 0 ? <span className="data-table__secondary">No team</span> : null}
                {/* Team access is edited here too, so changing someone's reach is one place (INV-853). */}
                {user.teamMemberships.map((m) => (
                  <span key={m.team.id} className="admin-members__team">
                    <span className="mono">{m.team.key}</span>
                    <Select
                      size="sm"
                      aria-label={`${who(user)} role in ${m.team.key}`}
                      value={m.role}
                      onChange={(e) => changeTeamRole(user, m.team, e.target.value as TeamRole)}
                    >
                      <option value="VIEWER">Viewer</option>
                      <option value="EDITOR">Member</option>
                      {user.globalRole !== 'GUEST' ? <option value="OWNER">Owner</option> : null}
                    </Select>
                    <Btn
                      variant="ghost"
                      aria-label={`Remove ${who(user)} from ${m.team.key}`}
                      onClick={() => removeFromTeam(user, m.team)}
                    >×</Btn>
                  </span>
                ))}
                {user.globalRole === 'GUEST' && user.teamMemberships.length > 0 ? (
                  <span className="admin-members__warning">A guest still sees all work of the teams listed here.</span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            width: '112px',
            render: (user) => (
              <span className="data-table__primary">
                <span className={user.accessStatus === 'ACTIVE' ? 'data-table__secondary' : 'admin-members__warning'}>
                  {STATUS_LABEL[user.accessStatus] ?? user.accessStatus}
                </span>
                <span className="data-table__secondary">
                  {user.accessStatus === 'PENDING' ? `invited ${formatDate(user.invitedAt)}` : `seen ${formatDate(user.lastSeenAt)}`}
                </span>
              </span>
            ),
          },
          {
            key: 'role',
            header: 'Role',
            width: '108px',
            render: (user) => (
              <Select
                size="sm"
                aria-label={`Workspace role for ${who(user)}`}
                value={user.globalRole}
                disabled={user.id === viewerId}
                title={user.id === viewerId ? 'Another admin changes your role.' : undefined}
                onChange={(e) => changeRole(user, e.target.value as WorkspaceRole)}
              >
                <option value="ADMIN">Admin</option>
                <option value="USER">Member</option>
                <option value="GUEST">Guest</option>
              </Select>
            ),
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            render: (user) => (user.accessStatus === 'PENDING' ? (
              <Btn variant="subtle" onClick={() => revoke(user)}>Revoke invite</Btn>
            ) : user.accessStatus === 'SUSPENDED' ? (
              <Btn variant="subtle" onClick={() => reactivate(user)}>Reactivate</Btn>
            ) : user.id !== viewerId ? (
              <Btn variant="danger" onClick={() => suspend(user)}>Suspend</Btn>
            ) : null),
          },
        ]}
      />
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

      <div className="inline-form" role="group" aria-label="Create team">
        <Field label="Key" className="inline-form__narrow">
          <TextInput aria-label="Team key" placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Name">
          <TextInput aria-label="Team name" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Visibility" className="inline-form__narrow">
          <Select aria-label="Team visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'PRIVATE' | 'PUBLIC')}>
            <option value="PRIVATE">Private</option>
            <option value="PUBLIC">Public</option>
          </Select>
        </Field>
        <Btn variant="accent" size="md" disabled={!key.trim() || !name.trim()} onClick={create}>Create team</Btn>
      </div>

      <DataTable
        label="Team list"
        rows={teams}
        rowKey={(team) => team.id}
        rowClassName={(team) => (team.archivedAt ? 'data-table__row--muted' : undefined)}
        columns={[
          { key: 'key', header: 'Key', width: 'max-content', render: (team) => <span className="mono">{team.key}</span> },
          {
            key: 'team',
            header: 'Team',
            render: (team) => {
              const owners = team.memberships.nodes.filter((m) => m.role === 'OWNER').map((m) => m.user.name ?? m.user.email);
              return (
                <span className="data-table__primary">
                  <span>{team.name}</span>
                  <span className="data-table__secondary">
                    {team.visibility === 'PUBLIC' ? 'Public' : 'Private'} · {team.memberships.nodes.length} member{team.memberships.nodes.length === 1 ? '' : 's'}
                    {owners.length > 0 ? ` · owner ${owners.join(', ')}` : ' · no owner'}
                    {team.archivedAt ? ` · archived ${formatDate(team.archivedAt)}` : ''}
                  </span>
                </span>
              );
            },
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            render: (team) => (
              <>
                <Link className="ui-action ui-action--ghost ui-action--sm" to={`/teams/${encodeURIComponent(team.key)}/members`}>Members</Link>
                <Link className="ui-action ui-action--ghost ui-action--sm" to={`/teams/${encodeURIComponent(team.key)}/settings`}>Settings</Link>
                {team.archivedAt ? (
                  <Btn variant="subtle" onClick={() => void attempt(() => runUnarchive({ variables: { teamId: team.id } }), (d) => d.teamUnarchive, `${team.key} is active again.`, setNotice).then(refreshOn)}>Unarchive</Btn>
                ) : (
                  <Btn
                    variant="subtle"
                    onClick={() => {
                      if (!window.confirm(`Archive ${team.key}? It becomes read-only and leaves the sidebar. Nothing is deleted.`)) return;
                      void attempt(() => runArchive({ variables: { teamId: team.id } }), (d) => d.teamArchive, `${team.key} is archived.`, setNotice).then(refreshOn);
                    }}
                  >Archive</Btn>
                )}
              </>
            ),
          },
        ]}
      />
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
      <div className="form-stack">
        <Field
          label="Approved email domains"
          hint="Anyone with a verified Google account on these domains can sign in and joins as a Member. One per line, e.g. company.com."
        >
          <TextArea aria-label="Approved email domains" rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} />
        </Field>
        <fieldset className="settings-fieldset">
          <legend className="field__label">Default teams</legend>
          <span className="field__hint">People who join by domain are added to these teams as Members.</span>
          <div className="checkbox-group">
            {data.teams.nodes.map((team) => (
              <Checkbox
                key={team.id}
                label={`${team.key} · ${team.name}`}
                checked={defaultTeamIds.includes(team.id)}
                onChange={(e) => setDefaultTeamIds((ids) => (e.target.checked ? [...ids, team.id] : ids.filter((id) => id !== team.id)))}
              />
            ))}
          </div>
        </fieldset>
        <Checkbox
          label="Members can invite people (as Members or Guests)"
          checked={membersCanInvite}
          onChange={(e) => setMembersCanInvite(e.target.checked)}
        />
        <Checkbox
          label="Members can create teams"
          checked={membersCanCreateTeams}
          onChange={(e) => setMembersCanCreateTeams(e.target.checked)}
        />
        <div>
          <Btn variant="accent" size="md" onClick={save}>Save security settings</Btn>
        </div>
      </div>
    </section>
  );
}
