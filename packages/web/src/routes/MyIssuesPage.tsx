import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, IssueSummary } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoFilter } from '../components/Icons';
import { Avatar, Btn, PriorityIcon, StatusIconPrimitive } from '../components/Primitives';
import { fetchSessionState, type SessionViewer } from '../lib/session';
import { useEffect, useState } from 'react';

function formatTimeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function classifyState(stateName: string): 'progress' | 'todo' | 'backlog' | 'completed' {
  const lower = stateName.toLowerCase();
  if (lower.includes('progress') || lower.includes('review') || lower.includes('started')) return 'progress';
  if (lower.includes('done') || lower.includes('complete') || lower.includes('cancel')) return 'completed';
  if (lower.includes('backlog') || lower.includes('triage')) return 'backlog';
  return 'todo';
}

function getStateType(stateName: string): string {
  const lower = stateName.toLowerCase();
  if (lower.includes('done') || lower.includes('complete')) return 'completed';
  if (lower.includes('cancel')) return 'canceled';
  if (lower.includes('progress') || lower.includes('review') || lower.includes('started')) return 'started';
  if (lower.includes('backlog') || lower.includes('triage')) return 'backlog';
  return 'unstarted';
}

function getStateColor(stateName: string): string {
  const type = getStateType(stateName);
  switch (type) {
    case 'completed': return 'var(--success)';
    case 'canceled': return 'var(--fg-dim)';
    case 'started': return 'var(--warn)';
    case 'backlog': return 'var(--fg-faint)';
    default: return 'var(--fg-dim)';
  }
}

interface IssueGroup {
  label: string;
  items: IssueSummary[];
}

export function MyIssuesPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const [viewer, setViewer] = useState<SessionViewer | null>(null);

  useEffect(() => {
    fetchSessionState().then((session) => {
      if (session.viewer) setViewer(session.viewer);
    });
  }, []);

  const { data, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 500,
      ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}),
    },
  });

  const myIssues = useMemo(() => {
    if (!data?.issues.nodes || !viewer) return [];
    return data.issues.nodes.filter((issue) => issue.assignee?.id === viewer.id);
  }, [data, viewer]);

  const groups = useMemo<IssueGroup[]>(() => {
    const progress: IssueSummary[] = [];
    const todo: IssueSummary[] = [];
    const backlog: IssueSummary[] = [];
    const completed: IssueSummary[] = [];

    for (const issue of myIssues) {
      const group = classifyState(issue.state.name);
      if (group === 'progress') progress.push(issue);
      else if (group === 'completed') completed.push(issue);
      else if (group === 'backlog') backlog.push(issue);
      else todo.push(issue);
    }

    return [
      { label: 'In progress', items: progress },
      { label: 'Todo', items: todo },
      { label: 'Backlog', items: backlog },
      { label: 'Completed', items: completed },
    ];
  }, [myIssues]);

  const viewerUser = viewer ? { name: viewer.name, email: viewer.email } : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <Avatar user={viewerUser} size={20} />
        <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>My Issues</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>
          {myIssues.length}
        </span>
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" icon={<IcoFilter size={12} />} size="sm">Filter</Btn>
      </div>

      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12 }}>
            Loading issues…
          </div>
        ) : myIssues.length === 0 ? (
          <div className="empty-state">
            <h3>No issues assigned to you</h3>
            <p>Issues assigned to your account will appear here.</p>
          </div>
        ) : (
          groups.map((g) =>
            g.items.length === 0 ? null : (
              <div key={g.label}>
                <div className="issue-group-header">
                  <span className="issue-group-header__label">{g.label}</span>
                  <span className="issue-group-header__count">{g.items.length}</span>
                </div>
                {g.items.map((issue) => (
                  <div
                    key={issue.id}
                    onClick={() => navigate(`/issue/${issue.id}`)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '64px 14px 14px 1fr auto auto',
                      gap: 10,
                      alignItems: 'center',
                      height: 'var(--row-h)',
                      padding: '0 var(--pad-x)',
                      borderBottom: '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      fontSize: 13,
                      transition: 'background var(--dur-1) var(--ease)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                      {issue.identifier}
                    </span>
                    <PriorityIcon level={0} size={14} />
                    <StatusIconPrimitive
                      stateType={getStateType(issue.state.name)}
                      stateColor={getStateColor(issue.state.name)}
                      size={14}
                    />
                    <span
                      style={{
                        color: 'var(--fg)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {issue.title}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{issue.state.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                      {formatTimeAgo(issue.updatedAt)}
                    </span>
                  </div>
                ))}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
