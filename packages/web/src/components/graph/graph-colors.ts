import type { WorkflowStateType } from '../../board/types';
import { getStatusColorVar, statusKindForStateType } from '../StatusIcon';

const STATE_TYPES: WorkflowStateType[] = ['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW', 'COMPLETED', 'CANCELED'];

/**
 * The hues StatusIcon draws, keyed by state type so the graph and the board
 * agree. Read from StatusIcon — the one place status colours are defined
 * (docs/design-system.md §3 rule 9).
 */
export const STATE_TYPE_COLOR = Object.fromEntries(
  STATE_TYPES.map((type) => [type, getStatusColorVar(statusKindForStateType(type))]),
) as Record<WorkflowStateType, string>;

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
