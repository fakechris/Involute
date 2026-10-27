import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { LabelPill, PriorityIcon } from '../Primitives';
import { StatusIcon } from '../StatusIcon';
import { Badge } from '../status';

/**
 * The one list row (docs/design-system.md §3 rule 6, INV-1315). Five slots on
 * one line — leading (icons, checkbox), id (mono, never shrinks), title (one
 * line, ellipsis), meta (muted chips/text), trailing (actions) — plus an
 * optional detail block under the line. Styles: styles/content.css.
 *
 * Opening: with `to` (or `onOpen`) the id + title become one link (or button)
 * that also covers the row; controls in `trailing` stay clickable above it.
 */
export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'id'> {
  as?: 'li' | 'div' | undefined;
  leading?: ReactNode;
  id?: ReactNode;
  title: ReactNode;
  /** Tooltip for the title; defaults to `title` when it is a string. */
  titleText?: string | undefined;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Lines under the main line (snippet, reason, error). */
  detail?: ReactNode;
  /** Route the id + title link to. */
  to?: string | undefined;
  /**
   * A plain click goes here instead of `to` (the issue drawer, `?issue=` on
   * this route, INV-1387). The link keeps `to` as its href, so ⌘/Ctrl-,
   * Shift- and middle-click still open the full page in a new tab or window.
   */
  clickTo?: string | undefined;
  /** Click handler for the id + title when there is no route. */
  onOpen?: (() => void) | undefined;
  /** Accessible name of the open link/button (default: its text). */
  openLabel?: string | undefined;
  /**
   * `plain` (default): rounded hover row inside a panel. `divided`: full-width
   * page list with a hairline under each row. `compact`: an inline reference
   * (table cell, "A mentions B"): no padding, no hover fill.
   */
  variant?: 'plain' | 'divided' | 'compact' | undefined;
  /** The J/K focus of a keyboard-driven list. */
  current?: boolean | undefined;
  unread?: boolean | undefined;
  /** Identifier in the danger colour (overdue). */
  alert?: boolean | undefined;
  /** Tooltip for the whole row. */
  rowTitle?: string | undefined;
}

export function ListRow({
  as = 'li',
  leading,
  id,
  title,
  titleText,
  meta,
  trailing,
  detail,
  to,
  clickTo,
  onOpen,
  openLabel,
  variant = 'plain',
  current = false,
  unread = false,
  alert = false,
  rowTitle,
  className,
  ...rest
}: ListRowProps) {
  const navigate = useNavigate();
  const opens = Boolean(to || onOpen);
  const handleLinkClick = clickTo
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(clickTo, { preventScrollReset: true });
      }
    : undefined;
  const classes = [
    'list-row',
    variant === 'plain' ? null : `list-row--${variant}`,
    detail ? 'list-row--multiline' : null,
    opens && variant !== 'compact' ? 'list-row--opens' : null,
    current ? 'is-current' : null,
    unread ? 'is-unread' : null,
    alert ? 'is-alert' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const mainContent = (
    <>
      {id ? <span className="mono list-row__id">{id}</span> : null}
      {id ? ' ' : null}
      <span className="list-row__title" title={titleText ?? (typeof title === 'string' ? title : undefined)}>
        {title}
      </span>
    </>
  );
  const main = to ? (
    <Link className="list-row__main" to={to} aria-label={openLabel} onClick={handleLinkClick}>
      {mainContent}
    </Link>
  ) : onOpen ? (
    <button type="button" className="list-row__main" aria-label={openLabel} onClick={onOpen}>
      {mainContent}
    </button>
  ) : (
    <span className="list-row__main">{mainContent}</span>
  );

  const body = (
    <>
      {leading ? <div className="list-row__leading">{leading}</div> : null}
      <div className="list-row__body">
        <div className="list-row__line">
          {main}
          {meta ? <span className="list-row__meta">{meta}</span> : null}
        </div>
        {detail ? <div className="list-row__detail">{detail}</div> : null}
      </div>
      {trailing ? <div className="list-row__trailing">{trailing}</div> : null}
    </>
  );

  if (as === 'div') {
    return (
      <div {...rest} className={classes} title={rowTitle}>
        {body}
      </div>
    );
  }
  return (
    <li {...rest} className={classes} title={rowTitle}>
      {body}
    </li>
  );
}

