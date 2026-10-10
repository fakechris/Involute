/**
 * Type: Incident impact timestamps on the issue page (INV-1125): when the
 * impact began, was noticed, stopped and was fixed, plus how long the impact
 * lasted. The server keeps them in order and refuses anything else with a
 * message; a missing mitigation counts as the resolution time.
 */
export type IncidentTimeField = 'impactStartedAt' | 'detectedAt' | 'mitigatedAt' | 'resolvedAt';

export type IncidentTimes = Partial<Record<IncidentTimeField, string | null>>;

const FIELDS: Array<{ field: IncidentTimeField; label: string; clearable: boolean }> = [
  { field: 'impactStartedAt', label: 'Impact started', clearable: false },
  { field: 'detectedAt', label: 'Detected', clearable: false },
  { field: 'mitigatedAt', label: 'Mitigated', clearable: true },
  { field: 'resolvedAt', label: 'Resolved', clearable: true },
];

/** "3h 5m", "2d 4h", "45m". */
export function formatImpactDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

/** How long the impact lasted (or has lasted so far), from impact start. */
export function impactSummary(times: IncidentTimes & { createdAt?: string }, now: Date = new Date()): string | null {
  const startText = times.impactStartedAt ?? times.detectedAt ?? times.createdAt;
  if (!startText) return null;
  const start = new Date(startText).getTime();
  if (times.resolvedAt) {
    const resolved = `Impact ${formatImpactDuration(new Date(times.resolvedAt).getTime() - start)}`;
    if (!times.mitigatedAt) return resolved;
    return `${resolved} · mitigated after ${formatImpactDuration(new Date(times.mitigatedAt).getTime() - start)}`;
  }
  if (times.mitigatedAt) return `Mitigated after ${formatImpactDuration(new Date(times.mitigatedAt).getTime() - start)} · not resolved yet`;
  return `Impact ongoing for ${formatImpactDuration(now.getTime() - start)}`;
}

/** ISO → the value a datetime-local input shows, in the viewer's time zone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function IncidentTimesPanel({
  work,
  disabled,
  onUpdate,
  now,
}: {
  work: IncidentTimes & { createdAt?: string };
  disabled?: boolean;
  onUpdate: (update: IncidentTimes) => void;
  now?: Date;
}) {
  const summary = impactSummary(work, now);
  return (
    <div className="incident-times" aria-label="Incident timestamps">
      {summary ? <div className="incident-times__summary">{summary}</div> : null}
      {FIELDS.map(({ field, label, clearable }) => (
        <label key={field} className="incident-times__row">
          <span className="incident-times__label">{label}</span>
          <input
            type="datetime-local"
            aria-label={label}
            className="issue-panel__prop-select"
            disabled={disabled}
            value={toLocalInput(work[field])}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                if (clearable && work[field]) onUpdate({ [field]: null });
                return;
              }
              const date = new Date(value);
              if (!Number.isNaN(date.getTime())) onUpdate({ [field]: date.toISOString() });
            }}
          />
        </label>
      ))}
    </div>
  );
}
