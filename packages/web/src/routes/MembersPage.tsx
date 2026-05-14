import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useRef, useState } from 'react';

import { BOARD_PAGE_QUERY, TEAM_MEMBERSHIP_UPSERT_MUTATION, TEAM_MEMBERSHIP_REMOVE_MUTATION } from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  UserSummary,
  TeamMembershipUpsertMutationData,
  TeamMembershipUpsertMutationVariables,
  TeamMembershipRemoveMutationData,
  TeamMembershipRemoveMutationVariables,
} from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoMore, IcoPlus, IcoTeam } from '../components/Icons';
import { Avatar, Btn } from '../components/Primitives';

function roleRank(role: string | undefined): number {
  switch (role) {
    case 'OWNER': return 3;
    case 'EDITOR': return 2;
    case 'VIEWER': return 1;
    default: return 0;
  }
}

function formatRole(role: string | undefined): string {
  switch (role) {
    case 'OWNER': return 'Owner';
    case 'EDITOR': return 'Editor';
    case 'VIEWER': return 'Viewer';
    default: return 'Member';
  }
}

export function MembersPage() {
  const teamKey = readStoredTeamKey();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'VIEWER' | 'EDITOR' | 'OWNER'>('EDITOR');

  const { data, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 200,
      ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}),
    },
  });

  const [runUpsert] = useMutation<TeamMembershipUpsertMutationData, TeamMembershipUpsertMutationVariables>(TEAM_MEMBERSHIP_UPSERT_MUTATION);
  const [runRemove] = useMutation<TeamMembershipRemoveMutationData, TeamMembershipRemoveMutationVariables>(TEAM_MEMBERSHIP_REMOVE_MUTATION);

  const users = data?.users.nodes ?? [];
  const issues = data?.issues.nodes ?? [];
  const teams = data?.teams.nodes ?? [];
  const teamId = teams.find((t) => t.key === teamKey)?.id ?? teams[0]?.id ?? '';

  const issueCountByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of issues) {
      if (issue.assignee?.id) {
        map.set(issue.assignee.id, (map.get(issue.assignee.id) ?? 0) + 1);
      }
    }
    return map;
  }, [issues]);

  const roleByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of teams) {
      if (!team.memberships) continue;
      for (const m of team.memberships.nodes) {
        const existing = map.get(m.user.id);
        if (!existing || roleRank(m.role) > roleRank(existing)) {
          map.set(m.user.id, m.role);
        }
      }
    }
    return map;
  }, [teams]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoTeam /></span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Members</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{users.length}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={() => {
          setInviteEmail('');
          setInviteName('');
          setInviteRole('EDITOR');
          dialogRef.current?.showModal();
        }}>Invite</Btn>
      </div>

      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12 }}>
            Loading members…
          </div>
        ) : users.length === 0 ? (
          <div className="empty-state">
            <h3>No members found</h3>
            <p>Team members will appear here once data is available.</p>
          </div>
        ) : (
          <div style={{ padding: '20px var(--pad-x)' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
            }}>
              {users.map((user) => (
                <MemberCard
                  key={user.id}
                  user={user}
                  issueCount={issueCountByUser.get(user.id) ?? 0}
                  role={formatRole(roleByUser.get(user.id))}
                  teamId={teamId}
                  onChangeRole={async (userId, role) => {
                    await runUpsert({
                      variables: { input: { teamId, email: user.email ?? '', role } },
                      refetchQueries: [{ query: BOARD_PAGE_QUERY, variables: { first: 200, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) } }],
                    });
                  }}
                  onRemove={async (userId) => {
                    if (!window.confirm(`Remove ${user.name ?? user.email} from team?`)) return;
                    await runRemove({
                      variables: { input: { teamId, userId } },
                      refetchQueries: [{ query: BOARD_PAGE_QUERY, variables: { first: 200, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) } }],
                    });
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <dialog ref={dialogRef} className="dialog-modal" onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!inviteEmail.trim() || !teamId) return;
            await runUpsert({
              variables: { input: { teamId, email: inviteEmail.trim(), name: inviteName.trim() || null, role: inviteRole } },
              refetchQueries: [{ query: BOARD_PAGE_QUERY, variables: { first: 200, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) } }],
            });
            dialogRef.current?.close();
          }}
          style={{ padding: 20, minWidth: 340 }}
        >
          <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 500 }}>Invite member</h3>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Email</span>
            <input
              type="email"
              style={{ width: '100%', height: 30, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)' }}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              required
            />
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Name (optional)</span>
            <input
              style={{ width: '100%', height: 30, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)' }}
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              placeholder="Full name"
            />
          </label>
          <label style={{ display: 'block', marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Role</span>
            <select
              style={{ width: '100%', height: 30, padding: '0 6px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'VIEWER' | 'EDITOR' | 'OWNER')}
            >
              <option value="VIEWER">Viewer</option>
              <option value="EDITOR">Editor</option>
              <option value="OWNER">Owner</option>
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--subtle btn--md" onClick={() => dialogRef.current?.close()}>Cancel</button>
            <button type="submit" className="btn btn--accent btn--md">Invite</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function MemberCard({
  user,
  issueCount,
  role,
  teamId,
  onChangeRole,
  onRemove,
}: {
  user: UserSummary;
  issueCount: number;
  role: string;
  teamId: string;
  onChangeRole: (userId: string, role: 'VIEWER' | 'EDITOR' | 'OWNER') => void;
  onRemove: (userId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: 14, border: '1px solid var(--border)',
      borderRadius: 'var(--r-3)', background: 'var(--bg-raised)',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar user={{ name: user.name ?? undefined }} size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 500,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {user.name ?? 'Unknown'}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--fg-dim)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {user.email ?? '—'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-dim)', padding: 4, borderRadius: 'var(--r-1)' }}
        >
          <IcoMore size={14} />
        </button>
        {menuOpen && (
          <div style={{
            position: 'absolute', top: 40, right: 10, zIndex: 10,
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-2)', padding: 4, minWidth: 120,
          }}>
            {(['VIEWER', 'EDITOR', 'OWNER'] as const).map((r) => (
              <button
                key={r}
                type="button"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px', fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', borderRadius: 'var(--r-1)' }}
                onClick={() => { setMenuOpen(false); onChangeRole(user.id, r); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                Set {r.toLowerCase()}
              </button>
            ))}
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
            <button
              type="button"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px', fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', borderRadius: 'var(--r-1)' }}
              onClick={() => { setMenuOpen(false); onRemove(user.id); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>
        <span>
          <span className="mono" style={{ color: 'var(--fg)' }}>{issueCount}</span> open
        </span>
        <span>·</span>
        <span>{role}</span>
      </div>
    </div>
  );
}
