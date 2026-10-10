import type { BugSlaSummary, FollowUpDeadlineSummary } from '../board/types';

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

export function describeFollowUpDeadline(deadline: FollowUpDeadlineSummary): string {
  switch (deadline.status) {
    case 'BREACHED':
      return `Follow-up overdue ${formatSlaDuration(deadline.remainingMs)}`;
    case 'PAUSED':
      return `Follow-up paused · ${formatSlaDuration(deadline.remainingMs)} left`;
    case 'MET':
      return 'Follow-up done in time';
    case 'DECLINED':
      return 'Follow-up declined';
    default:
      return `Follow-up due in ${formatSlaDuration(deadline.remainingMs)}`;
  }
}

/**
 * An incident follow-up's deadline (INV-1127): the same clock as the bug SLA,
 * a longer budget. Hidden once met or declined unless `showMet`.
 */
export function FollowUpDeadlineBadge({ deadline, showMet = false }: { deadline: FollowUpDeadlineSummary | null | undefined; showMet?: boolean }) {
  if (!deadline || ((deadline.status === 'MET' || deadline.status === 'DECLINED') && !showMet)) return null;
  const label = describeFollowUpDeadline(deadline);
  const due = deadline.dueAt ? ` · due ${new Date(deadline.dueAt).toLocaleString()}` : '';
  const incidents = deadline.incidents?.length ? ` · from ${deadline.incidents.map((incident) => incident.identifier).join(', ')}` : '';
  return (
    <span
      className={`bug-sla bug-sla--${deadline.status.toLowerCase().replace('_', '-')}`}
      title={`${label} (budget ${Math.round(deadline.budgetHours / 24)}d)${due}${incidents}`}
      aria-label={label}
    >
      {label}
    </span>
  );
}
