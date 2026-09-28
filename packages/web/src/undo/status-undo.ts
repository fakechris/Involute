/** Session undo for status changes. One gesture is one entry. Refresh clears it. */

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

export interface StatusUndoToast {
  entry: StatusUndoEntry;
  action: 'undo' | 'redo' | 'none';
  conflicts: string[];
  message?: string;
}

export interface StatusUndoSnapshot {
  undo: StatusUndoEntry[];
  redo: StatusUndoEntry[];
  toast: StatusUndoToast | null;
}

const EMPTY: StatusUndoSnapshot = { undo: [], redo: [], toast: null };

let snapshot: StatusUndoSnapshot = EMPTY;
let applyStatus: StatusUndoApply | null = null;
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

export function formatStatusToast(toast: StatusUndoToast): string {
  if (toast.message && toast.entry.changes.length === 0 && toast.conflicts.length === 0) {
    return toast.message;
  }
  const move = toast.entry.changes.length > 0 ? formatStatusMove(toast.entry) : '';
  const conflict = toast.conflicts.length > 0 ? `Could not change ${toast.conflicts.join(', ')}.` : '';
  return [toast.message, move, conflict].filter(Boolean).join(' ');
}

function entryId() {
  return globalThis.crypto?.randomUUID?.() ?? `undo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
