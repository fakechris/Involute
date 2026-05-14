import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import type { BoardIssueGroup, Html5BoardDragPayload, IssueSummary } from '../board/types';
import { parseHtml5BoardDragPayload } from '../board/utils';
import { IssueCard } from './IssueCard';
import { InlineCreate } from './InlineCreate';
import { IcoPlus } from './Icons';
import { PriorityIcon } from './Primitives';

interface KanbanViewProps {
  groups: BoardIssueGroup[];
  focusedIssueId: string | null;
  selectedIssueIds: string[];
  onSelectIssue: (issue: IssueSummary) => void;
  onToggleIssueSelection: (issue: IssueSummary) => void;
  onInlineCreate: (title: string, groupMeta?: BoardIssueGroup['meta']) => void;
  onNativeDropIssue?: ((payload: Html5BoardDragPayload, targetStateId: string) => void) | undefined;
  onNativeDragStart?: ((payload: Html5BoardDragPayload) => void) | undefined;
  onNativeDragEnd?: (() => void) | undefined;
}

function KanbanColumn({
  group,
  focusedIssueId,
  selectedIssueIds,
  onSelectIssue,
  onToggleIssueSelection,
  onInlineCreate,
  onNativeDropIssue,
  onNativeDragStart,
  onNativeDragEnd,
}: {
  group: BoardIssueGroup;
  focusedIssueId: string | null;
  selectedIssueIds: string[];
  onSelectIssue: (issue: IssueSummary) => void;
  onToggleIssueSelection: (issue: IssueSummary) => void;
  onInlineCreate: (title: string) => void;
  onNativeDropIssue?: ((payload: Html5BoardDragPayload, targetStateId: string) => void) | undefined;
  onNativeDragStart?: ((payload: Html5BoardDragPayload) => void) | undefined;
  onNativeDragEnd?: (() => void) | undefined;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const droppableId = group.meta?.stateId ?? group.id;

  const { isOver, setNodeRef } = useDroppable({
    id: droppableId,
    data: {
      stateId: group.meta?.stateId ?? null,
      title: group.label,
      type: 'column',
    },
  });

  return (
    <section
      className={`kanban-column${isOver ? ' kanban-column--active' : ''}`}
      aria-label={`${group.label} column`}
    >
      <div className="kanban-column-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {group.meta?.priority !== undefined && (
            <PriorityIcon level={group.meta.priority} size={12} />
          )}
          <span style={{ fontSize: 12, fontWeight: 600 }}>{group.label}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {group.issues.length}
          </span>
        </div>
        <button
          type="button"
          className="kanban-column-add"
          onClick={() => setIsCreating(true)}
          title="Create issue in this group"
        >
          <IcoPlus size={12} />
        </button>
      </div>

      <SortableContext
        items={group.issues.map((issue) => issue.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="kanban-column-body"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('application/x-involute-issue')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(event) => {
            const payload = parseHtml5BoardDragPayload(
              event.dataTransfer.getData('application/x-involute-issue'),
            );
            if (!payload || !group.meta?.stateId) return;
            event.preventDefault();
            onNativeDropIssue?.(payload, group.meta.stateId);
          }}
        >
          {isCreating && (
            <div className="kanban-card" style={{ padding: 0 }}>
              <InlineCreate
                contextLabel={group.label}
                onSubmit={(title) => onInlineCreate(title)}
                onCancel={() => setIsCreating(false)}
              />
            </div>
          )}
          {group.issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              isFocused={focusedIssueId === issue.id}
              isSelected={selectedIssueIds.includes(issue.id)}
              onSelect={onSelectIssue}
              onToggleSelected={onToggleIssueSelection}
              {...(onNativeDragStart ? { onNativeDragStart } : {})}
              {...(onNativeDragEnd ? { onNativeDragEnd } : {})}
            />
          ))}
          {group.issues.length === 0 && !isCreating && (
            <p className="board-column__empty">No issues</p>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

export function KanbanView({
  groups,
  focusedIssueId,
  selectedIssueIds,
  onSelectIssue,
  onToggleIssueSelection,
  onInlineCreate,
  onNativeDropIssue,
  onNativeDragStart,
  onNativeDragEnd,
}: KanbanViewProps) {
  return (
    <div className="kanban-container">
      {groups.map((group) => (
        <KanbanColumn
          key={group.id}
          group={group}
          focusedIssueId={focusedIssueId}
          selectedIssueIds={selectedIssueIds}
          onSelectIssue={onSelectIssue}
          onToggleIssueSelection={onToggleIssueSelection}
          onInlineCreate={(title) => onInlineCreate(title, group.meta)}
          onNativeDropIssue={onNativeDropIssue}
          onNativeDragStart={onNativeDragStart}
          onNativeDragEnd={onNativeDragEnd}
        />
      ))}
    </div>
  );
}
