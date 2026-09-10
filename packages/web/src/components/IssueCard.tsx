import { useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { Html5BoardDragPayload, IssueSummary } from '../board/types';
import { createHtml5BoardDragPayload } from '../board/utils';
import { StatusIcon } from './StatusIcon';

interface IssueCardProps {
  issue: IssueSummary;
  isFocused?: boolean;
  isSelected?: boolean;
  onSelect?: (issue: IssueSummary) => void;
  onToggleSelected?: (issue: IssueSummary) => void;
  sortable?: boolean;
  onNativeDragStart?: (payload: Html5BoardDragPayload) => void;
  onNativeDragEnd?: () => void;
  onFilterProject?: ((projectKey: string) => void) | undefined;
}

export function getProjectColor(repository?: string | null): { bg: string; fg: string; border: string } {
  if (!repository) {
    return { bg: 'var(--bg-hover)', fg: 'var(--fg-muted)', border: 'var(--border)' };
  }
  const PALETTE = [
    { bg: 'rgba(99, 102, 241, 0.15)', fg: '#818cf8', border: 'rgba(99, 102, 241, 0.35)' }, // indigo
    { bg: 'rgba(16, 185, 129, 0.15)', fg: '#34d399', border: 'rgba(16, 185, 129, 0.35)' }, // emerald
    { bg: 'rgba(245, 158, 11, 0.15)', fg: '#fbbf24', border: 'rgba(245, 158, 11, 0.35)' }, // amber
    { bg: 'rgba(244, 63, 94, 0.15)', fg: '#fb7185', border: 'rgba(244, 63, 94, 0.35)' },   // rose
    { bg: 'rgba(6, 182, 212, 0.15)', fg: '#22d3ee', border: 'rgba(6, 182, 212, 0.35)' },   // cyan
    { bg: 'rgba(168, 85, 247, 0.15)', fg: '#c084fc', border: 'rgba(168, 85, 247, 0.35)' }, // purple
    { bg: 'rgba(249, 115, 22, 0.15)', fg: '#fb923c', border: 'rgba(249, 115, 22, 0.35)' }, // orange
    { bg: 'rgba(14, 165, 233, 0.15)', fg: '#38bdf8', border: 'rgba(14, 165, 233, 0.35)' }, // sky
    { bg: 'rgba(132, 204, 22, 0.15)', fg: '#a3e635', border: 'rgba(132, 204, 22, 0.35)' }, // lime
    { bg: 'rgba(236, 72, 153, 0.15)', fg: '#f472b6', border: 'rgba(236, 72, 153, 0.35)' }, // pink
  ];
  let hash = 0;
  for (let i = 0; i < repository.length; i++) {
    hash = (hash * 31 + repository.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] ?? { bg: 'var(--bg-hover)', fg: 'var(--fg-muted)', border: 'var(--border)' };
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
  isFocused = false,
  isSelected = false,
  onSelect,
  onToggleSelected,
  sortable = true,
  onNativeDragEnd,
  onNativeDragStart,
  onFilterProject,
}: IssueCardProps) {
  const suppressNextSelectRef = useRef(false);
  const {
    attributes,
    listeners,
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
      className={`issue-card${isDragging ? ' issue-card--dragging' : ''}${isSelected ? ' issue-card--selected' : ''}${isFocused ? ' issue-card--focused' : ''}`}
      aria-label={`${issue.identifier} ${issue.title}`}
      data-testid={`issue-card-${issue.id}`}
      data-issue-identifier={issue.identifier}
      data-state-name={issue.state.name}
      data-focused={isFocused ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      data-sortable={sortable ? 'true' : 'false'}
      draggable={sortable}
      onDragStart={(event) => {
        const payload: Html5BoardDragPayload = {
          issueId: issue.id,
          stateId: issue.state.id,
        };

        suppressNextSelectRef.current = true;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(
          'application/x-involute-issue',
          createHtml5BoardDragPayload(payload.issueId, payload.stateId),
        );
        event.dataTransfer.setData('text/plain', issue.id);
        onNativeDragStart?.(payload);
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          suppressNextSelectRef.current = false;
        }, 0);
        onNativeDragEnd?.();
      }}
      {...(sortable ? attributes : {})}
      {...(sortable ? listeners : {})}
      >
      {onToggleSelected ? (
        <label
          className="issue-card__selection"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            aria-label={`Select ${issue.identifier}`}
            checked={isSelected}
            onChange={() => onToggleSelected(issue)}
          />
        </label>
      ) : null}
      {sortable ? (
        <span
          className="issue-card__drag-handle"
          aria-hidden="true"
          data-testid={`issue-drag-surface-${issue.identifier}`}
        >
          ⋮⋮
        </span>
      ) : null}
      <button
        type="button"
        className="issue-card__button"
        onClick={() => {
          if (suppressNextSelectRef.current) {
            suppressNextSelectRef.current = false;
            return;
          }

          onSelect?.(issue);
        }}
        aria-label={`Open ${issue.identifier}`}
      >
        <div className="issue-card__header">
          <span className="issue-card__identifier">
            <StatusIcon stateName={issue.state.name} size={12} />
            {issue.identifier}
          </span>
          <div className="issue-card__header-tags">
            {issue.repository ? (
              <span
                role={onFilterProject ? 'button' : undefined}
                tabIndex={onFilterProject ? 0 : undefined}
                className={`issue-card__repo-badge${onFilterProject ? ' issue-card__repo-badge--interactive' : ''}`}
                style={{
                  backgroundColor: getProjectColor(issue.repository).bg,
                  color: getProjectColor(issue.repository).fg,
                  borderColor: getProjectColor(issue.repository).border,
                }}
                title={`Project: ${issue.repository}`}
                data-testid={`issue-repo-${issue.id}`}
                onClick={(e) => {
                  if (onFilterProject) {
                    e.stopPropagation();
                    e.preventDefault();
                    onFilterProject(issue.repository!);
                  }
                }}
                onKeyDown={(e) => {
                  if (onFilterProject && (e.key === 'Enter' || e.key === ' ')) {
                    e.stopPropagation();
                    e.preventDefault();
                    onFilterProject(issue.repository!);
                  }
                }}
              >
                {issue.repository.includes('/') ? issue.repository.split('/')[1] : issue.repository}
              </span>
            ) : null}
            {issue.kind && issue.kind !== 'ISSUE' ? (
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  padding: '1px 5px',
                  borderRadius: 'var(--r-1)',
                  background: issue.kind === 'PROJECT' ? 'var(--accent-weak)' : 'var(--bg-hover)',
                  color: issue.kind === 'PROJECT' ? 'var(--accent)' : 'var(--fg-dim)',
                  border: `1px solid ${issue.kind === 'PROJECT' ? 'var(--accent-border)' : 'var(--border)'}`,
                  textTransform: 'uppercase',
                }}
              >
                {issue.kind}
              </span>
            ) : null}
          </div>
        </div>

        <h3 className="issue-card__title">{issue.title}</h3>

        <div className="issue-card__labels">
          {issue.labels.nodes.slice(0, 2).map((label) => (
            <span key={label.id} className={getLabelClassName(label.name)}>
              {label.name}
            </span>
          ))}
          {issue.labels.nodes.length > 2 ? (
            <span
              className="issue-card__label issue-card__label--neutral"
              title={issue.labels.nodes
                .slice(2)
                .map((label) => label.name)
                .join(', ')}
            >
              +{issue.labels.nodes.length - 2}
            </span>
          ) : null}
        </div>

        <div className="issue-card__footer">
          {issue.claim ? (
            <span
              className="issue-card__claim-badge"
              title={`Agent 租约中: ${issue.claim.actor.name ?? 'Agent'} (租约有效至 ${new Date(issue.claim.leaseUntil).toLocaleTimeString()})`}
            >
              🤖 {issue.claim.actor.name ?? 'Agent'}
            </span>
          ) : null}
          <div className="issue-card__assignee-group">
            {issue.assignee ? (
              <div className="issue-card__avatar" aria-hidden="true">
                {getInitials(issue.assignee.name)}
              </div>
            ) : null}
            <span className="issue-card__assignee">{issue.assignee?.name ?? (issue.claim ? '' : 'Unassigned')}</span>
          </div>
        </div>
      </button>
    </article>
  );
}
