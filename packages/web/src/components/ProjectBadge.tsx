import type { KeyboardEvent, MouseEvent } from 'react';

/**
 * The project a piece of work belongs to (INV-1536): one badge wherever a
 * person needs to see it — a board card, the issue drawer and page, the
 * backlog table, the projects list. A project is named by its repository; the
 * badge shows the short name, the full one on hover, in a colour that stays
 * the same for that repository everywhere.
 */

// Returns a stable palette class (proj-color-0..9) for a repository.
// Actual colors live in app.css so they can adapt to light/dark themes.
export function getProjectColorClass(repository?: string | null): string | null {
  if (!repository) {
    return null;
  }
  let hash = 0;
  for (let i = 0; i < repository.length; i++) {
    hash = (hash * 31 + repository.charCodeAt(i)) >>> 0;
  }
  return `proj-color-${hash % 10}`;
}

/** `owner/name` → `name`. */
export function projectShortName(repository: string): string {
  return repository.includes('/') ? repository.split('/')[1]! : repository;
}

export interface ProjectBadgeProps {
  repository: string | null | undefined;
  /** Shown when there is no project; omit to render nothing then. */
  emptyLabel?: string | undefined;
  /** Makes the badge a control, e.g. "filter the board to this project". */
  onSelect?: ((repository: string) => void) | undefined;
  /** Tooltip prefix (default "Project"). */
  titlePrefix?: string | undefined;
  className?: string | undefined;
  'data-testid'?: string | undefined;
}

export function ProjectBadge({
  repository,
  emptyLabel,
  onSelect,
  titlePrefix = 'Project',
  className,
  'data-testid': testId,
}: ProjectBadgeProps) {
  if (!repository) {
    if (!emptyLabel) return null;
    return (
      <span className={['project-badge', 'project-badge--none', className].filter(Boolean).join(' ')} data-testid={testId}>
        {emptyLabel}
      </span>
    );
  }

  const select = onSelect
    ? (event: MouseEvent | KeyboardEvent) => {
        // The badge sits inside a card or row that opens on click.
        event.stopPropagation();
        event.preventDefault();
        onSelect(repository);
      }
    : undefined;

  return (
    <span
      role={select ? 'button' : undefined}
      tabIndex={select ? 0 : undefined}
      className={['project-badge', select ? 'project-badge--interactive' : null, getProjectColorClass(repository), className]
        .filter(Boolean)
        .join(' ')}
      title={`${titlePrefix}: ${repository}`}
      data-testid={testId}
      onClick={select}
      onKeyDown={
        select
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') select(event);
            }
          : undefined
      }
    >
      {projectShortName(repository)}
    </span>
  );
}
