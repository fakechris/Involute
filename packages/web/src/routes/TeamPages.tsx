import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import {
  TEAM_ARCHIVE_MUTATION,
  TEAM_JOIN_MUTATION,
  TEAM_LEAVE_MUTATION,
  TEAM_MEMBERSHIP_REMOVE_MUTATION,
  TEAM_MEMBERSHIP_UPSERT_MUTATION,
  TEAM_PAGE_QUERY,
  TEAM_UNARCHIVE_MUTATION,
  TEAM_UPDATE_MUTATION,
} from '../board/queries';
import { writeStoredTeamKey } from '../board/utils';
import { AgentsTab } from './AgentsTab';
import { BugTriageTab } from './BugTriageTab';
import type { Refusable } from './settings-queries';
import { NoticeLine, WorkflowStatesTab, attempt, type Notice } from './WorkspaceSettingsTabs';
import { Field, Select, TextInput } from '../components/controls';
import { DataTable } from '../components/DataTable';
import { Btn } from '../components/Primitives';
import { SettingsSectionHeader, SettingsShell } from '../components/SettingsShell';

// A team's own pages (INV-850, docs/permissions.md §7): its roster and its
// settings live under the team, not scattered across the workspace.

type TeamRole = 'VIEWER' | 'EDITOR' | 'OWNER';
const TEAM_ROLE_LABEL: Record<TeamRole, string> = { VIEWER: 'Viewer', EDITOR: 'Member', OWNER: 'Owner' };

interface TeamPageTeam {
  id: string;
  key: string;
  name: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  archivedAt: string | null;
  viewerCanManage: boolean;
  viewerCanJoin: boolean;
  viewerIsMember: boolean;
  memberships: {
    nodes: Array<{
      id: string;
      role: TeamRole;
      user: { id: string; name: string | null; email: string | null; globalRole: 'ADMIN' | 'USER' | 'GUEST'; accessStatus: string };
    }>;
  };
}

interface TeamPageData {
  teams: { nodes: TeamPageTeam[] };
  viewer: { id: string } | null;
}

function useTeamPage() {
  const { key = '' } = useParams<{ key: string }>();
  const query = useQuery<TeamPageData>(TEAM_PAGE_QUERY, { variables: { key: key.toUpperCase() } });
  const team = query.data?.teams.nodes[0] ?? null;
  // Opening a team's page makes it the current team, as the sidebar does.
  useEffect(() => {
    if (team) writeStoredTeamKey(team.key);
  }, [team?.key]);
  return { key: key.toUpperCase(), query, team, viewerId: query.data?.viewer?.id ?? null };
}

function TeamHeader({ team, current }: { team: TeamPageTeam; current: 'members' | 'settings' }) {
  return (
    <div className="page-header">
      <span className="mono" style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>{team.key}</span>
      <span style={{ fontSize: 15, fontWeight: 500 }}>{team.name}</span>
      <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
        {team.visibility === 'PUBLIC' ? 'Public team' : 'Private team'}
        {team.archivedAt ? ' · archived, read-only' : ''}
      </span>
      <div style={{ flex: 1 }} />
      <nav aria-label="Team pages" style={{ display: 'flex', gap: 12, fontSize: 14 }}>
        {current === 'members' ? <strong>Members</strong> : <Link to={`/teams/${team.key}/members`}>Members</Link>}
        {team.viewerCanManage
          ? (current === 'settings' ? <strong>Settings</strong> : <Link to={`/teams/${team.key}/settings`}>Settings</Link>)
          : null}
      </nav>
    </div>
  );
}

function NotFound({ teamKey }: { teamKey: string }) {
  return (
    <div className="page-content" style={{ padding: 32 }}>
      <p>No team {teamKey} that you can see.</p>
    </div>
  );
}

// --- Members ---------------------------------------------------------------

