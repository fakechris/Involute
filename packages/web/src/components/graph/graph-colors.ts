import type { WorkflowStateType } from '../../board/types';

// Same hues StatusIcon draws, keyed by state type so the graph and the board agree.
export const STATE_TYPE_COLOR: Record<WorkflowStateType, string> = {
  BACKLOG: '#6b7280',
  UNSTARTED: '#64748b',
  STARTED: '#f59e0b',
  REVIEW: '#7c88ff',
  COMPLETED: '#10b981',
  CANCELED: '#ef4444',
};

export const STATE_TYPE_ORDER: WorkflowStateType[] = ['COMPLETED', 'REVIEW', 'STARTED', 'UNSTARTED', 'BACKLOG', 'CANCELED'];

export const STATE_TYPE_LABEL: Record<WorkflowStateType, string> = {
  BACKLOG: 'Backlog',
  UNSTARTED: 'Ready',
  STARTED: 'In Progress',
  REVIEW: 'In Review',
  COMPLETED: 'Done',
  CANCELED: 'Canceled',
};

/** A stable hue per milestone so its items share a stripe colour across views. */
export function milestoneHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}
