import { useQuery } from '@apollo/client/react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { WORK_SEARCH_QUERY } from '../work/queries';
import type { WorkSearchHit, WorkSearchQueryData } from '../work/types';

export interface PaletteAction {
  description?: string;
  group: string;
  hint?: string;
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_RESULT_LIMIT = 20;
const MATCH_FIELD_LABEL: Record<WorkSearchHit['matchedField'], string> = {
  identifier: 'identifier',
  title: 'title',
  contract: 'contract',
  description: 'description',
  comment: 'comment',
};

export function CommandPalette({
  actions,
  initialQuery = '',
  onClose,
  open,
}: {
  actions: PaletteAction[];
  /** Text to search for when the palette opens (from a board search box). */
  initialQuery?: string;
  onClose: () => void;
  open: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchText = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);

  // Issues come from the server, so anything readable is found, not only what
  // the board happened to load, and descriptions and comments count (INV-925).
  const { data: searchData, loading: searching } = useQuery<WorkSearchQueryData>(WORK_SEARCH_QUERY, {
    variables: { query: searchText, first: SEARCH_RESULT_LIMIT },
    skip: !open || searchText.length === 0,
    fetchPolicy: 'cache-and-network',
  });
  const searchHits = searchText.length > 0 ? searchData?.search : undefined;

  const filteredActions = useMemo(() => {
    if (!query.trim()) {
      return actions;
    }

    const normalizedQuery = query.trim().toLowerCase();
    const localMatches = actions.filter((action) => {
      return (
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.description?.toLowerCase().includes(normalizedQuery)
      );
    });
    if (!searchHits) {
      return localMatches;
    }

    const serverIssues: PaletteAction[] = searchHits.map((hit) => ({
      id: `issue-${hit.issue.id}`,
      label: `${hit.issue.identifier} · ${hit.issue.title}`,
      description: hit.snippet ?? `${hit.issue.team.key} · ${hit.issue.state.name}`,
      group: 'Issues',
      hint: hit.matchedField === 'title' || hit.matchedField === 'identifier'
        ? hit.issue.state.name
        : `in ${MATCH_FIELD_LABEL[hit.matchedField]}`,
      run: () => navigate(`/issue/${hit.issue.id}`),
    }));
    const serverIds = new Set(serverIssues.map((action) => action.id));
    return [
      ...localMatches.filter((action) => action.group !== 'Issues'),
      ...serverIssues,
      ...localMatches.filter((action) => action.group === 'Issues' && !serverIds.has(action.id)),
    ];
  }, [actions, navigate, query, searchHits]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery(initialQuery);
    setSelectedIndex(0);
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
  }, [initialQuery, open]);

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

  const terms = query.trim().split(/\s+/).filter(Boolean);
  const waitingForSearch = query.trim().length > 0 && (searching || searchText !== query.trim()) && !searchHits;

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
            placeholder="Type a command or search issues…"
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
                      <span className="command-palette__item-label">{highlight(action.label, terms)}</span>
                      {action.description ? (
                        <span className="command-palette__item-description">{highlight(action.description, terms)}</span>
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
          ) : waitingForSearch ? (
            <p className="command-palette__empty">Searching all work…</p>
          ) : (
            <p className="command-palette__empty">No matching commands or issues.</p>
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
          <span className="command-palette__footer-copy">
            {waitingForSearch && filteredActions.length > 0 ? 'Searching all work…' : 'Searches titles, descriptions, contracts and comments'}
          </span>
        </footer>
      </section>
    </div>
  );
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Wraps every case-insensitive occurrence of a search word in <mark>. */
function highlight(text: string, terms: string[]): ReactNode {
  const needles = terms.map((term) => term.replace(/^"|"$/g, '')).filter(Boolean);
  if (needles.length === 0) {
    return text;
  }
  const pattern = new RegExp(`(${needles.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  return parts.map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
