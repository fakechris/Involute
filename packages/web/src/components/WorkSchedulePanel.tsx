import { useMutation } from '@apollo/client/react';
import { useState } from 'react';

import type { WorkScheduleSummary } from '../board/types';
import { WORK_SCHEDULE_CLEAR_MUTATION, WORK_SCHEDULE_SET_MUTATION } from '../work/queries';
import { Btn } from './Primitives';
import { Field, TextInput } from './controls';

/**
 * The schedule on an item (INV-1582): rounds of work on a clock, run by one
 * agent. A person sets it here — five cron fields, a time zone, the agent —
 * pauses it, and removes it. What it has done so far (rounds fired, rounds
 * missed, the next one) reads next to the form; each round is a run on the
 * work page.
 */

const DEFAULT_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

type Refusable<T> = { success: boolean; message?: string | null } & T;

export function WorkSchedulePanel({
  workId,
  schedule,
  canEdit,
  onChanged,
}: {
  workId: string;
  schedule: WorkScheduleSummary | null | undefined;
  /** Whether the viewer may change it: a person with write access. */
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? DEFAULT_ZONE);
  const [agent, setAgent] = useState(schedule?.agent.handle ? `@${schedule.agent.handle}` : schedule?.agent.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runSet] = useMutation<{ workScheduleSet: Refusable<{ schedule: WorkScheduleSummary | null }> }, { input: { workId: string; cron: string; timezone: string; agent: string; active?: boolean } }>(WORK_SCHEDULE_SET_MUTATION);
  const [runClear] = useMutation<{ workScheduleClear: Refusable<{ cleared: boolean }> }, { workId: string }>(WORK_SCHEDULE_CLEAR_MUTATION);

  async function save(active?: boolean) {
    setSaving(true);
    setError(null);
    try {
      const result = await runSet({ variables: { input: { workId, cron: cron.trim(), timezone: timezone.trim(), agent: agent.trim(), ...(active === undefined ? {} : { active }) } } });
      const payload = result.data?.workScheduleSet;
      if (!payload?.success) {
        setError(payload?.message ?? 'The schedule was not saved.');
        return;
      }
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove this schedule? Its rounds stay as runs; nothing more fires.')) return;
    setSaving(true);
    setError(null);
    try {
      const result = await runClear({ variables: { workId } });
      const payload = result.data?.workScheduleClear;
      if (!payload?.success) {
        setError(payload?.message ?? 'The schedule was not removed.');
        return;
      }
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

  return (
    <div className="work-schedule" data-testid="work-schedule">
      {schedule ? (
        <dl className="work-schedule__facts">
          <dt>Clock</dt>
          <dd className="mono">{schedule.cron} · {schedule.timezone}{schedule.active ? '' : ' · paused'}</dd>
          <dt>Runs by</dt>
          <dd>{schedule.agent.handle ? `@${schedule.agent.handle}` : schedule.agent.name ?? schedule.agent.id}</dd>
          <dt>Rounds</dt>
          <dd>
            {schedule.round} fired{schedule.missedRounds > 0 ? <span className="work-schedule__missed"> · {schedule.missedRounds} in a row with no run</span> : null}
          </dd>
          <dt>Next</dt>
          <dd>{schedule.active ? when(schedule.nextRunAt) : 'paused'}</dd>
        </dl>
      ) : (
        <p className="work-schedule__none">No schedule. The item runs once; a schedule makes it run in rounds.</p>
      )}
      {canEdit && !editing ? (
        <div className="work-schedule__actions">
          <Btn size="sm" variant="subtle" onClick={() => setEditing(true)}>{schedule ? 'Edit schedule' : 'Add schedule'}</Btn>
          {schedule ? <Btn size="sm" variant="subtle" onClick={() => void save(!schedule.active)} disabled={saving}>{schedule.active ? 'Pause' : 'Resume'}</Btn> : null}
          {schedule ? <Btn size="sm" variant="danger" onClick={() => void remove()} disabled={saving}>Remove schedule</Btn> : null}
        </div>
      ) : null}
      {canEdit && editing ? (
        <form
          className="work-schedule__form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Cron (minute hour day month weekday)" hint='e.g. "0 9 * * 1-5" — 09:00 on weekdays'>
            <TextInput value={cron} onChange={(event) => setCron(event.target.value)} aria-label="Cron" />
          </Field>
          <Field label="Time zone">
            <TextInput value={timezone} onChange={(event) => setTimezone(event.target.value)} aria-label="Time zone" />
          </Field>
          <Field label="Agent" hint="@handle of the agent that runs each round; it must hold a credential on this team">
            <TextInput value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Agent" />
          </Field>
          {error ? <p className="work-schedule__error" role="alert">{error}</p> : null}
          <div className="work-schedule__actions">
            <Btn size="sm" variant="accent" type="submit" disabled={saving || !cron.trim() || !timezone.trim() || !agent.trim()}>Save schedule</Btn>
            <Btn size="sm" variant="subtle" type="button" onClick={() => { setEditing(false); setError(null); }}>Cancel</Btn>
          </div>
        </form>
      ) : null}
      {!editing && error ? <p className="work-schedule__error" role="alert">{error}</p> : null}
    </div>
  );
}
