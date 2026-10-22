import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';

import { SAVED_VIEW_DELETE_MUTATION, SAVED_VIEW_UPSERT_MUTATION } from '../work/queries';

import { readSavedBoardViews, writeSavedBoardViews, BOARD_SAVED_VIEWS_EVENT, dispatchApplyBoardView, type SavedBoardView } from '../board/views';
import { readSavedBacklogViews, writeSavedBacklogViews, BACKLOG_SAVED_VIEWS_EVENT, dispatchApplyBacklogView, type SavedBacklogView } from '../backlog/views';
import { readStoredTeamKey } from '../board/utils';
import { SAVED_VIEWS_ACCOUNT_EVENT } from '../lib/saved-views-account';
import { IcoPlus, IcoViews } from '../components/Icons';
import { Btn } from '../components/Primitives';
import { DialogShell } from '../components/DialogShell';
import { Field, Select, TextInput } from '../components/controls';
import { PageBody, PageHeader } from '../components/layout';
import { EmptyState, InlineError } from '../components/status';

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
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [runUpsert] = useMutation<{ savedViewUpsert: { success: boolean; message?: string | null } }>(SAVED_VIEW_UPSERT_MUTATION);
  const [runDelete] = useMutation<{ savedViewDelete: { success: boolean; message?: string | null } }>(SAVED_VIEW_DELETE_MUTATION);
  const [error, setError] = useState<string | null>(null);

  // Sharing and deleting go to the server (INV-1005); the local list follows.
  async function setVisibility(entry: ViewEntry, visibility: 'PRIVATE' | 'TEAM') {
    if (!teamKey) return;
    setError(null);
    const result = await runUpsert({ variables: { input: { id: entry.id, teamKey, name: entry.name, kind: entry.kind.toLowerCase(), visibility, stateJson: JSON.stringify(entry.view.state) } } }).catch((caught: unknown) => ({ data: { savedViewUpsert: { success: false, message: caught instanceof Error ? caught.message : 'Could not update the view.' } } }));
    if (!result.data?.savedViewUpsert.success) { setError(result.data?.savedViewUpsert.message ?? 'Could not update the view.'); return; }
    if (entry.kind === 'Board') {
      const next = boardViews.map((view) => (view.id === entry.id ? { ...view, visibility } : view));
      writeSavedBoardViews(teamKey, next); setBoardViews(next);
    } else {
      const next = backlogViews.map((view) => (view.id === entry.id ? { ...view, visibility } : view));
      writeSavedBacklogViews(teamKey, next); setBacklogViews(next);
    }
  }
  async function remove(entry: ViewEntry) {
    if (!teamKey) return;
    setError(null);
    const result = await runDelete({ variables: { id: entry.id } }).catch((caught: unknown) => ({ data: { savedViewDelete: { success: false, message: caught instanceof Error ? caught.message : 'Could not delete the view.' } } }));
    if (!result.data?.savedViewDelete.success) { setError(result.data?.savedViewDelete.message ?? 'Could not delete the view.'); return; }
    if (entry.kind === 'Board') {
      const next = boardViews.filter((view) => view.id !== entry.id);
      writeSavedBoardViews(teamKey, next); setBoardViews(next);
    } else {
      const next = backlogViews.filter((view) => view.id !== entry.id);
      writeSavedBacklogViews(teamKey, next); setBacklogViews(next);
    }
  }
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

    function handleAccountChange() {
      handleBoardUpdate();
      handleBacklogUpdate();
    }

    window.addEventListener(BOARD_SAVED_VIEWS_EVENT, handleBoardUpdate);
    window.addEventListener(BACKLOG_SAVED_VIEWS_EVENT, handleBacklogUpdate);
    // The signed-in account's copy, once the session says who that is (INV-1194).
    window.addEventListener(SAVED_VIEWS_ACCOUNT_EVENT, handleAccountChange);
    return () => {
      window.removeEventListener(BOARD_SAVED_VIEWS_EVENT, handleBoardUpdate);
      window.removeEventListener(BACKLOG_SAVED_VIEWS_EVENT, handleBacklogUpdate);
      window.removeEventListener(SAVED_VIEWS_ACCOUNT_EVENT, handleAccountChange);
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
    <div className="observation-page">
      <PageHeader
        icon={<IcoViews />}
        title="Views"
        count={views.length}
        actions={(
          <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={() => {
            setNewViewName('');
            setNewViewKind('Board');
            setIsDialogOpen(true);
          }}>New view</Btn>
        )}
      />

      <PageBody width="wide">
        {error ? <InlineError>{error}</InlineError> : null}
        {views.length === 0 ? (
          <EmptyState
            icon={<IcoViews size={20} />}
            title="No saved views"
            body="Save a filter on the Board or Backlog page to create a reusable view. Saved views will appear here."
          />
        ) : (
          <div className="views-grid">
            {views.map((v) => (
              <div key={v.id} className="saved-view-card" aria-label={`View ${v.name}`}>
                <button
                  type="button"
                  className="views-card__open"
                  onClick={() => {
                    if (v.kind === 'Board') {
                      dispatchApplyBoardView({ state: (v.view as SavedBoardView).state, viewId: v.id });
                    } else {
                      dispatchApplyBacklogView({ state: (v.view as SavedBacklogView).state, viewId: v.id });
                    }
                    navigate(v.route);
                  }}
                >
                  <span className="views-card__title">
                    <span className="views-card__icon"><IcoViews size={14} /></span>
                    <span className="views-card__name">{v.name}</span>
                  </span>
                  <span className="views-card__meta">
                    <span className={v.kind === 'Board' ? 'views-card__kind views-card__kind--board' : 'views-card__kind'}>{v.kind}</span>
                    {v.view.visibility === 'TEAM' ? <span className="observation-card__meta">shared with team</span> : null}
                  </span>
                </button>
                <div className="request-actions">
                  {v.view.visibility === 'TEAM' ? (
                    <Btn variant="ghost" onClick={() => void setVisibility(v, 'PRIVATE')}>Make private</Btn>
                  ) : (
                    <Btn variant="ghost" onClick={() => void setVisibility(v, 'TEAM')}>Share with team</Btn>
                  )}
                  <Btn variant="ghost" onClick={() => void remove(v)}>Delete view</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </PageBody>

      {isDialogOpen ? (
        <DialogShell
          variant="modal"
          title="New view"
          onClose={() => setIsDialogOpen(false)}
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
            setIsDialogOpen(false);
            navigate(newViewKind === 'Board' ? '/' : '/backlog');
          }}
          footer={(
            <>
              <Btn variant="subtle" size="md" onClick={() => setIsDialogOpen(false)}>Cancel</Btn>
              <Btn type="submit" variant="accent" size="md">Create</Btn>
            </>
          )}
        >
          <Field label="Name">
            <TextInput
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              placeholder="View name"
              required
            />
          </Field>
          <Field label="Type">
            <Select
              value={newViewKind}
              onChange={(e) => setNewViewKind(e.target.value as 'Board' | 'Backlog')}
            >
              <option value="Board">Board</option>
              <option value="Backlog">Backlog</option>
            </Select>
          </Field>
        </DialogShell>
      ) : null}
    </div>
  );
}
