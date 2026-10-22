import { ResolutionSelect, type WorkResolution } from '../components/CloseReasonDialog';
import { useMutation, useQuery } from '@apollo/client/react';
import { MarkdownRenderer } from '../components/MarkdownRenderer';

import { ProjectSharing } from '../components/ProjectSharing';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  BOARD_PAGE_QUERY,
  PROJECT_ISSUES_QUERY,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUE_DELETE_MUTATION,
} from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  ProjectIssuesQueryData,
  ProjectIssuesQueryVariables,
  ProjectIssueSummary,
  IssueCreateMutationData,
  IssueCreateMutationVariables,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
  IssueDeleteMutationData,
  IssueDeleteMutationVariables,
  UserSummary,
  WorkflowStateType,
} from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoChevL, IcoMore, IcoPlus, IcoProject } from '../components/Icons';
import { Avatar, Btn } from '../components/Primitives';
import { DialogShell } from '../components/DialogShell';
import { Checkbox, Field, Select, TextArea, TextInput } from '../components/controls';
import { PageBody, PageHeader } from '../components/layout';
import { EmptyState, LoadingState } from '../components/status';

/** The project's workflow state as a pill, tinted by state type. */
function ProjectStateBadge({ project }: { project: { state: { name: string; type: WorkflowStateType } } }) {
  return (
    <span className={`projects-state projects-state--${project.state.type.toLowerCase()}`}>
      {project.state.name}
    </span>
  );
}

const PROGRESS_SEGMENTS: ReadonlyArray<{ type: WorkflowStateType; label: string }> = [
  { type: 'COMPLETED', label: 'Done' },
  { type: 'REVIEW', label: 'Review' },
  { type: 'STARTED', label: 'Active' },
  { type: 'UNSTARTED', label: 'Ready' },
  { type: 'BACKLOG', label: 'Backlog' },
];

