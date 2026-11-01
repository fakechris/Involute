import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';

import { Btn } from '../components/Primitives';
import { SettingsSectionHeader } from '../components/SettingsShell';
import { Checkbox, Field, Select, TextInput } from '../components/controls';
import { Badge } from '../components/status';
import {
  AUTONOMY_SETTINGS_QUERY,
  WORKFLOW_POLICY_CLEAR_MUTATION,
  WORKFLOW_POLICY_SET_MUTATION,
  WORKSPACE_SETTINGS_SCOPE_ID,
  type AutonomyDecider,
  type AutonomyLevelInfo,
  type AutonomyScope,
  type AutonomySettingsData,
  type AutonomyTemplate,
  type IssueAutonomy,
  type Refusable,
} from './settings-queries';
import { NoticeLine, attempt, type Notice } from './WorkspaceSettingsTabs';

// Autonomy policy pages (INV-1489, docs/autonomy-policy.md §2, decision
// INV-1486): one concept, four levels L0–L3 described in both languages, set
// on the workspace (ceiling, locks, templates, pause), adopted by a team and
// optionally overridden by a project. Observing a level before turning it on
// is offered, never forced. Nothing on these pages opens a gate by itself:
// the deciders act from INV-1491 on.

const GATE_LABEL: Record<string, string> = {
  candidate_commit: 'Candidate → Ready',
  contract_amendment: 'Contract amendment',
  review_accept: 'Review → Done',
  agent_delegation: 'Agent → agent hand-off',
  merge_signal: 'Merge signal',
  spend_budget: 'Spend budget',
};

const SOURCE_LABEL: Record<string, string> = {
  default: 'workspace default',
  workspace: 'workspace',
  team: 'inherited from team',
  project: 'project override',
  ceiling: 'clamped by the workspace ceiling',
  agent_trust: 'clamped by agent trust',
  paused: 'paused by the workspace',
};

/** Level names when the settings query has not answered; descriptions come from the server. */
const LEVEL_NAMES_FALLBACK: AutonomyLevelInfo[] = ['L0 Review everything', 'L1 Low-risk pass-through', 'L2 Green-light accept', 'L3 Hands-off'].map((name, level) => ({ level, name, descriptionEn: '', descriptionZh: '', gates: [] }));

type SetVariables = { input: { scope: AutonomyScope; scopeId: string; level: number; reason: string; gates?: unknown; intake?: unknown; locked?: string[]; observeDays?: number; paused?: boolean; defaultLevel?: number; templates?: unknown } };
type ClearVariables = { input: { scope: AutonomyScope; scopeId: string; reason: string } };

function useAutonomySettings(scope: AutonomyScope, scopeId: string) {
  return useQuery<AutonomySettingsData, { scope: AutonomyScope; scopeId: string }>(AUTONOMY_SETTINGS_QUERY, { variables: { scope, scopeId } });
}

/** `L1 · Low-risk pass-through` with both descriptions underneath. */
export function LevelOption({ info, checked, disabled, lockedWhy, onSelect, name }: { info: AutonomyLevelInfo; checked: boolean; disabled?: boolean; lockedWhy?: string | null; onSelect: () => void; name: string }) {
  return (
    <label className={`autonomy-level${checked ? ' autonomy-level--on' : ''}${disabled ? ' autonomy-level--locked' : ''}`}>
      <input type="radio" name={name} aria-label={info.name} checked={checked} disabled={disabled} onChange={onSelect} />
      <span className="autonomy-level__body">
        <strong>{info.name}</strong>
        {disabled && lockedWhy ? <span className="field__hint"> 🔒 {lockedWhy}</span> : null}
        <span className="autonomy-level__text">{info.descriptionEn}</span>
        <span className="autonomy-level__text" lang="zh">{info.descriptionZh}</span>
      </span>
    </label>
  );
}

