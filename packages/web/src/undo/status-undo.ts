/** Session undo for status changes. One gesture is one entry. Refresh clears it. */
import { formatFieldChanges, type FieldUndoChange } from './field-gesture';

export const STATUS_UNDO_LIMIT = 50;
const TOAST_MS = 8000;

export interface StatusUndoChange {
  issueId: string;
  identifier: string;
  /** State this gesture wrote. */
  stateId: string;
  stateName: string;
  /** State to put back when this gesture is reversed. */
  previousStateId: string;
  previousStateName: string;
  /** Revision after this gesture. The reverse write sends it as expectedRevision. */
  revision: number;
}

export interface StatusUndoEntry {
  id: string;
  changes: StatusUndoChange[];
}

export interface StatusUndoApplyChange {
  issueId: string;
  identifier: string;
  stateId: string;
  expectedRevision: number;
  /** Columns to open so the issue stays visible after the reverse write. */
  revealStateIds: string[];
}

export interface StatusUndoApplied {
  issueId: string;
  revision: number;
  stateId: string;
}

export interface StatusUndoApplyResult {
  applied: StatusUndoApplied[];
  conflicts: string[];
}

export type StatusUndoApply = (changes: StatusUndoApplyChange[]) => Promise<StatusUndoApplyResult>;

export interface CommitUndoItem {
  acceptance: string;
  assigneeId: string | null;
  identifier: string;
  issueId: string;
  phase: 'committed' | 'candidate';
  priority: number | null;
  /** Revision to send as expectedRevision when reversing this phase. */
  revision: number;
}

export interface CommitUndoEntry {
  id: string;
  items: CommitUndoItem[];
}

/** Any field edits of one gesture (INV-839): state, priority, assignee, labels, title, … */
export interface FieldUndoEntry {
  id: string;
  fields: FieldUndoChange[];
}

export interface FieldUndoApplyResult {
  applied: Array<{ issueId: string; revision: number }>;
  conflicts: string[];
}

export type FieldUndoApply = (changes: Array<FieldUndoChange & { expectedRevision: number; patch: FieldUndoChange['before'] }>) => Promise<FieldUndoApplyResult>;

/** One deleted (or, after undo, restored) work item (INV-840). */
export interface DeleteUndoItem {
  issueId: string;
  identifier: string;
  /** 'deleted': undo restores it; 'restored': undo deletes it again. */
  phase: 'deleted' | 'restored';
  /** Revision of the restored item; deleting it again is refused if someone edited it since. */
  revision?: number;
  /** The gesture that put it on the stack was creating it (INV-841), so the toast says so. */
  origin?: 'created';
}

export interface DeleteUndoEntry {
  id: string;
  deletions: DeleteUndoItem[];
}

export interface DeleteUndoApplyResult {
  /** Issue ids the server applied; for restores, with the restored revision. */
  applied: Array<{ issueId: string; revision?: number }>;
  conflicts: string[];
  /** Issue ids the request never reached the server for (network); they stay on the stack. */
  retryable?: string[];
}

export type DeleteUndoApply = (items: DeleteUndoItem[]) => Promise<DeleteUndoApplyResult>;

export type SessionUndoEntry = StatusUndoEntry | CommitUndoEntry | FieldUndoEntry | DeleteUndoEntry;

export interface CommitUndoApplyResult {
  applied: Array<{ issueId: string; revision: number }>;
  conflicts: string[];
}

export type CommitUndoApply = (items: CommitUndoItem[]) => Promise<CommitUndoApplyResult>;

export interface StatusUndoToast {
  entry: SessionUndoEntry;
  action: 'undo' | 'redo' | 'none';
  conflicts: string[];
  message?: string;
}

export interface StatusUndoSnapshot {
  undo: SessionUndoEntry[];
  redo: SessionUndoEntry[];
  toast: StatusUndoToast | null;
}

const EMPTY: StatusUndoSnapshot = { undo: [], redo: [], toast: null };

