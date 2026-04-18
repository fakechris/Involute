import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import {
  ACTIVE_TEAM_STORAGE_KEY,
  OPEN_CREATE_ISSUE_EVENT,
  readStoredTeamKey,
  writeStoredTeamKey,
} from './board/utils';
import {
  BOARD_SAVED_VIEWS_EVENT,
  dispatchApplyBoardView,
  readSavedBoardViews,
  writeStoredBoardViewState,
  type SavedBoardView,
  type SavedBoardViewsEventDetail,
} from './board/views';
import {
  BACKLOG_SAVED_VIEWS_EVENT,
  dispatchApplyBacklogView,
  readSavedBacklogViews,
  writeStoredBacklogViewState,
  type SavedBacklogView,
  type SavedBacklogViewsEventDetail,
} from './backlog/views';
import {
  APP_SHELL_ISSUES_EVENT,
  APP_SHELL_ISSUES_STORAGE_KEY,
  APP_SHELL_TEAMS_EVENT,
  APP_SHELL_TEAMS_STORAGE_KEY,
  readStoredShellIssues,
  readStoredShellTeams,
  type AppShellIssueSummary,
  type AppShellTeamSummary,
} from './lib/app-shell-state';
import { fetchSessionState, getGoogleLoginUrl, logoutSession, type SessionState } from './lib/session';

const AccessPage = lazy(async () => {
  const module = await import('./routes/AccessPage');
  return { default: module.AccessPage };
});
const BoardPage = lazy(async () => {
  const module = await import('./routes/BoardPage');
  return { default: module.BoardPage };
});
const IssuePage = lazy(async () => {
  const module = await import('./routes/IssuePage');
  return { default: module.IssuePage };
});

const THEME_STORAGE_KEY = 'involute.theme';
const DENSITY_STORAGE_KEY = 'involute.density';
const SIDEBAR_WIDTH_STORAGE_KEY = 'involute.sidebar-width';

type ThemeMode = 'dark' | 'light';
type DensityMode = 'compact' | 'cozy' | 'comfortable';

interface PaletteAction {
  description?: string;
  group: string;
  hint?: string;
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

function getNavLinkClassName({ isActive }: { isActive: boolean }) {
  return `app-shell__link${isActive ? ' app-shell__link--active' : ''}`;
}

function getStoredTheme(): ThemeMode {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme;
    }
  } catch {
    // Ignore localStorage failures and fall back to dark.
  }

  return 'dark';
}

function persistTheme(nextTheme: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    // Ignore localStorage failures; the theme will still apply for this session.
  }
}

function getStoredDensity(): DensityMode {
  try {
    const storedDensity = window.localStorage.getItem(DENSITY_STORAGE_KEY);

    if (storedDensity === 'compact' || storedDensity === 'cozy' || storedDensity === 'comfortable') {
      return storedDensity;
    }
  } catch {
    // Ignore localStorage failures and fall back to cozy.
  }

  return 'cozy';
}

function persistDensity(nextDensity: DensityMode) {
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, nextDensity);
  } catch {
    // Ignore localStorage failures.
  }
}

function getStoredSidebarWidth() {
  try {
    const storedSidebarWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));

    if (!Number.isNaN(storedSidebarWidth) && storedSidebarWidth >= 220 && storedSidebarWidth <= 320) {
      return storedSidebarWidth;
    }
  } catch {
    // Ignore localStorage failures and fall back to the default sidebar width.
  }

  return 248;
}

function persistSidebarWidth(nextSidebarWidth: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextSidebarWidth));
  } catch {
    // Ignore localStorage failures.
  }
}

function openCreateIssueSurface(
  navigate: ReturnType<typeof useNavigate>,
  pathname: string,
) {
  if (pathname === '/' || pathname === '/backlog') {
    window.dispatchEvent(new Event(OPEN_CREATE_ISSUE_EVENT));
    return;
  }

  navigate('/', {
    state: {
      openCreateIssue: true,
    },
  });
}

