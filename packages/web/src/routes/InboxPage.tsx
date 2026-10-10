import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
    case 'work.committed':
      return 'Proposal committed';
    case 'work.rejected':
      return 'Proposal declined';
    case 'work.uncommitted':
      return 'Moved back to candidates';
    case 'work.review_rejected':
      return 'Returned with feedback';
    case 'work.claim_expired':
      return 'Agent lease expired';
    case 'run.stale':
      return 'Agent run went quiet';
    case 'review.overdue':
      return 'Fixed bug waiting too long for review';
    case 'review.digest':
      return 'Waiting for your review';
    case 'attention.digest':
      return 'What needs you today';
    case 'research.closable':
      return 'Research can be closed';
    case 'incident.closable':
      return 'Incident can be closed';
    case 'delivery.approved':
      return 'Delivery authorized';
    case 'executor.dispatched':
      return 'Execution dispatched';
    case 'delivery.declined':
      return 'Delivery change declined';
    case 'contract.breached':
      return 'Contract breached';
    case 'evidence.submitted':
      return 'Evidence submitted';
    case 'webhook.disabled':
      return 'Webhook disabled';
    case 'bug.reported':
      return 'Bug reported';
    case 'contract.amendment_proposed':
      return 'Contract change proposed';
    case 'duplicate.marked':
      return 'Marked as duplicate';
    case 'duplicate.original_changed':
      return 'Original of your duplicate changed';
    case 'bug.sla_at_risk':
      return 'Bug SLA at risk';
    case 'bug.sla_breached':
      return 'Bug SLA breached';
    case 'work.proposed_batch':
      return 'New candidates';
    case 'delivery.proposed':
      return 'Delivery change proposed';
    case 'executor.exhausted':
      return 'Implementation ran out of attempts';
    case 'contract.amendment_accepted':
      return 'Contract change accepted';
    case 'contract.amendment_rejected':
      return 'Contract change rejected';
    default:
      return type
        .split('.')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

function getPayloadSummary(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (Array.isArray(payload.items)) {
    const identifiers = (payload.items as Array<{ identifier?: unknown }>).map((entry) => entry.identifier).filter((value): value is string => typeof value === 'string');
    return `${identifiers.length} proposed: ${identifiers.slice(0, 5).join(', ')}${identifiers.length > 5 ? '…' : ''}`;
  }
  if (typeof payload.summary === 'string' && payload.summary) return payload.summary;
  if (typeof payload.message === 'string' && payload.message) return payload.message;
  if (typeof payload.reason === 'string' && payload.reason) return payload.reason;
  if (typeof payload.decision === 'string' && payload.decision) return `Decision: ${payload.decision}`;
  return null;
}

export interface ActivityRow {
  item: NotificationRecordItem;
  /** Older notifications about the same work, folded under the newest. */
  more: NotificationRecordItem[];
}

/**
 * One row per work item (INV-1093), like GitHub's activity: the newest
 * notification stands for the rest. Notifications with no work stay alone.
 * The list arrives newest first, so each row sits where its newest one was.
 */
