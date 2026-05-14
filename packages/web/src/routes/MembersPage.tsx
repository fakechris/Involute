import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, UserSummary } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoPlus, IcoTeam } from '../components/Icons';
import { Avatar, Btn } from '../components/Primitives';

export function MembersPage() {
  const teamKey = readStoredTeamKey();
  const { data, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 200,
      ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}),
    },
  });

  const users = data?.users.nodes ?? [];
  const issues = data?.issues.nodes ?? [];

  const issueCountByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of issues) {
      if (issue.assignee?.id) {
        map.set(issue.assignee.id, (map.get(issue.assignee.id) ?? 0) + 1);
      }
    }
    return map;
  }, [issues]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoTeam /></span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Members</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{users.length}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm">Invite</Btn>
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
              {users.map((user, i) => (
                <MemberCard
                  key={user.id}
                  user={user}
                  issueCount={issueCountByUser.get(user.id) ?? 0}
                  role={i === 0 ? 'Admin' : i < 3 ? 'Editor' : 'Viewer'}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MemberCard({
  user,
  issueCount,
  role,
}: {
  user: UserSummary;
  issueCount: number;
  role: string;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: 14, border: '1px solid var(--border)',
      borderRadius: 'var(--r-3)', background: 'var(--bg-raised)',
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
