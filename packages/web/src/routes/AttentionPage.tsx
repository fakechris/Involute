import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { AgentRequestActions } from '../components/AgentRequestActions';
import { ContractAmendmentPanel, useContractAmendmentDecisions } from '../components/ContractAmendmentPanel';
import { DELIVERY_DECIDE_MUTATION, DeliveryChangeQueue } from '../components/DeliveryPanel';
import { HumanReviewSection } from '../components/HumanReviewSection';
import { Btn } from '../components/Primitives';
import { RespondToAgent } from '../components/RespondToAgent';
import { useListKeys } from '../components/useListKeys';
import { fetchSessionState, type SessionViewer } from '../lib/session';
import { recordCommitGesture, undoStatusGesture } from '../undo/status-undo';
import { ATTENTION_PAGE_QUERY, WORK_COMMIT_MUTATION, WORK_CONTEXT_PAGE_QUERY, WORK_REVIEW_MUTATION } from '../work/queries';
import type {
  AttentionItemNode,
  AttentionKind,
  AttentionPageQueryData,
  WorkCommitMutationData,
  WorkCommitMutationVariables,
  WorkContextPageQueryData,
  WorkContextPageQueryVariables,
  WorkReviewMutationData,
  WorkReviewMutationVariables,
  WorkUserSummary,
} from '../work/types';
import { CandidateCard, COMMIT_CANDIDATE_EVENT, SNOOZE_CANDIDATE_EVENT, commitUndoItem, humanUsers } from './CandidatesPage';

/** Section order: the decisions that unblock running work first. */
const SECTIONS: Array<{ kind: AttentionKind; title: string }> = [
  { kind: 'CONTRACT_AMENDMENT', title: 'Contract changes' },
  { kind: 'WORK_REVIEW', title: 'Accept work' },
  { kind: 'CANDIDATE_COMMIT', title: 'Commit candidates' },
  { kind: 'DELIVERY_CHANGE', title: 'Delivery approvals' },
  { kind: 'AGENT_REQUEST', title: 'Agent questions' },
  { kind: 'DECISION_REQUESTED', title: 'Decisions requested' },
  { kind: 'OPS', title: 'Operations' },
];

const BATCHABLE: Partial<Record<AttentionKind, string>> = {
  CANDIDATE_COMMIT: 'Commit',
  CONTRACT_AMENDMENT: 'Accept contract change',
  WORK_REVIEW: 'Accept',
};

const MINUTE = 60_000;
// One empty list, so a render without data does not look like a new list.
const NO_ITEMS: AttentionItemNode[] = [];

export function formatWait(since: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(since).getTime());
  if (ms >= 24 * 60 * MINUTE) return `${Math.floor(ms / (24 * 60 * MINUTE))}d`;
  if (ms >= 60 * MINUTE) return `${Math.floor(ms / (60 * MINUTE))}h`;
  return `${Math.max(1, Math.floor(ms / MINUTE))}m`;
}

interface Section {
  key: string;
  title: string;
  count: number;
  oldestSince: string | null;
  groups: Array<{ key: string; label: string | null; items: AttentionItemNode[] }>;
  /** Work-tree view: one sentence on what the pack holds (INV-1094). */
  summary?: string;
}

export type AttentionView = 'kind' | 'tree';
const VIEW_STORAGE_KEY = 'involute.todo.view';

const NOUNS: Record<AttentionKind, [string, string]> = {
  AGENT_REQUEST: ['agent question', 'agent questions'],
  CANDIDATE_COMMIT: ['candidate to commit', 'candidates to commit'],
  CONTRACT_AMENDMENT: ['contract change', 'contract changes'],
  DECISION_REQUESTED: ['decision requested', 'decisions requested'],
  DELIVERY_CHANGE: ['delivery approval', 'delivery approvals'],
  OPS: ['operations item', 'operations items'],
  WORK_REVIEW: ['finished item to accept', 'finished items to accept'],
};

