import type { BugSlaSummary } from '../board/types';

const HOUR = 3_600_000;

/** "5h", "2d 3h", "40m" — coarse enough to read at a glance. */
export function formatSlaDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / 60_000))}m`;
  if (abs < 48 * HOUR) return `${Math.floor(abs / HOUR)}h`;
  const days = Math.floor(abs / (24 * HOUR));
  const hours = Math.floor((abs % (24 * HOUR)) / HOUR);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function describeSla(sla: BugSlaSummary): string {
  switch (sla.status) {
    case 'BREACHED':
      return `SLA breached ${formatSlaDuration(sla.remainingMs)} ago`;
    case 'PAUSED':
      return `SLA paused · ${formatSlaDuration(sla.remainingMs)} left`;
    case 'MET':
      return 'SLA met';
    default:
      return `SLA ${formatSlaDuration(sla.remainingMs)} left`;
  }
}

/**
 * A committed bug's SLA (INV-750): time left, paused in Review, or breached.
 * Hidden once met unless `showMet` (the detail view keeps the record).
 */
export function BugSlaBadge({ sla, showMet = false }: { sla: BugSlaSummary | null | undefined; showMet?: boolean }) {
  if (!sla || (sla.status === 'MET' && !showMet)) return null;
  const label = describeSla(sla);
  const due = sla.dueAt ? ` · due ${new Date(sla.dueAt).toLocaleString()}` : '';
  return (
    <span
      className={`bug-sla bug-sla--${sla.status.toLowerCase().replace('_', '-')}`}
      title={`${label} (budget ${sla.budgetHours}h)${due}`}
      aria-label={label}
    >
      {label}
    </span>
  );
}
