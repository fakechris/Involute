import { useMutation, useQuery } from '@apollo/client/react';
import { useRef, useState } from 'react';
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

function statusBadgeColor(type: WorkflowStateType): string {
  switch (type) {
    case 'STARTED': return 'var(--accent)';
    case 'COMPLETED': return 'var(--success)';
    case 'REVIEW': return 'var(--warn)';
    case 'CANCELED': return 'var(--fg-dim)';
    default: return 'var(--fg-muted)';
  }
}

function ProjectProgressBar({
  issues,
}: {
  issues: Array<{ state?: { type: WorkflowStateType } | null }>;
}) {
  const total = issues.length;
  if (total === 0) return null;

  const completed = issues.filter((i) => i.state?.type === 'COMPLETED').length;
  const review = issues.filter((i) => i.state?.type === 'REVIEW').length;
  const started = issues.filter((i) => i.state?.type === 'STARTED').length;
  const unstarted = issues.filter((i) => i.state?.type === 'UNSTARTED').length;
  const backlog = issues.filter((i) => i.state?.type === 'BACKLOG').length;
  const percent = Math.round((completed / total) * 100);

  return (
    <div style={{ marginTop: 10, marginBottom: 6 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--fg-dim)',
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{percent}% complete</span>
        <span>{completed}/{total} issues</span>
      </div>
      <div
        style={{
          display: 'flex',
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          background: 'var(--bg-sunken)',
          border: '1px solid var(--border)',
          gap: 1,
        }}
        title={`Completed: ${completed} | In Review: ${review} | In Progress: ${started} | Ready: ${unstarted} | Backlog: ${backlog}`}
      >
        {completed > 0 && (
          <div style={{ width: `${(completed / total) * 100}%`, background: 'var(--success)' }} />
        )}
        {review > 0 && (
          <div style={{ width: `${(review / total) * 100}%`, background: 'var(--warn)' }} />
        )}
        {started > 0 && (
          <div style={{ width: `${(started / total) * 100}%`, background: 'var(--accent)' }} />
        )}
        {unstarted > 0 && (
          <div style={{ width: `${(unstarted / total) * 100}%`, background: 'var(--fg-muted)' }} />
        )}
        {backlog > 0 && (
          <div style={{ width: `${(backlog / total) * 100}%`, background: 'var(--border-strong)' }} />
        )}
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          fontSize: 11.5,
          color: 'var(--fg-muted)',
          marginTop: 6,
        }}
      >
        {completed > 0 && <span>🟢 {completed} Done</span>}
        {review > 0 && <span>🟡 {review} Review</span>}
        {started > 0 && <span>🔵 {started} Active</span>}
        {unstarted > 0 && <span>⚪ {unstarted} Ready</span>}
        {backlog > 0 && <span>📦 {backlog} Backlog</span>}
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStateId, setFormStateId] = useState('');
  const [formLeadId, setFormLeadId] = useState('');

  const { data: boardData } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: { first: 1, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) },
  });

  const activeTeam = boardData?.teams.nodes.find((t) => t.key === teamKey) ?? boardData?.teams.nodes[0];
  const teamId = activeTeam?.id ?? '';
  const currentTeamKey = activeTeam?.key ?? teamKey ?? null;
  const teamStates = activeTeam?.states?.nodes ?? [];
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

  function openCreateDialog() {
    setDialogMode('create');
    setFormName('');
    setFormDesc('');
    setFormStateId(teamStates[0]?.id ?? '');
    setFormLeadId('');
    dialogRef.current?.showModal();
  }

  function openEditDialog(project: ProjectIssueSummary) {
    setDialogMode('edit');
    setSelectedProjectId(project.id);
    setFormName(project.title);
    setFormDesc(project.description ?? '');
    setFormStateId(project.state?.id ?? '');
    setFormLeadId(project.assignee?.id ?? '');
    dialogRef.current?.showModal();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;

    if (dialogMode === 'create') {
      const targetStateId = formStateId || teamStates[0]?.id;
      const input: IssueCreateMutationVariables['input'] = {
        teamId,
        title: formName.trim(),
        description: formDesc || null,
        kind: 'PROJECT',
        assigneeId: formLeadId || null,
      };
      if (targetStateId) {
        input.stateId = targetStateId;
      }
      await runCreate({
        variables: { input },
        refetchQueries: [{ query: PROJECT_ISSUES_QUERY, variables: { teamKey: currentTeamKey } }],
      });
    } else if (selectedProjectId) {
      const input: IssueUpdateMutationVariables['input'] = {
        title: formName.trim(),
        description: formDesc || null,
        assigneeId: formLeadId || null,
      };
      if (formStateId) {
        input.stateId = formStateId;
      }
      await runUpdate({
        variables: {
          id: selectedProjectId,
          input,
        },
        refetchQueries: [{ query: PROJECT_ISSUES_QUERY, variables: { teamKey: currentTeamKey } }],
      });
    }
    dialogRef.current?.close();
  }

  async function handleDelete(projectId: string) {
    if (!window.confirm('Delete this project? Child tasks will be unlinked but not deleted.')) return;
    await runDelete({
      variables: { id: projectId },
      refetchQueries: [{ query: PROJECT_ISSUES_QUERY, variables: { teamKey: currentTeamKey } }],
    });
    if (selectedProjectId === projectId) setSelectedProjectId(null);
  }

  if (selectedProject) {
    return (
      <ProjectDetailView
        project={selectedProject}
        onBack={() => setSelectedProjectId(null)}
        onEdit={() => openEditDialog(selectedProject)}
        onDelete={() => handleDelete(selectedProject.id)}
        navigate={navigate}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoProject /></span>
        <span style={{ fontSize: 15, fontWeight: 500 }}>Projects</span>
        <span className="mono" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>{projects.length}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateDialog}>New project</Btn>
      </div>

      <div className="page-content">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load projects</h3>
            <p>{error.message}</p>
            <Btn variant="subtle" size="sm" onClick={() => void refetch()} style={{ marginTop: 12 }}>
              Retry
            </Btn>
          </div>
        ) : loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 14 }}>
            Loading projects…
          </div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              border: '1px solid var(--border)', background: 'var(--bg-raised)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
            }}>
              <IcoProject size={22} style={{ color: 'var(--fg-faint)' }} />
            </div>
            <h3>No projects yet</h3>
            <p>Create a project work node (kind: PROJECT) to organize related tasks towards a goal.</p>
            <Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateDialog} style={{ marginTop: 12 }}>
              New project
            </Btn>
          </div>
        ) : (
          <div style={{ padding: '20px var(--pad-x)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
              {projects.map((project) => {
                const childIssues = project.children?.nodes ?? [];
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => setSelectedProjectId(project.id)}
                    style={{
                      border: '1px solid var(--border)', borderRadius: 'var(--r-3)',
                      background: 'var(--bg-raised)', padding: 16, cursor: 'pointer',
                      textAlign: 'left', transition: 'border-color var(--dur-1) var(--ease)',
                      display: 'flex', flexDirection: 'column', gap: 8,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
                        {project.identifier}
                      </span>
                      <span style={{ fontSize: 15, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {project.title}
                      </span>
                      {project.repository && (
                        <span
                          className="issue-card__repo-badge"
                          title={`Repository: ${project.repository}`}
                        >
                          {project.repository.includes('/') ? project.repository.split('/')[1] : project.repository}
                        </span>
                      )}
                    </div>

                    <ProjectProgressBar issues={childIssues} />

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
                      <span style={{
                        fontSize: 12, padding: '2px 7px', borderRadius: 10,
                        background: 'var(--bg-hover)', color: statusBadgeColor(project.state.type),
                        border: '1px solid var(--border)', fontWeight: 500,
                      }}>
                        {project.state.name}
                      </span>
                      {project.assignee && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--fg-dim)' }}>
                          <Avatar user={{ name: project.assignee.name ?? undefined }} size={14} />
                          {project.assignee.name}
                        </span>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Link
                          to={`/?project=${encodeURIComponent(project.repository || project.title)}`}
                          className="btn btn--subtle"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 12,
                            padding: '2px 8px',
                            borderRadius: 'var(--r-1)',
                            textDecoration: 'none',
                            color: 'var(--accent)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg)',
                          }}
                          onClick={(e) => e.stopPropagation()}
                          title={`Open ${project.title} on board`}
                        >
                          Board →
                        </Link>
                        <Link
                          to={`/graph?project=${encodeURIComponent(project.repository || project.title)}`}
                          className="btn btn--subtle"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 12,
                            padding: '2px 8px',
                            borderRadius: 'var(--r-1)',
                            textDecoration: 'none',
                            color: 'var(--fg-muted)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg)',
                          }}
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
          </div>
        )}
      </div>

      <dialog ref={dialogRef} className="dialog-modal" onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form onSubmit={handleSubmit} style={{ padding: 20, minWidth: 380 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 500 }}>
            {dialogMode === 'create' ? 'New project' : 'Edit project'}
          </h3>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 14, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Name</span>
            <input
              style={{ width: '100%', height: 30, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 14.5, color: 'var(--fg)' }}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Project name"
              required
            />
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 14, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Description</span>
            <textarea
              style={{ width: '100%', height: 60, padding: '6px 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 14.5, color: 'var(--fg)', resize: 'vertical' }}
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder="Optional description"
            />
          </label>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 14, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Status</span>
              <select
                style={{ width: '100%', height: 30, padding: '0 6px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 14, color: 'var(--fg)' }}
                value={formStateId}
                onChange={(e) => setFormStateId(e.target.value)}
              >
                {teamStates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 14, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Lead</span>
              <select
                style={{ width: '100%', height: 30, padding: '0 6px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 14, color: 'var(--fg)' }}
                value={formLeadId}
                onChange={(e) => setFormLeadId(e.target.value)}
              >
                <option value="">No lead</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? u.id}</option>)}
              </select>
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

function ProjectDetailView({
  project,
  onBack,
  onEdit,
  onDelete,
  navigate,
}: {
  project: ProjectIssueSummary;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const issues = project.children?.nodes ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <Btn variant="ghost" icon={<IcoChevL size={12} />} size="sm" onClick={onBack}>Projects</Btn>
        <span className="mono" style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>{project.identifier}</span>
        <span style={{ fontSize: 15, fontWeight: 500 }}>{project.title}</span>
        <span style={{
          fontSize: 12, padding: '2px 7px', borderRadius: 10,
          background: 'var(--bg-hover)', color: statusBadgeColor(project.state.type),
          border: '1px solid var(--border)', fontWeight: 500,
        }}>
          {project.state.name}
        </span>
        <div style={{ flex: 1 }} />
        <Btn
          variant="subtle"
          size="sm"
          onClick={() => navigate(`/?project=${encodeURIComponent(project.repository || project.title)}`)}
          style={{ marginRight: 8 }}
        >
          Open on Board →
        </Btn>
        <Btn
          variant="subtle"
          size="sm"
          onClick={() => navigate(`/graph?project=${encodeURIComponent(project.repository || project.title)}`)}
          style={{ marginRight: 8 }}
        >
          Graph →
        </Btn>
        <Btn variant="subtle" size="sm" onClick={() => navigate(`/work/${project.id}`)} style={{ marginRight: 8 }}>
          Work context
        </Btn>
        <div style={{ position: 'relative' }}>
          <Btn variant="ghost" icon={<IcoMore size={14} />} size="sm" onClick={() => setMenuOpen(!menuOpen)} />
          {menuOpen && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 4,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-2)', padding: 4, minWidth: 120, zIndex: 10,
            }}>
              <button
                type="button"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', borderRadius: 'var(--r-1)' }}
                onClick={() => { setMenuOpen(false); onEdit(); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                Edit
              </button>
              <button
                type="button"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', borderRadius: 'var(--r-1)' }}
                onClick={() => { setMenuOpen(false); onDelete(); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="page-content" style={{ padding: '20px var(--pad-x)' }}>
        {project.description && (
          <p style={{ fontSize: 15, color: 'var(--fg-muted)', marginBottom: 16, lineHeight: 1.5 }}>
            {project.description}
          </p>
        )}

        <div style={{ display: 'flex', gap: 24, marginBottom: 16, fontSize: 14, color: 'var(--fg-dim)' }}>
          {project.assignee && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Avatar user={{ name: project.assignee.name ?? undefined }} size={18} />
              Lead: {project.assignee.name}
            </span>
          )}
          <span>{issues.length} child issues (CONTAINS)</span>
        </div>

        <div style={{ marginBottom: 20 }}>
          <ProjectProgressBar issues={issues} />
        </div>

        {issues.length > 0 ? (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-3)', overflow: 'hidden' }}>
            {issues.map((issue, i) => (
              <button
                key={issue.id}
                type="button"
                onClick={() => navigate(`/issue/${issue.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '10px 12px', background: 'none', border: 'none',
                  borderBottom: i < issues.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                  cursor: 'pointer', textAlign: 'left', color: 'var(--fg)', fontSize: 14.5,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-dim)', width: 60 }}>{issue.identifier}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
                {issue.state && (
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '2px 6px', background: 'var(--bg-hover)', borderRadius: 4 }}>
                    {issue.state.name}
                  </span>
                )}
                {issue.assignee && (
                  <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Avatar user={{ name: issue.assignee.name ?? undefined }} size={14} />
                    {issue.assignee.name}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 14 }}>
            No child issues linked via CONTAINS yet. Link tasks from their issue page or via MCP work_link.
          </div>
        )}
      </div>
    </div>
  );
}