export function AutonomyBadge({ autonomy }: { autonomy: IssueAutonomy | null | undefined }) {
  if (!autonomy) return null;
  const source = SOURCE_LABEL[autonomy.source] ?? autonomy.source;
  return (
    <Badge title={`${autonomy.name} · ${source}`} tone={autonomy.level === 0 ? 'neutral' : 'accent'}>
      L{autonomy.level}{autonomy.observing ? ' · observing' : ''}
    </Badge>
  );
}

// --- Workspace (Admin) -----------------------------------------------------

export function AdminAutonomyTab() {
  const { data, loading, error, refetch } = useAutonomySettings('WORKSPACE', WORKSPACE_SETTINGS_SCOPE_ID);
  if (error) return <p role="alert">Could not load autonomy settings: {error.message}</p>;
  if (loading || !data) return <p role="status">Loading…</p>;
  return <WorkspaceAutonomyForm key={data.autonomySettings.active?.id ?? 'none'} data={data} onSaved={() => void refetch()} />;
}

function WorkspaceAutonomyForm({ data, onSaved }: { data: AutonomySettingsData; onSaved: () => void }) {
  const settings = data.autonomySettings;
  const [runSet] = useMutation<{ workflowPolicySet: Refusable<object> }, SetVariables>(WORKFLOW_POLICY_SET_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [ceiling, setCeiling] = useState(settings.active?.level ?? 0);
  const [defaultLevel, setDefaultLevel] = useState(settings.defaultLevel);
  const [locked, setLocked] = useState<string[]>(settings.active?.locked ?? []);
  const [templates, setTemplates] = useState<AutonomyTemplate[]>(settings.templates);
  const [newTemplate, setNewTemplate] = useState<{ name: string; level: number }>({ name: '', level: 1 });
  const [reason, setReason] = useState('');
  const extraGates = settings.gates.filter((gate) => gate !== 'merge_signal' && gate !== 'spend_budget');

  function save(extra: Partial<SetVariables['input']> = {}) {
    void attempt(
      () => runSet({ variables: { input: { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_SCOPE_ID, level: ceiling, defaultLevel, locked, templates: templates.map((template) => ({ name: template.name, level: template.level, ...(template.gates ? { gates: template.gates } : {}) })), reason, ...extra } } }),
      (d) => d.workflowPolicySet,
      extra.paused === true ? 'All autonomy paused: every team and project reads as L0.' : extra.paused === false ? 'Autonomy resumed.' : 'Autonomy settings saved.',
      setNotice,
    ).then((ok) => { if (ok) { setReason(''); onSaved(); } });
  }

  return (
    <section aria-label="Autonomy">
      <SettingsSectionHeader title="Autonomy">
        How far agents may go on their own. Teams pick a level up to the ceiling; a project may override its team. Levels are described in docs/autonomy-policy.md; nothing below changes a decision already waiting for you.
      </SettingsSectionHeader>
      <NoticeLine notice={notice} />
      {settings.paused ? (
        <p role="status" className="autonomy-paused">
          <Badge tone="warn">Paused</Badge> Every scope reads as L0 until you resume. <Btn size="sm" onClick={() => save({ paused: false })} disabled={!reason.trim()}>Resume autonomy</Btn>
        </p>
      ) : null}
      <div className="form-stack">
        <fieldset className="settings-fieldset">
          <legend className="field__label">Workspace ceiling</legend>
          <span className="field__hint">Teams and projects can go up to this level, never above. Current: L{settings.ceiling}{settings.paused ? ' (paused)' : ''}.</span>
          <div className="autonomy-levels">
            {settings.levels.map((info) => (
              <LevelOption key={info.level} name="ceiling" info={info} checked={ceiling === info.level} onSelect={() => setCeiling(info.level)} />
            ))}
          </div>
        </fieldset>
        <Field label="Default for new teams" hint="A team that has not chosen starts here (within the ceiling)." layout="aside">
          <Select aria-label="Default for new teams" value={defaultLevel} onChange={(e) => setDefaultLevel(Number(e.target.value))}>
            {settings.levels.map((info) => <option key={info.level} value={info.level}>{info.name}</option>)}
          </Select>
        </Field>
        <fieldset className="settings-fieldset">
          <legend className="field__label">Always needs a person</legend>
          <span className="field__hint">Locked at every level. The first three are built in and cannot be unlocked.</span>
          <div className="checkbox-group">
            {settings.builtInLocks.map((lock) => (
              <Checkbox key={lock.id} checked disabled label={<>{lock.reason}</>} aria-label={`Lock ${lock.id}`} />
            ))}
            {extraGates.map((gate) => (
              <Checkbox
                key={gate}
                aria-label={`Lock ${gate}`}
                checked={locked.includes(gate)}
                onChange={(e) => setLocked((current) => (e.target.checked ? [...current, gate] : current.filter((id) => id !== gate)))}
                label={<>{GATE_LABEL[gate] ?? gate} always waits for a person</>}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="settings-fieldset">
          <legend className="field__label">Templates</legend>
          <span className="field__hint">Named presets a team can adopt in one click.</span>
          <ul className="autonomy-templates" aria-label="Templates">
            {templates.map((template, index) => (
              <li key={`${template.name}-${index}`}>
                <span>{template.name}</span> <Badge mono>L{template.level}</Badge>{' '}
                <Btn size="sm" variant="ghost" aria-label={`Remove template ${template.name}`} onClick={() => setTemplates((current) => current.filter((_, i) => i !== index))}>Remove</Btn>
              </li>
            ))}
          </ul>
          <div className="inline-form">
            <TextInput aria-label="New template name" placeholder="Template name" value={newTemplate.name} onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })} />
            <Select aria-label="New template level" value={newTemplate.level} onChange={(e) => setNewTemplate({ ...newTemplate, level: Number(e.target.value) })}>
              {settings.levels.map((info) => <option key={info.level} value={info.level}>{info.name}</option>)}
            </Select>
            <Btn size="sm" onClick={() => { if (newTemplate.name.trim()) { setTemplates((current) => [...current, { name: newTemplate.name.trim(), level: newTemplate.level }]); setNewTemplate({ name: '', level: 1 }); } }}>Add template</Btn>
          </div>
        </fieldset>
        <Field label="Reason" hint="Required; kept in the change history." layout="aside">
          <TextInput aria-label="Reason for the autonomy change" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change" />
        </Field>
        <div className="inline-form">
          <Btn variant="accent" size="md" onClick={() => save()} disabled={!reason.trim()}>Save autonomy</Btn>
          {!settings.paused ? <Btn size="md" variant="danger" onClick={() => save({ paused: true })} disabled={!reason.trim()}>Pause all autonomy</Btn> : null}
        </div>
        <ChangeHistory history={settings.history} />
      </div>
    </section>
  );
}

function ChangeHistory({ history }: { history: AutonomySettingsData['autonomySettings']['history'] }) {
  if (!history.length) return null;
  return (
    <details className="autonomy-history">
      <summary>Change history ({history.length})</summary>
      <ul aria-label="Change history">
        {history.map((row) => (
          <li key={row.id}>
            <span className="mono">v{row.version}</span> · L{row.level}{row.paused ? ' · paused' : ''}{row.observeUntil ? ` · observing until ${new Date(row.observeUntil).toLocaleDateString()}` : ''} · {new Date(row.createdAt).toLocaleString()}{row.reason ? ` · ${row.reason}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

// --- Team (Owner) ----------------------------------------------------------

type ConditionRow = { field: string; op: 'eq' | 'in' | 'not_in' | 'gte' | 'lte'; value: string };

function rowsToPredicate(rows: ConditionRow[]): unknown | null {
  const clauses = rows.filter((row) => row.field && row.value.trim()).map((row) => {
    const raw = row.value.trim();
    const scalar = (text: string): string | number | boolean => (text === 'true' ? true : text === 'false' ? false : Number.isFinite(Number(text)) && text !== '' ? Number(text) : text);
    if (row.op === 'in' || row.op === 'not_in') return { field: row.field, [row.op]: raw.split(',').map((part) => scalar(part.trim())) };
    if (row.op === 'gte' || row.op === 'lte') return { field: row.field, [row.op]: Number(raw) };
    return { field: row.field, eq: scalar(raw) };
  });
  return clauses.length ? { all: clauses } : null;
}

export function TeamAutonomySection({ teamId }: { teamId: string }) {
  const { data, loading, error, refetch } = useAutonomySettings('TEAM', teamId);
  if (error) return <p role="alert">Could not load autonomy settings: {error.message}</p>;
  if (loading || !data) return <p role="status">Loading…</p>;
  return <TeamAutonomyForm key={data.autonomySettings.active?.id ?? 'none'} teamId={teamId} data={data} onSaved={() => void refetch()} />;
}

function TeamAutonomyForm({ teamId, data, onSaved }: { teamId: string; data: AutonomySettingsData; onSaved: () => void }) {
  const settings = data.autonomySettings;
  const [runSet] = useMutation<{ workflowPolicySet: Refusable<object> }, SetVariables>(WORKFLOW_POLICY_SET_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [level, setLevel] = useState(settings.active?.level ?? settings.defaultLevel);
  const [gates, setGates] = useState<Record<string, AutonomyDecider>>(() => Object.fromEntries(Object.entries(settings.active?.gates ?? {}).map(([gate, rule]) => [gate, rule.decider])));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [intakeRows, setIntakeRows] = useState<ConditionRow[]>([]);
  const [observeDays, setObserveDays] = useState(7);
  const [reason, setReason] = useState('');
  const preset = useMemo(() => settings.levels.find((info) => info.level === level) ?? settings.levels[0]!, [settings.levels, level]);
  const observing = settings.active?.observeUntil && new Date(settings.active.observeUntil) > new Date();

  function save(days: number) {
    const overrides = Object.fromEntries(Object.entries(gates).filter(([gate, decider]) => decider !== preset.gates.find((entry) => entry.gate === gate)?.decider).map(([gate, decider]) => [gate, { decider }]));
    const intake = level === 3 ? rowsToPredicate(intakeRows) : null;
    void attempt(
      () => runSet({ variables: { input: { scope: 'TEAM', scopeId: teamId, level, reason, gates: overrides, ...(intake ? { intake } : {}), observeDays: days } } }),
      (d) => d.workflowPolicySet,
      days > 0 ? `Observing L${level} for ${days} days: Needs you shows what would have been automatic; nothing changes yet.` : `Autonomy set to L${level}.`,
      setNotice,
    ).then((ok) => { if (ok) { setReason(''); onSaved(); } });
  }

  return (
    <section aria-label="Autonomy">
      <SettingsSectionHeader title="Autonomy">
        What happens after an item is proposed, amended or delivered in this team. The workspace ceiling is L{settings.ceiling}{settings.paused ? ' (paused: everything reads as L0 until an admin resumes)' : ''}.
      </SettingsSectionHeader>
      <NoticeLine notice={notice} />
      {settings.active ? (
        <p className="field__hint">
          Current: L{settings.active.level} (v{settings.active.version}){observing ? ` · observing until ${new Date(settings.active.observeUntil!).toLocaleDateString()}` : ''}{settings.active.reason ? ` · ${settings.active.reason}` : ''}
        </p>
      ) : (
        <p className="field__hint">No team choice yet: the workspace default L{settings.defaultLevel} applies.</p>
      )}
      {settings.templates.length ? (
        <div className="inline-form" aria-label="Templates">
          <span className="field__hint">Start from a template:</span>
          {settings.templates.map((template) => (
            <Btn key={template.name} size="sm" variant="ghost" disabled={template.level > settings.ceiling} onClick={() => { setLevel(template.level); setGates(Object.fromEntries(Object.entries((template.gates as Record<string, { decider: AutonomyDecider }> | null) ?? {}).map(([gate, rule]) => [gate, rule.decider]))); }}>
              {template.name} · L{template.level}
            </Btn>
          ))}
        </div>
      ) : null}
      <div className="autonomy-levels">
        {settings.levels.map((info) => (
          <LevelOption
            key={info.level}
            name="team-level"
            info={info}
            checked={level === info.level}
            disabled={info.level > settings.ceiling}
            lockedWhy={info.level > settings.ceiling ? `Above the workspace ceiling (L${settings.ceiling}); ask a workspace admin.` : null}
            onSelect={() => setLevel(info.level)}
          />
        ))}
      </div>
      <details className="autonomy-advanced" open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced: per step</summary>
        <table className="data-table" aria-label="Per step">
          <thead><tr><th>Step</th><th>Who decides at L{level}</th></tr></thead>
          <tbody>
            {preset.gates.map((entry) => {
              const current = gates[entry.gate] ?? entry.decider;
              const options: AutonomyDecider[] = entry.decider === 'auto' ? ['auto', 'human'] : entry.decider === 'none' ? ['none'] : ['human'];
              return (
                <tr key={entry.gate}>
                  <td>{GATE_LABEL[entry.gate] ?? entry.gate}</td>
                  <td>
                    <Select aria-label={`Decider for ${entry.gate}`} size="sm" value={current} disabled={options.length === 1} onChange={(e) => setGates((state) => ({ ...state, [entry.gate]: e.target.value as AutonomyDecider }))}>
                      {options.map((option) => <option key={option} value={option}>{option === 'auto' ? 'Automatic when the condition holds' : option === 'human' ? 'A person' : 'Not available'}</option>)}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="field__hint">A step can be tightened here. Loosening one the level keeps with a person is not possible; raise the level instead.</p>
      </details>
      {level === 3 ? (
        <fieldset className="settings-fieldset" aria-label="Intake rule">
          <legend className="field__label">Intake rule (L3)</legend>
          <span className="field__hint">Candidates matching every condition are committed and dispatched without a person. Conditions name stored fields only.</span>
          {intakeRows.map((row, index) => (
            <div className="inline-form" key={index}>
              <Select aria-label={`Intake field ${index + 1}`} size="sm" value={row.field} onChange={(e) => setIntakeRows((rows) => rows.map((r, i) => (i === index ? { ...r, field: e.target.value } : r)))}>
                <option value="">field…</option>
                {settings.conditionFields.map((field) => <option key={field} value={field}>{field}</option>)}
              </Select>
              <Select aria-label={`Intake operator ${index + 1}`} size="sm" value={row.op} onChange={(e) => setIntakeRows((rows) => rows.map((r, i) => (i === index ? { ...r, op: e.target.value as ConditionRow['op'] } : r)))}>
                {(['eq', 'in', 'not_in', 'gte', 'lte'] as const).map((op) => <option key={op} value={op}>{op}</option>)}
              </Select>
              <TextInput aria-label={`Intake value ${index + 1}`} size="sm" value={row.value} placeholder="value, or a,b for lists" onChange={(e) => setIntakeRows((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
              <Btn size="sm" variant="ghost" onClick={() => setIntakeRows((rows) => rows.filter((_, i) => i !== index))}>Remove</Btn>
            </div>
          ))}
          <Btn size="sm" onClick={() => setIntakeRows((rows) => [...rows, { field: '', op: 'eq', value: '' }])}>Add condition</Btn>
        </fieldset>
      ) : null}
      <Field label="Reason" hint="Required; kept in the change history." layout="aside">
        <TextInput aria-label="Reason for the autonomy change" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change" />
      </Field>
      <div className="inline-form">
        <Btn variant="accent" size="md" onClick={() => save(0)} disabled={!reason.trim()}>Turn on now</Btn>
        <span className="field__hint">or try first:</span>
        <TextInput aria-label="Observe for days" type="number" size="sm" min={1} max={90} value={observeDays} onChange={(e) => setObserveDays(Math.max(1, Number(e.target.value) || 1))} />
        <Btn size="md" onClick={() => save(observeDays)} disabled={!reason.trim()}>Observe for {observeDays} days</Btn>
      </div>
      <p className="field__hint">Observe keeps today&apos;s behaviour and marks, on each item in Needs you, what L{level} would have done. It is advice, not a gate: turning on directly is always available.</p>
      <ChangeHistory history={settings.history} />
    </section>
  );
}

// --- Project (inherit or override) -----------------------------------------

export function ProjectAutonomyField({ projectId, autonomy, onChanged }: { projectId: string; autonomy: IssueAutonomy | null | undefined; onChanged: () => void }) {
  const { data } = useAutonomySettings('PROJECT', projectId);
  // Rendered inside the project dialog, whose own query may answer first: tolerate a different shape.
  const ceiling = data?.autonomySettings?.ceiling ?? 3;
  const levels = data?.autonomySettings?.levels?.length ? data.autonomySettings.levels : LEVEL_NAMES_FALLBACK;
  const [runSet] = useMutation<{ workflowPolicySet: Refusable<object> }, SetVariables>(WORKFLOW_POLICY_SET_MUTATION);
  const [runClear] = useMutation<{ workflowPolicyClear: Refusable<object> }, ClearVariables>(WORKFLOW_POLICY_CLEAR_MUTATION);
  const overridden = autonomy?.requestedBy === 'project';
  const [mode, setMode] = useState<'inherit' | 'override'>(overridden ? 'override' : 'inherit');
  const [level, setLevel] = useState(overridden ? autonomy!.requested : (autonomy?.level ?? 0));
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const dirty = overridden ? mode === 'inherit' || level !== autonomy!.requested : mode === 'override';

  function apply() {
    const run = mode === 'inherit'
      ? attempt(() => runClear({ variables: { input: { scope: 'PROJECT', scopeId: projectId, reason } } }), (d) => d.workflowPolicyClear, 'The project inherits its team again.', setNotice)
      : attempt(() => runSet({ variables: { input: { scope: 'PROJECT', scopeId: projectId, level, reason } } }), (d) => d.workflowPolicySet, `Project autonomy set to L${level}.`, setNotice);
    void run.then((ok) => { if (ok) { setReason(''); onChanged(); } });
  }

  return (
    <fieldset className="settings-fieldset" aria-label="Autonomy">
      <legend className="field__label">Autonomy <AutonomyBadge autonomy={autonomy} /></legend>
      <span className="field__hint">Who decides at each gate for this project&apos;s work. Effective now: {autonomy ? `${autonomy.name} (${SOURCE_LABEL[autonomy.source] ?? autonomy.source})` : 'unknown'}.</span>
      <NoticeLine notice={notice} />
      <label className="autonomy-level">
        <input type="radio" name="project-autonomy" aria-label="Inherit from team" checked={mode === 'inherit'} onChange={() => setMode('inherit')} />
        <span>Inherit from team</span>
      </label>
      <label className="autonomy-level">
        <input type="radio" name="project-autonomy" aria-label="Override for this project" checked={mode === 'override'} onChange={() => setMode('override')} />
        <span>Override for this project</span>
      </label>
      {mode === 'override' ? (
        <Select aria-label="Project autonomy level" size="sm" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
          {levels.map((info) => <option key={info.level} value={info.level} disabled={info.level > ceiling}>{info.name}{info.level > ceiling ? ' (above ceiling)' : ''}</option>)}
        </Select>
      ) : null}
      {dirty ? (
        <div className="inline-form">
          <TextInput aria-label="Reason for the project autonomy change" size="sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" />
          <Btn size="sm" variant="accent" onClick={apply} disabled={!reason.trim()}>Apply autonomy</Btn>
        </div>
      ) : null}
    </fieldset>
  );
}
