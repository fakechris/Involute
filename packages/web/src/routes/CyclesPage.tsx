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
import { Btn } from '../components/Primitives';
import { IssueRow, ListRow } from '../components/list';
import { STATE_TYPE_LABEL } from '../components/graph/graph-colors';
import { DialogShell } from '../components/DialogShell';
import { Field, TextArea, TextInput } from '../components/controls';
import { PageBody, PageHeader } from '../components/layout';
import { Badge, EmptyState, LoadingState, SegmentedControl } from '../components/status';

type ViewTab = 'milestones' | 'cycles';

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

  function renderProgress(items: Array<{ state: { type: WorkflowStateType } }>, withCount: boolean) {
    const total = items.length;
    if (total === 0) return null;
    const completed = items.filter(
      (c) => c.state.type === 'COMPLETED' || c.state.type === 'CANCELED',
    ).length;
    const pct = Math.round((completed / total) * 100);

    return (
      <div className="cycles-progress">
        <div className="cycles-progress__track">
          <div className="cycles-progress__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="cycles-progress__label">
          {withCount ? `${completed}/${total} (${pct}%)` : `${pct}%`}
        </span>
      </div>
    );
  }

  function renderIssueLinks(items: Array<{ id: string; identifier: string; title: string; state: { type: WorkflowStateType } }>) {
    return (
      <ul className="list-rows cycles-card__issues">
        {items.map((child) => (
          <IssueRow key={child.id} issue={{ ...child, state: { name: STATE_TYPE_LABEL[child.state.type], type: child.state.type } }} />
        ))}
      </ul>
    );
  }

  return (
    <div className="observation-page">
      <PageHeader
        icon={<IcoCycle />}
        title={activeTab === 'milestones' ? 'Milestones' : 'Cycles'}
        hint={teamKey ? <Badge mono>{teamKey}</Badge> : null}
        actions={(
          <>
            <SegmentedControl
              aria-label="Planning view"
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: 'milestones', label: 'Milestones (Work Graph)' },
                { value: 'cycles', label: 'Cycles (Legacy)' },
              ]}
            />
            {!canWriteTeam ? null : activeTab === 'milestones' ? (
              <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateMilestone}>
                New milestone
              </Btn>
            ) : (
              <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateCycleDialog}>
                New cycle
              </Btn>
            )}
          </>
        )}
      />

      <PageBody width="wide">
        {activeTab === 'milestones' ? (
          milestoneLoading ? (
            <LoadingState>Loading milestones…</LoadingState>
          ) : milestones.length === 0 ? (
            <EmptyState
              icon={<IcoCycle size={20} />}
              title="No milestones configured"
              body="Milestones group work nodes into deliverables with outcome criteria and child tasks."
              action={canWriteTeam ? (
                <Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateMilestone}>
                  New milestone
                </Btn>
              ) : null}
            />
          ) : (
            <>
              {activeMilestones.length > 0 && (
                <section className="cycles-section">
                  <h2 className="cycles-section__title">In progress</h2>
                  {activeMilestones.map((milestone) => (
                    <div key={milestone.id} className="card cycles-card">
                      <div className="cycles-card__head">
                        <span className="mono cycles-row__id">{milestone.identifier}</span>
                        <span className="cycles-row__title">{milestone.title}</span>
                        <Btn variant="ghost" size="sm" onClick={() => navigate(`/work/${milestone.id}`)}>
                          Work context
                        </Btn>
                        <Btn variant="ghost" icon={<IcoSettings size={12} />} size="sm" onClick={() => openEditMilestone(milestone)}>
                          Configure
                        </Btn>
                      </div>
                      {renderProgress(milestone.children?.nodes ?? [], true)}
                      {(milestone.children?.nodes ?? []).length > 0 && renderIssueLinks(milestone.children.nodes)}
                    </div>
                  ))}
                </section>
              )}

              {upcomingMilestones.length > 0 && (
                <section className="cycles-section">
                  <h2 className="cycles-section__title">Upcoming &amp; backlog</h2>
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
                <section className="cycles-section">
                  <h2 className="cycles-section__title">Completed</h2>
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
            </>
          )
        ) : (
          cyclesLoading ? (
            <LoadingState>Loading cycles…</LoadingState>
          ) : cycles.length === 0 ? (
            <EmptyState
              icon={<IcoCycle size={20} />}
              title="No cycles configured"
              body="Create a cycle to group issues into time-boxed sprints."
              action={canWriteTeam ? (
                <Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateCycleDialog}>
                  New cycle
                </Btn>
              ) : null}
            />
          ) : (
            <>
              {activeCycle && (
                <section className="cycles-section">
                  <h2 className="cycles-section__title">Active cycle</h2>
                  <div className="card cycles-card">
                    <div className="cycles-card__head">
                      <span className="cycles-row__title">{activeCycle.name}</span>
                      <span className="cycles-row__meta">
                        {formatDate(activeCycle.startsAt)} – {formatDate(activeCycle.endsAt)}
                      </span>
                      <Btn variant="ghost" icon={<IcoSettings size={12} />} size="sm" onClick={() => openEditCycleDialog(activeCycle)}>
                        Configure
                      </Btn>
                    </div>
                    {renderProgress(activeCycle.issues?.nodes ?? [], false)}
                    {(activeCycle.issues?.nodes ?? []).length > 0 && renderIssueLinks(activeCycle.issues!.nodes)}
                  </div>
                </section>
              )}

              {upcomingCycles.length > 0 && (
                <section className="cycles-section">
                  <h2 className="cycles-section__title">Upcoming</h2>
                  {upcomingCycles.map((cycle) => (
                    <CycleRow key={cycle.id} cycle={cycle} onEdit={() => openEditCycleDialog(cycle)} onDelete={() => void handleCycleDelete(cycle.id)} />
                  ))}
                </section>
              )}

              {completedCycles.length > 0 && (
                <section className="cycles-section">
                  <h2 className="cycles-section__title">Completed</h2>
                  {completedCycles.map((cycle) => (
                    <CycleRow key={cycle.id} cycle={cycle} onEdit={() => openEditCycleDialog(cycle)} onDelete={() => void handleCycleDelete(cycle.id)} />
                  ))}
                </section>
              )}
            </>
          )
        )}
      </PageBody>

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
    <ListRow
      as="div"
      leading={<IcoCycle size={14} />}
      id={milestone.identifier}
      title={milestone.title}
      meta={<span className="mono">{childCount} tasks</span>}
      trailing={
        <>
          <Btn variant="ghost" size="sm" onClick={onNavigate}>Context</Btn>
          <Btn variant="ghost" size="sm" onClick={onEdit}>Edit</Btn>
          <Btn variant="danger" size="sm" onClick={onDelete}>Delete</Btn>
        </>
      }
    />
  );
}

function CycleRow({ cycle, onEdit, onDelete }: { cycle: CycleSummary; onEdit: () => void; onDelete: () => void }) {
  const issueCount = cycle.issues?.nodes.length ?? 0;
  return (
    <ListRow
      as="div"
      leading={<IcoCycle size={14} />}
      title={cycle.name}
      meta={
        <>
          <span>{formatDate(cycle.startsAt)} – {formatDate(cycle.endsAt)}</span>
          <span className="mono">{issueCount} issues</span>
        </>
      }
      trailing={
        <>
          <Btn variant="ghost" size="sm" onClick={onEdit}>Edit</Btn>
          <Btn variant="danger" size="sm" onClick={onDelete}>Delete</Btn>
        </>
      }
    />
  );
}
