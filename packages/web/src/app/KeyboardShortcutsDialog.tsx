import { useEffect, useMemo, useRef, useState } from 'react';
import { IcoKeyboard, IcoSearch } from '../components/Icons';

export interface ShortcutItem {
  id: string;
  label: string;
  description?: string;
  keys: string[];
}

export interface ShortcutSection {
  id: string;
  title: string;
  items: ShortcutItem[];
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    id: 'navigation',
    title: 'Navigation (G Chords)',
    items: [
      { id: 'nav-board', label: 'Go to Board', description: 'Active committed board', keys: ['G', 'B'] },
      { id: 'nav-backlog', label: 'Go to Backlog', description: 'Issue backlog table', keys: ['G', 'L'] },
      { id: 'nav-candidates', label: 'Go to Candidates', description: 'Proposed work review queue', keys: ['G', 'C'] },
      { id: 'nav-in-review', label: 'Go to In Review', description: 'Completed agent runs review', keys: ['G', 'N'] },
      { id: 'nav-bugs', label: 'Go to Bugs', description: 'Reported bugs queue', keys: ['G', 'U'] },
      { id: 'nav-graph', label: 'Go to Graph', description: 'Work-graph relationships view', keys: ['G', 'R'] },
      { id: 'nav-inbox', label: 'Go to Inbox', description: 'Notifications and activity', keys: ['G', 'I'] },
      { id: 'nav-my-issues', label: 'Go to My Issues', description: 'Issues assigned to you', keys: ['G', 'M'] },
      { id: 'nav-projects', label: 'Go to Projects', description: 'Projects overview', keys: ['G', 'P'] },
      { id: 'nav-cycles', label: 'Go to Milestones', description: 'Milestones and delivery cycles', keys: ['G', 'V'] },
      { id: 'nav-views', label: 'Go to Views', description: 'Saved filters and custom views', keys: ['G', 'W'] },
      { id: 'nav-members', label: 'Go to Members', description: 'Team and workspace members', keys: ['G', 'E'] },
      { id: 'nav-settings', label: 'Go to Settings', description: 'Workspace configuration', keys: ['G', 'S'] },
      { id: 'nav-access', label: 'Go to Access', description: 'Authentication & token management', keys: ['G', 'A'] },
    ],
  },
  {
    id: 'actions',
    title: 'Global Actions',
    items: [
      { id: 'act-create', label: 'Create issue', description: 'Open quick issue composer anywhere', keys: ['C'] },
      { id: 'act-palette', label: 'Command palette', description: 'Open search and action launcher', keys: ['⌘', 'K'] },
      { id: 'act-search', label: 'Search in view', description: 'Focus search input on active board or backlog', keys: ['/'] },
      { id: 'act-number', label: 'Find by issue number', description: 'Type a digit on the board to filter by identifier number', keys: ['0–9'] },
      { id: 'act-shortcuts', label: 'Keyboard shortcuts', description: 'Open this cheat sheet', keys: ['?'] },
      { id: 'act-theme', label: 'Toggle theme', description: 'Switch between light and dark mode', keys: ['T'] },
      { id: 'act-close', label: 'Close / Dismiss', description: 'Close dialog, modal, drawer, or cancel chord', keys: ['Esc'] },
    ],
  },
  {
    id: 'board-backlog',
    title: 'Board & Backlog Navigation',
    items: [
      { id: 'bb-down', label: 'Next item', description: 'Move focus down in list or board', keys: ['J'] },
      { id: 'bb-up', label: 'Previous item', description: 'Move focus up in list or board', keys: ['K'] },
      { id: 'bb-open', label: 'Open focused item', description: 'Open issue detail drawer', keys: ['↵'] },
      { id: 'bb-open-alt', label: 'Open focused item (alt)', description: 'Alternative key to open drawer', keys: ['O'] },
      { id: 'bb-select', label: 'Toggle selection', description: 'Select or deselect focused issue', keys: ['X'] },
      { id: 'bb-clear-select', label: 'Clear selection', description: 'Deselect all selected issues', keys: ['⇧', 'X'] },
      { id: 'bb-select-all', label: 'Select all visible', description: 'Select all issues on screen', keys: ['⇧', 'A'] },
      { id: 'bb-prev-drawer', label: 'Previous in drawer', description: 'Navigate to previous issue in drawer', keys: ['['] },
      { id: 'bb-next-drawer', label: 'Next in drawer', description: 'Navigate to next issue in drawer', keys: [']'] },
    ],
  },
];