let snapshot: StatusUndoSnapshot = EMPTY;
let applyStatus: StatusUndoApply | null = null;
let applyCommit: CommitUndoApply | null = null;
let applyField: FieldUndoApply | null = null;
let applyDelete: DeleteUndoApply | null = null;
const listeners = new Set<() => void>();
let toastTimer: number | null = null;
let chain: Promise<void> = Promise.resolve();

function emit(next: StatusUndoSnapshot) {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function scheduleToastDismiss() {
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    if (snapshot.toast) {
      emit({ ...snapshot, toast: null });
    }
  }, TOAST_MS);
}

export function subscribeStatusUndo(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getStatusUndoSnapshot(): StatusUndoSnapshot {
  return snapshot;
}

export function resetStatusUndo() {
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
  applyStatus = null;
  applyCommit = null;
  applyField = null;
  applyDelete = null;
  chain = Promise.resolve();
  emit(EMPTY);
}

export function registerStatusUndoApply(apply: StatusUndoApply) {
  applyStatus = apply;
  return () => {
    if (applyStatus === apply) {
      applyStatus = null;
    }
  };
}

export function registerFieldUndoApply(apply: FieldUndoApply) {
  applyField = apply;
  return () => {
    if (applyField === apply) {
      applyField = null;
    }
  };
}

export function registerDeleteUndoApply(apply: DeleteUndoApply) {
  applyDelete = apply;
  return () => {
    if (applyDelete === apply) {
      applyDelete = null;
    }
  };
}

export function registerCommitUndoApply(apply: CommitUndoApply) {
  applyCommit = apply;
  return () => {
    if (applyCommit === apply) {
      applyCommit = null;
    }
  };
}

export function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.getAttribute('contenteditable') === 'true'
  );
}

export function formatStatusMove(entry: StatusUndoEntry): string {
  const ids = entry.changes.map((change) => change.identifier);
  const shown = ids.slice(0, 3);
  const extra = ids.length - shown.length;
  const who = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  const names = [...new Set(entry.changes.map((change) => change.stateName))];
  const stateLabel = names.length === 1 ? names[0] : 'updated states';
  return `${who} moved to ${stateLabel}`;
}

export function formatCommitGesture(entry: CommitUndoEntry): string {
  const ids = entry.items.map((item) => item.identifier);
  const shown = ids.slice(0, 3);
  const extra = ids.length - shown.length;
  const who = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  return entry.items[0]?.phase === 'candidate' ? `${who} returned to candidates` : `${who} committed`;
}

export function formatDeleteGesture(entry: DeleteUndoEntry): string {
  const ids = entry.deletions.map((item) => item.identifier);
  const shown = ids.slice(0, 3);
  const extra = ids.length - shown.length;
  const who = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  const first = entry.deletions[0];
  if (first?.phase !== 'restored') return `${who} deleted`;
  return first.origin === 'created' ? `${who} created` : `${who} restored`;
}

function entrySize(entry: SessionUndoEntry): number {
  if ('deletions' in entry) return entry.deletions.length;
  if ('items' in entry) return entry.items.length;
  if ('fields' in entry) return entry.fields.length;
  return entry.changes.length;
}

export function formatUndoEntry(entry: SessionUndoEntry): string {
  if ('deletions' in entry) return formatDeleteGesture(entry);
  if ('items' in entry) return formatCommitGesture(entry);
  if ('fields' in entry) return formatFieldChanges(entry.fields);
  return formatStatusMove(entry);
}

export function formatStatusToast(toast: StatusUndoToast): string {
  const described = entrySize(toast.entry) > 0;
  if (toast.message && !described && toast.conflicts.length === 0) {
    return toast.message;
  }
  const move = described ? formatUndoEntry(toast.entry) : '';
  const conflict = toast.conflicts.length > 0 ? `Could not change ${toast.conflicts.join(', ')}.` : '';
  return [toast.message, move, conflict].filter(Boolean).join(' ');
}

