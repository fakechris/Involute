import type { IssueSummary, IssueUpdateMutationVariables } from '../board/types';

/**
 * One gesture's field edits, recorded for the session undo stack (INV-839).
 * A patch is whatever the gesture sent to issueUpdate; its reverse is the
 * same keys with the values the issue had before. Both carry the names a
 * toast needs, so undo can say "INV-12 priority set to High" without
 * looking anything up later.
 */
export type IssueFieldPatch = Omit<IssueUpdateMutationVariables['input'], 'expectedRevision'> & { snoozedUntil?: string | null };

export interface FieldUndoChange {
  issueId: string;
  identifier: string;
  /** What the gesture wrote. */
  after: IssueFieldPatch;
  /** What to write to take it back. */
  before: IssueFieldPatch;
  /** Revision after this gesture; the reverse write sends it as expectedRevision. */
  revision: number;
  /** "priority set to High" — how the gesture reads when undone/redone. */
  summary: string;
  reverseSummary: string;
}

export interface FieldNames {
  stateName?: (id: string) => string | undefined;
  userName?: (id: string | null) => string | undefined;
  labelNames?: (ids: string[]) => string[];
}

const PRIORITY_NAMES: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

/** The patch's keys, read from the issue as it was before the gesture. */
export function beforePatch(issue: IssueSummary, after: IssueFieldPatch): IssueFieldPatch {
  const before: IssueFieldPatch = {};
  for (const key of Object.keys(after) as Array<keyof IssueFieldPatch>) {
    switch (key) {
      case 'stateId': before.stateId = issue.state.id; break;
      case 'priority': before.priority = issue.priority; break;
      case 'assigneeId': before.assigneeId = issue.assignee?.id ?? null; break;
      case 'labelIds': before.labelIds = issue.labels.nodes.map((label) => label.id); break;
      case 'title': before.title = issue.title; break;
      case 'description': before.description = issue.description ?? null; break;
      case 'parentId': before.parentId = issue.parent?.id ?? null; break;
      case 'kind': if (issue.kind) before.kind = issue.kind as NonNullable<IssueFieldPatch['kind']>; break;
      case 'snoozedUntil': before.snoozedUntil = (issue as { snoozedUntil?: string | null }).snoozedUntil ?? null; break;
      case 'outcome': case 'scope': case 'constraints': case 'acceptance': case 'verification':
        before[key] = ((issue as unknown as Record<string, unknown>)[key] as string | null | undefined) ?? null; break;
      default: break;
    }
  }
  return before;
}

function describe(patch: IssueFieldPatch, names: FieldNames): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof IssueFieldPatch, unknown]>) {
    switch (key) {
      case 'stateId': parts.push(`moved to ${names.stateName?.(String(value)) ?? 'another state'}`); break;
      case 'priority': parts.push(`priority set to ${PRIORITY_NAMES[Number(value)] ?? String(value)}`); break;
      case 'assigneeId': parts.push(value ? `assigned to ${names.userName?.(String(value)) ?? 'someone'}` : 'unassigned'); break;
      case 'labelIds': {
        const labels = names.labelNames?.(value as string[]) ?? [];
        parts.push(labels.length ? `labels set to ${labels.join(', ')}` : 'labels cleared');
        break;
      }
      case 'title': parts.push('title updated'); break;
      case 'description': parts.push('description updated'); break;
      case 'parentId': parts.push(value ? 'moved under another parent' : 'parent removed'); break;
      case 'kind': parts.push(`kind set to ${String(value)}`); break;
      case 'snoozedUntil': parts.push(value ? 'snoozed' : 'unsnoozed'); break;
      default: parts.push(`${key} updated`); break;
    }
  }
  return parts.join(', ') || 'updated';
}

/** One change entry for a gesture that just saved `after` on `issue`, now at `revision`. */
export function fieldChange(issue: IssueSummary, after: IssueFieldPatch, revision: number, names: FieldNames = {}): FieldUndoChange | null {
  const keys = Object.keys(after).filter((key) => key !== 'cascadeRepository');
  if (keys.length === 0) return null;
  const before = beforePatch(issue, after);
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    after,
    before,
    revision,
    summary: describe(after, names),
    reverseSummary: describe(before, names),
  };
}

export function formatFieldChanges(changes: FieldUndoChange[]): string {
  if (changes.length === 0) return '';
  const ids = changes.map((change) => change.identifier);
  const shown = ids.slice(0, 3);
  const extra = ids.length - shown.length;
  const who = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  const summaries = [...new Set(changes.map((change) => change.summary))];
  return `${who} ${summaries.length === 1 ? summaries[0] : 'updated'}`;
}
