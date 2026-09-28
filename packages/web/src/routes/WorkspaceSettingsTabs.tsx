import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';

import { readStoredTeamKey } from '../board/utils';
import {
  EMAIL_NOTIFICATIONS_QUERY,
  LABEL_CREATE_MUTATION,
  LABEL_DELETE_MUTATION,
  LABEL_UPDATE_MUTATION,
  NOTIFICATION_PREFERENCES_UPDATE_MUTATION,
  SERVER_FEATURES_QUERY,
  SERVICE_ACTOR_CREATE_MUTATION,
  SETTINGS_LABELS_QUERY,
  SETTINGS_PEOPLE_QUERY,
  SETTINGS_STATES_QUERY,
  USER_SET_GLOBAL_ROLE_MUTATION,
  WORKFLOW_STATE_CREATE_MUTATION,
  WORKFLOW_STATE_DELETE_MUTATION,
  WORKFLOW_STATE_UPDATE_MUTATION,
  type Refusable,
  type ServerFeature,
  type SettingsLabel,
  type SettingsState,
  type SettingsUser,
  type WorkflowStateType,
} from './settings-queries';

// Workspace settings a person used to change with SQL, env edits or the CLI
// (INV-797). The server refuses non-admins; these tabs are shown to admins.

export type Notice = { ok: boolean; text: string } | null;

export function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role={notice.ok ? 'status' : 'alert'} style={{ fontSize: 14, color: notice.ok ? 'var(--fg-muted)' : 'var(--danger, #d14343)' }}>
      {notice.text}
    </p>
  );
}

export const inputStyle: React.CSSProperties = {
  height: 28, padding: '0 8px', fontSize: 14, color: 'var(--fg)',
  background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)',
};

export const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-subtle)',
};

/** Runs a settings mutation and turns its payload into a notice: the server's reason when refused. */
export async function attempt<T>(
  run: () => Promise<{ data?: T | null }>,
  pick: (data: NonNullable<T>) => Refusable<object> | undefined,
  done: string,
  setNotice: (notice: Notice) => void,
): Promise<boolean> {
  try {
    const result = await run();
    const payload = result.data ? pick(result.data as NonNullable<T>) : undefined;
    if (!payload?.success) {
      setNotice({ ok: false, text: payload?.message ?? 'The change was not saved.' });
      return false;
    }
    setNotice({ ok: true, text: done });
    return true;
  } catch (error) {
    setNotice({ ok: false, text: error instanceof Error ? error.message : 'The change was not saved.' });
    return false;
  }
}

// --- Labels ---------------------------------------------------------------

const BUILT_IN_LABELS = new Set(['bug', 'feature', 'improvement', 'research']);

