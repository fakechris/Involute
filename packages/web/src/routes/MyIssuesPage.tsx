import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, IssueSummary, WorkflowStateType } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoFilter } from '../components/Icons';
import { Avatar, Btn, PriorityIcon, StatusIconPrimitive } from '../components/Primitives';

function formatTimeAgo(date: string): string {
  const parsed = new Date(date).getTime();
  if (Number.isNaN(parsed)) return '—';
  const seconds = Math.floor((Date.now() - parsed) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function classifyState(stateType: WorkflowStateType): 'progress' | 'todo' | 'backlog' | 'completed' {
  switch (stateType) {
    case 'STARTED': return 'progress';
    case 'COMPLETED':
    case 'CANCELED': return 'completed';
    case 'BACKLOG': return 'backlog';
    case 'UNSTARTED':
    default: return 'todo';
  }
}

function getStateType(stateType: WorkflowStateType): string {
  switch (stateType) {
    case 'COMPLETED': return 'completed';
    case 'CANCELED': return 'canceled';
    case 'STARTED': return 'started';
    case 'BACKLOG': return 'backlog';
    case 'UNSTARTED':
    default: return 'unstarted';
  }
}

function getStateColor(stateType: WorkflowStateType): string {
  const type = getStateType(stateType);
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

  const { data, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 500,
      filter: {
        ...(teamKey ? { team: { key: { eq: teamKey } } } : {}),
        assignee: { isMe: { eq: true } },
      },
    },
  });

  const myIssues = data?.issues.nodes ?? [];

  const groups = useMemo<IssueGroup[]>(() => {
    const progress: IssueSummary[] = [];
    const todo: IssueSummary[] = [];
    const backlog: IssueSummary[] = [];
    const completed: IssueSummary[] = [];

    for (const issue of myIssues) {
      const group = classifyState(issue.state.type);
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

  const firstAssignee = myIssues[0]?.assignee ?? null;
  const viewerUser = firstAssignee ? { name: firstAssignee.name ?? undefined, email: firstAssignee.email ?? undefined } : null;

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
                  <button
                    type="button"
                    key={issue.id}
                    onClick={() => navigate(`/issue/${issue.id}`)}
                    aria-label={`Open issue ${issue.identifier}`}
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
                      background: 'transparent',
                      border: 'none',
                      width: '100%',
                      textAlign: 'left',
                      color: 'inherit',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                      {issue.identifier}
                    </span>
                    <PriorityIcon level={issue.priority} size={14} />
                    <StatusIconPrimitive
                      stateType={getStateType(issue.state.type)}
                      stateColor={getStateColor(issue.state.type)}
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
                  </button>
                ))}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