function CommandPalette({
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

function TweaksPanel({
  density,
  onClose,
  open,
  setDensity,
  setSidebarWidth,
  setTheme,
  sidebarWidth,
  theme,
}: {
  density: DensityMode;
  onClose: () => void;
  open: boolean;
  setDensity: (nextDensity: DensityMode) => void;
  setSidebarWidth: (nextSidebarWidth: number) => void;
  setTheme: (nextTheme: ThemeMode) => void;
  sidebarWidth: number;
  theme: ThemeMode;
}) {
  if (!open) {
    return null;
  }

  return (
    <section className="tweaks-panel" aria-label="Interface tweaks">
      <div className="tweaks-panel__header">
        <strong>Tweaks</strong>
        <button type="button" className="tweaks-panel__close" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="tweaks-panel__section">
        <span className="tweaks-panel__label">Theme</span>
        <div className="tweaks-panel__options">
          {(['dark', 'light'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`tweaks-panel__option${theme === mode ? ' tweaks-panel__option--active' : ''}`}
              onClick={() => setTheme(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="tweaks-panel__section">
        <span className="tweaks-panel__label">Density</span>
        <div className="tweaks-panel__options">
          {(
            [
              ['compact', 'Compact'],
              ['cozy', 'Cozy'],
              ['comfortable', 'Comfortable'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`tweaks-panel__option${density === mode ? ' tweaks-panel__option--active' : ''}`}
              onClick={() => setDensity(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="tweaks-panel__section">
        <div className="tweaks-panel__slider-row">
          <span className="tweaks-panel__label">Sidebar width</span>
          <span className="tweaks-panel__value">{sidebarWidth}px</span>
        </div>
        <input
          type="range"
          min="220"
          max="320"
          step="4"
          value={sidebarWidth}
          onChange={(event) => setSidebarWidth(Number(event.target.value))}
        />
      </div>
    </section>
  );
}

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState<SessionState | null | undefined>(undefined);
  const [isSessionLoaded, setIsSessionLoaded] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());
  const [density, setDensity] = useState<DensityMode>(() => getStoredDensity());
  const [sidebarWidth, setSidebarWidth] = useState(() => getStoredSidebarWidth());
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isTweaksOpen, setIsTweaksOpen] = useState(false);
  const [shellTeams, setShellTeams] = useState<AppShellTeamSummary[]>(() => readStoredShellTeams());
  const [shellIssues, setShellIssues] = useState<AppShellIssueSummary[]>(() => readStoredShellIssues());
  const [activeTeamKey, setActiveTeamKey] = useState<string | null>(() => readStoredTeamKey());
  const [savedBoardViews, setSavedBoardViews] = useState<SavedBoardView[]>(() =>
    readSavedBoardViews(readStoredTeamKey()),
  );
  const [savedBacklogViews, setSavedBacklogViews] = useState<SavedBacklogView[]>(() =>
    readSavedBacklogViews(readStoredTeamKey()),
  );
  const [expandedTeamKey, setExpandedTeamKey] = useState<string | null>(() => readStoredTeamKey());
  const gotoPrefixTimeoutRef = useRef<number | null>(null);
  const issuesByTeamKey = useMemo(() => {
    const nextMap = new Map<string, AppShellIssueSummary[]>();

    for (const issue of shellIssues) {
      const currentIssues = nextMap.get(issue.teamKey) ?? [];
      currentIssues.push(issue);
      nextMap.set(issue.teamKey, currentIssues);
    }

    return nextMap;
  }, [shellIssues]);
  const recentIssues = useMemo(() => shellIssues.slice(0, 8), [shellIssues]);

  useEffect(() => {
    let cancelled = false;

    fetchSessionState()
      .then((nextSession) => {
        if (cancelled) {
          return;
        }

        setSession(nextSession);
        setIsSessionLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        console.error('Could not load session state.', error);
        setSession(null);
        setSessionError('Could not load session state.');
        setIsSessionLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    persistTheme(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    persistDensity(density);
  }, [density]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth}px`);
    persistSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    setSavedBoardViews(readSavedBoardViews(activeTeamKey));
    setSavedBacklogViews(readSavedBacklogViews(activeTeamKey));
  }, [activeTeamKey]);

  useEffect(() => {
    function handleTeamsUpdate(event: Event) {
      const nextTeams =
        event instanceof CustomEvent && Array.isArray(event.detail)
          ? (event.detail as AppShellTeamSummary[])
          : readStoredShellTeams();
      setShellTeams(nextTeams);
    }

    function handleActiveTeamUpdate(event: Event) {
      const nextTeamKey =
        event instanceof CustomEvent && (typeof event.detail === 'string' || event.detail === null)
          ? (event.detail as string | null)
          : readStoredTeamKey();
      setActiveTeamKey(nextTeamKey);

      if (nextTeamKey === null) {
        setExpandedTeamKey(null);
      }
    }

    function handleIssuesUpdate(event: Event) {
      const nextIssues =
        event instanceof CustomEvent && Array.isArray(event.detail)
          ? (event.detail as AppShellIssueSummary[])
          : readStoredShellIssues();
      setShellIssues(nextIssues);
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === null || event.key === APP_SHELL_TEAMS_STORAGE_KEY) {
        setShellTeams(readStoredShellTeams());
      }

      if (event.key === null || event.key === APP_SHELL_ISSUES_STORAGE_KEY) {
        setShellIssues(readStoredShellIssues());
      }

      if (event.key === null || event.key === ACTIVE_TEAM_STORAGE_KEY) {
        const nextTeamKey = readStoredTeamKey();
        setActiveTeamKey(nextTeamKey);
        setExpandedTeamKey(nextTeamKey);
      }
    }

    function handleBoardSavedViewsUpdate(event: Event) {
      const detail =
        event instanceof CustomEvent && event.detail
          ? (event.detail as SavedBoardViewsEventDetail)
          : null;

      if (detail?.teamKey === activeTeamKey) {
        setSavedBoardViews(detail.views);
      }
    }

    function handleBacklogSavedViewsUpdate(event: Event) {
      const detail =
        event instanceof CustomEvent && event.detail
          ? (event.detail as SavedBacklogViewsEventDetail)
          : null;

      if (detail?.teamKey === activeTeamKey) {
        setSavedBacklogViews(detail.views);
      }
    }

    window.addEventListener(APP_SHELL_TEAMS_EVENT, handleTeamsUpdate as EventListener);
    window.addEventListener(APP_SHELL_ISSUES_EVENT, handleIssuesUpdate as EventListener);
    window.addEventListener('involute:active-team-key', handleActiveTeamUpdate as EventListener);
    window.addEventListener(BOARD_SAVED_VIEWS_EVENT, handleBoardSavedViewsUpdate as EventListener);
    window.addEventListener(BACKLOG_SAVED_VIEWS_EVENT, handleBacklogSavedViewsUpdate as EventListener);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener(APP_SHELL_TEAMS_EVENT, handleTeamsUpdate as EventListener);
      window.removeEventListener(APP_SHELL_ISSUES_EVENT, handleIssuesUpdate as EventListener);
      window.removeEventListener('involute:active-team-key', handleActiveTeamUpdate as EventListener);
      window.removeEventListener(BOARD_SAVED_VIEWS_EVENT, handleBoardSavedViewsUpdate as EventListener);
      window.removeEventListener(BACKLOG_SAVED_VIEWS_EVENT, handleBacklogSavedViewsUpdate as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, [activeTeamKey]);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const isElementTarget = target instanceof HTMLElement;
      const tagName = isElementTarget ? target.tagName : null;
      const isTypingField =
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        (isElementTarget && target.getAttribute('contenteditable') === 'true');

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsPaletteOpen((currentValue) => !currentValue);
        return;
      }

      if (isTypingField || isPaletteOpen) {
        return;
      }

      if (gotoPrefixTimeoutRef.current !== null) {
        window.clearTimeout(gotoPrefixTimeoutRef.current);
        gotoPrefixTimeoutRef.current = null;

        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          const shortcutKey = event.key.toLowerCase();

          if (shortcutKey === 'b') {
            event.preventDefault();
            navigate('/');
            return;
          }

          if (shortcutKey === 'l') {
            event.preventDefault();
            navigate('/backlog');
            return;
          }

          if (shortcutKey === 'a' && session?.authenticated) {
            event.preventDefault();
            navigate('/settings/access');
            return;
          }
        }
      }

      if (event.key.toLowerCase() === 'g' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        gotoPrefixTimeoutRef.current = window.setTimeout(() => {
          gotoPrefixTimeoutRef.current = null;
        }, 1200);
        return;
      }

      if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        openCreateIssueSurface(navigate, location.pathname);
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown);

    return () => {
      if (gotoPrefixTimeoutRef.current !== null) {
        window.clearTimeout(gotoPrefixTimeoutRef.current);
        gotoPrefixTimeoutRef.current = null;
      }
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isPaletteOpen, location.pathname, navigate, session?.authenticated]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = [
      {
        id: 'go-board',
        label: 'Go to board',
        description: 'Open the active team board',
        group: 'Navigation',
        shortcut: 'G B',
        run: () => navigate('/'),
      },
      {
        id: 'go-backlog',
        label: 'Go to backlog',
        description: 'Open the list view',
        group: 'Navigation',
        shortcut: 'G L',
        run: () => navigate('/backlog'),
      },
      {
        id: 'create-issue',
        label: 'Create issue',
        description: 'Open the quick issue composer on the active team',
        group: 'Actions',
        shortcut: 'C',
        run: () => openCreateIssueSurface(navigate, location.pathname),
      },
      {
        id: 'toggle-theme',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
        description: 'Toggle the workspace theme',
        group: 'Preferences',
        shortcut: 'T',
        run: () => setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark')),
      },
      {
        id: 'open-tweaks',
        label: 'Open interface tweaks',
        description: 'Adjust density, theme, and sidebar width',
        group: 'Preferences',
        run: () => setIsTweaksOpen(true),
      },
    ];

    if (session?.authenticated) {
      actions.push({
        id: 'go-access',
        label: 'Open access settings',
        description: 'Manage team visibility and memberships',
        group: 'Navigation',
        shortcut: 'G A',
        run: () => navigate('/settings/access'),
      });
    }

    if (activeTeamKey) {
      for (const view of savedBoardViews) {
        actions.push({
          id: `board-view-${view.id}`,
          label: `Load board view · ${view.name}`,
          description: `Apply saved board filters for ${activeTeamKey}`,
          group: 'Views',
          hint: 'Board',
          run: () => {
            writeStoredBoardViewState(activeTeamKey, view.state);
            dispatchApplyBoardView({ state: view.state, viewId: view.id });
            navigate('/');
          },
        });
      }

      for (const view of savedBacklogViews) {
        actions.push({
          id: `backlog-view-${view.id}`,
          label: `Load backlog view · ${view.name}`,
          description: `Apply saved backlog filters for ${activeTeamKey}`,
          group: 'Views',
          hint: 'Backlog',
          run: () => {
            writeStoredBacklogViewState(activeTeamKey, view.state);
            dispatchApplyBacklogView({ state: view.state, viewId: view.id });
            navigate('/backlog');
          },
        });
      }
    }

    for (const team of shellTeams) {
      actions.push({
        id: `team-${team.key}`,
        label: `Open ${team.name}`,
        description: `${team.key} board`,
        group: 'Teams',
        hint: team.key,
        run: () => {
          writeStoredTeamKey(team.key);
          setActiveTeamKey(team.key);
          setExpandedTeamKey(team.key);
          navigate('/');
        },
      });
    }

    for (const issue of shellIssues) {
      actions.push({
        id: `issue-${issue.id}`,
        label: `${issue.identifier} · ${issue.title}`,
        description: `${issue.teamKey} · ${issue.stateName}`,
        group: 'Issues',
        hint: issue.identifier,
        run: () => navigate(`/issue/${issue.id}`),
      });
    }

    return actions;
  }, [
    activeTeamKey,
    location.pathname,
    navigate,
    savedBacklogViews,
    savedBoardViews,
    session?.authenticated,
    shellIssues,
    shellTeams,
    theme,
  ]);

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar" aria-label="Workspace navigation">
        <div className="app-shell__sidebar-top">
          <div className="app-shell__workspace-switcher">
            <div className="app-shell__workspace-mark">I</div>
            <div className="app-shell__workspace-copy">
              <strong>Involute</strong>
              <span>Self-hosted issue tracker</span>
            </div>
          </div>

          <button
            type="button"
            className="app-shell__search-trigger"
            onClick={() => setIsPaletteOpen(true)}
          >
            <span>Search issues and commands</span>
            <kbd>⌘K</kbd>
          </button>

          <nav className="app-shell__nav-section">
            <NavLink to="/" end className={getNavLinkClassName}>
              Board
            </NavLink>
            <NavLink to="/backlog" className={getNavLinkClassName}>
              Backlog
            </NavLink>
            {session?.authenticated ? (
              <NavLink to="/settings/access" className={getNavLinkClassName}>
                Access
              </NavLink>
            ) : null}
          </nav>

          {shellTeams.length > 0 ? (
            <div className="app-shell__team-section">
              <div className="app-shell__section-label">Teams</div>
              <div className="app-shell__team-list">
                {shellTeams.map((team) => {
                  const isActive = activeTeamKey === team.key;
                  const isExpanded = expandedTeamKey === team.key;
                  const teamIssues = issuesByTeamKey.get(team.key) ?? [];

                  return (
                    <div key={team.id} className="app-shell__team-group">
                      <button
                        type="button"
                        className={`app-shell__team-link${isActive ? ' app-shell__team-link--active' : ''}`}
                        onClick={() => {
                          const nextExpanded = isExpanded ? null : team.key;
                          setExpandedTeamKey(nextExpanded);
                          writeStoredTeamKey(team.key);
                          setActiveTeamKey(team.key);
                          navigate(location.pathname === '/backlog' ? '/backlog' : '/');
                        }}
                      >
                        <span className={`app-shell__team-caret${isExpanded ? ' app-shell__team-caret--expanded' : ''}`}>
                          ▾
                        </span>
                        <span className="app-shell__team-key">{team.key}</span>
                        <span className="app-shell__team-name">{team.name}</span>
                        <span className="app-shell__team-count">{teamIssues.length}</span>
                      </button>
                      {isExpanded ? (
                        <div className="app-shell__team-subnav">
                          <button
                            type="button"
                            className={`app-shell__team-subnav-link${location.pathname !== '/backlog' && isActive ? ' app-shell__team-subnav-link--active' : ''}`}
                            onClick={() => {
                              writeStoredTeamKey(team.key);
                              setActiveTeamKey(team.key);
                              navigate('/');
                            }}
                          >
                            Issues
                          </button>
                          <button
                            type="button"
                            className={`app-shell__team-subnav-link${location.pathname === '/backlog' && isActive ? ' app-shell__team-subnav-link--active' : ''}`}
                            onClick={() => {
                              writeStoredTeamKey(team.key);
                              setActiveTeamKey(team.key);
                              navigate('/backlog');
                            }}
                          >
                            Backlog
                          </button>
                          {teamIssues.slice(0, 3).map((issue) => (
                            <button
                              key={issue.id}
                              type="button"
                              className="app-shell__team-subnav-issue"
                              onClick={() => navigate(`/issue/${issue.id}`)}
                            >
                              <span className="app-shell__team-subnav-issue-key">#{issue.identifier}</span>
                              <span className="app-shell__team-subnav-issue-title">Open {issue.title}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {recentIssues.length > 0 ? (
            <div className="app-shell__team-section">
              <div className="app-shell__section-label">Recent issues</div>
              <div className="app-shell__recent-list">
                {recentIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    className={`app-shell__recent-link${location.pathname === `/issue/${issue.id}` ? ' app-shell__recent-link--active' : ''}`}
                    onClick={() => navigate(`/issue/${issue.id}`)}
                  >
                    <span className="app-shell__recent-link-key">#{issue.identifier}</span>
                    <span className="app-shell__recent-link-title">Recent {issue.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="app-shell__sidebar-footer">
          <div className="app-shell__sidebar-meta">
            {sessionError ? <span className="app-shell__session-status">{sessionError}</span> : null}
            {session?.authenticated && session.viewer ? (
              <>
                <strong>{session.viewer.name ?? session.viewer.email ?? 'Signed-in viewer'}</strong>
                <span>
                  {session.viewer.globalRole}
                  {session.viewer.email ? ` · ${session.viewer.email}` : ''}
                </span>
              </>
            ) : !isSessionLoaded ? (
              <span className="app-shell__session-status">Loading session…</span>
            ) : session?.googleOAuthConfigured ? (
              <span className="app-shell__session-status">Session ready for Google sign-in</span>
            ) : (
              <span className="app-shell__session-status">Google OAuth not configured</span>
            )}
          </div>

          <div className="app-shell__sidebar-actions">
            <button
              type="button"
              className="app-shell__session-action"
              onClick={() => setIsTweaksOpen((currentValue) => !currentValue)}
            >
              Interface tweaks
            </button>

            <button
              type="button"
              className="app-shell__session-action"
              onClick={() => setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>

            {session?.authenticated && session.viewer ? (
              <button
                type="button"
                className="app-shell__session-action"
                onClick={() => {
                  logoutSession()
                    .then((didLogout) => {
                      if (didLogout) {
                        setSessionError(null);
                        setSession(null);
                        setIsSessionLoaded(true);
                        setTimeout(() => {
                          window.location.reload();
                        }, 0);
                      }
                    })
                    .catch((error: unknown) => {
                      console.error('Could not sign out.', error);
                      setSessionError('Could not sign out.');
                    });
                }}
              >
                Sign out
              </button>
            ) : session?.googleOAuthConfigured ? (
              <a className="app-shell__session-action" href={getGoogleLoginUrl()}>
                Sign in with Google
              </a>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="app-shell__viewport">
        <header className="app-shell__mobilebar">
          <div className="app-shell__mobile-brand">Involute</div>
          <div className="app-shell__mobile-actions">
            <button
              type="button"
              className="app-shell__session-action"
              onClick={() => setIsPaletteOpen(true)}
            >
              Search
            </button>
          </div>
        </header>

        <div className="app-shell__content" data-route={location.pathname}>
          <Suspense
            fallback={
              <main className="board-page board-page--state">
                <section className="shell-notice">
                  <p>Loading view…</p>
                </section>
              </main>
            }
          >
            <Routes>
              <Route path="/" element={<BoardPage />} />
              <Route path="/backlog" element={<BoardPage />} />
              <Route path="/settings/access" element={<AccessPage />} />
              <Route path="/issue/:id" element={<IssuePage />} />
            </Routes>
          </Suspense>
        </div>
      </div>

      <CommandPalette
        actions={paletteActions}
        open={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
      />
      <TweaksPanel
        density={density}
        open={isTweaksOpen}
        onClose={() => setIsTweaksOpen(false)}
        setDensity={setDensity}
        setSidebarWidth={setSidebarWidth}
        setTheme={setTheme}
        sidebarWidth={sidebarWidth}
        theme={theme}
      />
    </div>
  );
}
