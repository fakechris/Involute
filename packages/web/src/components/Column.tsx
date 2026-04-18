import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import type { Html5BoardDragPayload, IssueSummary } from '../board/types';
import { parseHtml5BoardDragPayload } from '../board/utils';
import { IssueCard } from './IssueCard';

interface ColumnProps {
  title: string;
  stateId: string;
  issues: IssueSummary[];
  focusedIssueId?: string | null;
  onSelectIssue?: (issue: IssueSummary) => void;
  onToggleIssueSelection?: (issue: IssueSummary) => void;
  selectedIssueIds?: string[];
  onNativeDropIssue?: (payload: Html5BoardDragPayload, targetStateId: string) => void;
  onNativeDragStart?: (payload: Html5BoardDragPayload) => void;
  onNativeDragEnd?: () => void;
}

export function Column({
  title,
  stateId,
  issues,
  focusedIssueId,
  onSelectIssue,
  onToggleIssueSelection,
  selectedIssueIds = [],
  onNativeDropIssue,
  onNativeDragStart,
  onNativeDragEnd,
}: ColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: stateId,
    data: {
      stateId,
      title,
      type: 'column',
    },
  });

  function getIssueCardNativeDragProps() {
    return {
      ...(onNativeDragStart ? { onNativeDragStart } : {}),
      ...(onNativeDragEnd ? { onNativeDragEnd } : {}),
    };
  }

  return (
    <section
      className={`board-column${isOver ? ' board-column--active' : ''}`}
      aria-label={`${title} column`}
      data-testid={`board-column-${stateId}`}
      data-state-id={stateId}
    >
      <div className="board-column__header">
        <h2>{title}</h2>
        <span className="board-column__count">{issues.length}</span>
      </div>

      <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="board-column__body"
          data-testid={`column-${title}`}
          data-droppable-state-id={stateId}
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

            if (!payload) {
              return;
            }

            event.preventDefault();
            onNativeDropIssue?.(payload, stateId);
          }}
        >
          {issues.length > 0 ? (
            issues.map((issue) =>
              onSelectIssue ? (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  isFocused={focusedIssueId === issue.id}
                  isSelected={selectedIssueIds.includes(issue.id)}
                  onSelect={onSelectIssue}
                  {...(onToggleIssueSelection ? { onToggleSelected: onToggleIssueSelection } : {})}
                  {...getIssueCardNativeDragProps()}
                />
              ) : (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  isFocused={focusedIssueId === issue.id}
                  isSelected={selectedIssueIds.includes(issue.id)}
                  {...(onToggleIssueSelection ? { onToggleSelected: onToggleIssueSelection } : {})}
                  {...getIssueCardNativeDragProps()}
                />
              ),
            )
          ) : (
            <p className="board-column__empty">No issues in {title} yet.</p>
          )}
        </div>
      </SortableContext>
    </section>
  );
}
