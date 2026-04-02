import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { IssueSummary } from '../board/types';

interface IssueCardProps {
  issue: IssueSummary;
  onSelect?: (issue: IssueSummary) => void;
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

export function IssueCard({ issue, onSelect }: IssueCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.id,
    data: {
      issue,
      type: 'issue-card',
    },
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
      data-state-name={issue.state.name}
      {...attributes}
      {...listeners}
    >
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