export function TeamMembersPage() {
  const { key, query, team, viewerId } = useTeamPage();
  const [runUpsert] = useMutation<{ teamMembershipUpsert: Refusable<object> }>(TEAM_MEMBERSHIP_UPSERT_MUTATION);
  const [runRemove] = useMutation<{ teamMembershipRemove: Refusable<object> }>(TEAM_MEMBERSHIP_REMOVE_MUTATION);
  const [runJoin] = useMutation<{ teamJoin: Refusable<object> }>(TEAM_JOIN_MUTATION);
  const [runLeave] = useMutation<{ teamLeave: Refusable<object> }>(TEAM_LEAVE_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('EDITOR');

  if (query.error) return <p role="alert" style={{ padding: 32 }}>Could not load the team: {query.error.message}</p>;
  if (query.loading && !query.data) return <p role="status" style={{ padding: 32 }}>Loading…</p>;
  if (!team) return <NotFound teamKey={key} />;

  const canManage = team.viewerCanManage && !team.archivedAt;
  const refreshOn = (ok: boolean) => { if (ok) void query.refetch(); };
  const roster = [...team.memberships.nodes].sort((a, b) => (a.user.name ?? a.user.email ?? '').localeCompare(b.user.name ?? b.user.email ?? ''));

  function add() {
    const address = email.trim();
    if (!address) return;
    void attempt(
      () => runUpsert({ variables: { input: { teamId: team!.id, email: address, role } } }),
      (d) => d.teamMembershipUpsert,
      `${address} is on ${team!.key} as ${TEAM_ROLE_LABEL[role]}. If they have never signed in, no email was sent: send them ${window.location.origin} and ask them to sign in with Google as ${address}.`,
      setNotice,
    ).then((ok) => {
      if (!ok) return;
      setEmail('');
      void query.refetch();
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <TeamHeader team={team} current="members" />
      <div className="page-content" style={{ padding: '20px var(--pad-x)', maxWidth: 760 }}>
        <p style={{ fontSize: 13.5, color: 'var(--fg-dim)', margin: '0 0 12px' }}>
          Roles are per team: a Viewer reads the team&apos;s work, a Member also creates and edits it, an Owner also
          manages members, settings and agents. To give someone one project instead, share it from the Projects page.
        </p>
        <NoticeLine notice={notice} />

        {team.viewerCanJoin ? (
          <p>
            <Btn variant="accent" size="md" onClick={() => void attempt(() => runJoin({ variables: { teamId: team.id } }), (d) => d.teamJoin, `You joined ${team.key}.`, setNotice).then(refreshOn)}>
              Join {team.key}
            </Btn>
          </p>
        ) : null}

        {canManage ? (
          <div className="inline-form" role="group" aria-label="Add member">
            <Field label="Email">
              <TextInput aria-label="Member email" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Role" className="inline-form__narrow">
              <Select aria-label="New member role" value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
                <option value="VIEWER">Viewer</option>
                <option value="EDITOR">Member</option>
                <option value="OWNER">Owner</option>
              </Select>
            </Field>
            <Btn variant="accent" size="md" disabled={!email.trim()} onClick={add}>Add to team</Btn>
          </div>
        ) : null}

        <DataTable
          label="Team members"
          rows={roster}
          rowKey={(membership) => membership.id}
          empty="Nobody is on this team yet."
          columns={[
            {
              key: 'person',
              header: 'Person',
              render: (membership) => {
                const person = membership.user;
                return (
                  <span className="data-table__primary">
                    <span>{person.name ?? person.email ?? 'Someone'}{person.id === viewerId ? ' (you)' : ''}</span>
                    <span className="data-table__secondary">
                      {person.email}
                      {person.globalRole === 'GUEST' ? ' · guest' : ''}
                      {person.accessStatus === 'PENDING' ? ' · invited, not signed in yet' : ''}
                      {person.accessStatus === 'SUSPENDED' ? ' · suspended' : ''}
                    </span>
                  </span>
                );
              },
            },
            {
              key: 'role',
              header: 'Role',
              width: '120px',
              render: (membership) => {
                const person = membership.user;
                const name = person.name ?? person.email ?? 'Someone';
                return canManage ? (
                  <Select
                    size="sm"
                    aria-label={`Team role for ${name}`}
                    value={membership.role}
                    onChange={(e) => void attempt(
                      () => runUpsert({ variables: { input: { teamId: team.id, email: person.email ?? '', role: e.target.value as TeamRole } } }),
                      (d) => d.teamMembershipUpsert,
                      `${name} is now ${TEAM_ROLE_LABEL[e.target.value as TeamRole]}.`,
                      setNotice,
                    ).then(refreshOn)}
                  >
                    <option value="VIEWER">Viewer</option>
                    <option value="EDITOR">Member</option>
                    {person.globalRole !== 'GUEST' ? <option value="OWNER">Owner</option> : null}
                  </Select>
                ) : (
                  <span className="data-table__secondary">{TEAM_ROLE_LABEL[membership.role]}</span>
                );
              },
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (membership) => {
                const person = membership.user;
                const name = person.name ?? person.email ?? 'Someone';
                if (person.id === viewerId) {
                  return (
                    <Btn
                      variant="subtle"
                      onClick={() => {
                        if (!window.confirm(`Leave ${team.key}?`)) return;
                        void attempt(() => runLeave({ variables: { teamId: team.id } }), (d) => d.teamLeave, `You left ${team.key}.`, setNotice).then(refreshOn);
                      }}
                    >Leave</Btn>
                  );
                }
                return canManage ? (
                  <Btn
                    variant="danger"
                    onClick={() => {
                      if (!window.confirm(`Remove ${name} from ${team.key}?`)) return;
                      void attempt(
                        () => runRemove({ variables: { input: { teamId: team.id, userId: person.id } } }),
                        (d) => d.teamMembershipRemove,
                        `${name} is no longer on ${team.key}.`,
                        setNotice,
                      ).then(refreshOn);
                    }}
                  >Remove</Btn>
                ) : null;
              },
            },
          ]}
        />
      </div>
    </div>
  );
}

// --- Settings --------------------------------------------------------------

type SettingsSection = 'general' | 'states' | 'triage' | 'agents';
const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'states', label: 'Workflow states' },
  { id: 'triage', label: 'Bug triage' },
  { id: 'agents', label: 'Agents' },
];

export function TeamSettingsPage() {
  const { key, query, team } = useTeamPage();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = (SECTIONS.find((s) => s.id === searchParams.get('section'))?.id ?? 'general');

  if (query.error) return <p role="alert" style={{ padding: 32 }}>Could not load the team: {query.error.message}</p>;
  if (query.loading && !query.data) return <p role="status" style={{ padding: 32 }}>Loading…</p>;
  if (!team) return <NotFound teamKey={key} />;
  if (!team.viewerCanManage) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <TeamHeader team={team} current="settings" />
        <p style={{ padding: 32 }}>Only this team&apos;s owners and workspace admins change its settings.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <TeamHeader team={team} current="settings" />
      <SettingsShell
        navLabel="Team settings sections"
        groups={[{ items: SECTIONS }]}
        active={section}
        onSelect={(id) => setSearchParams(id === 'general' ? {} : { section: id }, { replace: true })}
      >
        {section === 'general' ? <TeamGeneral team={team} onSaved={() => void query.refetch()} /> : null}
        {section === 'states' ? <WorkflowStatesTab teamKey={team.key} /> : null}
        {section === 'triage' ? <BugTriageTab teamKey={team.key} /> : null}
        {section === 'agents' ? <AgentsTab teamKey={team.key} /> : null}
      </SettingsShell>
    </div>
  );
}