export function LabelsTab() {
  const { data, loading, error, refetch } = useQuery<{ issueLabels: { nodes: SettingsLabel[] } }>(SETTINGS_LABELS_QUERY);
  const [runCreate] = useMutation<{ labelCreate: Refusable<{ label: SettingsLabel | null }> }, { name: string }>(LABEL_CREATE_MUTATION);
  const [runUpdate] = useMutation<{ labelUpdate: Refusable<{ label: SettingsLabel | null }> }, { id: string; name: string }>(LABEL_UPDATE_MUTATION);
  const [runDelete] = useMutation<{ labelDelete: Refusable<{ labelId: string | null }> }, { id: string }>(LABEL_DELETE_MUTATION);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  if (error) return <p role="alert">Could not load labels: {error.message}</p>;
  if (loading && !data) return <p role="status">Loading…</p>;
  const labels = [...(data?.issueLabels.nodes ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section aria-label="Labels">
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 4px' }}>Labels</h2>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
        Labels are shared by every team. Bug, Feature, Improvement and research are built in and cannot be renamed or deleted.
      </p>
      <form
        style={{ display: 'flex', gap: 8, marginBottom: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          void attempt(() => runCreate({ variables: { name: newName } }), (d) => d.labelCreate, `Created ${newName.trim()}.`, setNotice)
            .then((ok) => { if (ok) { setNewName(''); void refetch(); } });
        }}
      >
        <input aria-label="New label name" placeholder="New label" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} />
        <button type="submit" className="ui-action ui-action--subtle" disabled={!newName.trim()}>Add label</button>
      </form>
      <NoticeLine notice={notice} />
      <div role="list" aria-label="Label list">
        {labels.map((label) => {
          const builtIn = BUILT_IN_LABELS.has(label.name.toLowerCase());
          const isEditing = editing?.id === label.id;
          return (
            <div key={label.id} role="listitem" style={rowStyle}>
              {isEditing ? (
                <input
                  aria-label={`Rename ${label.name}`}
                  value={editing.name}
                  onChange={(e) => setEditing({ id: label.id, name: e.target.value })}
                  style={{ ...inputStyle, flex: 1 }}
                />
              ) : (
                <span style={{ flex: 1, fontSize: 14.5 }}>{label.name}</span>
              )}
              <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>{label.issueCount} items</span>
              {builtIn ? (
                <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>built in</span>
              ) : isEditing ? (
                <>
                  <button
                    type="button"
                    className="ui-action ui-action--subtle"
                    onClick={() => void attempt(() => runUpdate({ variables: { id: label.id, name: editing.name } }), (d) => d.labelUpdate, 'Label renamed.', setNotice)
                      .then((ok) => { if (ok) { setEditing(null); void refetch(); } })}
                  >Save</button>
                  <button type="button" className="ui-action ui-action--subtle" onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="ui-action ui-action--subtle" onClick={() => setEditing({ id: label.id, name: label.name })}>Rename</button>
                  <button
                    type="button"
                    className="ui-action ui-action--subtle"
                    aria-label={`Delete label ${label.name}`}
                    onClick={() => {
                      const warning = label.issueCount > 0 ? ` It will be removed from ${label.issueCount} items.` : '';
                      if (!window.confirm(`Delete the label "${label.name}"?${warning}`)) return;
                      void attempt(() => runDelete({ variables: { id: label.id } }), (d) => d.labelDelete, `Deleted ${label.name}.`, setNotice)
                        .then((ok) => { if (ok) void refetch(); });
                    }}
                  >Delete</button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Workflow states --------------------------------------------------------

const STATE_TYPES: WorkflowStateType[] = ['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW', 'COMPLETED', 'CANCELED'];
const TYPE_LABELS: Record<WorkflowStateType, string> = {
  BACKLOG: 'Backlog', UNSTARTED: 'Ready', STARTED: 'In progress', REVIEW: 'Review', COMPLETED: 'Done', CANCELED: 'Canceled',
};

export function WorkflowStatesTab() {
  const teamKey = readStoredTeamKey() ?? 'INV';
  const { data, loading, error, refetch } = useQuery<
    { teams: { nodes: Array<{ id: string; name: string; states: { nodes: SettingsState[] } }> } },
    { teamKey: string }
  >(SETTINGS_STATES_QUERY, { variables: { teamKey } });
  const [runCreate] = useMutation<{ workflowStateCreate: Refusable<object> }, { input: { teamId: string; name: string; type: WorkflowStateType } }>(
    WORKFLOW_STATE_CREATE_MUTATION,
  );
  const [runUpdate] = useMutation<{ workflowStateUpdate: Refusable<object> }, { id: string; input: { name?: string; position?: number } }>(
    WORKFLOW_STATE_UPDATE_MUTATION,
  );
  const [runDelete] = useMutation<{ workflowStateDelete: Refusable<object> }, { id: string }>(WORKFLOW_STATE_DELETE_MUTATION);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<WorkflowStateType>('STARTED');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  if (error) return <p role="alert">Could not load workflow states: {error.message}</p>;
  if (loading && !data) return <p role="status">Loading…</p>;
  const team = data?.teams.nodes[0];
  if (!team) return <p>No team selected.</p>;
  const states = [...team.states.nodes].sort((a, b) => a.position - b.position);

  // Swaps positions with the neighbour: two updates, so refetch either way.
  async function move(index: number, delta: number) {
    const a = states[index]!;
    const b = states[index + delta]!;
    const save = (id: string, position: number) =>
      attempt(() => runUpdate({ variables: { id, input: { position } } }), (d) => d.workflowStateUpdate, 'Order saved.', setNotice);
    if (await save(a.id, b.position)) await save(b.id, a.position);
    void refetch();
  }

  return (
    <section aria-label="Workflow states">
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 4px' }}>Workflow states — {team.name}</h2>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
        Agents and GitHub move work by a state&apos;s type, into the first state of that type. Names and order are yours; a
        new state goes last, so it never takes over that role. A state can be deleted once it holds no work and another state
        of its type remains.
      </p>
      <NoticeLine notice={notice} />
      <div role="list" aria-label="State list">
        {states.map((state, index) => {
          const isRenaming = renaming?.id === state.id;
          return (
            <div key={state.id} role="listitem" style={rowStyle}>
              {isRenaming ? (
                <input
                  aria-label={`Rename state ${state.name}`}
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: state.id, name: e.target.value })}
                  style={{ ...inputStyle, flex: 1 }}
                />
              ) : (
                <span style={{ flex: 1, fontSize: 14.5 }}>{state.name}</span>
              )}
              <span style={{ fontSize: 13, color: 'var(--fg-dim)', width: 90 }}>{TYPE_LABELS[state.type]}</span>
              <span style={{ fontSize: 13, color: 'var(--fg-dim)', width: 70 }}>{state.issueCount} items</span>
              <button type="button" className="ui-action ui-action--subtle" aria-label={`Move ${state.name} up`} disabled={index === 0} onClick={() => void move(index, -1)}>↑</button>
              <button type="button" className="ui-action ui-action--subtle" aria-label={`Move ${state.name} down`} disabled={index === states.length - 1} onClick={() => void move(index, 1)}>↓</button>
              {isRenaming ? (
                <>
                  <button
                    type="button"
                    className="ui-action ui-action--subtle"
                    onClick={() => void attempt(() => runUpdate({ variables: { id: state.id, input: { name: renaming.name } } }), (d) => d.workflowStateUpdate, 'State renamed.', setNotice)
                      .then((ok) => { if (ok) { setRenaming(null); void refetch(); } })}
                  >Save</button>
                  <button type="button" className="ui-action ui-action--subtle" onClick={() => setRenaming(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="ui-action ui-action--subtle" onClick={() => setRenaming({ id: state.id, name: state.name })}>Rename</button>
                  <button
                    type="button"
                    className="ui-action ui-action--subtle"
                    aria-label={`Delete state ${state.name}`}
                    onClick={() => {
                      if (!window.confirm(`Delete the state "${state.name}"?`)) return;
                      void attempt(() => runDelete({ variables: { id: state.id } }), (d) => d.workflowStateDelete, `Deleted ${state.name}.`, setNotice)
                        .then((ok) => { if (ok) void refetch(); });
                    }}
                  >Delete</button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <form
        style={{ display: 'flex', gap: 8, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          void attempt(() => runCreate({ variables: { input: { teamId: team.id, name: newName, type: newType } } }), (d) => d.workflowStateCreate, `Added ${newName.trim()}.`, setNotice)
            .then((ok) => { if (ok) { setNewName(''); void refetch(); } });
        }}
      >
        <input aria-label="New state name" placeholder="New state" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} />
        <select aria-label="New state type" value={newType} onChange={(e) => setNewType(e.target.value as WorkflowStateType)} style={inputStyle}>
          {STATE_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
        </select>
        <button type="submit" className="ui-action ui-action--subtle" disabled={!newName.trim()}>Add state</button>
      </form>
    </section>
  );
}

// --- Admins ------------------------------------------------------------------

// --- Server features (read only) ------------------------------------------------

export function ServerFeaturesTab() {
  const { data, loading, error } = useQuery<{ serverFeatures: ServerFeature[] }>(SERVER_FEATURES_QUERY);
  if (error) return <p role="alert">Could not load server features: {error.message}</p>;
  if (loading && !data) return <p role="status">Loading…</p>;
  return (
    <section aria-label="Server features">
      <h2 style={{ fontSize: 17, fontWeight: 500, margin: '0 0 4px' }}>Server features</h2>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
        What this deployment runs, read from its environment. Change them in the server&apos;s .env and restart; values are never shown here.
      </p>
      <div role="list" aria-label="Feature list">
        {(data?.serverFeatures ?? []).map((feature) => (
          <div key={feature.key} role="listitem" style={rowStyle}>
            <span style={{ width: 180, fontSize: 14.5 }}>{feature.label}</span>
            <span style={{ width: 50, fontSize: 13, color: feature.enabled ? 'var(--fg)' : 'var(--fg-dim)' }}>{feature.enabled ? 'On' : 'Off'}</span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-dim)' }}>{feature.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// --- Service actors -----------------------------------------------------------

/** A SERVICE actor is an external program (CI, cron, a bridge) with its own identity; issue it a credential under Agents. */
export function ServiceActorForm({ onCreated }: { onCreated?: () => void }) {
  const [runCreate] = useMutation<
    { serviceActorCreate: Refusable<{ actor: { id: string; handle: string | null } | null }> },
    { input: { name: string; handle: string; description?: string | null } }
  >(SERVICE_ACTOR_CREATE_MUTATION);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <section aria-label="New service actor" style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 15, fontWeight: 500, margin: '0 0 4px' }}>New service actor</h3>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: '0 0 8px' }}>
        For a program such as CI, a cron job or a bridge. You are its owner; issue it a credential afterwards.
      </p>
      <form
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        onSubmit={(event) => {
          event.preventDefault();
          void attempt(
            () => runCreate({ variables: { input: { name, handle, description: description.trim() || null } } }),
            (d) => d.serviceActorCreate,
            `Created @${handle.trim()}.`,
            setNotice,
          ).then((ok) => {
            if (!ok) return;
            setName(''); setHandle(''); setDescription('');
            onCreated?.();
          });
        }}
      >
        <input aria-label="Service name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        <input aria-label="Service handle" placeholder="handle" value={handle} onChange={(e) => setHandle(e.target.value)} style={inputStyle} />
        <input aria-label="Service description" placeholder="What it does" value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
        <button type="submit" className="ui-action ui-action--subtle" disabled={!name.trim() || !handle.trim()}>Create service</button>
      </form>
      <NoticeLine notice={notice} />
    </section>
  );
}

// --- Email notifications -------------------------------------------------------

export function EmailNotificationsField() {
  const { data, loading } = useQuery<{ viewer: { id: string; emailNotifications: boolean | null } | null }>(EMAIL_NOTIFICATIONS_QUERY);
  const [runUpdate] = useMutation<
    { notificationPreferencesUpdate: Refusable<{ emailNotifications: boolean }> },
    { emailNotifications: boolean }
  >(NOTIFICATION_PREFERENCES_UPDATE_MUTATION, { refetchQueries: [{ query: EMAIL_NOTIFICATIONS_QUERY }] });
  const [notice, setNotice] = useState<Notice>(null);
  const enabled = data?.viewer?.emailNotifications ?? true;

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          aria-label="Email notifications"
          checked={enabled}
          disabled={loading && !data}
          onChange={(e) => {
            const next = e.target.checked;
            void attempt(
              () => runUpdate({ variables: { emailNotifications: next } }),
              (d) => d.notificationPreferencesUpdate,
              next ? 'Inbox notifications will also be emailed.' : 'Email notifications are off.',
              setNotice,
            );
          }}
        />
        <span style={{ fontSize: 14.5 }}>{enabled ? 'Email me inbox notifications' : 'Inbox only'}</span>
      </label>
      <NoticeLine notice={notice} />
    </div>
  );
}
