import { useEffect, useMemo, useRef, useState } from 'react';
import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';

import { IcoBell } from './Icons';

const UNREAD_COUNT_QUERY = gql`
  query UnreadNotificationCount {
    unreadNotificationCount
  }
`;

const NOTIFICATIONS_QUERY = gql`
  query NotificationPanel($first: Int) {
    notifications(first: $first) {
      nodes {
        id
        type
        payload
        readAt
        createdAt
        work {
          id
          identifier
          title
        }
      }
    }
  }
`;

const MARK_READ_MUTATION = gql`
  mutation NotificationMarkRead($id: String!) {
    notificationMarkRead(id: $id) {
      success
    }
  }
`;

const MARK_ALL_READ_MUTATION = gql`
  mutation NotificationsMarkAllRead {
    notificationsMarkAllRead {
      count
      success
    }
  }
`;

interface NotificationItem {
  createdAt: string;
  id: string;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  type: string;
  work: { id: string; identifier: string; title: string } | null;
}

const PANEL_SIZE = 10;

export function NotificationsBell({ authenticated }: { authenticated: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const countQuery = useQuery<{ unreadNotificationCount: number }>(UNREAD_COUNT_QUERY, {
    // The one deliberate poll in the shell: notifications are push-shaped but
    // the kernel has no websocket surface yet; 60s keeps the badge honest
    // without load.
    pollInterval: 60_000,
    skip: !authenticated,
  });
  const listQuery = useQuery<{ notifications: { nodes: NotificationItem[] } }>(NOTIFICATIONS_QUERY, {
    fetchPolicy: 'network-only',
    skip: !authenticated || !isOpen,
    variables: { first: PANEL_SIZE },
  });
  const [markRead] = useMutation(MARK_READ_MUTATION);
  const [markAllRead] = useMutation(MARK_ALL_READ_MUTATION);

  const unreadCount = countQuery.data?.unreadNotificationCount ?? 0;
  const items = useMemo(() => listQuery.data?.notifications?.nodes ?? [], [listQuery.data]);

  if (!authenticated) {
    return null;
  }

  const openItem = (item: NotificationItem) => {
    if (!item.readAt) {
      void markRead({ variables: { id: item.id } });
    }
    setIsOpen(false);
    if (item.work) {
      navigate(`/work/${item.work.id}`);
    }
  };

  return (
    <div className="notif-bell" ref={containerRef}>
      <button
        type="button"
        className="app-shell__footer-settings"
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-testid="notifications-bell"
        onClick={() => setIsOpen((open) => !open)}
      >
        <IcoBell size={14} />
        {unreadCount > 0 ? (
          <span className="notif-bell__badge" data-testid="notifications-badge">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="notif-bell__panel" role="dialog" aria-label="Notifications" data-testid="notifications-panel">
          <div className="notif-bell__panel-head">
            <strong>Notifications</strong>
            {unreadCount > 0 ? (
              <button
                type="button"
                className="notif-bell__link"
                onClick={() => {
                  void markAllRead({
                    refetchQueries: [UNREAD_COUNT_QUERY, NOTIFICATIONS_QUERY],
                  });
                }}
              >
                Mark all read
              </button>
            ) : null}
          </div>
          {listQuery.loading && items.length === 0 ? (
            <div className="notif-bell__empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="notif-bell__empty">Nothing yet. Decisions requested by agents land here.</div>
          ) : (
            <ul className="notif-bell__list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`notif-bell__item${item.readAt ? '' : ' notif-bell__item--unread'}`}
                    onClick={() => openItem(item)}
                  >
                    <span className="notif-bell__item-type">{item.type}</span>
                    {item.work ? (
                      <span className="notif-bell__item-title">
                        [{item.work.identifier}] {item.work.title}
                      </span>
                    ) : (
                      <span className="notif-bell__item-title">{item.type}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
