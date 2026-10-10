import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ISSUE_TIMELINE_QUERY, ISSUE_TIMELINE_STAR_MUTATION, ISSUE_TIMELINE_UNSTAR_MUTATION } from '../board/queries';
import type { CommentSummary } from '../board/types';
import { IcoLabel } from './Icons';

interface TimelineActor {
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface IssueTimelineEntry {
  key: string;
  kind: string;
  at: string;
  actorKind?: string | null;
  actor?: TimelineActor | null;
  summary: string;
  detail?: string | null;
  url?: string | null;
  sourceId: string;
  starred: boolean;
  starredAt?: string | null;
  starredBy?: TimelineActor | null;
}

export interface IssueTimelineQueryData {
  issueTimeline: { workId: string; truncated: boolean; entries: IssueTimelineEntry[] };
}

interface StarPayload {
  success: boolean;
  message?: string | null;
  entryKey?: string | null;
  starred?: boolean | null;
}

type StarVariables = { input: { issueId: string; entryKey: string } };

type Row =
  | { type: 'event'; key: string; at: string; entry: IssueTimelineEntry }
  | { type: 'comment'; key: string; at: string; comment: CommentSummary };

const actorName = (actor: TimelineActor | null | undefined) => actor?.name ?? actor?.email ?? null;

function formatTimestamp(at: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/**
 * Activity on the issue page (INV-1116): the server's timeline — state,
 * assignee, priority and field changes from the audit trail, runs and
 * evidence — interleaved with the comments the page already holds (so a
 * comment posted or deleted shows at once), each with a star that marks it as
 * a key event. "Key events only" narrows the list to starred entries.
 */
export function IssueTimeline({
  issueId,
  comments,
  refreshKey,
  renderComment,
}: {
  issueId: string;
  comments: CommentSummary[];
  /** Changes when the issue or its comments change, so the server timeline is read again. */
  refreshKey: string;
  renderComment: (comment: CommentSummary, star: ReactNode) => ReactNode;
}) {
  const { data, refetch } = useQuery<IssueTimelineQueryData, { issueId: string }>(ISSUE_TIMELINE_QUERY, {
    variables: { issueId },
    fetchPolicy: 'cache-and-network',
  });
  const [runStar] = useMutation<{ issueTimelineStar: StarPayload }, StarVariables>(ISSUE_TIMELINE_STAR_MUTATION);
  const [runUnstar] = useMutation<{ issueTimelineUnstar: StarPayload }, StarVariables>(ISSUE_TIMELINE_UNSTAR_MUTATION);
  const [starredOnly, setStarredOnly] = useState(false);
  // What this person just starred or unstarred, until the server timeline catches up.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    void refetch?.();
  }, [refreshKey, refetch]);

  const serverEntries = useMemo(() => data?.issueTimeline?.entries ?? [], [data]);
  const starredOnServer = useMemo(() => new Map(serverEntries.map((entry) => [entry.key, entry.starred])), [serverEntries]);
  const isStarred = (key: string) => overrides[key] ?? starredOnServer.get(key) ?? false;

  const rows = useMemo(() => {
    const list: Row[] = serverEntries
      .filter((entry) => entry.kind !== 'COMMENT')
      .map((entry) => ({ type: 'event' as const, key: entry.key, at: entry.at, entry }));
    for (const comment of comments) list.push({ type: 'comment', key: `comment:${comment.id}`, at: comment.createdAt, comment });
    return list.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
  }, [comments, serverEntries]);

  const visible = starredOnly ? rows.filter((row) => isStarred(row.key)) : rows;

  async function toggleStar(key: string) {
    const next = !isStarred(key);
    setError(null);
    setOverrides((current) => ({ ...current, [key]: next }));
    try {
      const variables = { input: { issueId, entryKey: key } };
      const payload = next
        ? (await runStar({ variables })).data?.issueTimelineStar
        : (await runUnstar({ variables })).data?.issueTimelineUnstar;
      if (!payload?.success) {
        setOverrides((current) => ({ ...current, [key]: !next }));
        setError(payload?.message ?? 'The star could not be saved.');
        return;
      }
      void refetch?.();
    } catch (failure) {
      setOverrides((current) => ({ ...current, [key]: !next }));
      setError(failure instanceof Error ? failure.message : 'The star could not be saved.');
    }
  }

  function starButton(key: string) {
    const starred = isStarred(key);
    return (
      <button
        type="button"
        className={`issue-timeline__star${starred ? ' issue-timeline__star--on' : ''}`}
        aria-label={starred ? 'Remove star' : 'Star as key event'}
        aria-pressed={starred}
        title={starred ? 'Remove star' : 'Star as key event'}
        onClick={() => void toggleStar(key)}
      >
        {starred ? '★' : '☆'}
      </button>
    );
  }

  return (
    <div className="issue-panel__activity-section">
      <div className="issue-panel__activity-header issue-timeline__header">
        <span>Activity</span>
        <button
          type="button"
          className="issue-timeline__filter"
          aria-pressed={starredOnly}
          onClick={() => setStarredOnly((current) => !current)}
        >
          Key events only
        </button>
      </div>
      {error ? <div role="alert" className="issue-timeline__error">{error}</div> : null}
      <div className="issue-activity" aria-label="Issue activity">
        {visible.length === 0 && starredOnly ? (
          <div className="observation-empty">No key events yet. Star an entry to mark it.</div>
        ) : null}
        {visible.map((row) =>
          row.type === 'comment' ? (
            <div key={row.key}>{renderComment(row.comment, starButton(row.key))}</div>
          ) : (
            <div key={row.key} className="issue-activity__event" data-kind={row.entry.kind}>
              <div className="issue-activity__event-icon">
                {row.entry.kind === 'FIELDS' ? (
                  <IcoLabel size={12} />
                ) : (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fg-dim)', display: 'block' }} />
                )}
              </div>
              <span style={{ flex: 1, minWidth: 0 }}>
                {actorName(row.entry.actor) ? <strong className="issue-timeline__actor">{actorName(row.entry.actor)}</strong> : null}{' '}
                {row.entry.summary}
                {row.entry.detail ? <span className="issue-timeline__detail"> — {row.entry.detail}</span> : null}
                {row.entry.url ? (
                  <>
                    {' '}
                    <a href={row.entry.url} target="_blank" rel="noreferrer">link</a>
                  </>
                ) : null}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 13, whiteSpace: 'nowrap' }}>{formatTimestamp(row.at)}</span>
              {starButton(row.key)}
            </div>
          ),
        )}
      </div>
      {data?.issueTimeline?.truncated ? <div className="observation-empty">Older entries are not shown.</div> : null}
    </div>
  );
}
