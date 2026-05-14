import { useMutation, useQuery } from '@apollo/client/react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  BOARD_PAGE_QUERY,
  PROJECTS_QUERY,
  PROJECT_CREATE_MUTATION,
  PROJECT_UPDATE_MUTATION,
  PROJECT_DELETE_MUTATION,
} from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  ProjectsQueryData,
  ProjectsQueryVariables,
  ProjectSummary,
  ProjectCreateMutationData,
  ProjectCreateMutationVariables,
  ProjectUpdateMutationData,
  ProjectUpdateMutationVariables,
  ProjectDeleteMutationData,
  ProjectDeleteMutationVariables,
  UserSummary,
} from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoChevL, IcoMore, IcoPlus, IcoProject } from '../components/Icons';
import { Avatar, Btn } from '../components/Primitives';

const STATUS_OPTIONS = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const COLOR_PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#06b6d4'];

function statusBadgeColor(status: string): string {
  switch (status) {
    case 'in_progress': return 'var(--accent)';
    case 'completed': return 'var(--success)';
    case 'paused': return 'var(--warn)';
    case 'cancelled': return 'var(--fg-dim)';
    default: return 'var(--fg-muted)';
  }
}

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formColor, setFormColor] = useState('#6366f1');
  const [formStatus, setFormStatus] = useState('planned');
  const [formLeadId, setFormLeadId] = useState('');
  const [formTargetDate, setFormTargetDate] = useState('');

  const { data: boardData } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(BOARD_PAGE_QUERY, {
    variables: { first: 1, ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}) },
  });

  const teamId = boardData?.teams.nodes.find((t) => t.key === teamKey)?.id ?? boardData?.teams.nodes[0]?.id ?? '';
  const users: UserSummary[] = boardData?.users.nodes ?? [];

  const { data, loading } = useQuery<ProjectsQueryData, ProjectsQueryVariables>(PROJECTS_QUERY, {
    skip: !teamId,
    variables: { teamId },
  });

  const [runCreate] = useMutation<ProjectCreateMutationData, ProjectCreateMutationVariables>(PROJECT_CREATE_MUTATION);
  const [runUpdate] = useMutation<ProjectUpdateMutationData, ProjectUpdateMutationVariables>(PROJECT_UPDATE_MUTATION);
  const [runDelete] = useMutation<ProjectDeleteMutationData, ProjectDeleteMutationVariables>(PROJECT_DELETE_MUTATION);

  const projects = data?.projects.nodes ?? [];
  const selectedProject = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) ?? null : null;

  function openCreateDialog() {
    setDialogMode('create');
    setFormName('');
    setFormDesc('');
    setFormColor('#6366f1');
    setFormStatus('planned');
    setFormLeadId('');
    setFormTargetDate('');
    dialogRef.current?.showModal();
  }

  function openEditDialog(project: ProjectSummary) {
    setDialogMode('edit');
    setSelectedProjectId(project.id);
    setFormName(project.name);
    setFormDesc(project.description ?? '');
    setFormColor(project.color);
    setFormStatus(project.status);
    setFormLeadId(project.lead?.id ?? '');
    setFormTargetDate(project.targetDate ? new Date(project.targetDate).toISOString().slice(0, 10) : '');
    dialogRef.current?.showModal();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;

    if (dialogMode === 'create') {
      await runCreate({
        variables: {
          input: {
            teamId,
            name: formName.trim(),
            description: formDesc || null,
            color: formColor,
            status: formStatus,
            leadId: formLeadId || null,
            targetDate: formTargetDate ? new Date(formTargetDate).toISOString() : null,
          },
        },
        refetchQueries: [{ query: PROJECTS_QUERY, variables: { teamId } }],
      });
    } else if (selectedProjectId) {
      await runUpdate({
        variables: {
          id: selectedProjectId,
          input: {
            name: formName.trim(),
            description: formDesc || null,
            color: formColor,
            status: formStatus,
            leadId: formLeadId || null,
            targetDate: formTargetDate ? new Date(formTargetDate).toISOString() : null,
          },
        },
        refetchQueries: [{ query: PROJECTS_QUERY, variables: { teamId } }],
      });
    }
    dialogRef.current?.close();
  }

  async function handleDelete(projectId: string) {
    if (!window.confirm('Delete this project? Issues will be unlinked but not deleted.')) return;
    await runDelete({
      variables: { id: projectId },
      refetchQueries: [{ query: PROJECTS_QUERY, variables: { teamId } }],
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
        <span style={{ fontSize: 13, fontWeight: 500 }}>Projects</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{projects.length}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm" onClick={openCreateDialog}>New project</Btn>
      </div>

      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12 }}>
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
            <p>Create a project to organize related issues towards a goal.</p>
            <Btn variant="subtle" icon={<IcoPlus size={12} />} size="md" onClick={openCreateDialog} style={{ marginTop: 12 }}>
              New project
            </Btn>
          </div>
        ) : (
          <div style={{ padding: '20px var(--pad-x)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedProjectId(project.id)}
                  style={{
                    border: '1px solid var(--border)', borderRadius: 'var(--r-3)',
                    background: 'var(--bg-raised)', padding: 14, cursor: 'pointer',
                    textAlign: 'left', transition: 'border-color var(--dur-1) var(--ease)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: project.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {project.name}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 10, padding: '2px 7px', borderRadius: 10,
                      background: 'var(--bg-hover)', color: statusBadgeColor(project.status),
                      border: '1px solid var(--border)', fontWeight: 500,
                    }}>
                      {statusLabel(project.status)}
                    </span>
                    {project.lead && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--fg-dim)' }}>
                        <Avatar user={{ name: project.lead.name ?? undefined }} size={14} />
                        {project.lead.name}
                      </span>
                    )}
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)', marginLeft: 'auto' }}>
                      {project.issues?.nodes.length ?? 0} issues
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <dialog ref={dialogRef} className="dialog-modal" onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form onSubmit={handleSubmit} style={{ padding: 20, minWidth: 380 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 500 }}>
            {dialogMode === 'create' ? 'New project' : 'Edit project'}
          </h3>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Name</span>
            <input
              style={{ width: '100%', height: 30, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)' }}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Project name"
              required
            />
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Description</span>
            <textarea
              style={{ width: '100%', height: 60, padding: '6px 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12.5, color: 'var(--fg)', resize: 'vertical' }}
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder="Optional description"
            />
          </label>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Color</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setFormColor(c)}
                    style={{
                      width: 20, height: 20, borderRadius: '50%', background: c, border: formColor === c ? '2px solid var(--fg)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </label>
            <label style={{ width: 130 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Status</span>
              <select
                style={{ width: '100%', height: 30, padding: '0 6px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
                value={formStatus}
                onChange={(e) => setFormStatus(e.target.value)}
              >
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Lead</span>
              <select
                style={{ width: '100%', height: 30, padding: '0 6px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
                value={formLeadId}
                onChange={(e) => setFormLeadId(e.target.value)}
              >
                <option value="">No lead</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? u.id}</option>)}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'block', marginBottom: 4 }}>Target date</span>
              <input
                type="date"
                style={{ width: '100%', height: 30, padding: '0 8px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', fontSize: 12, color: 'var(--fg)' }}
                value={formTargetDate}
                onChange={(e) => setFormTargetDate(e.target.value)}
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

function ProjectDetailView({
  project,
  onBack,
  onEdit,
  onDelete,
  navigate,
}: {
  project: ProjectSummary;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const issues = project.issues?.nodes ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <Btn variant="ghost" icon={<IcoChevL size={12} />} size="sm" onClick={onBack}>Projects</Btn>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: project.color }} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>{project.name}</span>
        <span style={{
          fontSize: 10, padding: '2px 7px', borderRadius: 10,
          background: 'var(--bg-hover)', color: statusBadgeColor(project.status),
          border: '1px solid var(--border)', fontWeight: 500,
        }}>
          {statusLabel(project.status)}
        </span>
        <div style={{ flex: 1 }} />
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
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', borderRadius: 'var(--r-1)' }}
                onClick={() => { setMenuOpen(false); onEdit(); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                Edit
              </button>
              <button
                type="button"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', borderRadius: 'var(--r-1)' }}
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
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 20, lineHeight: 1.5 }}>
            {project.description}
          </p>
        )}

        <div style={{ display: 'flex', gap: 24, marginBottom: 20, fontSize: 12, color: 'var(--fg-dim)' }}>
          {project.lead && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Avatar user={{ name: project.lead.name ?? undefined }} size={18} />
              Lead: {project.lead.name}
            </span>
          )}
          {project.targetDate && (
            <span>Target: {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(project.targetDate))}</span>
          )}
          <span>{issues.length} issues</span>
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
                  cursor: 'pointer', textAlign: 'left', color: 'var(--fg)', fontSize: 12.5,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)', width: 60 }}>{issue.identifier}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 12 }}>
            No issues linked to this project yet.
          </div>
        )}
      </div>
    </div>
  );
}