export interface IssueRowWork {
  id: string;
  identifier: string;
  title: string;
  priority?: number | null | undefined;
  state?: { name: string; type?: string | undefined } | null | undefined;
  labels?: { nodes: Array<{ id?: string; name: string; color?: string | null | undefined }> } | null | undefined;
  repository?: string | null | undefined;
}

/**
 * Where a row opens an item: the drawer (`?issue=<identifier>` on the current
 * route, other params kept) or the issue page.
 */
export function useIssueHref(): (work: Pick<IssueRowWork, 'identifier'>, open: 'page' | 'drawer') => string {
  const location = useLocation();
  return (work, open) => {
    if (open === 'drawer') {
      const params = new URLSearchParams(location.search);
      params.set('issue', work.identifier);
      return `${location.pathname}?${params.toString()}`;
    }
    return `/issue/${encodeURIComponent(work.identifier)}`;
  };
}

export interface IssueRowProps extends Omit<ListRowProps, 'id' | 'title' | 'to' | 'leading'> {
  issue: IssueRowWork;
  /**
   * `page` (default): /issue/:identifier. `drawer`: a click sets ?issue= on this
   * route (IssueDrawerHost shows it) while the href stays the issue page, so
   * modifier and middle clicks open the page. `none`: not a link.
   */
  open?: 'page' | 'drawer' | 'none' | undefined;
  /** Replaces the plain title (e.g. with highlighted search words). */
  titleNode?: ReactNode;
  showPriority?: boolean | undefined;
  showStatus?: boolean | undefined;
  /** State name as text in meta. */
  showState?: boolean | undefined;
  showLabels?: boolean | undefined;
  showProject?: boolean | undefined;
  /** Short age text ("3d"), mono, at the end of meta. */
  age?: ReactNode;
  /** An SLA / deadline chip, before the age. */
  sla?: ReactNode;
  /** Extra leading content after the icons (a checkbox). */
  leadingExtra?: ReactNode;
}

/** A ListRow for one work item: icons, identifier, title, state, labels, project, SLA, age. */
export function IssueRow({
  issue,
  open = 'page',
  titleNode,
  showPriority = true,
  showStatus = true,
  showState = false,
  showLabels = false,
  showProject = false,
  age,
  sla,
  leadingExtra,
  meta,
  ...rest
}: IssueRowProps) {
  const issueHref = useIssueHref();
  const leading = (
    <>
      {leadingExtra}
      {showPriority && issue.priority != null ? <PriorityIcon level={issue.priority} size={14} /> : null}
      {showStatus && issue.state ? <StatusIcon stateName={issue.state.name} stateType={issue.state.type} size={14} /> : null}
    </>
  );
  const labels = showLabels ? issue.labels?.nodes ?? [] : [];
  const metaParts = (
    <>
      {labels.map((label) => (
        <LabelPill key={label.id ?? label.name} label={{ name: label.name, color: label.color ?? 'var(--fg-faint)' }} size="xs" />
      ))}
      {meta}
      {showState && issue.state ? <span className="list-row__state">{issue.state.name}</span> : null}
      {showProject ? <Badge mono>{issue.repository ?? 'No project'}</Badge> : null}
      {sla}
      {age ? <span className="mono list-row__age">{age}</span> : null}
    </>
  );
  const hasMeta = labels.length > 0 || Boolean(meta) || (showState && issue.state) || showProject || Boolean(sla) || Boolean(age);
  return (
    <ListRow
      {...rest}
      leading={leadingExtra || (showPriority && issue.priority != null) || (showStatus && issue.state) ? leading : undefined}
      id={issue.identifier}
      title={titleNode ?? issue.title}
      titleText={issue.title}
      to={open === 'none' ? undefined : issueHref(issue, 'page')}
      clickTo={open === 'drawer' ? issueHref(issue, 'drawer') : undefined}
      meta={hasMeta ? metaParts : undefined}
    />
  );
}
