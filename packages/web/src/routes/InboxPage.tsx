import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';

import {
  NOTIFICATIONS_PAGE_QUERY,
  NOTIFICATION_MARK_READ_MUTATION,
  NOTIFICATIONS_MARK_ALL_READ_MUTATION,
} from '../board/queries';
import type {
  NotificationRecordItem,
  NotificationsPageQueryData,
  NotificationsPageQueryVariables,
  NotificationMarkReadMutationData,
  NotificationMarkReadMutationVariables,
  NotificationsMarkAllReadMutationData,
} from '../board/types';
import { IcoCheck, IcoInbox } from '../components/Icons';
import { Btn } from '../components/Primitives';

type InboxFilter = 'all' | 'unread';

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

function formatNotificationType(type: string): string {
  switch (type) {
    case 'decision.requested':
      return 'Decision requested';
    case 'run.completed':
      return 'Run completed';
    case 'work.accepted':
      return 'Work accepted';
    case 'contract.breached':
      return 'Contract breached';
    case 'evidence.submitted':
      return 'Evidence submitted';
    case 'webhook.disabled':
      return 'Webhook disabled';
    case 'bug.reported':
      return 'Bug reported';
    default:
      return type
        .split('.')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

function getPayloadSummary(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (typeof payload.summary === 'string' && payload.summary) return payload.summary;
  if (typeof payload.message === 'string' && payload.message) return payload.message;
  if (typeof payload.reason === 'string' && payload.reason) return payload.reason;
  if (typeof payload.decision === 'string' && payload.decision) return `Decision: ${payload.decision}`;
  return null;
}

export function InboxPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<InboxFilter>('all');

  const queryVariables: NotificationsPageQueryVariables = { first: 50 };
  if (filter === 'unread') {
    queryVariables.unreadOnly = true;
  }

  const { data, loading, error, refetch } = useQuery<
    NotificationsPageQueryData,
    NotificationsPageQueryVariables
  >(NOTIFICATIONS_PAGE_QUERY, {
    fetchPolicy: 'cache-and-network',
    variables: queryVariables,
  });

  const [runMarkRead] = useMutation<
    NotificationMarkReadMutationData,
    NotificationMarkReadMutationVariables
  >(NOTIFICATION_MARK_READ_MUTATION, {
    update(cache, { data: mutationData }) {
      if (mutationData?.notificationMarkRead.success) {
        void refetch();
      }
    },
  });

  const [runMarkAllRead, { loading: markingAll }] = useMutation<NotificationsMarkAllReadMutationData>(
    NOTIFICATIONS_MARK_ALL_READ_MUTATION,
    {
      onCompleted() {
        void refetch();
      },
    },
  );

  const notifications = useMemo(() => data?.notifications.nodes ?? [], [data?.notifications.nodes]);
  const unreadCount = data?.unreadNotificationCount ?? 0;

  const handleOpenItem = (item: NotificationRecordItem) => {
    if (!item.readAt) {
      void runMarkRead({ variables: { id: item.id } });
    }
    if (item.work) {
      navigate(`/work/${item.work.id}`);
    }
  };

  const handleMarkItemRead = (e: React.MouseEvent, item: NotificationRecordItem) => {
    e.stopPropagation();
    if (!item.readAt) {
      void runMarkRead({ variables: { id: item.id } });
    }
  };

  const handleMarkAllRead = async () => {
    await runMarkAllRead();
  };

  return (
    <main className="inbox-page" aria-label="Inbox">
      <header className="inbox-page__header">
        <IcoInbox size={14} style={{ color: 'var(--fg-dim)' }} />
        <span className="inbox-page__title">Inbox</span>
        <span className="mono" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
          {unreadCount}
        </span>
        <div style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <Btn
            variant="ghost"
            size="sm"
            disabled={markingAll}
            onClick={() => void handleMarkAllRead()}
            style={{ marginRight: 8 }}
          >
            Mark all read
          </Btn>
        )}
        <div className="inbox-page__toggle" role="tablist" aria-label="Inbox filter">
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
      </header>

      <div className="inbox-page__list">
        {error && notifications.length === 0 ? (
          <p className="inbox-page__empty" role="alert">
            Could not load inbox notifications. Confirm the API server is running and try again.
          </p>
        ) : loading && notifications.length === 0 ? (
          <p className="inbox-page__empty">Loading…</p>
        ) : notifications.length === 0 ? (
          <p className="inbox-page__empty">
            {filter === 'unread' ? 'No unread notifications.' : 'Inbox is empty.'}
          </p>
        ) : (
          notifications.map((item) => {
            const isUnread = !item.readAt;
            const summary = getPayloadSummary(item.payload);

            return (
              <div
                role="button"
                tabIndex={0}
                key={item.id}
                className={`inbox-item${isUnread ? ' inbox-item--unread' : ''}`}
                onClick={() => handleOpenItem(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleOpenItem(item);
                  }
                }}
              >
                <div className="inbox-avatar-wrap">
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: 'var(--bg-hover)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--fg-muted)',
                    }}
                  >
                    ⚡
                  </div>
                  {isUnread && <span className="inbox-unread-dot" />}
                </div>

                <div className="inbox-item__content">
                  <div className="inbox-item__line">
                    <strong>{formatNotificationType(item.type)}</strong>
                    {item.work && (
                      <>
                        <span style={{ color: 'var(--fg-dim)' }}> on </span>
                        <span className="mono" style={{ color: 'var(--fg-muted)' }}>
                          {item.work.identifier}
                        </span>
                      </>
                    )}
                  </div>
                  {item.work && (
                    <div className="inbox-item__issue truncate">
                      {item.work.title}
                    </div>
                  )}
                  {summary && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--fg-dim)',
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {summary}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span className="inbox-item__time">{formatRelative(item.createdAt)}</span>
                  {isUnread && (
                    <button
                      type="button"
                      title="Mark as read"
                      aria-label="Mark as read"
                      onClick={(e) => handleMarkItemRead(e, item)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 4,
                        cursor: 'pointer',
                        color: 'var(--fg-dim)',
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <IcoCheck size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}
