import type { ReactNode } from 'react';

export interface SettingsNavGroup<Id extends string> {
  /** Group heading in the rail (sentence case); the first group may omit it. */
  label?: string | undefined;
  items: ReadonlyArray<{ id: Id; label: string }>;
}

export interface SettingsShellProps<Id extends string> {
  /** Accessible name of the section navigation. */
  navLabel: string;
  /** Heading above the rail, e.g. "Settings". */
  title?: string | undefined;
  groups: ReadonlyArray<SettingsNavGroup<Id>>;
  active: Id;
  onSelect: (id: Id) => void;
  children: ReactNode;
}

/**
 * The settings layout shared by workspace and team settings: a 200px side rail
 * of sections and a content column (padding 24px var(--pad-x), max-width 760).
 */
export function SettingsShell<Id extends string>({ navLabel, title, groups, active, onSelect, children }: SettingsShellProps<Id>) {
  return (
    <div className="settings-shell">
      <nav className="settings-shell__nav" aria-label={navLabel}>
        {title ? <div className="settings-shell__title">{title}</div> : null}
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
