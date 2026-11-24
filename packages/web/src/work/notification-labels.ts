/** A notification type in words, for Activity and the notification bell (INV-2135). */
export function formatNotificationType(type: string): string {
  switch (type) {
    case 'decision.requested':
      return 'Decision requested';
    case 'run.completed':
      return 'Run completed';
    case 'work.accepted':
      return 'Work accepted';
    case 'work.committed':
      return 'Candidate committed';
    case 'work.rejected':
      return 'Candidate declined';
    case 'work.uncommitted':
      return 'Moved back to candidates';
    case 'work.review_rejected':
      return 'Returned to Ready';
    case 'work.claim_expired':
      return 'Agent claim expired';
    case 'run.stale':
      return 'Agent run went quiet';
    case 'review.overdue':
      return 'Fixed bug waiting too long for review';
    case 'review.digest':
      return 'Waiting for your review';
    case 'attention.digest':
      return 'What needs you today';
    case 'research.closable':
      return 'Research can be closed';
    case 'incident.closable':
      return 'Incident can be closed';
    case 'delivery.approved':
      return 'Delivery change approved';
    case 'executor.dispatched':
      return 'Sent to an agent';
    case 'delivery.declined':
      return 'Delivery change declined';
    case 'contract.breached':
      return 'Contract breached';
    case 'evidence.submitted':
      return 'Evidence submitted';
    case 'webhook.disabled':
      return 'Webhook disabled';
    case 'bug.reported':
      return 'Bug reported';
    case 'contract.amendment_proposed':
      return 'Contract change proposed';
    case 'duplicate.marked':
      return 'Marked as duplicate';
    case 'duplicate.original_changed':
      return 'Original of your duplicate changed';
    case 'bug.sla_at_risk':
      return 'Bug SLA at risk';
    case 'bug.sla_breached':
      return 'Bug SLA breached';
    case 'incident.follow_up_at_risk':
      return 'Incident follow-up due soon';
    case 'incident.follow_up_overdue':
      return 'Incident follow-up overdue';
    case 'work.proposed_batch':
      return 'New candidates';
    case 'delivery.proposed':
      return 'Delivery change proposed';
    case 'executor.exhausted':
      return 'Agent gave up after all attempts';
    case 'contract.amendment_accepted':
      return 'Contract change accepted';
    case 'contract.amendment_rejected':
      return 'Contract change declined';
    default:
      return type
        .split('.')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}
