import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteAction {
  description?: string;
  group: string;
  hint?: string;
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({
  actions,
  onClose,
  open,
}: {
  actions: PaletteAction[];
  onClose: () => void;
  open: boolean;
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredActions = useMemo(() => {
    if (!query.trim()) {
      return actions;
    }

    const normalizedQuery = query.trim().toLowerCase();

    return actions.filter((action) => {
      return (
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.description?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [actions, query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery('');
    setSelectedIndex(0);
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((currentIndex) =>
          filteredActions.length === 0 ? 0 : Math.min(filteredActions.length - 1, currentIndex + 1),
        );
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((currentIndex) => Math.max(0, currentIndex - 1));
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        filteredActions[selectedIndex]?.run();
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [filteredActions, onClose, open, selectedIndex]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const groupedActions = useMemo(() => {
    const nextGroups = new Map<string, Array<PaletteAction & { index: number }>>();

    filteredActions.forEach((action, index) => {
      const currentGroup = nextGroups.get(action.group) ?? [];
      currentGroup.push({ ...action, index });
      nextGroups.set(action.group, currentGroup);
    });

    return Array.from(nextGroups.entries());
  }, [filteredActions]);

  if (!open) {
    return null;
  }

  return (
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <button
        type="button"
        className="command-palette__backdrop"
        aria-label="Close command palette"
        onClick={onClose}
      />
      <section className="command-palette__panel">
        <div className="command-palette__search-row">
          <input
            ref={inputRef}
            aria-label="Search commands"
            className="command-palette__input"
            placeholder="Type a command or search issues..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="command-palette__hint">Esc</span>
        </div>
        <div className="command-palette__results" role="listbox" aria-label="Command results">
          {filteredActions.length > 0 ? (
            groupedActions.map(([group, actionsInGroup]) => (
              <section key={group} className="command-palette__group">
                <header className="command-palette__group-label">{group}</header>
                {actionsInGroup.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={`command-palette__item${action.index === selectedIndex ? ' command-palette__item--active' : ''}`}
                    onMouseEnter={() => setSelectedIndex(action.index)}
                    onClick={() => {
                      action.run();
                      onClose();
                    }}
                  >
                    <div className="command-palette__item-copy">
                      <span className="command-palette__item-label">{action.label}</span>
                      {action.description ? (
                        <span className="command-palette__item-description">{action.description}</span>
                      ) : null}
                    </div>
                    <div className="command-palette__item-trailing">
                      {action.hint ? <span className="command-palette__item-hint">{action.hint}</span> : null}
                      {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
                    </div>
                  </button>
                ))}
              </section>
            ))
          ) : (
            <p className="command-palette__empty">No matching commands.</p>
          )}
        </div>
        <footer className="command-palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            Navigate
          </span>
          <span>
            <kbd>↵</kbd>
            Open
          </span>
          <span className="command-palette__footer-copy">Involute command space</span>
        </footer>
      </section>
    </div>
  );
}
