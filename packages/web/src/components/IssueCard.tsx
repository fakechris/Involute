import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { Html5BoardDragPayload, IssueSummary } from '../board/types';
import { createHtml5BoardDragPayload } from '../routes/BoardPage';

interface IssueCardProps {
  issue: IssueSummary;
  onSelect?: (issue: IssueSummary) => void;
  sortable?: boolean;
  onNativeDragStart?: (payload: Html5BoardDragPayload) => void;
  onNativeDragEnd?: () => void;
}

function getInitials(name: string | null | undefined): string {
  if (!name) {
    return '?';
  }

  return name
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
}

function getLabelClassName(labelName: string): string {
  const normalized = labelName.toLowerCase();

  if (normalized.includes('bug') || normalized.includes('blocked')) {
    return 'issue-card__label issue-card__label--danger';
  }

  if (normalized.includes('feature') || normalized.includes('improvement')) {
    return 'issue-card__label issue-card__label--accent';
  }

  return 'issue-card__label issue-card__label--neutral';
}

export function IssueCard({
  issue,
  onSelect,
  sortable = true,
  onNativeDragEnd,
  onNativeDragStart,
}: IssueCardProps) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: issue.id,
    data: {
      issue,
      type: 'issue-card',
      stateId: issue.state.id,
    },
    disabled: !sortable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`issue-card${isDragging ? ' issue-card--dragging' : ''}`}
      aria-label={`${issue.identifier} ${issue.title}`}
      data-testid={`issue-card-${issue.id}`}
      data-issue-identifier={issue.identifier}
      data-state-name={issue.state.name}
      data-sortable={sortable ? 'true' : 'false'}
    >
      {sortable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="issue-card__drag-handle"
          aria-label={`Drag ${issue.identifier}`}
          data-testid={`issue-drag-handle-${issue.identifier}`}
          draggable
          onDragStart={(event) => {
            const payload: Html5BoardDragPayload = {
              issueId: issue.id,
              stateId: issue.state.id,
            };

            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(
              'application/x-involute-issue',
              createHtml5BoardDragPayload(payload.issueId, payload.stateId),
            );
            event.dataTransfer.setData('text/plain', issue.id);
            onNativeDragStart?.(payload);
          }}
          onDragEnd={() => onNativeDragEnd?.()}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
      ) : null}
      <button
        type="button"
        className="issue-card__button"
        onClick={() => onSelect?.(issue)}
        aria-label={`Open ${issue.identifier}`}
      >
        <div className="issue-card__header">
          <span className="issue-card__identifier">{issue.identifier}</span>
        </div>

        <h3 className="issue-card__title">{issue.title}</h3>

        <div className="issue-card__labels">
          {issue.labels.nodes.map((label) => (
            <span key={label.id} className={getLabelClassName(label.name)}>
              {label.name}
            </span>
          ))}
        </div>

        <div className="issue-card__footer">
          <div className="issue-card__avatar" aria-hidden="true">
            {getInitials(issue.assignee?.name)}
          </div>
          <span className="issue-card__assignee">{issue.assignee?.name ?? 'Unassigned'}</span>
        </div>
      </button>
    </article>
  );
}
