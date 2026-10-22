import { useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, IssueSummary, WorkflowStateType } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { Select } from '../components/controls';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { Avatar, PriorityIcon, StatusIconPrimitive } from '../components/Primitives';
import { ProjectFilterCombobox } from '../components/ProjectFilterCombobox';
import { EmptyState, LoadingState } from '../components/status';
import { getStatusColorVar } from '../components/StatusIcon';
import { useWorkFilters, WorkFilterBar } from '../components/WorkFilterBar';
import { matchesProject, matchesWorkFilters, projectsFromCounts, useProjectParam, NO_REPOSITORY_OPTIONS } from './work-filter-match';

function formatTimeAgo(date: string): string {
  const parsed = new Date(date).getTime();
  if (Number.isNaN(parsed)) return '—';
  const seconds = Math.floor((Date.now() - parsed) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function classifyState(stateType: WorkflowStateType): 'progress' | 'todo' | 'backlog' | 'completed' {
  switch (stateType) {
    case 'STARTED': return 'progress';
    case 'COMPLETED':
    case 'CANCELED': return 'completed';
    case 'BACKLOG': return 'backlog';
    case 'UNSTARTED':
    default: return 'todo';
  }
}

function getStateType(stateType: WorkflowStateType): string {
  switch (stateType) {
    case 'COMPLETED': return 'completed';
    case 'CANCELED': return 'canceled';
    case 'STARTED': return 'started';
    case 'BACKLOG': return 'backlog';
    case 'UNSTARTED':
    default: return 'unstarted';
  }
}

function getStateColor(stateType: WorkflowStateType): string {
  const type = getStateType(stateType);
  switch (type) {
    case 'completed': return getStatusColorVar('completed');
    case 'canceled': return getStatusColorVar('canceled');
    case 'started': return getStatusColorVar('started');
    case 'backlog': return getStatusColorVar('backlog');
    default: return getStatusColorVar('unstarted');
  }
}

interface IssueGroup {
  label: string;
  items: IssueSummary[];
}

export function MyIssuesPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const [filterStateType, setFilterStateType] = useState<WorkflowStateType | ''>('');
  const [project, setProject] = useProjectParam();
  const workFilters = useWorkFilters();

  const { data, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 500,
      filter: {
        ...(teamKey ? { team: { key: { eq: teamKey } } } : {}),
        assignee: { isMe: { eq: true } },
      },
    },
  });

  const allIssues = data?.issues.nodes ?? [];
  const projects = useMemo(
    () => projectsFromCounts(allIssues.map((issue) => ({ repository: issue.repository, count: 1 }))),
    [allIssues],
  );
  const myIssues = useMemo(() => {
    return allIssues.filter((issue) =>
      (!filterStateType || issue.state.type === filterStateType) &&
      matchesProject(issue.repository, project) &&
      matchesWorkFilters(
        {
          title: issue.title,
          description: issue.description,
          kind: issue.kind,
          priority: issue.priority,
          labelNames: issue.labels.nodes.map((label) => label.name),
          assigneeId: issue.assignee?.id ?? null,
        },
        workFilters.filters,
        null,
      ),
    );
  }, [allIssues, filterStateType, project, workFilters.filters]);

  const groups = useMemo<IssueGroup[]>(() => {
    const progress: IssueSummary[] = [];
    const todo: IssueSummary[] = [];
    const backlog: IssueSummary[] = [];
    const completed: IssueSummary[] = [];

    for (const issue of myIssues) {
      const group = classifyState(issue.state.type);
      if (group === 'progress') progress.push(issue);
      else if (group === 'completed') completed.push(issue);
      else if (group === 'backlog') backlog.push(issue);
      else todo.push(issue);
    }

    return [
      { label: 'In progress', items: progress },
      { label: 'Todo', items: todo },
      { label: 'Backlog', items: backlog },
      { label: 'Completed', items: completed },
    ];
  }, [myIssues]);

  const firstAssignee = myIssues[0]?.assignee ?? null;
  const viewerUser = firstAssignee ? { name: firstAssignee.name ?? undefined, email: firstAssignee.email ?? undefined } : null;

  return (
    <div className="observation-page">
      <PageHeader icon={<Avatar user={viewerUser} size={20} />} title="My Issues" count={myIssues.length} />
      <PageToolbar
        aria-label="My issues filters"
        projects={
          <ProjectFilterCombobox
            projects={projects}
            selectedProjectKey={project || null}
            totalCount={allIssues.length}
            onSelectProject={setProject}
            extraOptions={NO_REPOSITORY_OPTIONS}
            showQuickPills
          />
        }
        filters={
          <>
            <WorkFilterBar {...workFilters} />
            <Select
              size="sm"
              aria-label="Filter by state"
              value={filterStateType}
              onChange={(e) => setFilterStateType(e.target.value as WorkflowStateType | '')}
            >
              <option value="">All states</option>
              <option value="BACKLOG">Backlog</option>
              <option value="UNSTARTED">Unstarted</option>
              <option value="STARTED">Started</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELED">Canceled</option>
            </Select>
          </>
        }
      />

      <PageBody width="full" padding={loading || myIssues.length === 0 ? 'default' : 'none'}>
        {loading ? (
          <LoadingState>Loading issues…</LoadingState>
        ) : myIssues.length === 0 ? (
          <EmptyState title="No issues assigned to you" body="Issues assigned to your account will appear here." />
        ) : (
          groups.map((g) =>
            g.items.length === 0 ? null : (
              <div key={g.label}>
                <div className="issue-group-header">
                  <span className="issue-group-header__label">{g.label}</span>
                  <span className="issue-group-header__count">{g.items.length}</span>
                </div>
                {g.items.map((issue) => (
                  <button
                    type="button"
                    key={issue.id}
                    className="my-issues-row"
                    onClick={() => navigate(`/issue/${issue.id}`)}
                    aria-label={`Open issue ${issue.identifier}`}
                  >
                    <span className="mono my-issues-row__dim">{issue.identifier}</span>
                    <PriorityIcon level={issue.priority} size={14} />
                    <StatusIconPrimitive
                      stateType={getStateType(issue.state.type)}
                      stateColor={getStateColor(issue.state.type)}
                      size={14}
                    />
                    <span className="my-issues-row__title">{issue.title}</span>
                    <span className="my-issues-row__state">{issue.state.name}</span>
                    <span className="mono my-issues-row__dim">{formatTimeAgo(issue.updatedAt)}</span>
                  </button>
                ))}
              </div>
            ),
          )
        )}
      </PageBody>
    </div>
  );
}