export function KeyboardShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery('');
    window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 20);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  const filteredSections = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return SHORTCUT_SECTIONS;
    }

    return SHORTCUT_SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        return (
          item.label.toLowerCase().includes(trimmed) ||
          item.description?.toLowerCase().includes(trimmed) ||
          item.keys.some((key) => key.toLowerCase().includes(trimmed))
        );
      }),
    })).filter((section) => section.items.length > 0);
  }, [query]);

  if (!open) {
    return null;
  }

  return (
    <div className="shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <button
        type="button"
        className="shortcuts-dialog__backdrop"
        onClick={onClose}
        aria-label="Close keyboard shortcuts"
      />
      <section className="shortcuts-dialog__panel">
        <header className="shortcuts-dialog__header">
          <div className="shortcuts-dialog__title-area">
            <span className="shortcuts-dialog__icon">
              <IcoKeyboard size={16} />
            </span>
            <div>
              <h2 className="shortcuts-dialog__title">Keyboard Shortcuts</h2>
              <p className="shortcuts-dialog__subtitle">Keyboard-first navigation and actions aligned with Linear</p>
            </div>
          </div>
          <div className="shortcuts-dialog__search-box">
            <span className="shortcuts-dialog__search-icon"><IcoSearch size={13} /></span>
            <input
              ref={searchInputRef}
              type="text"
              className="shortcuts-dialog__search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              aria-label="Search keyboard shortcuts"
            />
            <button
              type="button"
              className="shortcuts-dialog__close"
              onClick={onClose}
              aria-label="Close keyboard shortcuts"
            >
              <kbd>Esc</kbd>
            </button>
          </div>
        </header>

        <div className="shortcuts-dialog__content">
          {filteredSections.length > 0 ? (
            <div className="shortcuts-dialog__grid">
              {filteredSections.map((section) => (
                <div key={section.id} className="shortcuts-dialog__section">
                  <h3 className="shortcuts-dialog__section-title">{section.title}</h3>
                  <div className="shortcuts-dialog__list">
                    {section.items.map((item) => (
                      <div key={item.id} className="shortcuts-dialog__item">
                        <div className="shortcuts-dialog__item-info">
                          <span className="shortcuts-dialog__item-label">{item.label}</span>
                          {item.description ? (
                            <span className="shortcuts-dialog__item-desc">{item.description}</span>
                          ) : null}
                        </div>
                        <div className="shortcuts-dialog__item-keys">
                          {item.keys.map((key, keyIndex) => (
                            <span key={`${item.id}-key-${keyIndex}`} className="shortcuts-dialog__key-wrapper">
                              <kbd className="shortcuts-dialog__kbd">{key}</kbd>
                              {keyIndex < item.keys.length - 1 ? (
                                <span className="shortcuts-dialog__key-separator">then</span>
                              ) : null}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="shortcuts-dialog__empty">
              <p>No shortcuts matching &ldquo;{query}&rdquo;</p>
            </div>
          )}
        </div>

        <footer className="shortcuts-dialog__footer">
          <span className="shortcuts-dialog__tip">
            Tip: Press <kbd className="shortcuts-dialog__kbd">?</kbd> or <kbd className="shortcuts-dialog__kbd">⌘</kbd><kbd className="shortcuts-dialog__kbd">/</kbd> anywhere to toggle this cheat sheet
          </span>
          <span className="shortcuts-dialog__badge">Involute Work-Graph</span>
        </footer>
      </section>
    </div>
  );
}
