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
import { NoticeLine, WorkflowStatesTab, attempt, inputStyle, rowStyle, type Notice } from './WorkspaceSettingsTabs';

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
      `${address} is on ${team!.key} as ${TEAM_ROLE_LABEL[role]}.`,
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
            <button type="button" className="ui-action ui-action--primary" onClick={() => void attempt(() => runJoin({ variables: { teamId: team.id } }), (d) => d.teamJoin, `You joined ${team.key}.`, setNotice).then(refreshOn)}>
              Join {team.key}
            </button>
          </p>
        ) : null}

        {canManage ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 16px' }} aria-label="Add member">
            <input style={{ ...inputStyle, flex: 1, minWidth: 220 }} aria-label="Member email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select style={inputStyle} aria-label="New member role" value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
              <option value="VIEWER">Viewer</option>
              <option value="EDITOR">Member</option>
              <option value="OWNER">Owner</option>
            </select>
            <button type="button" className="ui-action ui-action--primary" disabled={!email.trim()} onClick={add}>Add to team</button>
          </div>
        ) : null}

        <div role="table" aria-label="Team members">
          {roster.length === 0 ? <p style={{ color: 'var(--fg-dim)' }}>Nobody is on this team yet.</p> : null}
          {roster.map((membership) => {
            const person = membership.user;
            const name = person.name ?? person.email ?? 'Someone';
            const isViewer = person.id === viewerId;
            return (
              <div key={membership.id} role="row" style={rowStyle}>
                <span role="cell" style={{ flex: 1, minWidth: 0 }}>
                  {name}{isViewer ? ' (you)' : ''}
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--fg-dim)' }}>
                    {person.email}
                    {person.globalRole === 'GUEST' ? ' · guest' : ''}
                    {person.accessStatus === 'PENDING' ? ' · invited, not signed in yet' : ''}
                    {person.accessStatus === 'SUSPENDED' ? ' · suspended' : ''}
                  </span>
                </span>
                {canManage ? (
                  <select
                    role="cell"
                    style={inputStyle}
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
                  </select>
                ) : (
                  <span role="cell" style={{ fontSize: 13.5, color: 'var(--fg-muted)' }}>{TEAM_ROLE_LABEL[membership.role]}</span>
                )}
                <span role="cell" style={{ width: 90, textAlign: 'right' }}>
                  {isViewer ? (
                    <button
                      type="button"
                      className="ui-action ui-action--subtle"
                      onClick={() => {
                        if (!window.confirm(`Leave ${team.key}?`)) return;
                        void attempt(() => runLeave({ variables: { teamId: team.id } }), (d) => d.teamLeave, `You left ${team.key}.`, setNotice).then(refreshOn);
                      }}
                    >Leave</button>
                  ) : canManage ? (
                    <button
                      type="button"
                      className="ui-action ui-action--subtle"
                      onClick={() => {
                        if (!window.confirm(`Remove ${name} from ${team.key}?`)) return;
                        void attempt(
                          () => runRemove({ variables: { input: { teamId: team.id, userId: person.id } } }),
                          (d) => d.teamMembershipRemove,
                          `${name} is no longer on ${team.key}.`,
                          setNotice,
                        ).then(refreshOn);
                      }}
                    >Remove</button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
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
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav aria-label="Team settings sections" style={{ width: 180, padding: 12, borderRight: '1px solid var(--border-subtle)' }}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`ui-action ${section === s.id ? 'ui-action--primary' : 'ui-action--subtle'}`}
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
              onClick={() => setSearchParams(s.id === 'general' ? {} : { section: s.id }, { replace: true })}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', maxWidth: 720 }}>
          {section === 'general' ? <TeamGeneral team={team} onSaved={() => void query.refetch()} /> : null}
          {section === 'states' ? <WorkflowStatesTab teamKey={team.key} /> : null}
          {section === 'triage' ? <BugTriageTab teamKey={team.key} /> : null}
          {section === 'agents' ? <AgentsTab teamKey={team.key} /> : null}
        </div>
      </div>
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
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 12px' }}>General</h2>
      <NoticeLine notice={notice} />
      <label style={{ display: 'block', marginBottom: 12 }}>
        <span style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>Name</span>
        <input style={{ ...inputStyle, width: '100%' }} aria-label="Team name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p style={{ fontSize: 13, color: 'var(--fg-dim)', margin: '0 0 12px' }}>
        Key <span className="mono">{team.key}</span> is the prefix of every identifier and cannot change.
      </p>
      <label style={{ display: 'block', marginBottom: 16 }}>
        <span style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>Visibility</span>
        <select style={inputStyle} aria-label="Team visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'PRIVATE' | 'PUBLIC')}>
          <option value="PRIVATE">Private — only members and admins see it</option>
          <option value="PUBLIC">Public — every workspace member sees it and can join</option>
        </select>
      </label>
      <button
        type="button"
        className="ui-action ui-action--primary"
        onClick={() => void attempt(
          () => runUpdate({ variables: { input: { teamId: team.id, name: name.trim(), visibility } } }),
          (d) => d.teamUpdate,
          'Team settings saved.',
          setNotice,
        ).then(refreshOn)}
      >Save team settings</button>

      <h3 style={{ fontSize: 15, fontWeight: 500, margin: '28px 0 6px' }}>Archive</h3>
      <p style={{ fontSize: 13.5, color: 'var(--fg-dim)', margin: '0 0 8px' }}>
        An archived team is read-only and leaves the sidebar. Nothing is deleted; identifiers keep resolving.
      </p>
      {team.archivedAt ? (
        <button type="button" className="ui-action ui-action--subtle" onClick={() => void attempt(() => runUnarchive({ variables: { teamId: team.id } }), (d) => d.teamUnarchive, `${team.key} is active again.`, setNotice).then(refreshOn)}>Unarchive team</button>
      ) : (
        <button
          type="button"
          className="ui-action ui-action--subtle"
          onClick={() => {
            if (!window.confirm(`Archive ${team.key}? It becomes read-only for everyone.`)) return;
            void attempt(() => runArchive({ variables: { teamId: team.id } }), (d) => d.teamArchive, `${team.key} is archived.`, setNotice).then(refreshOn);
          }}
        >Archive team</button>
      )}
    </section>
  );
}