function ProjectProgressBar({
  issues,
}: {
  issues: Array<{ state?: { type: WorkflowStateType } | null }>;
}) {
  const total = issues.length;
  if (total === 0) return null;

  const segments = PROGRESS_SEGMENTS
    .map((segment) => ({ ...segment, count: issues.filter((i) => i.state?.type === segment.type).length }))
    .filter((segment) => segment.count > 0);
  const completed = issues.filter((i) => i.state?.type === 'COMPLETED').length;
  const percent = Math.round((completed / total) * 100);
  const countOf = (type: WorkflowStateType) => issues.filter((i) => i.state?.type === type).length;

  return (
    <div className="projects-progress">
      <div className="projects-progress__summary">
        <span className="projects-progress__percent">{percent}% complete</span>
        <span>{completed}/{total} issues</span>
      </div>
      <div
        className="projects-progress__bar"
        title={`Completed: ${countOf('COMPLETED')} | In Review: ${countOf('REVIEW')} | In Progress: ${countOf('STARTED')} | Ready: ${countOf('UNSTARTED')} | Backlog: ${countOf('BACKLOG')}`}
      >
        {segments.map((segment) => (
          <div
            key={segment.type}
            className={`projects-progress__segment projects-state--${segment.type.toLowerCase()}`}
            style={{ width: `${(segment.count / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="projects-progress__legend">
        {segments.map((segment) => (
          <span key={segment.type} className="projects-progress__key">
            <span className={`projects-progress__dot projects-state--${segment.type.toLowerCase()}`} aria-hidden="true" />
            {segment.count} {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALIAS_PATTERN = /^[A-Z]{2,10}$/;

export function ProjectsPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStateId, setFormStateId] = useState('');
  // Canceling a project says why (INV-1118).
  const [formResolution, setFormResolution] = useState<WorkResolution | ''>('');
  const [formLeadId, setFormLeadId] = useState('');
  // GitHub routing (INV-793): which repository the project owns, and the
  // extra reference prefix its PRs may use (LUM-398 for lumenbox).
  const [formRepository, setFormRepository] = useState('');
  const [formAlias, setFormAlias] = useState('');
  const [formCascade, setFormCascade] = useState(true);
  const [formAutoAccept, setFormAutoAccept] = useState(false);
  // Where the project's web app runs (INV-1146): the bug-capture extension
  // files a page's bug under the project that owns its origin.
  const [formWebOrigins, setFormWebOrigins] = useState('');
  const [editingOriginal, setEditingOriginal] = useState<{ repository: string; alias: string; autoAcceptBugs: boolean; webOrigins: string[] } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: boardData } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: { first: 1, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) },
  });

  const activeTeam = boardData?.teams.nodes.find((t) => t.key === teamKey) ?? boardData?.teams.nodes[0];
  const teamId = activeTeam?.id ?? '';
  const currentTeamKey = activeTeam?.key ?? teamKey ?? null;
  const teamStates = activeTeam?.states?.nodes ?? [];
  // Creating a project is a write on the team; the server decides who may.
  const canCreate = activeTeam?.viewerCanWrite ?? false;
  const users: UserSummary[] = boardData?.users.nodes ?? [];

  const { data, loading, error, refetch } = useQuery<ProjectIssuesQueryData, ProjectIssuesQueryVariables>(PROJECT_ISSUES_QUERY, {
    skip: !currentTeamKey,
    variables: { teamKey: currentTeamKey },
    fetchPolicy: 'cache-and-network',
  });

  const [runCreate] = useMutation<IssueCreateMutationData, IssueCreateMutationVariables>(ISSUE_CREATE_MUTATION);
  const [runUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(ISSUE_UPDATE_MUTATION);
  const [runDelete] = useMutation<IssueDeleteMutationData, IssueDeleteMutationVariables>(ISSUE_DELETE_MUTATION);

  const projects = data?.issues.nodes ?? [];
  const selectedProject = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) ?? null : null;
  const cancelingProject = dialogMode === 'edit'
    && teamStates.find((state) => state.id === formStateId)?.type === 'CANCELED'
    && selectedProject?.state?.id !== formStateId;

  function openCreateDialog() {
    setDialogMode('create');
    setFormName('');
    setFormDesc('');
    setFormStateId(teamStates[0]?.id ?? '');
    setFormLeadId('');
    setFormRepository('');
    setFormAlias('');
    setFormCascade(true);
    setFormAutoAccept(false);
    setFormWebOrigins('');
    setEditingOriginal(null);
    setFormError(null);
    setIsDialogOpen(true);
  }

  function openEditDialog(project: ProjectIssueSummary) {
    setDialogMode('edit');
    setSelectedProjectId(project.id);
    setFormName(project.title);
    setFormDesc(project.description ?? '');
    setFormStateId(project.state?.id ?? '');
    setFormResolution('');
    setFormLeadId(project.assignee?.id ?? '');
    setFormRepository(project.repository ?? '');
    setFormAlias(project.alias ?? '');
    setFormCascade(true);
    setFormAutoAccept(project.autoAcceptBugs ?? false);
    setFormWebOrigins((project.webOrigins ?? []).join('\n'));
    setEditingOriginal({ repository: project.repository ?? '', alias: project.alias ?? '', autoAcceptBugs: project.autoAcceptBugs ?? false, webOrigins: project.webOrigins ?? [] });
    setFormError(null);
    setIsDialogOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    const repository = formRepository.trim();
    const alias = formAlias.trim().toUpperCase();
    // Comma or line separated; the server normalizes and checks each one.
    const webOrigins = formWebOrigins.split(/[\s,]+/).map((origin) => origin.trim()).filter(Boolean);
    if (repository && !REPOSITORY_PATTERN.test(repository)) {
      setFormError('Repository is owner/name, such as fakechris/lumenbox.');
      return;
    }
    if (alias && !ALIAS_PATTERN.test(alias)) {
      setFormError('Alias is 2 to 10 letters, such as LUM.');
      return;
    }
    setFormError(null);
    setSaving(true);
    const refetchQueries = [{ query: PROJECT_ISSUES_QUERY, variables: { teamKey: currentTeamKey } }];

    try {
      let projectId = selectedProjectId;
      if (dialogMode === 'create') {
        const targetStateId = formStateId || teamStates[0]?.id;
        const input: IssueCreateMutationVariables['input'] = {
          teamId,
          title: formName.trim(),
          description: formDesc || null,
          kind: 'PROJECT',
          assigneeId: formLeadId || null,
          ...(repository ? { repository } : {}),
        };
        if (targetStateId) {
          input.stateId = targetStateId;
        }
        const created = await runCreate({ variables: { input }, refetchQueries });
        const payload = created.data?.issueCreate;
        if (!payload?.success || !payload.issue) {
          setFormError(payload?.message ?? 'The project was not created.');
          return;
        }
        projectId = payload.issue.id;
        // issueCreate has no alias or web origins; set them on the new project.
        if (alias || webOrigins.length > 0) {
          const aliased = await runUpdate({
            variables: { id: projectId, input: { ...(alias ? { alias } : {}), ...(webOrigins.length > 0 ? { webOrigins } : {}) } },
            refetchQueries,
          });
          if (!aliased.data?.issueUpdate.success) {
            setFormError(`The project was created, but its ${alias ? 'alias was' : 'web origins were'} not saved: ${aliased.data?.issueUpdate.message ?? 'refused.'}`);
            setDialogMode('edit');
            setSelectedProjectId(projectId);
            setEditingOriginal({ repository, alias: '', autoAcceptBugs: false, webOrigins: [] });
            return;
          }
        }
      } else if (projectId) {
        const input: IssueUpdateMutationVariables['input'] = {
          title: formName.trim(),
          description: formDesc || null,
          assigneeId: formLeadId || null,
        };
        if (formStateId) {
          input.stateId = formStateId;
        }
        if (cancelingProject && formResolution) {
          input.resolution = formResolution;
        }
        if (repository !== (editingOriginal?.repository ?? '')) {
          input.repository = repository || null;
          input.cascadeRepository = formCascade;
        }
        if (alias !== (editingOriginal?.alias ?? '')) {
          input.alias = alias || null;
        }
        if (formAutoAccept !== (editingOriginal?.autoAcceptBugs ?? false)) {
          input.autoAcceptBugs = formAutoAccept;
        }
        if (webOrigins.join('\n') !== (editingOriginal?.webOrigins ?? []).join('\n')) {
          input.webOrigins = webOrigins;
        }
        const updated = await runUpdate({ variables: { id: projectId, input }, refetchQueries });
        if (!updated.data?.issueUpdate.success) {
          setFormError(updated.data?.issueUpdate.message ?? 'The project was not saved.');
          return;
        }
      }
      setIsDialogOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The project was not saved.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(projectId: string) {
    if (!window.confirm('Delete this project? Child tasks will be unlinked but not deleted.')) return;
    await runDelete({
      variables: { id: projectId },
      refetchQueries: [{ query: PROJECT_ISSUES_QUERY, variables: { teamKey: currentTeamKey } }],
    });
    if (selectedProjectId === projectId) setSelectedProjectId(null);
  }

  // Rendered in both views: Edit lives in the detail view's menu (INV-793).
  const projectDialog = (
    isDialogOpen ? (
      <DialogShell
        variant="modal"
        title={dialogMode === 'create' ? 'New project' : 'Edit project'}
        onClose={() => setIsDialogOpen(false)}
        onSubmit={handleSubmit}
        footer={(
          <>
            <Btn variant="subtle" size="md" onClick={() => setIsDialogOpen(false)}>Cancel</Btn>
            <Btn type="submit" variant="accent" size="md" disabled={saving}>
              {dialogMode === 'create' ? 'Create' : 'Save'}
            </Btn>
          </>
        )}
      >
        <Field label="Name">
          <TextInput
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Project name"
            required
          />
        </Field>
        <Field label="Description">
          <TextArea
            size="sm"
            value={formDesc}
            onChange={(e) => setFormDesc(e.target.value)}
            placeholder="Optional description"
          />
        </Field>
        <div className="field-grid">
          <Field label="GitHub repository">
            <TextInput
              aria-label="GitHub repository"
              value={formRepository}
              onChange={(e) => setFormRepository(e.target.value)}
              placeholder="owner/name"
            />
          </Field>
          <Field label="Reference alias">
            <TextInput
              aria-label="Reference alias"
              value={formAlias}
              onChange={(e) => setFormAlias(e.target.value)}
              placeholder="e.g. LUM"
            />
          </Field>
        </div>
        <p className="field__hint">
          PRs and branches in this repository are routed to this project. With an alias, they may reference work as{' '}
          <span className="mono">{(formAlias.trim() || 'ALIAS').toUpperCase()}-123</span> as well as by the team key.
        </p>
        <Field
          label="Web origins"
          hint="Where this project's web app runs, one per line or comma separated. Bugs reported from these pages with the capture extension go to this project."
        >
          <TextArea
            aria-label="Web origins"
            size="sm"
            className="mono"
            value={formWebOrigins}
            onChange={(e) => setFormWebOrigins(e.target.value)}
            placeholder="https://app.example.com, http://localhost:5173"
          />
        </Field>
        {dialogMode === 'edit' ? (
          <Checkbox
            aria-label="Auto-accept verified bug fixes"
            checked={formAutoAccept}
            // Turning it on needs a repository; turning it off never does.
            disabled={!formRepository.trim() && !formAutoAccept}
            onChange={(e) => setFormAutoAccept(e.target.checked)}
            label={(
              <>
                Auto-accept verified bug fixes
                <br />
                <span className="field__hint">
                  A bug in Review moves to Done when GitHub shows its fix merged (or on the default branch) with CI checks green. Anything else waits for you, with the reason on /in-review. You can move an auto-accepted bug back to Review.
                </span>
              </>
            )}
          />
        ) : null}
        {dialogMode === 'edit' && editingOriginal?.repository && formRepository.trim() !== editingOriginal.repository ? (
          <Checkbox
            checked={formCascade}
            onChange={(e) => setFormCascade(e.target.checked)}
            label={<>Move the project&apos;s work from {editingOriginal.repository} to the new repository too</>}
          />
        ) : null}
        <div className="field-grid">
          <Field label="Status">
            <Select
              value={formStateId}
              onChange={(e) => setFormStateId(e.target.value)}
            >
              {teamStates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          {cancelingProject ? (
            <Field label="Resolution">
              <ResolutionSelect ariaLabel="Project resolution" value={formResolution} onChange={setFormResolution} />
            </Field>
          ) : null}
          <Field label="Lead">
            <Select
              value={formLeadId}
              onChange={(e) => setFormLeadId(e.target.value)}
            >
              <option value="">No lead</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? u.id}</option>)}
            </Select>
          </Field>
        </div>
        {formError ? (
          <p role="alert" className="dialog-shell__error">{formError}</p>
        ) : null}
      </DialogShell>
    ) : null
  );

  if (selectedProject) {
    return (
      <>
        <ProjectDetailView
          project={selectedProject}
          onBack={() => setSelectedProjectId(null)}
          onEdit={() => openEditDialog(selectedProject)}
          onDelete={() => handleDelete(selectedProject.id)}
          navigate={navigate}
          teamKey={currentTeamKey}
        />
        {projectDialog}
      </>
    );
  }

  return (
    <div className="observation-page">
      <PageHeader
        icon={<IcoProject />}
        title="Projects"
        count={projects.length}
        actions={canCreate ? <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateDialog}>New project</Btn> : null}
      />

      <PageBody width="wide">
        {error ? (
          <div role="alert">
            <EmptyState
              title="Could not load projects"
              body={error.message}
              action={<Btn variant="subtle" size="sm" onClick={() => void refetch()}>Retry</Btn>}
            />
          </div>
        ) : loading ? (
          <LoadingState>Loading projects…</LoadingState>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<IcoProject size={20} />}
            title="No projects yet"
            body={canCreate
              ? 'Create a project work node (kind: PROJECT) to organize related tasks towards a goal.'
              : 'You have no access to a team’s projects yet. Ask a team owner to add you, or to share a project with you.'}
            action={canCreate ? (
              <Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateDialog}>
                New project
              </Btn>
            ) : null}
          />
        ) : (
          <div className="projects-grid">
            {projects.map((project) => {
              const childIssues = project.children?.nodes ?? [];
              return (
                <button
                  key={project.id}
                  type="button"
                  className="projects-card"
                  onClick={() => setSelectedProjectId(project.id)}
                >
                  <div className="projects-card__head">
                    <span className="mono projects-identifier">{project.identifier}</span>
                    <span className="projects-card__title">{project.title}</span>
                    {project.repository && (
                      <span
                        className="issue-card__repo-badge"
                        title={`Repository: ${project.repository}`}
                      >
                        {project.repository.includes('/') ? project.repository.split('/')[1] : project.repository}
                      </span>
                    )}
                    {project.alias && (
                      <span className="mono projects-card__alias" title={`PRs may reference this project's work as ${project.alias}-123`}>
                        {project.alias}
                      </span>
                    )}
                  </div>

                  <ProjectProgressBar issues={childIssues} />

                  <div className="projects-card__foot">
                    <ProjectStateBadge project={project} />
                    {project.assignee && (
                      <span className="projects-person projects-person--sm">
                        <Avatar user={{ name: project.assignee.name ?? undefined }} size={14} />
                        {project.assignee.name}
                      </span>
                    )}
                    <div className="projects-card__links">
                      <Link
                        to={`/?project=${encodeURIComponent(project.repository || project.title)}`}
                        className="ui-action ui-action--subtle ui-action--sm"
                        onClick={(e) => e.stopPropagation()}
                        title={`Open ${project.title} on board`}
                      >
                        Board →
                      </Link>
                      <Link
                        to={`/graph?project=${encodeURIComponent(project.repository || project.title)}`}
                        className="ui-action ui-action--subtle ui-action--sm"
                        onClick={(e) => e.stopPropagation()}
                        title={`Open ${project.title} on graph`}
                      >
                        Graph →
                      </Link>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </PageBody>

      {projectDialog}
    </div>
  );
}

function ProjectDetailView({
  project,
  onBack,
  onEdit,
  onDelete,
  navigate,
  teamKey,
}: {
  project: ProjectIssueSummary;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  navigate: ReturnType<typeof useNavigate>;
  teamKey: string | null;
}) {
  // What a share holder opens: the board, scoped to this team and project.
  const shareParams = new URLSearchParams({
    ...(teamKey ? { team: teamKey } : {}),
    project: project.repository || project.identifier,
  });
  const shareUrl = `${window.location.origin}/?${shareParams.toString()}`;
  const [menuOpen, setMenuOpen] = useState(false);
  const issues = project.children?.nodes ?? [];

  return (
    <div className="observation-page">
      <PageHeader
        back={<Btn variant="ghost" icon={<IcoChevL size={12} />} size="sm" onClick={onBack}>Projects</Btn>}
        title={(
          <>
            <span className="mono projects-identifier">{project.identifier}</span> {project.title}
          </>
        )}
        hint={<ProjectStateBadge project={project} />}
        actions={(
          <>
            <Btn variant="subtle" size="sm" onClick={() => navigate(`/?project=${encodeURIComponent(project.repository || project.title)}`)}>
              Open on Board →
            </Btn>
            <Btn variant="subtle" size="sm" onClick={() => navigate(`/graph?project=${encodeURIComponent(project.repository || project.title)}`)}>
              Graph →
            </Btn>
            <Btn variant="subtle" size="sm" onClick={() => navigate(`/work/${project.id}`)}>
              Work context
            </Btn>
            <div className="projects-menu">
              <Btn variant="ghost" icon={<IcoMore size={14} />} size="sm" title="Project actions" onClick={() => setMenuOpen(!menuOpen)} />
              {menuOpen && (
                <div className="projects-menu__popover">
                  <button type="button" className="projects-menu__item" onClick={() => { setMenuOpen(false); onEdit(); }}>
                    Edit
                  </button>
                  <button type="button" className="projects-menu__item projects-menu__item--danger" onClick={() => { setMenuOpen(false); onDelete(); }}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      />

      <PageBody width="wide">
        {project.description && (
          <MarkdownRenderer content={project.description} size="sm" className="projects-detail__description" />
        )}

        <div className="projects-detail__facts">
          {project.assignee && (
            <span className="projects-person">
              <Avatar user={{ name: project.assignee.name ?? undefined }} size={18} />
              Lead: {project.assignee.name}
            </span>
          )}
          {project.repository && <span>Repository: {project.repository}</span>}
          {project.alias && <span>Alias: <span className="mono">{project.alias}</span></span>}
          <span>{issues.length} child issues (CONTAINS)</span>
        </div>

        <ProjectProgressBar issues={issues} />

        <ProjectSharing projectId={project.id} shareUrl={shareUrl} />

        {issues.length > 0 ? (
          <div className="projects-issues">
            {issues.map((issue) => (
              <button
                key={issue.id}
                type="button"
                className="projects-issues__row"
                onClick={() => navigate(`/issue/${issue.id}`)}
              >
                <span className="mono projects-issues__id">{issue.identifier}</span>
                <span className="projects-issues__title">{issue.title}</span>
                {issue.state && <span className="projects-issues__state">{issue.state.name}</span>}
                {issue.assignee && (
                  <span className="projects-person projects-person--sm">
                    <Avatar user={{ name: issue.assignee.name ?? undefined }} size={14} />
                    {issue.assignee.name}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            size="inline"
            title="No child issues linked via CONTAINS yet. Link tasks from their issue page or via MCP work_link."
          />
        )}
      </PageBody>
    </div>
  );
}