/** "3 candidates to commit, 1 contract change" in section order. */
export function packSummary(items: AttentionItemNode[]): string {
  return SECTIONS.flatMap(({ kind }) => {
    const count = items.filter((item) => item.kind === kind).length;
    return count ? [`${count} ${NOUNS[kind][count === 1 ? 0 : 1]}`] : [];
  }).join(', ');
}

/**
 * Inside a pack: what just became ready first (everything before it is done),
 * then in BLOCKS order — an item waiting on another item of the pack comes
 * after it — then the longest wait (INV-1094).
 */
export function orderPack(items: AttentionItemNode[]): AttentionItemNode[] {
  const byWait = [...items].sort((a, b) => Number(Boolean(b.unblocked)) - Number(Boolean(a.unblocked)) || a.since.localeCompare(b.since));
  const ordered: AttentionItemNode[] = [];
  const remaining = new Set(byWait);
  while (remaining.size > 0) {
    const pending = new Set([...remaining].flatMap((item) => (item.work ? [item.work.id] : [])));
    const next = [...remaining].find((item) => !(item.waitingOn ?? []).some((blocker) => pending.has(blocker.id))) ?? [...remaining][0]!;
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered;
}

/** One pack per work tree (nearest EPIC/MILESTONE, else PROJECT); packs with anything overdue first, then the oldest. */
function buildPacks(items: AttentionItemNode[]): Section[] {
  const packs = new Map<string, AttentionItemNode[]>();
  for (const item of items) {
    const key = item.groupKey ?? '';
    packs.set(key, [...(packs.get(key) ?? []), item]);
  }
  return [...packs.entries()]
    .map(([key, entries]) => {
      const ordered = orderPack(entries);
      const group = entries.find((entry) => entry.group)?.group ?? null;
      const oldest = [...entries].sort((a, b) => a.since.localeCompare(b.since))[0]!.since;
      return {
        count: entries.length,
        groups: [{ items: ordered, key, label: null }],
        key: `pack:${key}`,
        oldestSince: oldest,
        summary: packSummary(entries),
        title: group ? `${group.identifier} ${group.title}` : 'Not placed',
        overdue: entries.some((entry) => entry.overdue),
      };
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.oldestSince ?? '').localeCompare(b.oldestSince ?? ''))
    .map(({ overdue: _overdue, ...section }) => section);
}

/** What a pack's one button may decide: no reason needed, nothing it waits on, nothing stale. Review stays a person's look. */
export function suggestedDecisions(items: AttentionItemNode[]): AttentionItemNode[] {
  return items.filter((item) => {
    if ((item.waitingOn ?? []).length > 0) return false;
    if (item.kind === 'CANDIDATE_COMMIT') return item.actions.includes('COMMIT');
    if (item.kind === 'CONTRACT_AMENDMENT') return item.actions.includes('ACCEPT');
    if (item.kind === 'DELIVERY_CHANGE') return item.actions.includes('APPROVE');
    return false;
  });
}

/** Sections in fixed order; inside one, items under the same EPIC/MILESTONE sit together, longest wait first. */
function buildSections(items: AttentionItemNode[]): Section[] {
  return SECTIONS.flatMap(({ kind, title }) => {
    const ofKind = items.filter((item) => item.kind === kind).sort((a, b) => a.since.localeCompare(b.since));
    if (ofKind.length === 0) return [];
    const groups = new Map<string, { key: string; label: string | null; items: AttentionItemNode[] }>();
    for (const item of ofKind) {
      const key = item.groupKey ?? '';
      if (!groups.has(key)) {
        groups.set(key, { key, label: item.group ? `${item.group.identifier} ${item.group.title}` : null, items: [] });
      }
      groups.get(key)!.items.push(item);
    }
    // Groups follow their oldest item; Map keeps first-seen order, which is that.
    return [{ count: ofKind.length, groups: [...groups.values()], key: kind, oldestSince: ofKind[0]!.since, title }];
  });
}

type Armed = { id: string; action: 'accept' } | null;

/**
 * Needs you (INV-1092): everything waiting on this person's decision, in one
 * list. J/K move, the decision is made on the right without leaving the page,
 * and the next item comes up. The count beside "Needs you" in the sidebar is
 * the same list (INV-1091).
 */
export function AttentionPage() {
  const navigate = useNavigate();
  const [viewer, setViewer] = useState<SessionViewer | null>(null);
  useEffect(() => {
    fetchSessionState()
      .then((session) => setViewer(session.viewer))
      .catch(() => setViewer(null));
  }, []);

  const { data, error, loading, refetch } = useQuery<AttentionPageQueryData, { first: number }>(ATTENTION_PAGE_QUERY, {
    variables: { first: 200 },
    fetchPolicy: 'cache-and-network',
  });
  const refresh = () => refetch();
  const items = data?.attention.nodes ?? NO_ITEMS;
  // By kind (decide one sort of thing in a row) or by work tree (decide one piece of work at once), remembered (INV-1094).
  const [view, setView] = useState<AttentionView>(() => (window.localStorage.getItem(VIEW_STORAGE_KEY) === 'tree' ? 'tree' : 'kind'));
  useEffect(() => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);
  const sections = useMemo(() => (view === 'tree' ? buildPacks(items) : buildSections(items)), [items, view]);
  const ordered = useMemo(() => sections.flatMap((section) => section.groups.flatMap((group) => group.items)), [sections]);

  const humansByTeam = useMemo(() => {
    const result = new Map<string, WorkUserSummary[]>();
    for (const team of data?.teams.nodes ?? []) {
      result.set(team.id, humanUsers(team.memberships.nodes.map((membership) => membership.user)));
    }
    return result;
  }, [data?.teams.nodes]);
  const statesByTeam = useMemo(
    () => new Map((data?.teams.nodes ?? []).map((team) => [team.id, team.states?.nodes ?? []])),
    [data?.teams.nodes],
  );

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [armed, setArmed] = useState<Armed>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<Array<{ id: string; label: string; message: string | null }>>([]);
  const [batchPending, setBatchPending] = useState(false);

  const amendmentDecisions = useContractAmendmentDecisions(refresh);
  const [runReview] = useMutation<WorkReviewMutationData, WorkReviewMutationVariables>(WORK_REVIEW_MUTATION);
  const [runCommit] = useMutation<WorkCommitMutationData, WorkCommitMutationVariables>(WORK_COMMIT_MUTATION);
  const [runDeliveryDecide] = useMutation<{ deliveryChangeDecide: { success: boolean; message?: string | null } }>(DELIVERY_DECIDE_MUTATION);
  const [packConfirm, setPackConfirm] = useState<{ key: string; title: string; items: AttentionItemNode[] } | null>(null);

  useEffect(() => {
    setSelectedIds((current) => {
      const kept = current.filter((id) => ordered.some((item) => item.id === id));
      return kept.length === current.length ? current : kept;
    });
  }, [ordered]);

  // One decision, by key or by the batch bar. Returns why it was refused, or null.
  async function accept(item: AttentionItemNode): Promise<string | null> {
    if (item.kind === 'CONTRACT_AMENDMENT') {
      if (!item.actions.includes('ACCEPT')) return 'This change is out of date: the contract was edited after it was proposed. Reject it instead.';
      return amendmentDecisions.accept(item.subjectId);
    }
    if (item.kind === 'WORK_REVIEW' && item.work) {
      try {
        const result = await runReview({ variables: { id: item.work.id, input: { decision: 'ACCEPTED', expectedRevision: item.work.revision } } });
        return result.data?.workReview.success ? null : result.data?.workReview.message ?? 'The review was not accepted.';
      } catch {
        return 'The review request failed.';
      }
    }
    if (item.kind === 'CANDIDATE_COMMIT' && item.work) {
      const work = item.work;
      // Whoever decides from the queue owns it unless it already has an owner.
      const assigneeId = work.assignee?.actorKind === 'HUMAN' ? work.assignee.id : viewer?.id ?? null;
      const priority = work.priority ?? 0;
      try {
        const result = await runCommit({
          variables: {
            id: work.id,
            input: { expectedRevision: work.revision, ...(assigneeId ? { assigneeId } : {}), ...(priority >= 1 && priority <= 4 ? { priority } : {}) },
          },
        });
        const committed = result.data?.workCommit.issue;
        if (!result.data?.workCommit.success || !committed) return result.data?.workCommit.message ?? 'The candidate was not committed.';
        if (committed.revision) {
          recordCommitGesture([commitUndoItem(work, committed.revision, { acceptance: work.acceptance ?? '', assigneeId, priority: work.priority ?? null })]);
        }
        return null;
      } catch {
        return 'The commit request failed.';
      }
    }
    if (item.kind === 'DELIVERY_CHANGE') {
      try {
        // No owner chosen: the server keeps the current owner, as the card's default does.
        const result = await runDeliveryDecide({ variables: { approve: true, id: item.subjectId, note: null, ownerId: null } });
        return result.data?.deliveryChangeDecide.success ? null : result.data?.deliveryChangeDecide.message ?? 'The delivery change was not approved.';
      } catch {
        return 'The delivery request failed.';
      }
    }
    return 'Decide this one on the right.';
  }

  // A pack's suggested decisions, after the person saw the list: stops at the first refusal (INV-1094).
  async function runPack(entries: AttentionItemNode[]) {
    setBatchPending(true);
    const results: Array<{ id: string; label: string; message: string | null }> = [];
    let stopped = false;
    for (const item of entries) {
      const label = item.work?.identifier ?? item.reason;
      if (stopped) {
        results.push({ id: item.id, label, message: 'Not done: stopped at the refusal above.' });
        continue;
      }
      const message = await accept(item);
      results.push({ id: item.id, label, message });
      if (message) stopped = true;
    }
    setBatchResults(results);
    setPackConfirm(null);
    setBatchPending(false);
    await refresh();
  }

  async function acceptFocused(item: AttentionItemNode) {
    if (item.kind === 'CANDIDATE_COMMIT') {
      // The card commits with what it holds; commit is undoable, so no second press.
      window.dispatchEvent(new CustomEvent(COMMIT_CANDIDATE_EVENT, { detail: { id: item.work?.id } }));
      return;
    }
    if (item.kind !== 'CONTRACT_AMENDMENT' && item.kind !== 'WORK_REVIEW') {
      setNotice('Decide this one on the right.');
      return;
    }
    // Accepting a contract change or finished work cannot be undone: the first press asks.
    if (!armed || armed.id !== item.id) {
      setArmed({ action: 'accept', id: item.id });
      setNotice(`Press A again to accept ${item.work?.identifier ?? 'this'}. It cannot be undone.`);
      return;
    }
    setArmed(null);
    setNotice(null);
    const refused = await accept(item);
    if (refused) {
      setNotice(refused);
      return;
    }
    await refresh();
  }

  const listKeys = useListKeys(ordered, {
    onToggle: (item) => setSelectedIds((current) => (current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])),
    onSelectAll: () => setSelectedIds(ordered.map((item) => item.id)),
    onClear: () => setSelectedIds([]),
    onOpen: (item) => navigate(item.work ? `/work/${item.work.id}` : '/ops'),
    onPrimary: (item) => void acceptFocused(item),
    onKey: (key, item) => {
      // C is the shell's create-issue key, so A is every item's main decision.
      if (key === 'a') {
        void acceptFocused(item);
        return true;
      }
      if (key === 'r') {
        // A decline or a return needs words: put the cursor where they go.
        const field = document.querySelector<HTMLElement>('#attention-decision textarea, #attention-decision input:not([type="checkbox"])');
        field?.focus();
        return Boolean(field);
      }
      if (key === 'h' && item.kind === 'CANDIDATE_COMMIT') {
        window.dispatchEvent(new CustomEvent(SNOOZE_CANDIDATE_EVENT, { detail: { id: item.work?.id } }));
        return true;
      }
      if (key === 'z') {
        void undoStatusGesture();
        return true;
      }
      return false;
    },
  });

  // The queue opens on its first item, so the first J goes to the second.
  const { focusedId, setFocusedId } = listKeys;
  useEffect(() => {
    if (!focusedId && ordered[0]) setFocusedId(ordered[0].id);
  }, [focusedId, setFocusedId, ordered]);
  const focused = ordered.find((item) => item.id === listKeys.focusedId) ?? ordered[0] ?? null;
  useEffect(() => {
    setArmed(null);
    setNotice(null);
  }, [focused?.id]);

  const selected = ordered.filter((item) => selectedIds.includes(item.id));
  const batchable = selected.filter((item) => BATCHABLE[item.kind]);
  const oneByOne = selected.length - batchable.length;

  async function runBatch() {
    setBatchPending(true);
    const results: Array<{ id: string; label: string; message: string | null }> = [];
    for (const item of batchable) {
      results.push({ id: item.id, label: item.work?.identifier ?? item.reason, message: await accept(item) });
    }
    setBatchResults(results);
    setSelectedIds([]);
    setBatchPending(false);
    await refresh();
  }

  if (error && !data) {
    return (
      <div className="observation-page">
        <div className="page-header"><h1 className="page-header__title">Needs you</h1></div>
        <div className="empty-state" role="alert">
          <h3>Could not load what needs you</h3>
          <Btn variant="subtle" onClick={() => void refetch()}>Retry</Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="observation-page attention-page">
      <div className="page-header">
        <h1 className="page-header__title">Needs you</h1>
        <span className="observation-card__meta">{data ? `${data.attentionSummary.total} waiting on your decision` : ''}</span>
        <div className="inbox-page__toggle" role="tablist" aria-label="Group by">
          {(['kind', 'tree'] as const).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'is-active' : ''} onClick={() => setView(key)}>
              {key === 'kind' ? 'By kind' : 'By work tree'}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span className="observation-card__meta">J/K move · A accept or commit · R reason · H snooze · Z undo · X select</span>
      </div>
      {loading && !data ? <p className="observation-empty">Loading…</p> : null}
      {data && ordered.length === 0 ? (
        <div className="empty-state">
          <h3>Nothing is waiting on your decision</h3>
          <p>
            What happened recently is in <Link to="/inbox">Activity</Link>.
          </p>
        </div>
      ) : null}
      {ordered.length > 0 ? (
        <div className="page-content attention-layout">
          <div className="attention-list" aria-label="Waiting on your decision">
            {sections.map((section) => (
              <section key={section.key} className="attention-section" aria-label={section.title}>
                <h2 className="attention-section__title">
                  {section.title} <span className="attention-section__count">{section.count}</span>
                  {section.oldestSince ? <span className="observation-card__meta">oldest {formatWait(section.oldestSince)}</span> : null}
                </h2>
                {section.summary ? <p className="attention-section__summary">{section.summary}</p> : null}
                {view === 'tree' && suggestedDecisions(section.groups[0]?.items ?? []).length > 0 ? (
                  <Btn
                    variant="subtle"
                    onClick={() => setPackConfirm({ items: suggestedDecisions(section.groups[0]!.items), key: section.key, title: section.title })}
                  >
                    {`Do the suggested decisions (${suggestedDecisions(section.groups[0]!.items).length})`}
                  </Btn>
                ) : null}
                {packConfirm?.key === section.key ? (
                  <div className="attention-pack-confirm" role="dialog" aria-label={`Confirm decisions for ${section.title}`}>
                    <p>These will be decided as proposed. Nothing that needs a reason is in the list.</p>
                    <ul>
                      {packConfirm.items.map((entry) => (
                        <li key={entry.id}>
                          <span className="mono">{entry.work?.identifier}</span> {entry.kind === 'CANDIDATE_COMMIT' ? 'commit' : entry.kind === 'CONTRACT_AMENDMENT' ? 'accept the contract change' : 'approve the delivery change'}
                        </li>
                      ))}
                    </ul>
                    <Btn variant="accent" disabled={batchPending} onClick={() => void runPack(packConfirm.items)}>
                      {batchPending ? 'Deciding…' : `Confirm ${packConfirm.items.length} decisions`}
                    </Btn>
                    <Btn variant="ghost" onClick={() => setPackConfirm(null)}>Cancel</Btn>
                  </div>
                ) : null}
                {section.groups.map((group) => (
                  <div key={group.key} className="attention-group">
                    {group.label ? <div className="attention-group__label">{group.label}</div> : null}
                    <ul>
                      {group.items.map((item) => (
                        <li
                          key={item.id}
                          data-list-key-id={item.id}
                          aria-current={focused?.id === item.id ? 'true' : undefined}
                          className={`attention-row${focused?.id === item.id ? ' attention-row--focused' : ''}${item.overdue ? ' attention-row--overdue' : ''}`}
                          onClick={() => listKeys.setFocusedId(item.id)}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select ${item.work?.identifier ?? item.reason}`}
                            checked={selectedIds.includes(item.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => setSelectedIds((current) => (current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]))}
                          />
                          <span className="attention-row__text">
                            {item.work ? <span className="mono">{item.work.identifier}</span> : null} {item.work?.title ?? item.reason}
                            <span className="attention-row__reason">{item.reason}</span>
                            {item.unblocked ? <span className="attention-row__flag attention-row__flag--ready">What blocked it is done</span> : null}
                            {(item.waitingOn ?? []).length > 0 ? (
                              <span className="attention-row__flag">Waiting on {(item.waitingOn ?? []).map((blocker) => blocker.identifier).join(', ')}</span>
                            ) : null}
                            {item.overdue ? <span className="attention-row__flag attention-row__flag--overdue">Overdue</span> : null}
                          </span>
                          <span className="observation-card__meta" title={new Date(item.since).toLocaleString()}>{formatWait(item.since)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
          </div>
          <div id="attention-decision" className="attention-decision" aria-label="Decision">
            {notice ? <p className="attention-notice" role="status">{notice}</p> : null}
            {focused ? (
              <AttentionDecision
                key={focused.id}
                item={focused}
                viewer={viewer}
                humans={focused.work ? humansByTeam.get(focused.work.team.id) ?? [] : []}
                states={focused.work ? statesByTeam.get(focused.work.team.id) ?? [] : []}
                refresh={refresh}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {selected.length > 0 ? (
        <div className="candidates-bulkbar" role="region" aria-label="Batch decisions">
          <span className="candidates-bulkbar__count">{selected.length} selected</span>
          {batchable.length > 0 ? (
            <Btn variant="accent" disabled={batchPending} onClick={() => void runBatch()}>
              {batchPending ? 'Deciding…' : `Accept or commit ${batchable.length}`}
            </Btn>
          ) : null}
          {oneByOne > 0 ? (
            <span className="observation-card__meta">
              {oneByOne} of these need a decision one at a time; declining or returning needs a reason.
            </span>
          ) : null}
          <Btn variant="ghost" onClick={() => setSelectedIds([])}>Clear</Btn>
        </div>
      ) : null}
      {batchResults.length > 0 ? (
        <div className="attention-batch-results" role="status" aria-label="Batch results">
          <ul>
            {batchResults.map((result) => (
              <li key={result.id}>
                <span className="mono">{result.label}</span> {result.message ? <span className="issue-relations__error">{result.message}</span> : 'done'}
              </li>
            ))}
          </ul>
          <Btn variant="ghost" onClick={() => setBatchResults([])}>Dismiss</Btn>
        </div>
      ) : null}
    </div>
  );
}

function AttentionDecision({
  item,
  viewer,
  humans,
  states,
  refresh,
}: {
  item: AttentionItemNode;
  viewer: SessionViewer | null;
  humans: WorkUserSummary[];
  states: Array<{ id: string; name: string; type: string }>;
  refresh: () => Promise<unknown>;
}) {
  const header = item.work ? (
    <div className="attention-decision__header">
      <Link className="mono" to={`/work/${item.work.id}`}>{item.work.identifier}</Link>
      <strong>{item.work.title}</strong>
    </div>
  ) : null;

  switch (item.kind) {
    case 'CANDIDATE_COMMIT':
      return item.work ? (
        <CandidateCard
          candidate={item.work}
          humans={humans}
          states={states}
          otherCandidates={[]}
          focused
          onCommitted={() => void refresh()}
          onRejected={() => void refresh()}
          onRefresh={() => void refresh()}
        />
      ) : null;
    case 'WORK_REVIEW':
      return item.work ? (
        <>
          {header}
          {item.work.acceptance ? (
            <dl className="observation-contract observation-contract--stack">
              <div className="observation-contract__row"><dt>Acceptance</dt><dd>{item.work.acceptance}</dd></div>
            </dl>
          ) : null}
          <p><Link to={`/work/${item.work.id}`}>Runs and evidence</Link></p>
          <HumanReviewSection work={item.work} onReviewed={refresh} />
        </>
      ) : null;
    case 'DELIVERY_CHANGE':
      return item.work ? (
        <>
          {header}
          <DeliveryChangeQueue workId={item.work.id} heading="Delivery change" />
        </>
      ) : null;
    case 'CONTRACT_AMENDMENT':
    case 'AGENT_REQUEST':
    case 'DECISION_REQUESTED':
      return item.work ? (
        <>
          {header}
          <WorkContextDecision item={item} workId={item.work.id} viewer={viewer} refresh={refresh} />
        </>
      ) : null;
    case 'OPS':
      return (
        <>
          <p>{item.reason}</p>
          <Link className="ui-action ui-action--accent" to="/ops">Open operations</Link>
        </>
      );
    default:
      return null;
  }
}

/** Decisions whose controls need the work's full context: the amendment, the request, the agent that asked. */
function WorkContextDecision({
  item,
  workId,
  viewer,
  refresh,
}: {
  item: AttentionItemNode;
  workId: string;
  viewer: SessionViewer | null;
  refresh: () => Promise<unknown>;
}) {
  const { data, loading, refetch } = useQuery<WorkContextPageQueryData, WorkContextPageQueryVariables>(WORK_CONTEXT_PAGE_QUERY, {
    variables: { id: workId },
  });
  const decisions = useContractAmendmentDecisions(async () => {
    await refetch();
    await refresh();
  });
  const bundle = data?.workContext ?? null;
  if (loading && !bundle) return <p className="observation-empty">Loading…</p>;
  if (!bundle) return null;

  if (item.kind === 'CONTRACT_AMENDMENT') {
    const amendment = bundle.work.pendingContractAmendment;
    return amendment ? <ContractAmendmentPanel amendment={amendment} onAccept={decisions.accept} onReject={decisions.reject} /> : null;
  }
  if (item.kind === 'AGENT_REQUEST') {
    const request = (bundle.work.agentRequests ?? []).find((entry) => entry.id === item.subjectId);
    return request ? (
      <div className="observation-card">
        {request.body ? <p className="observation-card__body">{request.body}</p> : null}
        <AgentRequestActions request={request} viewer={viewer} />
      </div>
    ) : null;
  }
  // DECISION_REQUESTED: the reply goes to the agent that ran it most recently, as on the work page.
  const run = bundle.runs.find((entry) => entry.id === item.subjectId);
  const agent = run?.actor?.actorKind === 'AGENT' && run.actor.handle
    ? run.actor
    : bundle.runs.map((entry) => entry.actor).find((actor) => actor && actor.actorKind === 'AGENT' && actor.handle) ?? null;
  return (
    <>
      {run?.summary ? <p className="observation-card__body">{run.summary}</p> : null}
      {agent ? <RespondToAgent workId={workId} agent={agent} /> : <p className="observation-empty">No agent to answer on this work.</p>}
    </>
  );
}
