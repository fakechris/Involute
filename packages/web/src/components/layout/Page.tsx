import type { ReactNode } from 'react';

/**
 * The one page skeleton (docs/design-system.md §3 rule 1, INV-1314):
 * PageHeader, an optional PageToolbar, then PageBody. Styles: styles/layout.css.
 */

export interface PageHeaderProps {
  /** Leading glyph before the title (14px, --fg-dim). */
  icon?: ReactNode | undefined;
  /** Rendered as the page's h1. */
  title: ReactNode;
  /** A number (or short node) beside the title, mono and dim. */
  count?: ReactNode | undefined;
  /** One line of dim text after the title / count; ellipsised when short of room. */
  hint?: ReactNode | undefined;
  /** Leading navigation (back link, breadcrumb) placed before the icon. */
  back?: ReactNode | undefined;
  /** Right-aligned controls (buttons, selects). */
  actions?: ReactNode | undefined;
}

/** 44px bar: [back] [icon] title [count] [hint] … [actions]. */
export function PageHeader({ icon, title, count, hint, back, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      {back ? <div className="page-header__back">{back}</div> : null}
      {icon ? <span className="page-header__icon" aria-hidden="true">{icon}</span> : null}
      <h1 className="page-header__title">{title}</h1>
      {count !== undefined && count !== null && count !== false ? (
        <span className="page-header__count mono">{count}</span>
      ) : null}
      {hint ? <span className="page-header__hint">{hint}</span> : null}
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export interface PageToolbarProps {
  /** Project scope: `ProjectFilterCombobox` (with quick pills). Always first. */
  projects?: ReactNode | undefined;
  /** What narrows the list: `WorkFilterBar`, search, FilterMenus, chips. */
  filters?: ReactNode | undefined;
  /** How the list is shown: sort, saved views, view switch, IQL. Right-aligned. */
  view?: ReactNode | undefined;
  'aria-label'?: string | undefined;
}

/**
 * The filter strip under the header. Slots render in a fixed order —
 * projects → filters → view — on one `--pad-x` gutter, so every list page
 * lines its filters up the same way.
 */
export function PageToolbar({ projects, filters, view, 'aria-label': ariaLabel }: PageToolbarProps) {
  if (!projects && !filters && !view) return null;
  return (
    <section className="page-toolbar" aria-label={ariaLabel}>
      {projects ? <div className="page-toolbar__slot page-toolbar__projects">{projects}</div> : null}
      {filters ? <div className="page-toolbar__slot page-toolbar__filters">{filters}</div> : null}
      {view ? <div className="page-toolbar__slot page-toolbar__view">{view}</div> : null}
    </section>
  );
}

export type PageBodyWidth = 'narrow' | 'default' | 'wide' | 'full';

export interface PageBodyProps {
  /** Content column: narrow 640 | default 880 | wide 1100 | full. */
  width?: PageBodyWidth | undefined;
  /** `none` for surfaces that draw to the edges (kanban, tables, graph canvas). */
  padding?: 'default' | 'none' | undefined;
  /** Extra classes on the content column (page scopes such as `ops`). */
  className?: string | undefined;
  'aria-label'?: string | undefined;
  children?: ReactNode;
}

/** The scrolling region under the header: padding `20px var(--pad-x)`, one of four widths. */
export function PageBody({ width = 'default', padding = 'default', className, 'aria-label': ariaLabel, children }: PageBodyProps) {
  const outer = ['page-body', padding === 'none' ? 'page-body--flush' : null].filter(Boolean).join(' ');
  const inner = ['page-body__inner', `page-body__inner--${width}`, className].filter(Boolean).join(' ');
  return (
    <div className={outer} aria-label={ariaLabel}>
      <div className={inner}>{children}</div>
    </div>
  );
}
