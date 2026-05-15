import { useMutation, useQuery } from '@apollo/client/react';
import { useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { BOARD_PAGE_QUERY, CYCLES_QUERY, CYCLE_CREATE_MUTATION, CYCLE_UPDATE_MUTATION, CYCLE_DELETE_MUTATION } from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  CyclesQueryData,
  CyclesQueryVariables,
  CycleSummary,
  CycleCreateMutationData,
  CycleCreateMutationVariables,
  CycleUpdateMutationData,
  CycleUpdateMutationVariables,
  CycleDeleteMutationData,
  CycleDeleteMutationVariables,
  WorkflowStateType,
} from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoCycle, IcoPlus, IcoSettings } from '../components/Icons';
import { Btn, StatusIconPrimitive } from '../components/Primitives';

function getStateType(stateType: WorkflowStateType): string {
  switch (stateType) {
    case 'COMPLETED': return 'completed';
    case 'CANCELED': return 'canceled';
    case 'STARTED': return 'started';
    case 'BACKLOG': return 'backlog';
    default: return 'unstarted';
  }
}

function getStateColor(stateType: WorkflowStateType): string {
  switch (stateType) {
    case 'COMPLETED': return '#10b981';
    case 'CANCELED': return '#ef4444';
    case 'STARTED': return '#f59e0b';
    case 'BACKLOG': return '#6b7280';
    default: return '#64748b';
  }
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

function isCycleActive(cycle: CycleSummary): boolean {
  const now = Date.now();
  return new Date(cycle.startsAt).getTime() <= now && new Date(cycle.endsAt).getTime() >= now;
}

function isCycleCompleted(cycle: CycleSummary): boolean {
  return new Date(cycle.endsAt).getTime() < Date.now();
}

export function CyclesPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [editingCycleId, setEditingCycleId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formStartsAt, setFormStartsAt] = useState('');
  const [formEndsAt, setFormEndsAt] = useState('');

  const { data: boardData } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: { first: 1, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) },
  });

  const teamId = boardData?.teams.nodes.find((t) => t.key === teamKey)?.id ?? boardData?.teams.nodes[0]?.id ?? '';

  const { data, loading } = useQuery<CyclesQueryData, CyclesQueryVariables>(CYCLES_QUERY, {
    skip: !teamId,
    variables: { teamId },
  });

  const [runCreate] = useMutation<CycleCreateMutationData, CycleCreateMutationVariables>(CYCLE_CREATE_MUTATION);
  const [runUpdate] = useMutation<CycleUpdateMutationData, CycleUpdateMutationVariables>(CYCLE_UPDATE_MUTATION);
  const [runDelete] = useMutation<CycleDeleteMutationData, CycleDeleteMutationVariables>(CYCLE_DELETE_MUTATION);

  const cycles = data?.cycles.nodes ?? [];
  const activeCycle = useMemo(() => cycles.find(isCycleActive) ?? null, [cycles]);
  const completedCycles = useMemo(() => cycles.filter(isCycleCompleted), [cycles]);
  const upcomingCycles = useMemo(
    () => cycles.filter((c) => !isCycleActive(c) && !isCycleCompleted(c)),
    [cycles],
  );

  function openCreateDialog() {
    setDialogMode('create');
    setEditingCycleId(null);
    setFormName('');
    const now = new Date();
    setFormStartsAt(now.toISOString().slice(0, 10));
    const end = new Date(now.getTime() + 14 * 86400000);
    setFormEndsAt(end.toISOString().slice(0, 10));
    dialogRef.current?.showModal();
  }

  function openEditDialog(cycle: CycleSummary) {
    setDialogMode('edit');
    setEditingCycleId(cycle.id);
    setFormName(cycle.name);
    setFormStartsAt(new Date(cycle.startsAt).toISOString().slice(0, 10));
    setFormEndsAt(new Date(cycle.endsAt).toISOString().slice(0, 10));
    dialogRef.current?.showModal();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || !formStartsAt || !formEndsAt) return;

    if (dialogMode === 'create') {
      await runCreate({
        variables: {
          input: {
            teamId,
            name: formName.trim(),
            startsAt: new Date(formStartsAt).toISOString(),
            endsAt: new Date(formEndsAt).toISOString(),
          },
        },
        refetchQueries: [{ query: CYCLES_QUERY, variables: { teamId } }],
      });
    } else if (editingCycleId) {
      await runUpdate({
        variables: {
          id: editingCycleId,
          input: {
            name: formName.trim(),
            startsAt: new Date(formStartsAt).toISOString(),
            endsAt: new Date(formEndsAt).toISOString(),
          },
        },
        refetchQueries: [{ query: CYCLES_QUERY, variables: { teamId } }],
      });
    }
    dialogRef.current?.close();
  }

  async function handleDelete(cycleId: string) {
    if (!window.confirm('Delete this cycle? This cannot be undone.')) return;
    await runDelete({
      variables: { id: cycleId },
      refetchQueries: [{ query: CYCLES_QUERY, variables: { teamId } }],
    });
  }

  function renderCycleProgress(cycle: CycleSummary) {
    const issues = cycle.issues?.nodes ?? [];
    const total = issues.length;
    if (total === 0) return null;
    const completed = issues.filter(
      (i) => i.state.type === 'COMPLETED' || i.state.type === 'CANCELED',
    ).length;
    const pct = Math.round((completed / total) * 100);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <div style={{
          flex: 1, height: 4, borderRadius: 2,
          background: 'var(--bg-hover)', overflow: 'hidden',
        }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{pct}%</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoCycle /></span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Cycles</span>
        {teamKey && (
          <>
            <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>·</span>
            <span className="mono" style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3,
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
            }}>
              {teamKey}
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateDialog}>
          New cycle
        </Btn>
      </div>

      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12 }}>
            Loading cycles…
          </div>
        ) : cycles.length === 0 ? (
          <div className="empty-state">
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              border: '1px solid var(--border)', background: 'var(--bg-raised)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
            }}>
              <IcoCycle size={22} style={{ color: 'var(--fg-faint)' }} />
            </div>
            <h3>No cycles configured</h3>
            <p>Create a cycle to group issues into time-boxed sprints.</p>
            <Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateDialog} style={{ marginTop: 12 }}>
              New cycle
            </Btn>
          </div>
        ) : (
          <div style={{ padding: '20px var(--pad-x)' }}>
            {activeCycle && (
              <section style={{ marginBottom: 32 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                  ACTIVE CYCLE
                </div>
                <div style={{
                  border: '1px solid var(--accent-border)', borderRadius: 'var(--r-3)',
                  padding: 16, background: 'var(--bg-raised)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{activeCycle.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                      {formatDate(activeCycle.startsAt)} – {formatDate(activeCycle.endsAt)}
                    </span>
                    <div style={{ flex: 1 }} />
                    <Btn variant="ghost" icon={<IcoSettings size={12} />} size="sm" onClick={() => openEditDialog(activeCycle)}>
                      Configure
                    </Btn>
                  </div>
                  {renderCycleProgress(activeCycle)}
                  {(activeCycle.issues?.nodes ?? []).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      {activeCycle.issues!.nodes.map((issue) => (
                        <button
                          key={issue.id}
                          type="button"
                          onClick={() => navigate(`/issue/${issue.id}`)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            width: '100%', padding: '6px 0', background: 'none', border: 'none',
                            cursor: 'pointer', fontSize: 12.5, color: 'var(--fg)', textAlign: 'left',
                          }}
                        >
                          <StatusIconPrimitive stateType={getStateType(issue.state.type)} stateColor={getStateColor(issue.state.type)} size={14} />
                          <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>{issue.identifier}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            {upcomingCycles.length > 0 && (
              <section style={{ marginBottom: 32 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                  UPCOMING
                </div>
                {upcomingCycles.map((cycle) => (
                  <CycleRow key={cycle.id} cycle={cycle} onEdit={() => openEditDialog(cycle)} onDelete={() => handleDelete(cycle.id)} />
                ))}
              </section>
            )}

            {completedCycles.length > 0 && (
              <section>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                  COMPLETED
                </div>
                {completedCycles.map((cycle) => (
                  <CycleRow key={cycle.id} cycle={cycle} onEdit={() => openEditDialog(cycle)} onDelete={() => handleDelete(cycle.id)} />
                ))}
              </section>
            )}
          </div>
        )}
      </div>

      <dialog ref={dialogRef} className="dialog-modal" onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form onSubmit={handleSubmit} style={{ padding: 20, minWidth: 340 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 500 }}>
            {dialogMode === 'create' ? 'New cycle' : 'Edit cycle'}
          </h3>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Name</span>
            <input
              style={{ width: '100%', height: 30, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)' }}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Sprint 1"
              required
            />
          </label>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Start date</span>
              <input
                type="date"
                style={{ width: '100%', height: 30, padding: '0 8px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
                value={formStartsAt}
                onChange={(e) => setFormStartsAt(e.target.value)}
                required
              />
            </label>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>End date</span>
              <input
                type="date"
                style={{ width: '100%', height: 30, padding: '0 8px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
                value={formEndsAt}
                onChange={(e) => setFormEndsAt(e.target.value)}
                required
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--subtle btn--md" onClick={() => dialogRef.current?.close()}>Cancel</button>
            <button type="submit" className="btn btn--accent btn--md">
              {dialogMode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function CycleRow({ cycle, onEdit, onDelete }: { cycle: CycleSummary; onEdit: () => void; onDelete: () => void }) {
  const issueCount = cycle.issues?.nodes.length ?? 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', borderRadius: 'var(--r-2)',
      border: '1px solid var(--border)', marginBottom: 6, background: 'var(--bg-raised)',
    }}>
      <IcoCycle size={14} style={{ color: 'var(--fg-dim)' }} />
      <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{cycle.name}</span>
      <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
        {formatDate(cycle.startsAt)} – {formatDate(cycle.endsAt)}
      </span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{issueCount} issues</span>
      <Btn variant="ghost" size="sm" onClick={onEdit}>Edit</Btn>
      <Btn variant="ghost" size="sm" onClick={onDelete} style={{ color: 'var(--danger)' }}>Delete</Btn>
    </div>
  );
}