function TeamGeneral({ team, onSaved }: { team: TeamPageTeam; onSaved: () => void }) {
  const [runUpdate] = useMutation<{ teamUpdate: Refusable<object> }>(TEAM_UPDATE_MUTATION);
  const [runArchive] = useMutation<{ teamArchive: Refusable<object> }>(TEAM_ARCHIVE_MUTATION);
  const [runUnarchive] = useMutation<{ teamUnarchive: Refusable<object> }>(TEAM_UNARCHIVE_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [name, setName] = useState(team.name);
  const [visibility, setVisibility] = useState(team.visibility);
  const refreshOn = (ok: boolean) => { if (ok) onSaved(); };

  return (
    <section aria-label="General">
      <SettingsSectionHeader title="General" />
      <NoticeLine notice={notice} />
      <div className="form-stack">
        <Field label="Name" hint={<>Key <span className="mono">{team.key}</span> is the prefix of every identifier and cannot change.</>}>
          <TextInput aria-label="Team name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Visibility">
          <Select aria-label="Team visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'PRIVATE' | 'PUBLIC')}>
            <option value="PRIVATE">Private — only members and admins see it</option>
            <option value="PUBLIC">Public — every workspace member sees it and can join</option>
          </Select>
        </Field>
        <div>
          <Btn
            variant="accent"
            size="md"
            onClick={() => void attempt(
              () => runUpdate({ variables: { input: { teamId: team.id, name: name.trim(), visibility } } }),
              (d) => d.teamUpdate,
              'Team settings saved.',
              setNotice,
            ).then(refreshOn)}
          >Save team settings</Btn>
        </div>
      </div>

      <h3 className="settings-section__title settings-section__title--sub">Archive</h3>
      <p className="settings-section__sub">
        An archived team is read-only and leaves the sidebar. Nothing is deleted; identifiers keep resolving.
      </p>
      {team.archivedAt ? (
        <Btn variant="subtle" size="md" onClick={() => void attempt(() => runUnarchive({ variables: { teamId: team.id } }), (d) => d.teamUnarchive, `${team.key} is active again.`, setNotice).then(refreshOn)}>Unarchive team</Btn>
      ) : (
        <Btn
          variant="danger"
          size="md"
          onClick={() => {
            if (!window.confirm(`Archive ${team.key}? It becomes read-only for everyone.`)) return;
            void attempt(() => runArchive({ variables: { teamId: team.id } }), (d) => d.teamArchive, `${team.key} is archived.`, setNotice).then(refreshOn);
          }}
        >Archive team</Btn>
      )}
    </section>
  );
}
