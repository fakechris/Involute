import { useSyncExternalStore } from 'react';

import {
  formatStatusToast,
  getStatusUndoSnapshot,
  redoStatusGesture,
  subscribeStatusUndo,
  undoStatusGesture,
} from './status-undo';

export function StatusUndoToast() {
  const snapshot = useSyncExternalStore(subscribeStatusUndo, getStatusUndoSnapshot, getStatusUndoSnapshot);
  const toast = snapshot.toast;
  if (!toast) {
    return null;
  }

  const label = toast.action === 'undo' ? 'Undo' : toast.action === 'redo' ? 'Redo' : null;

  return (
    <div className="status-undo-toast" role="status" aria-live="polite" data-testid="status-undo-toast">
      <p>{formatStatusToast(toast)}</p>
      {label ? (
        <button
          type="button"
          className="ui-action ui-action--accent"
          onClick={() => {
            void (toast.action === 'undo' ? undoStatusGesture() : redoStatusGesture());
          }}
        >
          {label}
        </button>
      ) : null}
    </div>
  );
}
