import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Btn } from '../Primitives';

/**
 * State displays (docs/design-system.md §3 rule 7, INV-1314): one empty state,
 * one loading line, one inline error, one stat tile, one segmented control and
 * one bulk action bar. Styles: styles/layout.css.
 */

export interface EmptyStateProps {
  /** Glyph in a 40px tile above the title (block size only). */
  icon?: ReactNode | undefined;
  title: ReactNode;
  body?: ReactNode | undefined;
  /** A button or link under the body. */
  action?: ReactNode | undefined;
  /** `block`: centred panel for an empty page. `inline`: one dim line inside a section. */
  size?: 'block' | 'inline' | undefined;
}

export function EmptyState({ icon, title, body, action, size = 'block' }: EmptyStateProps) {
  if (size === 'inline') {
    return (
      <div className="empty-state empty-state--inline">
        <p className="empty-state__title">{title}</p>
        {body ? <p className="empty-state__body">{body}</p> : null}
        {action ? <div className="empty-state__action">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon" aria-hidden="true">{icon}</div> : null}
      <h3 className="empty-state__title">{title}</h3>
      {body ? <p className="empty-state__body">{body}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

/** One dim line saying what is loading; announced politely. */
export function LoadingState({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p className="loading-state" aria-live="polite">
      {children}
    </p>
  );
}

export interface InlineErrorProps {
  children: ReactNode;
  /** `alert` (default) announces it; `none` for errors already announced elsewhere. */
  role?: 'alert' | 'none' | undefined;
  /** `block` adds a tinted box for page-level failures. */
  variant?: 'text' | 'block' | undefined;
}

export function InlineError({ children, role = 'alert', variant = 'text' }: InlineErrorProps) {
  return (
    <p className={variant === 'block' ? 'inline-error inline-error--block' : 'inline-error'} role={role === 'alert' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Colours the value: alert (danger), warn, success; default is --fg. */
  tone?: 'default' | 'alert' | 'warn' | 'success' | undefined;
  /** Makes the tile a link. */
  to?: string | undefined;
  title?: string | undefined;
  /** Extra line under the label. */
  detail?: ReactNode | undefined;
}

export function StatTile({ label, value, tone = 'default', to, title, detail }: StatTileProps) {
  const className = tone === 'default' ? 'stat-tile' : `stat-tile stat-tile--${tone}`;
  const content = (
    <>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__label">{label}</span>
      {detail ? <span className="stat-tile__detail">{detail}</span> : null}
    </>
  );
  if (to) {
    return <Link to={to} className={className} title={title}>{content}</Link>;
  }
  return <div className={className} title={title}>{content}</div>;
}

/** A responsive row of StatTiles. */
export function StatRow({ children, 'aria-label': ariaLabel }: { children: ReactNode; 'aria-label'?: string | undefined }) {
  return <div className="stat-row" aria-label={ariaLabel} role={ariaLabel ? 'group' : undefined}>{children}</div>;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode | undefined;
  /** Accessible name when the label alone is ambiguous. */
  'aria-label'?: string | undefined;
  title?: string | undefined;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  /**
   * `buttons` (default): a group of toggle buttons (aria-pressed).
   * `tabs`: a tablist (aria-selected), for switches that swap the whole view.
   */
  semantics?: 'buttons' | 'tabs' | undefined;
}

export function SegmentedControl<T extends string>({ options, value, onChange, 'aria-label': ariaLabel, semantics = 'buttons' }: SegmentedControlProps<T>) {
  const tabs = semantics === 'tabs';
  return (
    <div className="segmented" role={tabs ? 'tablist' : 'group'} aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? active : undefined}
            aria-pressed={tabs ? undefined : active}
            aria-label={option['aria-label']}
            title={option.title}
            className={active ? 'segmented__option is-active' : 'segmented__option'}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface BulkActionBarProps {
  /** Number of selected items; the bar is hidden at 0. */
  count: number;
  /** "selected" by default; e.g. "candidates selected". */
  noun?: string | undefined;
  onSelectAll?: (() => void) | undefined;
  selectAllLabel?: string | undefined;
  /** Disables Select all (everything already selected, or loading). */
  selectAllDisabled?: boolean | undefined;
  onClear: () => void;
  clearLabel?: string | undefined;
  /** Status line under the actions (result of the last batch, an error). */
  status?: ReactNode | undefined;
  'aria-label'?: string | undefined;
  /** The batch actions, right of the count. */
  children?: ReactNode;
}

/**
 * The one bulk bar: sticky at the bottom of PageBody, raised surface, hairline
 * border, --shadow-md, no blur. Count, Select all / Clear, then the actions.
 */
export function BulkActionBar({
  count,
  noun = 'selected',
  onSelectAll,
  selectAllLabel = 'Select all',
  selectAllDisabled,
  onClear,
  clearLabel = 'Clear',
  status,
  'aria-label': ariaLabel = 'Bulk actions',
  children,
}: BulkActionBarProps) {
  if (count <= 0) return null;
  return (
    <section className="bulk-action-bar" aria-label={ariaLabel}>
      <div className="bulk-action-bar__row">
        <strong className="bulk-action-bar__count">{count} {noun}</strong>
        {onSelectAll ? (
          <Btn variant="subtle" onClick={onSelectAll} disabled={selectAllDisabled}>{selectAllLabel}</Btn>
        ) : null}
        <Btn variant="ghost" onClick={onClear}>{clearLabel}</Btn>
        {children ? <div className="bulk-action-bar__actions">{children}</div> : null}
      </div>
      {status ? <div className="bulk-action-bar__status">{status}</div> : null}
    </section>
  );
}
