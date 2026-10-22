import type { ReactNode } from 'react';

import { PageHeader } from './layout';

export interface SettingsNavGroup<Id extends string> {
  /** Group heading in the rail (sentence case); the first group may omit it. */
  label?: string | undefined;
  items: ReadonlyArray<{ id: Id; label: string }>;
}

export interface SettingsShellProps<Id extends string> {
  /** Accessible name of the section navigation. */
  navLabel: string;
  /**
   * Page title, e.g. "Settings": rendered as a PageHeader (the page's h1) above
   * rail and content. Omit it when the route draws its own header (team pages).
   */
  title?: string | undefined;
  groups: ReadonlyArray<SettingsNavGroup<Id>>;
  active: Id;
  onSelect: (id: Id) => void;
  children: ReactNode;
}

/**
 * The settings layout shared by workspace and team settings: an optional
 * PageHeader, then a 200px side rail of sections and a content column
 * (padding 24px var(--pad-x), max-width 760).
 */
export function SettingsShell<Id extends string>({ navLabel, title, groups, active, onSelect, children }: SettingsShellProps<Id>) {
  const shell = (
    <div className="settings-shell">
      <nav className="settings-shell__nav" aria-label={navLabel}>
        {groups.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className="settings-shell__group">
            {group.label ? <div className="settings-shell__group-label">{group.label}</div> : null}
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={['settings-shell__item', item.id === active ? 'is-active' : null].filter(Boolean).join(' ')}
                aria-current={item.id === active ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-shell__content">
        <div className="settings-shell__inner">{children}</div>
      </div>
    </div>
  );
  if (!title) return shell;
  return (
    <div className="observation-page">
      <PageHeader title={title} />
      {shell}
    </div>
  );
}

/** The heading and one-paragraph intro at the top of a settings section. */
export function SettingsSectionHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <>
      <h2 className="settings-section__title">{title}</h2>
      {children ? <p className="settings-section__sub">{children}</p> : null}
    </>
  );
}
