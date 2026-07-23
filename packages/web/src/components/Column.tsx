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
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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
  collapsed = false,
  onToggleCollapse,
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

  const classNames = [
    'board-column',
    isOver ? 'board-column--active' : '',
    collapsed ? 'board-column--collapsed' : '',
  ].filter(Boolean).join(' ');

  if (collapsed) {
    return (
      <section
        className={classNames}
        aria-label={`${title} column (collapsed)`}
        data-testid={`board-column-${stateId}`}
        data-state-id={stateId}
        onClick={onToggleCollapse}
      >
        <div className="board-column__header">
          <h2>{title}</h2>
          <span className="board-column__count">{issues.length}</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className={classNames}
      aria-label={`${title} column`}
      data-testid={`board-column-${stateId}`}
      data-state-id={stateId}
    >
      <div className="board-column__header">
        <h2>{title}</h2>
        <span className="board-column__count">{issues.length}</span>
        {onToggleCollapse ? (
          <button
            type="button"
            className="board-column__collapse-toggle"
            onClick={onToggleCollapse}
            aria-label={`Collapse ${title} column`}
            title="Collapse column"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-90 6 6)" />
            </svg>
          </button>
        ) : null}
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
