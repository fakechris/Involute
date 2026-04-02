import type { IssueSummary } from '../board/types';

interface IssueCardProps {
  issue: IssueSummary;
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

export function IssueCard({ issue }: IssueCardProps) {
  return (
    <article className="issue-card" aria-label={`${issue.identifier} ${issue.title}`}>
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
    </article>
  );
}
