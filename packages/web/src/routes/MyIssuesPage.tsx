import { useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables, IssueSummary, WorkflowStateType } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { Select } from '../components/controls';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { IssueRow } from '../components/list';
import { Avatar } from '../components/Primitives';
import { ProjectFilterCombobox } from '../components/ProjectFilterCombobox';
import { EmptyState, LoadingState, QueryErrorState } from '../components/status';
import { useWorkFilters, WorkFilterBar } from '../components/WorkFilterBar';
import { STATE_TYPE_LABEL } from '../components/graph/graph-colors';
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

// Groups follow the workflow states by type, in the order work moves (INV-2120):
// In Review is its own group, and Canceled is not counted as Done.
const GROUP_ORDER: WorkflowStateType[] = ['STARTED', 'REVIEW', 'UNSTARTED', 'BACKLOG', 'COMPLETED', 'CANCELED'];

interface IssueGroup {
  label: string;
  items: IssueSummary[];
}

export function MyIssuesPage() {
  const teamKey = readStoredTeamKey();
  const [filterStateType, setFilterStateType] = useState<WorkflowStateType | ''>('');
  const [project, setProject] = useProjectParam();
  const workFilters = useWorkFilters();

  const { data, loading, error, refetch } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: {
      first: 500,
      // This page searches the bodies, so it asks for them (INV-1470); the
      // board does not, and leaves them out of its list.
      withDescriptions: true,
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

  const groups = useMemo<IssueGroup[]>(
    () => GROUP_ORDER.map((type) => ({ label: STATE_TYPE_LABEL[type], items: myIssues.filter((issue) => issue.state.type === type) })),
    [myIssues],
  );

  const firstAssignee = myIssues[0]?.assignee ?? null;
  const viewerUser = firstAssignee ? { name: firstAssignee.name ?? undefined, email: firstAssignee.email ?? undefined } : null;

  return (
    <div className="observation-page">
      <PageHeader icon={<Avatar user={viewerUser} size={20} />} title="My Issues" count={loading || error ? undefined : myIssues.length} />
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
              {GROUP_ORDER.map((type) => (
                <option key={type} value={type}>{STATE_TYPE_LABEL[type]}</option>
              ))}
            </Select>
          </>
        }
      />

      <PageBody width="full" padding={loading || error || myIssues.length === 0 ? 'default' : 'none'}>
        {loading ? (
          <LoadingState>Loading issues…</LoadingState>
        ) : error ? (
          <QueryErrorState title="Could not load your issues" onRetry={refetch} />
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
                <ul className="list-rows list-rows--divided" aria-label={g.label}>
                  {g.items.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      variant="divided"
                      open="drawer"
                      openLabel={`Open issue ${issue.identifier}`}
                      showState
                      age={formatTimeAgo(issue.updatedAt)}
                    />
                  ))}
                </ul>
              </div>
            ),
          )
        )}
      </PageBody>
    </div>
  );
}
