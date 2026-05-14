import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { readSavedBoardViews, writeSavedBoardViews, BOARD_SAVED_VIEWS_EVENT, dispatchApplyBoardView, type SavedBoardView } from '../board/views';
import { readSavedBacklogViews, writeSavedBacklogViews, BACKLOG_SAVED_VIEWS_EVENT, dispatchApplyBacklogView, type SavedBacklogView } from '../backlog/views';
import { readStoredTeamKey } from '../board/utils';
import { IcoPlus, IcoViews } from '../components/Icons';
import { Btn } from '../components/Primitives';

interface ViewEntry {
  id: string;
  name: string;
  kind: 'Board' | 'Backlog';
  route: string;
  view: SavedBoardView | SavedBacklogView;
}

export function ViewsPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const [boardViews, setBoardViews] = useState<SavedBoardView[]>(() => readSavedBoardViews(teamKey));
  const [backlogViews, setBacklogViews] = useState<SavedBacklogView[]>(() => readSavedBacklogViews(teamKey));
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [newViewName, setNewViewName] = useState('');
  const [newViewKind, setNewViewKind] = useState<'Board' | 'Backlog'>('Board');

  useEffect(() => {
    setBoardViews(readSavedBoardViews(teamKey));
    setBacklogViews(readSavedBacklogViews(teamKey));
  }, [teamKey]);

  useEffect(() => {
    function handleBoardUpdate() {
      setBoardViews(readSavedBoardViews(teamKey));
    }
    function handleBacklogUpdate() {
      setBacklogViews(readSavedBacklogViews(teamKey));
    }

    window.addEventListener(BOARD_SAVED_VIEWS_EVENT, handleBoardUpdate);
    window.addEventListener(BACKLOG_SAVED_VIEWS_EVENT, handleBacklogUpdate);
    return () => {
      window.removeEventListener(BOARD_SAVED_VIEWS_EVENT, handleBoardUpdate);
      window.removeEventListener(BACKLOG_SAVED_VIEWS_EVENT, handleBacklogUpdate);
    };
  }, [teamKey]);

  const views = useMemo<ViewEntry[]>(() => {
    const entries: ViewEntry[] = [];
    for (const v of boardViews) {
      entries.push({ id: v.id, name: v.name, kind: 'Board', route: '/', view: v });
    }
    for (const v of backlogViews) {
      entries.push({ id: v.id, name: v.name, kind: 'Backlog', route: '/backlog', view: v });
    }
    return entries;
  }, [boardViews, backlogViews]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoViews /></span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Views</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{views.length}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={() => {
          setNewViewName('');
          setNewViewKind('Board');
          dialogRef.current?.showModal();
        }}>New view</Btn>
      </div>

      <div className="page-content">
        {views.length === 0 ? (
          <div className="empty-state">
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              border: '1px solid var(--border)',
              background: 'var(--bg-raised)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 16,
            }}>
              <IcoViews size={22} style={{ color: 'var(--fg-faint)' }} />
            </div>
            <h3>No saved views</h3>
            <p>
              Save a filter on the Board or Backlog page to create a reusable view. Saved views will appear here.
            </p>
          </div>
        ) : (
          <div style={{ padding: '20px var(--pad-x)' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 12,
            }}>
              {views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    if (v.kind === 'Board') {
                      dispatchApplyBoardView({ state: (v.view as SavedBoardView).state, viewId: v.id });
                    } else {
                      dispatchApplyBacklogView({ state: (v.view as SavedBacklogView).state, viewId: v.id });
                    }
                    navigate(v.route);
                  }}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-3)',
                    background: 'var(--bg-raised)',
                    padding: 14,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'border-color var(--dur-1) var(--ease)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><IcoViews size={14} /></span>
                    <span style={{
                      fontSize: 13, fontWeight: 500, flex: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {v.name}
                    </span>
                  </div>
                  <span style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 10,
                    background: v.kind === 'Board' ? 'var(--accent-weak)' : 'var(--bg-hover)',
                    color: v.kind === 'Board' ? 'var(--accent)' : 'var(--fg-muted)',
                    border: `1px solid ${v.kind === 'Board' ? 'var(--accent-border)' : 'var(--border)'}`,
                    fontWeight: 500,
                  }}>
                    {v.kind}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <dialog ref={dialogRef} className="dialog-modal" onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newViewName.trim() || !teamKey) return;
            const id = `view-${Date.now()}`;
            if (newViewKind === 'Board') {
              const next: SavedBoardView[] = [...boardViews, { id, name: newViewName.trim(), state: { groupBy: 'status', sortField: 'updatedAt', sortDirection: 'asc', query: '', assigneeIds: [], labelIds: [], stateIds: [], viewMode: 'board' } }];
              writeSavedBoardViews(teamKey, next);
              setBoardViews(next);
            } else {
              const next: SavedBacklogView[] = [...backlogViews, { id, name: newViewName.trim(), state: { sortField: 'identifier', sortDirection: 'desc', query: '', assigneeIds: [], labelIds: [], stateIds: [] } }];
              writeSavedBacklogViews(teamKey, next);
              setBacklogViews(next);
            }
            dialogRef.current?.close();
            navigate(newViewKind === 'Board' ? '/' : '/backlog');
          }}
          style={{ padding: 20, minWidth: 300 }}
        >
          <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 500 }}>New view</h3>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Name</span>
            <input
              style={{ width: '100%', height: 30, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)' }}
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              placeholder="View name"
              required
            />
          </label>
          <label style={{ display: 'block', marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Type</span>
            <select
              style={{ width: '100%', height: 30, padding: '0 6px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
              value={newViewKind}
              onChange={(e) => setNewViewKind(e.target.value as 'Board' | 'Backlog')}
            >
              <option value="Board">Board</option>
              <option value="Backlog">Backlog</option>
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--subtle btn--md" onClick={() => dialogRef.current?.close()}>Cancel</button>
            <button type="submit" className="btn btn--accent btn--md">Create</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
