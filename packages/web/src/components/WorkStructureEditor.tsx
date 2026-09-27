import { useMemo } from 'react';
import { useQuery } from '@apollo/client/react';

import { readStoredTeamKey } from '../board/utils';
import { GRAPH_PROJECTS_QUERY } from '../work/queries';
import type { GraphProjectsQueryData, WorkKind } from '../work/types';
import type { CreatePlacement } from '../work/placement';
import { PlacementPicker } from './PlacementPicker';

export interface StructureUpdate {
  parentId?: string | null;
  repository?: string | null;
  priority?: number;
  kind?: WorkKind;
}

interface StructuredWork {
  id: string;
  kind?: WorkKind | null;
  priority: number;
  repository?: string | null;
  parent?: { id: string; identifier: string; title: string; kind?: WorkKind | null } | null;
}

const PRIORITIES = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
];

const KINDS: Array<{ value: WorkKind; label: string }> = [
  { value: 'ISSUE', label: 'Issue' },
  { value: 'EPIC', label: 'Epic' },
  { value: 'MILESTONE', label: 'Milestone' },
  { value: 'DECISION', label: 'Decision' },
];

/** Where the work sits now, in the picker's terms: its project for "No milestone". */
export function currentPlacement(work: StructuredWork): CreatePlacement | null {
  if (!work.repository || !work.parent) return null;
  if (work.parent.kind === 'PROJECT') return { repository: work.repository, parentId: work.parent.identifier };
  const prefix = !work.parent.kind || work.parent.kind === 'ISSUE' ? 'Sub-issue of' : 'In';
  // Labelled, so a finished milestone or a parent issue is still shown as the current place.
  return { repository: work.repository, parentId: work.parent.id, parentLabel: `${prefix} ${work.parent.identifier} — ${work.parent.title}` };
}

/**
 * Structure of committed work a person can change (INV-791): where it sits
 * (project, then No milestone / milestone / epic), its priority and its kind.
 * Refusals — an illegal parent, a kind the hierarchy does not allow — come back
 * from the server with the reason, shown by the caller.
 */
export function WorkStructureEditor({
  work,
  disabled,
  onUpdate,
}: {
  work: StructuredWork;
  disabled?: boolean;
  onUpdate: (update: StructureUpdate) => void;
}) {
  const teamKey = readStoredTeamKey();
  const { data } = useQuery<GraphProjectsQueryData>(GRAPH_PROJECTS_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
  });
  const projects = data?.projectSummary?.projects ?? [];
  const value = useMemo(() => currentPlacement(work), [work]);
  const kind = work.kind ?? 'ISSUE';

  return (
    <div className="work-structure">
      {kind !== 'PROJECT' ? (
        <PlacementPicker
          projects={projects}
          value={value}
          source={null}
          kind={kind}
          excludeId={work.id}
          autoCorrect={false}
          disabled={Boolean(disabled)}
          onChange={(next) => {
            if (!next || next.parentId === value?.parentId) return;
            onUpdate({ parentId: next.parentId, ...(next.repository !== work.repository ? { repository: next.repository } : {}) });
          }}
        />
      ) : null}
      <label className="field-stack">
        <span>Priority</span>
        <select
          aria-label="Issue priority"
          value={work.priority}
          disabled={disabled}
          onChange={(event) => onUpdate({ priority: Number(event.target.value) })}
        >
          {PRIORITIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'PROJECT' ? (
        <label className="field-stack">
          <span>Kind</span>
          <select
            aria-label="Issue kind"
            value={kind}
            disabled={disabled}
            onChange={(event) => onUpdate({ kind: event.target.value as WorkKind })}
          >
            {KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
