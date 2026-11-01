import { useMutation } from '@apollo/client/react';
import { useState } from 'react';

import { AGENT_TRUST_SET_MUTATION } from '../board/queries';
import { Btn } from './Primitives';
import { Field, Select, TextInput } from './controls';
import { Badge } from './status';

// INV-1490 (docs/autonomy-policy.md §2.4, §7): an agent's trust level is a
// clamp on the project's autonomy. A person promotes or demotes it with a
// reason, next to the last 30 days' numbers; the server suggests, never raises.

export type AgentTrustLevel = 'OBSERVE' | 'L1' | 'L2' | 'L3';

export interface AgentTrustView {
  level: AgentTrustLevel;
  descriptionEn: string;
  descriptionZh: string;
  reason: string | null;
  updatedAt: string | null;
  setBy: { id: string; name: string | null; handle: string | null } | null;
  allowed: { claimWork: boolean; fileBugs: boolean; autoCommit: boolean; autoAccept: boolean; delegate: boolean };
  metrics: { windowDays: number; deliveries: number; bugsFiled: number; falseReports: number; falseReportRate: number | null; reopens: number; overrides: number; overridesLastWeek: number };
  suggestedLevel: AgentTrustLevel | null;
  warning: string | null;
}

const LEVELS: AgentTrustLevel[] = ['OBSERVE', 'L1', 'L2', 'L3'];
const LEVEL_LABEL: Record<AgentTrustLevel, string> = { OBSERVE: 'Observe', L1: 'L1', L2: 'L2', L3: 'L3' };
const ALLOWED_LABEL: Array<[keyof AgentTrustView['allowed'], string]> = [
  ['claimWork', 'claim work'],
  ['fileBugs', 'file bugs'],
  ['autoCommit', 'have qualifying candidates committed'],
  ['autoAccept', 'have CLEAR deliveries accepted'],
  ['delegate', 'delegate to other agents'],
];

export function AgentTrustPanel({ actorId, trust, canManage, onChanged }: { actorId: string; trust: AgentTrustView; canManage: boolean; onChanged: () => void }) {
  const [runSet] = useMutation<{ agentTrustSet: { success: boolean; message?: string | null } }, { input: { actorId: string; level: AgentTrustLevel; reason: string } }>(AGENT_TRUST_SET_MUTATION);
  const [level, setLevel] = useState<AgentTrustLevel>(trust.level);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const current = LEVELS.indexOf(trust.level);
  const chosen = LEVELS.indexOf(level);
  const metrics = trust.metrics;

  async function apply() {
    setNotice(null);
    const result = await runSet({ variables: { input: { actorId, level, reason } } });
    const payload = result.data?.agentTrustSet;
    if (!payload?.success) {
      setNotice({ ok: false, text: payload?.message ?? 'The trust level was not changed.' });
      return;
    }
    setNotice({ ok: true, text: `Trust level set to ${LEVEL_LABEL[level]}.` });
    setReason('');
    onChanged();
  }

  return (
    <section className="issue-panel__section" aria-label="Trust level">
      <h2 className="issue-panel__label">
        Trust level <Badge tone={trust.level === 'OBSERVE' ? 'neutral' : 'accent'}>{LEVEL_LABEL[trust.level]}</Badge>
      </h2>
      <p className="agent-directory__meta">{trust.descriptionEn}</p>
      <p className="agent-directory__meta" lang="zh">{trust.descriptionZh}</p>
      {trust.reason ? (
        <p className="agent-directory__meta">
          Set {trust.updatedAt ? new Date(trust.updatedAt).toLocaleDateString() : ''}{trust.setBy ? ` by ${trust.setBy.name ?? trust.setBy.handle ?? trust.setBy.id}` : ''}: {trust.reason}
        </p>
      ) : null}
      <ul className="agent-trust__allowed" aria-label="Allowed to">
        {ALLOWED_LABEL.map(([key, label]) => (
          <li key={key} className={trust.allowed[key] ? '' : 'agent-trust__allowed--off'}>{trust.allowed[key] ? '✓' : '—'} {label}</li>
        ))}
      </ul>
      <div className="agent-directory__counts" aria-label={`Last ${metrics.windowDays} days`}>
        <span>deliveries {metrics.deliveries}</span>
        <span>bugs filed {metrics.bugsFiled}</span>
        <span>false reports {metrics.falseReports}{metrics.falseReportRate !== null ? ` (${metrics.falseReportRate}%)` : ''}</span>
        <span>reopens {metrics.reopens}</span>
        <span>overrides {metrics.overrides}</span>
      </div>
      {trust.warning ? <p role="alert" className="agent-directory__meta">{trust.warning}</p> : null}
      {trust.suggestedLevel ? <p role="status" className="agent-directory__meta">Suggested: {LEVEL_LABEL[trust.suggestedLevel]} — clean for {metrics.windowDays} days with {metrics.deliveries} deliveries.</p> : null}
      {canManage ? (
        <div className="form-stack">
          <Field label="Set trust level" layout="aside" hint="Promote with data, demote at once; the reason is what the audit shows.">
            <Select aria-label="Trust level" size="sm" value={level} onChange={(e) => setLevel(e.target.value as AgentTrustLevel)}>
              {LEVELS.map((option) => <option key={option} value={option}>{LEVEL_LABEL[option]}</option>)}
            </Select>
          </Field>
          {chosen !== current ? (
            <div className="inline-form">
              <TextInput aria-label="Reason for the trust change" size="sm" value={reason} placeholder="Why" onChange={(e) => setReason(e.target.value)} />
              <Btn size="sm" variant={chosen > current ? 'accent' : 'danger'} disabled={!reason.trim()} onClick={() => void apply()}>
                {chosen > current ? `Promote to ${LEVEL_LABEL[level]}` : `Demote to ${LEVEL_LABEL[level]}`}
              </Btn>
            </div>
          ) : null}
          {notice ? <p role={notice.ok ? 'status' : 'alert'} className="agent-directory__meta">{notice.text}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