export function handleSessionUndoKey(event: KeyboardEvent): boolean {
  if (!((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z')) {
    return false;
  }
  if (isTextEditingTarget(event.target)) {
    return false;
  }
  event.preventDefault();
  void (event.shiftKey ? redoStatusGesture() : undoStatusGesture());
  return true;
}

function entryId() {
  return globalThis.crypto?.randomUUID?.() ?? `undo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function recordCommitGesture(items: CommitUndoItem[]) {
  if (items.length === 0) {
    return;
  }
  const entry: CommitUndoEntry = { id: entryId(), items };
  emit({
    undo: [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT),
    redo: [],
    toast: { entry, action: 'undo', conflicts: [] },
  });
  scheduleToastDismiss();
}

/** A deletion that the server can take back by id becomes one undo entry (INV-840). */
export function recordDeleteGesture(deletions: DeleteUndoItem[]) {
  if (deletions.length === 0) {
    return;
  }
  const entry: DeleteUndoEntry = { id: entryId(), deletions };
  emit({
    undo: [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT),
    redo: [],
    toast: { entry, action: 'undo', conflicts: [] },
  });
  scheduleToastDismiss();
}

/** One gesture's field edits become one undo entry (INV-839). */
export function recordFieldGesture(fields: FieldUndoChange[]) {
  if (fields.length === 0) {
    return;
  }
  const entry: FieldUndoEntry = { id: entryId(), fields };
  emit({
    undo: [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT),
    redo: [],
    toast: { entry, action: 'undo', conflicts: [] },
  });
  scheduleToastDismiss();
}

export function recordStatusGesture(changes: StatusUndoChange[]) {
  if (changes.length === 0) {
    return;
  }
  const entry: StatusUndoEntry = { id: entryId(), changes };
  emit({
    undo: [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT),
    redo: [],
    toast: { entry, action: 'undo', conflicts: [] },
  });
  scheduleToastDismiss();
}

function reverseApplied(entry: StatusUndoEntry, applied: StatusUndoApplied[]): StatusUndoEntry {
  const appliedById = new Map(applied.map((item) => [item.issueId, item]));
  return {
    id: entryId(),
    changes: entry.changes.flatMap((change) => {
      const next = appliedById.get(change.issueId);
      if (!next) {
        return [];
      }
      return [
        {
          issueId: change.issueId,
          identifier: change.identifier,
          stateId: change.previousStateId,
          stateName: change.previousStateName,
          previousStateId: change.stateId,
          previousStateName: change.stateName,
          revision: next.revision,
        },
      ];
    }),
  };
}

async function waitForApply(): Promise<StatusUndoApply | null> {
  if (applyStatus) {
    return applyStatus;
  }
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (applyStatus) {
        window.clearInterval(timer);
        resolve(applyStatus);
        return;
      }
      if (Date.now() - started > 2000) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 40);
  });
}

function showToast(toast: StatusUndoToast, next: Omit<StatusUndoSnapshot, 'toast'>) {
  emit({ ...next, toast });
  scheduleToastDismiss();
}

async function perform(direction: 'undo' | 'redo') {
  const source = direction === 'undo' ? snapshot.undo : snapshot.redo;
  const entry = source[source.length - 1];
  if (!entry) {
    showToast(
      {
        entry: { id: 'empty', changes: [] },
        action: 'none',
        conflicts: [],
        message: direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo',
      },
      { undo: snapshot.undo, redo: snapshot.redo },
    );
    return;
  }

  const poppedUndo = direction === 'undo' ? source.slice(0, -1) : snapshot.undo;
  const poppedRedo = direction === 'redo' ? source.slice(0, -1) : snapshot.redo;
  emit({ undo: poppedUndo, redo: poppedRedo, toast: snapshot.toast });

  if ('items' in entry) {
    await performCommit(entry, direction, poppedUndo, poppedRedo);
    return;
  }
  if ('fields' in entry) {
    await performFields(entry, direction, poppedUndo, poppedRedo);
    return;
  }
  if ('deletions' in entry) {
    await performDeletions(entry, direction, poppedUndo, poppedRedo);
    return;
  }

  const apply = await waitForApply();
  if (!apply) {
    emit({
      undo: direction === 'undo' ? [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.undo,
      redo: direction === 'redo' ? [...snapshot.redo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.redo,
      toast: {
        entry: { id: 'unavailable', changes: [] },
        action: 'none',
        conflicts: [],
        message: 'Open the board to undo',
      },
    });
    scheduleToastDismiss();
    return;
  }

  const result = await apply(
    entry.changes.map((change) => ({
      issueId: change.issueId,
      identifier: change.identifier,
      stateId: change.previousStateId,
      expectedRevision: change.revision,
      revealStateIds: [change.previousStateId, change.stateId],
    })),
  );
  const reversed = reverseApplied(entry, result.applied);
  const gestureArrived = snapshot.undo.length > poppedUndo.length || snapshot.redo.length !== poppedRedo.length;
  const undo = direction === 'redo' && reversed.changes.length > 0 && !gestureArrived
    ? [...snapshot.undo, reversed].slice(-STATUS_UNDO_LIMIT)
    : snapshot.undo;
  const redo = direction === 'undo' && reversed.changes.length > 0 && !gestureArrived
    ? [...snapshot.redo, reversed].slice(-STATUS_UNDO_LIMIT)
    : snapshot.redo;

  showToast(
    {
      entry: reversed.changes.length > 0 ? reversed : { id: entry.id, changes: [] },
      action: reversed.changes.length > 0 ? (direction === 'undo' ? 'redo' : 'undo') : 'none',
      conflicts: result.conflicts,
    },
    { undo, redo },
  );
}

async function performFields(
  entry: FieldUndoEntry,
  direction: 'undo' | 'redo',
  poppedUndo: SessionUndoEntry[],
  poppedRedo: SessionUndoEntry[],
) {
  const apply = applyField;
  if (!apply) {
    emit({
      undo: direction === 'undo' ? [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.undo,
      redo: direction === 'redo' ? [...snapshot.redo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.redo,
      toast: { entry: { id: 'unavailable', changes: [] }, action: 'none', conflicts: [], message: 'Undo is not ready' },
    });
    scheduleToastDismiss();
    return;
  }
  // Undo writes `before`; the reversed entry (for redo) writes `after` again.
  const result = await apply(entry.fields.map((change) => ({ ...change, expectedRevision: change.revision, patch: change.before })));
  const appliedById = new Map(result.applied.map((item) => [item.issueId, item]));
  const reversed: FieldUndoEntry = {
    id: entryId(),
    fields: entry.fields.flatMap((change) => {
      const next = appliedById.get(change.issueId);
      if (!next) return [];
      return [{ ...change, before: change.after, after: change.before, summary: change.reverseSummary, reverseSummary: change.summary, revision: next.revision }];
    }),
  };
  const gestureArrived = snapshot.undo.length > poppedUndo.length || snapshot.redo.length !== poppedRedo.length;
  const undo = direction === 'redo' && reversed.fields.length > 0 && !gestureArrived
    ? [...snapshot.undo, reversed].slice(-STATUS_UNDO_LIMIT)
    : snapshot.undo;
  const redo = direction === 'undo' && reversed.fields.length > 0 && !gestureArrived
    ? [...snapshot.redo, reversed].slice(-STATUS_UNDO_LIMIT)
    : snapshot.redo;
  showToast(
    {
      entry: reversed.fields.length > 0 ? reversed : { id: entry.id, fields: [] },
      action: reversed.fields.length > 0 ? (direction === 'undo' ? 'redo' : 'undo') : 'none',
      conflicts: result.conflicts,
    },
    { undo, redo },
  );
}

async function performDeletions(
  entry: DeleteUndoEntry,
  direction: 'undo' | 'redo',
  poppedUndo: SessionUndoEntry[],
  poppedRedo: SessionUndoEntry[],
) {
  const apply = applyDelete;
  if (!apply) {
    emit({
      undo: direction === 'undo' ? [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.undo,
      redo: direction === 'redo' ? [...snapshot.redo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.redo,
      toast: { entry: { id: 'unavailable', changes: [] }, action: 'none', conflicts: [], message: 'Undo is not ready' },
    });
    scheduleToastDismiss();
    return;
  }
  const result = await apply(entry.deletions);
  const applied = new Map(result.applied.map((item) => [item.issueId, item]));
  const retryable = new Set(result.retryable ?? []);
  const reversed: DeleteUndoEntry = {
    id: entryId(),
    deletions: entry.deletions.flatMap((item) => {
      const next = applied.get(item.issueId);
      if (!next) return [];
      return [{
        ...item,
        phase: item.phase === 'deleted' ? 'restored' as const : 'deleted' as const,
        ...(next.revision !== undefined ? { revision: next.revision } : {}),
      }];
    }),
  };
  // A request that never reached the server leaves its item where it was, to try again.
  const retry: DeleteUndoEntry = { id: entryId(), deletions: entry.deletions.filter((item) => retryable.has(item.issueId)) };
  const gestureArrived = snapshot.undo.length > poppedUndo.length || snapshot.redo.length !== poppedRedo.length;
  let undo = snapshot.undo;
  let redo = snapshot.redo;
  if (!gestureArrived) {
    if (direction === 'redo' && reversed.deletions.length > 0) undo = [...undo, reversed].slice(-STATUS_UNDO_LIMIT);
    if (direction === 'undo' && reversed.deletions.length > 0) redo = [...redo, reversed].slice(-STATUS_UNDO_LIMIT);
    if (retry.deletions.length > 0) {
      if (direction === 'undo') undo = [...undo, retry].slice(-STATUS_UNDO_LIMIT);
      else redo = [...redo, retry].slice(-STATUS_UNDO_LIMIT);
    }
  }
  showToast(
    {
      entry: reversed.deletions.length > 0 ? reversed : { id: entry.id, deletions: [] },
      action: reversed.deletions.length > 0 ? (direction === 'undo' ? 'redo' : 'undo') : 'none',
      conflicts: result.conflicts,
      ...(retry.deletions.length > 0 ? { message: 'Could not reach the server; try again.' } : {}),
    },
    { undo, redo },
  );
}

async function performCommit(
  entry: CommitUndoEntry,
  direction: 'undo' | 'redo',
  poppedUndo: SessionUndoEntry[],
  poppedRedo: SessionUndoEntry[],
) {
  const apply = applyCommit;
  if (!apply) {
    emit({
      undo: direction === 'undo' ? [...snapshot.undo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.undo,
      redo: direction === 'redo' ? [...snapshot.redo, entry].slice(-STATUS_UNDO_LIMIT) : snapshot.redo,
      toast: {
        entry: { id: 'unavailable', changes: [] },
        action: 'none',
        conflicts: [],
        message: 'Undo commit is not ready',
      },
    });
    scheduleToastDismiss();
    return;
  }

  const result = await apply(entry.items);
  const appliedById = new Map(result.applied.map((item) => [item.issueId, item]));
  const reversed: CommitUndoEntry = {
    id: entryId(),
    items: entry.items.flatMap((item) => {
      const next = appliedById.get(item.issueId);
      if (!next) return [];
      return [{
        ...item,
        phase: item.phase === 'committed' ? 'candidate' as const : 'committed' as const,
        revision: next.revision,
      }];
    }),
  };
  const gestureArrived = snapshot.undo.length > poppedUndo.length || snapshot.redo.length !== poppedRedo.length;
  const undo = direction === 'redo' && reversed.items.length > 0 && !gestureArrived
    ? [...snapshot.undo, reversed].slice(-STATUS_UNDO_LIMIT)
    : snapshot.undo;
  const redo = direction === 'undo' && reversed.items.length > 0 && !gestureArrived
    ? [...snapshot.redo, reversed].slice(-STATUS_UNDO_LIMIT)
    : snapshot.redo;
  showToast(
    {
      entry: reversed.items.length > 0 ? reversed : { id: entry.id, items: [] },
      action: reversed.items.length > 0 ? (direction === 'undo' ? 'redo' : 'undo') : 'none',
      conflicts: result.conflicts,
    },
    { undo, redo },
  );
}

function enqueue(task: () => Promise<void>) {
  chain = chain.then(task, task);
  return chain;
}

export function undoStatusGesture() {
  return enqueue(() => perform('undo'));
}

export function redoStatusGesture() {
  return enqueue(() => perform('redo'));
}
