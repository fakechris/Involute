import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, IssueSummary } from '../board/types';
import { StatusIcon } from '../components/StatusIcon';

type InboxFilter = 'all' | 'unread';

interface InboxEntry {
  id: string;
  ago: string;
  at: string;
  body: string;
  fromInitials: string;
  fromName: string;
  issue: IssueSummary;
  kind: 'comment' | 'assigned' | 'status';
  unread: boolean;
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) {
    return '';
  }

  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) {
    return `${Math.max(1, Math.round(diff / minute))}m`;
  }
  if (diff < day) {
    return `${Math.round(diff / hour)}h`;
  }
  if (diff < 7 * day) {
    return `${Math.round(diff / day)}d`;
  }
  return `${Math.round(diff / (7 * day))}w`;
}

function getInitials(name: string | null | undefined): string {
  if (!name) {
    return '?';
  }
  return name
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
}

function deriveEntries(issues: IssueSummary[]): InboxEntry[] {
  const entries: InboxEntry[] = [];

  for (const issue of issues) {
    for (const comment of issue.comments.nodes) {
      entries.push({
        id: `cmt-${comment.id}`,
        ago: formatRelative(comment.createdAt),
        at: comment.createdAt,
        body: comment.body,
        fromInitials: getInitials(comment.user?.name ?? comment.user?.email ?? null),
        fromName: comment.user?.name ?? comment.user?.email ?? 'Someone',
        issue,
        kind: 'comment',
        unread: Date.now() - new Date(comment.createdAt).getTime() < 24 * 60 * 60 * 1000,
      });
    }

    if (issue.assignee) {
      entries.push({
        id: `asn-${issue.id}`,
        ago: formatRelative(issue.updatedAt),
        at: issue.updatedAt,
        body: 'assigned this to you',
        fromInitials: getInitials(issue.assignee.name ?? issue.assignee.email ?? null),
        fromName: issue.assignee.name ?? issue.assignee.email ?? 'Someone',
        issue,
        kind: 'assigned',
        unread: Date.now() - new Date(issue.updatedAt).getTime() < 24 * 60 * 60 * 1000,
      });
    }
  }

  entries.sort((left, right) => {
    if (left.unread !== right.unread) {
      return left.unread ? -1 : 1;
    }
    return new Date(right.at).getTime() - new Date(left.at).getTime();
  });

  return entries;
}

const INBOX_DISPLAY_LIMIT = 24;

export function InboxPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const { data, loading, error } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(
    BOARD_PAGE_QUERY,
    {
      fetchPolicy: 'cache-and-network',
      variables: { first: 60 },
    },
  );

  const entries = useMemo(() => deriveEntries(data?.issues.nodes ?? []), [data?.issues.nodes]);
  const visibleEntries = useMemo(() => {
    const filtered = filter === 'unread' ? entries.filter((entry) => entry.unread) : entries;
    return filtered.slice(0, INBOX_DISPLAY_LIMIT);
  }, [entries, filter]);

  const unreadCount = entries.filter((entry) => entry.unread).length;

  return (
    <main className="board-page inbox-page" aria-label="Inbox">
      <header className="app-shell__header">
        <div className="app-shell__header-copy">
          <div className="app-shell__header-inline-meta">
            <span className="context-chip">Inbox</span>
          </div>
          <h1>Inbox</h1>
        </div>
        <div className="board-page__controls">
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {unreadCount} unread
          </span>
        </div>
      </header>

      <div className="inbox-page__toolbar">
        <div className="inbox-page__toolbar-toggle" role="tablist" aria-label="Inbox filter">
          {(['all', 'unread'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? 'is-active' : ''}
              onClick={() => setFilter(key)}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <div className="inbox-page__list">
        {error && entries.length === 0 ? (
          <p className="inbox-page__empty" role="alert">
            Could not load inbox updates. Confirm the API server is running and try again.
          </p>
        ) : loading && entries.length === 0 ? (
          <p className="inbox-page__empty">Loading…</p>
        ) : visibleEntries.length === 0 ? (
          <p className="inbox-page__empty">
            {filter === 'unread' ? 'No unread updates.' : 'Inbox is empty.'}
          </p>
        ) : (
          visibleEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`inbox-page__item${entry.unread ? ' inbox-page__item--unread' : ''}`}
              onClick={() => navigate(`/issue/${entry.issue.id}`)}
            >
              <span className="inbox-page__item-avatar" aria-hidden="true">
                {entry.fromInitials}
                {entry.unread ? <span className="inbox-page__item-dot" /> : null}
              </span>
              <span className="inbox-page__item-copy">
                <span className="inbox-page__item-line">
                  <strong>{entry.fromName}</strong>{' '}
                  <span>
                    {entry.kind === 'comment'
                      ? 'commented on'
                      : entry.kind === 'assigned'
                        ? 'is assigned to'
                        : 'updated'}
                  </span>{' '}
                  <span className="mono" style={{ color: 'var(--fg-muted)' }}>
                    {entry.issue.identifier}
                  </span>
                </span>
                <span className="inbox-page__item-issue">
                  <StatusIcon stateName={entry.issue.state.name} size={11} /> {entry.issue.title}
                </span>
              </span>
              <span className="inbox-page__item-time">{entry.ago}</span>
            </button>
          ))
        )}
      </div>
    </main>
  );
}
