import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  BOARD_PAGE_QUERY,
  CYCLES_QUERY,
  CYCLE_CREATE_MUTATION,
  CYCLE_UPDATE_MUTATION,
  CYCLE_DELETE_MUTATION,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUE_DELETE_MUTATION,
  MILESTONE_ISSUES_QUERY,
} from '../board/queries';
import { PlacementPicker } from '../components/PlacementPicker';
import { GRAPH_PROJECTS_QUERY } from '../work/queries';
import type { GraphProjectsQueryData } from '../work/types';
import type { CreatePlacement } from '../work/placement';
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
  IssueCreateMutationData,
  IssueCreateMutationVariables,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
  IssueDeleteMutationData,
  IssueDeleteMutationVariables,
  MilestoneIssueSummary,
  MilestoneIssuesQueryData,
  MilestoneIssuesQueryVariables,
  WorkflowStateType,
} from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoCycle, IcoPlus, IcoSettings } from '../components/Icons';
import { Btn, StatusIconPrimitive } from '../components/Primitives';
import { DialogShell } from '../components/DialogShell';
import { Field, TextArea, TextInput } from '../components/controls';
import { getStatusColorVar } from '../components/StatusIcon';

type ViewTab = 'milestones' | 'cycles';

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
    case 'COMPLETED': return getStatusColorVar('completed');
    case 'CANCELED': return getStatusColorVar('canceled');
    case 'STARTED': return getStatusColorVar('started');
    case 'BACKLOG': return getStatusColorVar('backlog');
    default: return getStatusColorVar('unstarted');
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
  const [teamKey, setTeamKey] = useState<string | null>(() => readStoredTeamKey());
  const [activeTab, setActiveTab] = useState<ViewTab>('milestones');

  const [isCycleDialogOpen, setIsCycleDialogOpen] = useState(false);
  const [isMilestoneDialogOpen, setIsMilestoneDialogOpen] = useState(false);

  useEffect(() => {
    function handleActiveTeamKeyChange(event: Event) {
      const nextTeamKey =
        event instanceof CustomEvent && (typeof event.detail === 'string' || event.detail === null)
          ? (event.detail as string | null)
          : readStoredTeamKey();
      setTeamKey(nextTeamKey);
    }

    window.addEventListener('involute:active-team-key', handleActiveTeamKeyChange as EventListener);

    return () => {
      window.removeEventListener('involute:active-team-key', handleActiveTeamKeyChange as EventListener);
    };
  }, []);

  // Legacy cycle modal state
  const [cycleDialogMode, setCycleDialogMode] = useState<'create' | 'edit'>('create');
  const [editingCycleId, setEditingCycleId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formStartsAt, setFormStartsAt] = useState('');
  const [formEndsAt, setFormEndsAt] = useState('');

  // Milestone modal state
  const [milestoneDialogMode, setMilestoneDialogMode] = useState<'create' | 'edit'>('create');
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [milestoneTitle, setMilestoneTitle] = useState('');
  const [milestoneDescription, setMilestoneDescription] = useState('');
  const [milestoneOutcome, setMilestoneOutcome] = useState('');
  // A new milestone goes directly under its project (INV-744/792).
  const [milestonePlacement, setMilestonePlacement] = useState<CreatePlacement | null>(null);
  const [milestoneError, setMilestoneError] = useState<string | null>(null);
  const { data: milestoneProjectsData } = useQuery<GraphProjectsQueryData>(GRAPH_PROJECTS_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
  });
  const milestoneProjects = milestoneProjectsData?.projectSummary?.projects ?? [];

  const { data: boardData } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: { first: 1, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) },
  });

  const selectedTeam = boardData?.teams.nodes.find((t) => t.key === teamKey) ?? boardData?.teams.nodes[0] ?? null;
  const canWriteTeam = selectedTeam?.viewerCanWrite ?? false;
  const teamId = selectedTeam?.id ?? '';

  const milestoneQueryVariables: MilestoneIssuesQueryVariables = {};
  if (teamKey) {
    milestoneQueryVariables.teamKey = teamKey;
  }

  // Milestones query
  const { data: milestoneData, loading: milestoneLoading, refetch: refetchMilestones } = useQuery<
    MilestoneIssuesQueryData,
    MilestoneIssuesQueryVariables
  >(MILESTONE_ISSUES_QUERY, {
    variables: milestoneQueryVariables,
    fetchPolicy: 'cache-and-network',
  });

  // Legacy cycles query
  const { data: cyclesData, loading: cyclesLoading, refetch: refetchCycles } = useQuery<
    CyclesQueryData,
    CyclesQueryVariables
  >(CYCLES_QUERY, {
    skip: !teamId,
    variables: { teamId },
  });

  // Cycle mutations
  const [runCycleCreate] = useMutation<CycleCreateMutationData, CycleCreateMutationVariables>(CYCLE_CREATE_MUTATION);
  const [runCycleUpdate] = useMutation<CycleUpdateMutationData, CycleUpdateMutationVariables>(CYCLE_UPDATE_MUTATION);
  const [runCycleDelete] = useMutation<CycleDeleteMutationData, CycleDeleteMutationVariables>(CYCLE_DELETE_MUTATION);

  // Milestone (Issue) mutations
  const [runIssueCreate] = useMutation<IssueCreateMutationData, IssueCreateMutationVariables>(ISSUE_CREATE_MUTATION);
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(ISSUE_UPDATE_MUTATION);
  const [runIssueDelete] = useMutation<IssueDeleteMutationData, IssueDeleteMutationVariables>(ISSUE_DELETE_MUTATION);

  const milestones = useMemo(() => milestoneData?.issues?.nodes ?? [], [milestoneData?.issues?.nodes]);
  const activeMilestones = useMemo(
    () => milestones.filter((m) => m.state.type === 'STARTED'),
    [milestones],
  );
  const upcomingMilestones = useMemo(
    () => milestones.filter((m) => m.state.type === 'UNSTARTED' || m.state.type === 'BACKLOG'),
    [milestones],
  );
  const completedMilestones = useMemo(
    () => milestones.filter((m) => m.state.type === 'COMPLETED' || m.state.type === 'CANCELED'),
    [milestones],
  );

  const cycles = cyclesData?.cycles.nodes ?? [];
  const activeCycle = useMemo(() => cycles.find(isCycleActive) ?? null, [cycles]);
  const completedCycles = useMemo(() => cycles.filter(isCycleCompleted), [cycles]);
  const upcomingCycles = useMemo(
    () => cycles.filter((c) => !isCycleActive(c) && !isCycleCompleted(c)),
    [cycles],
  );

  function openCreateMilestone() {
    setMilestoneDialogMode('create');
    setEditingMilestoneId(null);
    setMilestoneTitle('');
    setMilestoneDescription('');
    setMilestoneOutcome('');
    setMilestonePlacement(null);
    setMilestoneError(null);
    setMilestoneOutcome('');
    setIsMilestoneDialogOpen(true);
  }

  function openEditMilestone(milestone: MilestoneIssueSummary) {
    setMilestoneDialogMode('edit');
    setEditingMilestoneId(milestone.id);
    setMilestoneTitle(milestone.title);
    setMilestoneDescription(milestone.description ?? '');
    setMilestoneOutcome(milestone.outcome ?? '');
    setMilestoneError(null);
    setIsMilestoneDialogOpen(true);
  }

  async function handleMilestoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!milestoneTitle.trim() || !teamId) return;
    setMilestoneError(null);

    if (milestoneDialogMode === 'create') {
      if (!milestonePlacement) return;
      const defaultState = selectedTeam?.states.nodes[0];
      const result = await runIssueCreate({
        variables: {
          input: {
            teamId,
            title: milestoneTitle.trim(),
            description: milestoneDescription.trim() || null,
            kind: 'MILESTONE',
            parentId: milestonePlacement.parentId,
            ...(milestoneOutcome.trim() ? { outcome: milestoneOutcome.trim() } : {}),
            ...(defaultState ? { stateId: defaultState.id } : {}),
          },
        },
      });
      if (!result.data?.issueCreate.success) {
        setMilestoneError(result.data?.issueCreate.message ?? 'Could not create the milestone.');
        return;
      }
    } else if (editingMilestoneId) {
      const result = await runIssueUpdate({
        variables: {
          id: editingMilestoneId,
          input: {
            title: milestoneTitle.trim(),
            description: milestoneDescription.trim() || null,
            outcome: milestoneOutcome.trim() || null,
          },
        },
      });
      if (!result.data?.issueUpdate.success) {
        setMilestoneError(result.data?.issueUpdate.message ?? 'Could not save the milestone.');
        return;
      }
    }

    void refetchMilestones();
    setIsMilestoneDialogOpen(false);
  }

  async function handleMilestoneDelete(id: string) {
    if (!window.confirm('Delete this milestone? This cannot be undone.')) return;
    await runIssueDelete({ variables: { id } });
    void refetchMilestones();
  }

  function openCreateCycleDialog() {
    setCycleDialogMode('create');
    setEditingCycleId(null);
    setFormName('');
    const now = new Date();
    setFormStartsAt(now.toISOString().slice(0, 10));
    const end = new Date(now.getTime() + 14 * 86400000);
    setFormEndsAt(end.toISOString().slice(0, 10));
    setIsCycleDialogOpen(true);
  }

  function openEditCycleDialog(cycle: CycleSummary) {
    setCycleDialogMode('edit');
    setEditingCycleId(cycle.id);
    setFormName(cycle.name);
    setFormStartsAt(new Date(cycle.startsAt).toISOString().slice(0, 10));
    setFormEndsAt(new Date(cycle.endsAt).toISOString().slice(0, 10));
    setIsCycleDialogOpen(true);
  }

  async function handleCycleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || !formStartsAt || !formEndsAt) return;

    if (cycleDialogMode === 'create') {
      await runCycleCreate({
        variables: {
          input: {
            teamId,
            name: formName.trim(),
            startsAt: new Date(formStartsAt).toISOString(),
            endsAt: new Date(formEndsAt).toISOString(),
          },
        },
      });
    } else if (editingCycleId) {
      await runCycleUpdate({
        variables: {
          id: editingCycleId,
          input: {
            name: formName.trim(),
            startsAt: new Date(formStartsAt).toISOString(),
            endsAt: new Date(formEndsAt).toISOString(),
          },
        },
      });
    }
    void refetchCycles();
    setIsCycleDialogOpen(false);
  }

  async function handleCycleDelete(cycleId: string) {
    if (!window.confirm('Delete this cycle? This cannot be undone.')) return;
    await runCycleDelete({ variables: { id: cycleId } });
    void refetchCycles();
  }

  function renderMilestoneProgress(milestone: MilestoneIssueSummary) {
    const children = milestone.children?.nodes ?? [];
    const total = children.length;
    if (total === 0) return null;
    const completed = children.filter(
      (c) => c.state.type === 'COMPLETED' || c.state.type === 'CANCELED',
    ).length;
    const pct = Math.round((completed / total) * 100);

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <div
          style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            background: 'var(--bg-hover)',
            overflow: 'hidden',
          }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
          {completed}/{total} ({pct}%)
        </span>
      </div>
    );
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
        <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>{pct}%</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoCycle /></span>
        <span style={{ fontSize: 15, fontWeight: 500 }}>
          {activeTab === 'milestones' ? 'Milestones' : 'Cycles'}
        </span>
        {teamKey && (
          <>
            <span style={{ color: 'var(--fg-faint)', fontSize: 14 }}>·</span>
            <span className="mono" style={{
              fontSize: 12, padding: '1px 5px', borderRadius: 3,
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
            }}>
              {teamKey}
            </span>
          </>
        )}

        <div style={{ display: 'inline-flex', marginLeft: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-2)', padding: 1 }}>
          <Btn variant="ghost" size="sm" active={activeTab === 'milestones'} onClick={() => setActiveTab('milestones')}>
            Milestones (Work Graph)
          </Btn>
          <Btn variant="ghost" size="sm" active={activeTab === 'cycles'} onClick={() => setActiveTab('cycles')}>
            Cycles (Legacy)
          </Btn>
        </div>

        <div style={{ flex: 1 }} />
        {!canWriteTeam ? null : activeTab === 'milestones' ? (
          <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateMilestone}>
            New milestone
          </Btn>
        ) : (
          <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateCycleDialog}>
            New cycle
          </Btn>
        )}
      </div>

      <div className="page-content">
        {activeTab === 'milestones' ? (
          milestoneLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 14 }}>
              Loading milestones…
            </div>
          ) : milestones.length === 0 ? (
            <div className="empty-state">
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                border: '1px solid var(--border)', background: 'var(--bg-raised)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
              }}>
                <IcoCycle size={22} style={{ color: 'var(--fg-faint)' }} />
              </div>
              <h3>No milestones configured</h3>
              <p>Milestones group work nodes into deliverables with outcome criteria and child tasks.</p>
              {canWriteTeam ? (<Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateMilestone} style={{ marginTop: 12 }}>
                New milestone
              </Btn>) : null}
            </div>
          ) : (
            <div style={{ padding: '20px var(--pad-x)' }}>
              {activeMilestones.length > 0 && (
                <section style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                    IN PROGRESS
                  </div>
                  {activeMilestones.map((milestone) => (
                    <div
                      key={milestone.id}
                      style={{
                        border: '1px solid var(--accent-border)',
                        borderRadius: 'var(--r-3)',
                        padding: 16,
                        background: 'var(--bg-raised)',
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                          {milestone.identifier}
                        </span>
                        <span style={{ fontSize: 15, fontWeight: 500 }}>{milestone.title}</span>
                        <div style={{ flex: 1 }} />
                        <Btn
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/work/${milestone.id}`)}
                          style={{ marginRight: 6 }}
                        >
                          Work context
                        </Btn>
                        <Btn variant="ghost" icon={<IcoSettings size={12} />} size="sm" onClick={() => openEditMilestone(milestone)}>
                          Configure
                        </Btn>
                      </div>
                      {renderMilestoneProgress(milestone)}
                      {(milestone.children?.nodes ?? []).length > 0 && (
                        <div style={{ marginTop: 12, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                          {milestone.children.nodes.map((child) => (
                            <button
                              key={child.id}
                              type="button"
                              onClick={() => navigate(`/issue/${child.id}`)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                width: '100%',
                                padding: '6px 0',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: 14,
                                color: 'var(--fg)',
                                textAlign: 'left',
                              }}
                            >
                              <StatusIconPrimitive stateType={getStateType(child.state.type)} stateColor={getStateColor(child.state.type)} size={14} />
                              <span className="mono" style={{ fontSize: 12, color: 'var(--fg-dim)' }}>{child.identifier}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{child.title}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              )}

              {upcomingMilestones.length > 0 && (
                <section style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                    UPCOMING & BACKLOG
                  </div>
                  {upcomingMilestones.map((milestone) => (
                    <MilestoneRow
                      key={milestone.id}
                      milestone={milestone}
                      onEdit={() => openEditMilestone(milestone)}
                      onDelete={() => void handleMilestoneDelete(milestone.id)}
                      onNavigate={() => navigate(`/work/${milestone.id}`)}
                    />
                  ))}
                </section>
              )}

              {completedMilestones.length > 0 && (
                <section>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                    COMPLETED
                  </div>
                  {completedMilestones.map((milestone) => (
                    <MilestoneRow
                      key={milestone.id}
                      milestone={milestone}
                      onEdit={() => openEditMilestone(milestone)}
                      onDelete={() => void handleMilestoneDelete(milestone.id)}
                      onNavigate={() => navigate(`/work/${milestone.id}`)}
                    />
                  ))}
                </section>
              )}
            </div>
          )
        ) : (
          cyclesLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 14 }}>
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
              {canWriteTeam ? (<Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateCycleDialog} style={{ marginTop: 12 }}>
                New cycle
              </Btn>) : null}
            </div>
          ) : (
            <div style={{ padding: '20px var(--pad-x)' }}>
              {activeCycle && (
                <section style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                    ACTIVE CYCLE
                  </div>
                  <div style={{
                    border: '1px solid var(--accent-border)', borderRadius: 'var(--r-3)',
                    padding: 16, background: 'var(--bg-raised)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 15, fontWeight: 500 }}>{activeCycle.name}</span>
                      <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
                        {formatDate(activeCycle.startsAt)} – {formatDate(activeCycle.endsAt)}
                      </span>
                      <div style={{ flex: 1 }} />
                      <Btn variant="ghost" icon={<IcoSettings size={12} />} size="sm" onClick={() => openEditCycleDialog(activeCycle)}>
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
                              cursor: 'pointer', fontSize: 14.5, color: 'var(--fg)', textAlign: 'left',
                            }}
                          >
                            <StatusIconPrimitive stateType={getStateType(issue.state.type)} stateColor={getStateColor(issue.state.type)} size={14} />
                            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-dim)' }}>{issue.identifier}</span>
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
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                    UPCOMING
                  </div>
                  {upcomingCycles.map((cycle) => (
                    <CycleRow key={cycle.id} cycle={cycle} onEdit={() => openEditCycleDialog(cycle)} onDelete={() => void handleCycleDelete(cycle.id)} />
                  ))}
                </section>
              )}

              {completedCycles.length > 0 && (
                <section>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-dim)', marginBottom: 8, letterSpacing: '0.03em' }}>
                    COMPLETED
                  </div>
                  {completedCycles.map((cycle) => (
                    <CycleRow key={cycle.id} cycle={cycle} onEdit={() => openEditCycleDialog(cycle)} onDelete={() => void handleCycleDelete(cycle.id)} />
                  ))}
                </section>
              )}
            </div>
          )
        )}
      </div>

      {/* Milestone Dialog */}
      {isMilestoneDialogOpen ? (
        <DialogShell
          variant="modal"
          title={milestoneDialogMode === 'create' ? 'New milestone' : 'Edit milestone'}
          onClose={() => setIsMilestoneDialogOpen(false)}
          onSubmit={(e) => void handleMilestoneSubmit(e)}
          footer={(
            <>
              <Btn variant="subtle" size="md" onClick={() => setIsMilestoneDialogOpen(false)}>Cancel</Btn>
              <Btn type="submit" variant="accent" size="md" disabled={milestoneDialogMode === 'create' && !milestonePlacement}>
                {milestoneDialogMode === 'create' ? 'Create' : 'Save'}
              </Btn>
            </>
          )}
        >
          <Field label="Title">
            <TextInput
              value={milestoneTitle}
              onChange={(e) => setMilestoneTitle(e.target.value)}
              placeholder="e.g. Release v1.0 or Core Engine"
              required
            />
          </Field>
          <Field label="Description">
            <TextArea
              value={milestoneDescription}
              onChange={(e) => setMilestoneDescription(e.target.value)}
              placeholder="Milestone goals and deliverables"
            />
          </Field>
          <Field label="Outcome">
            <TextArea
              aria-label="Milestone outcome"
              size="sm"
              value={milestoneOutcome}
              onChange={(e) => setMilestoneOutcome(e.target.value)}
              placeholder="What is true once this milestone is done"
            />
          </Field>
          {milestoneDialogMode === 'create' ? (
            <PlacementPicker
              projects={milestoneProjects}
              value={milestonePlacement}
              source={null}
              kind="MILESTONE"
              onChange={setMilestonePlacement}
            />
          ) : null}
          {milestoneError ? (
            <p role="alert" className="dialog-shell__error">
              {milestoneError}
            </p>
          ) : null}
        </DialogShell>
      ) : null}

      {/* Cycle Dialog */}
      {isCycleDialogOpen ? (
        <DialogShell
          variant="modal"
          title={cycleDialogMode === 'create' ? 'New cycle' : 'Edit cycle'}
          onClose={() => setIsCycleDialogOpen(false)}
          onSubmit={(e) => void handleCycleSubmit(e)}
          footer={(
            <>
              <Btn variant="subtle" size="md" onClick={() => setIsCycleDialogOpen(false)}>Cancel</Btn>
              <Btn type="submit" variant="accent" size="md">
                {cycleDialogMode === 'create' ? 'Create' : 'Save'}
              </Btn>
            </>
          )}
        >
          <Field label="Name">
            <TextInput
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Sprint 1"
              required
            />
          </Field>
          <div className="field-grid">
            <Field label="Start date">
              <TextInput
                type="date"
                value={formStartsAt}
                onChange={(e) => setFormStartsAt(e.target.value)}
                required
              />
            </Field>
            <Field label="End date">
              <TextInput
                type="date"
                value={formEndsAt}
                onChange={(e) => setFormEndsAt(e.target.value)}
                required
              />
            </Field>
          </div>
        </DialogShell>
      ) : null}
    </div>
  );
}

function MilestoneRow({
  milestone,
  onEdit,
  onDelete,
  onNavigate,
}: {
  milestone: MilestoneIssueSummary;
  onEdit: () => void;
  onDelete: () => void;
  onNavigate: () => void;
}) {
  const childCount = milestone.children?.nodes.length ?? 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', borderRadius: 'var(--r-2)',
      border: '1px solid var(--border)', marginBottom: 6, background: 'var(--bg-raised)',
    }}>
      <IcoCycle size={14} style={{ color: 'var(--fg-dim)' }} />
      <span className="mono" style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
        {milestone.identifier}
      </span>
      <span style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>{milestone.title}</span>
      <span className="mono" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>{childCount} tasks</span>
      <Btn variant="ghost" size="sm" onClick={onNavigate}>Context</Btn>
      <Btn variant="ghost" size="sm" onClick={onEdit}>Edit</Btn>
      <Btn variant="danger" size="sm" onClick={onDelete}>Delete</Btn>
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
      <span style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>{cycle.name}</span>
      <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
        {formatDate(cycle.startsAt)} – {formatDate(cycle.endsAt)}
      </span>
      <span className="mono" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>{issueCount} issues</span>
      <Btn variant="ghost" size="sm" onClick={onEdit}>Edit</Btn>
      <Btn variant="danger" size="sm" onClick={onDelete}>Delete</Btn>
    </div>
  );
}