export function groupActivity(items: NotificationRecordItem[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const byWork = new Map<string, ActivityRow>();
  for (const item of items) {
    const key = item.work?.id;
    const row = key ? byWork.get(key) : undefined;
    if (row) {
      row.more.push(item);
      continue;
    }
    const created = { item, more: [] };
    rows.push(created);
    if (key) byWork.set(key, created);
  }
  return rows;
}

/** What became of a notification that asked for a decision. */
export function resolutionText(item: NotificationRecordItem): string | null {
  if (!item.actionable || !item.resolvedAt) return null;
  const how = item.resolution ? item.resolution.charAt(0).toUpperCase() + item.resolution.slice(1) : 'Decided';
  const who = item.resolvedBy?.name ?? item.resolvedBy?.email;
  return who ? `${how} by ${who}` : how;
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

  const markGroupRead = (group: NotificationRecordItem[]) => {
    for (const entry of group) {
      if (!entry.readAt) void runMarkRead({ variables: { id: entry.id } });
    }
  };

  const handleOpenGroup = (group: NotificationRecordItem[]) => {
    markGroupRead(group);
    const work = group[0]?.work;
    if (work) {
      navigate(`/work/${work.id}`);
    }
  };

  const handleMarkGroupRead = (e: React.MouseEvent, group: NotificationRecordItem[]) => {
    e.stopPropagation();
    markGroupRead(group);
  };

  const handleMarkAllRead = async () => {
    await runMarkAllRead();
  };

  return (
    <main className="inbox-page" aria-label="Activity">
      <header className="inbox-page__header">
        <IcoInbox size={14} style={{ color: 'var(--fg-dim)' }} />
        <span className="inbox-page__title">Activity</span>
        {/* No number here: what waits on you is counted once, in Needs you (INV-1093). */}
        <Link className="inbox-page__todo-link" to="/todo">What needs you</Link>
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
        <div className="inbox-page__toggle" role="tablist" aria-label="Activity filter">
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
            Could not load activity. Confirm the API server is running and try again.
          </p>
        ) : loading && notifications.length === 0 ? (
          <p className="inbox-page__empty">Loading…</p>
        ) : notifications.length === 0 ? (
          <p className="inbox-page__empty">
            {filter === 'unread' ? 'Nothing unread.' : 'No activity yet.'}
          </p>
        ) : (
          groupActivity(notifications).map(({ item, more }) => {
            const group = [item, ...more];
            const isUnread = group.some((entry) => !entry.readAt);
            const summary = getPayloadSummary(item.payload);
            const resolved = resolutionText(item);

            return (
              <div
                role="button"
                tabIndex={0}
                key={item.id}
                className={`inbox-item${isUnread ? ' inbox-item--unread' : ''}`}
                onClick={() => handleOpenGroup(group)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleOpenGroup(group);
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
                  {item.actionable ? (
                    resolved ? (
                      <div className="inbox-item__resolution">{resolved}</div>
                    ) : (
                      <Link className="inbox-item__ops-link" to="/todo" onClick={(event) => event.stopPropagation()}>
                        Waiting on you · Needs you
                      </Link>
                    )
                  ) : null}
                  {more.length > 0 ? (
                    <div className="inbox-item__more">+{more.length} more on this item</div>
                  ) : null}
                  {!item.work ? <NotificationDetails payload={item.payload} /> : null}
                  {!item.work && OPS_SECTION[item.type] ? (
                    <Link className="inbox-item__ops-link" to={`/ops#${OPS_SECTION[item.type]}`} onClick={(event) => event.stopPropagation()}>
                      Open in Ops
                    </Link>
                  ) : null}
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
                      onClick={(e) => handleMarkGroupRead(e, group)}
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

const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

/** Where on the ops page each ops notification is handled (INV-796). */
const OPS_SECTION: Record<string, string> = {
  'webhook.disabled': 'webhooks',
  'ops.webhook.disabled': 'webhooks',
  'ops.event.dead_letter': 'outbox',
  'ops.github_sync.dead_letter': 'sync-dead-letters',
  'ops.github_inbound.dead_letter': 'inbound',
  'ops.github_inbound.payload_conflict': 'inbound',
  'ops.github.pr_unverified_reference': 'traceability',
};

/**
 * A notification with no work item — ops alerts, a disabled webhook — opens
 * nothing, so its details and links are shown in the row itself (INV-794).
 */
function NotificationDetails({ payload }: { payload: Record<string, unknown> | null }) {
  if (!payload) return null;
  const entries = Object.entries(payload).filter(
    ([key, value]) => key !== 'summary' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
  );
  if (entries.length === 0) return null;
  return (
    <dl className="inbox-item__details" aria-label="Notification details" onClick={(event) => event.stopPropagation()}>
      {entries.map(([key, value]) => {
        const text = String(value);
        return (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              {/^https?:\/\//.test(text) ? (
                <a href={text} target="_blank" rel="noreferrer">
                  {text}
                </a>
              ) : IDENTIFIER.test(text) ? (
                <a href={`/issue/${text}`}>{text}</a>
              ) : (
                text
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
