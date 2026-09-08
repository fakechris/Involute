import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { type PaletteAction } from './CommandPalette';
import { type DensityMode, type ThemeMode } from './TweaksPanel';
import {
  getStoredDensity,
  getStoredSidebarWidth,
  getStoredTheme,
  openCreateIssueSurface,
  persistDensity,
  persistSidebarWidth,
  persistTheme,
} from './shellStorage';
import {
  BACKLOG_SAVED_VIEWS_EVENT,
  dispatchApplyBacklogView,
  readSavedBacklogViews,
  writeStoredBacklogViewState,
  type SavedBacklogView,
  type SavedBacklogViewsEventDetail,
} from '../backlog/views';
import {
  ACTIVE_TEAM_STORAGE_KEY,
  readStoredTeamKey,
  writeStoredTeamKey,
} from '../board/utils';
import {
  BOARD_SAVED_VIEWS_EVENT,
  dispatchApplyBoardView,
  readSavedBoardViews,
  writeStoredBoardViewState,
  type SavedBoardView,
  type SavedBoardViewsEventDetail,
} from '../board/views';
import {
  APP_SHELL_ISSUES_EVENT,
  APP_SHELL_ISSUES_STORAGE_KEY,
  APP_SHELL_TEAMS_EVENT,
  APP_SHELL_TEAMS_STORAGE_KEY,
  readStoredShellIssues,
  readStoredShellTeams,
  type AppShellIssueSummary,
  type AppShellTeamSummary,
} from '../lib/app-shell-state';
import { fetchSessionState, type SessionState } from '../lib/session';

export function useShellController() {
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme());
  const [density, setDensityState] = useState<DensityMode>(() => getStoredDensity());
  const [sidebarWidth, setSidebarWidthState] = useState(() => getStoredSidebarWidth());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [shellTeams, setShellTeams] = useState<AppShellTeamSummary[]>(() => readStoredShellTeams());
  const [shellIssues, setShellIssues] = useState<AppShellIssueSummary[]>(() => readStoredShellIssues());
  const [activeTeamKey, setActiveTeamKey] = useState<string | null>(() => readStoredTeamKey());
  const [savedBoardViews, setSavedBoardViews] = useState<SavedBoardView[]>(() =>
    readSavedBoardViews(readStoredTeamKey()),
  );
  const [savedBacklogViews, setSavedBacklogViews] = useState<SavedBacklogView[]>(() =>
    readSavedBacklogViews(readStoredTeamKey()),
  );
  const gotoPrefixTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSessionState().then((nextSession) => {
      if (!cancelled) {
        setSession(nextSession);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persistTheme(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    persistDensity(density);
  }, [density]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
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
        setActiveTeamKey(readStoredTeamKey());
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
    function onKeyDown(event: KeyboardEvent) {
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
        setPaletteOpen((currentValue) => !currentValue);
        return;
      }

      if (isTypingField || paletteOpen) {
        return;
      }

      if (gotoPrefixTimeoutRef.current !== null) {
        window.clearTimeout(gotoPrefixTimeoutRef.current);
        gotoPrefixTimeoutRef.current = null;

        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          const shortcutKey = event.key.toLowerCase();
          const routes: Record<string, string> = {
            b: '/',
            l: '/backlog',
            n: '/in-review',
            c: '/candidates',
            r: '/graph',
            i: '/inbox',
            m: '/my-issues',
            p: '/projects',
            v: '/cycles',
            w: '/views',
            e: '/members',
            s: '/settings',
          };

          if (shortcutKey === 'a' && session?.authenticated) {
            event.preventDefault();
            navigate('/settings/access');
            return;
          }

          const route = routes[shortcutKey];
          if (route) {
            event.preventDefault();
            navigate(route);
          }
        }
      }

      if (event.key.toLowerCase() === 'g' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        gotoPrefixTimeoutRef.current = window.setTimeout(() => {
          gotoPrefixTimeoutRef.current = null;
        }, 1200);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (gotoPrefixTimeoutRef.current !== null) {
        window.clearTimeout(gotoPrefixTimeoutRef.current);
        gotoPrefixTimeoutRef.current = null;
      }
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate, paletteOpen, session?.authenticated]);

  const actions = useMemo<PaletteAction[]>(() => {
    const nextActions: PaletteAction[] = [
      { id: 'go-board', label: 'Go to board', description: 'Open the committed-issue board', group: 'Navigation', shortcut: 'G B', run: () => navigate('/') },
      { id: 'go-backlog', label: 'Go to backlog', description: 'Open the list view', group: 'Navigation', shortcut: 'G L', run: () => navigate('/backlog') },
      { id: 'go-in-review', label: 'Go to In Review', description: 'Batch accept or return committed work waiting in review', group: 'Navigation', shortcut: 'G N', run: () => navigate('/in-review') },
      { id: 'go-candidates', label: 'Go to candidates', description: 'Review proposed work before it is committed', group: 'Navigation', shortcut: 'G C', run: () => navigate('/candidates') },
      { id: 'go-graph', label: 'Go to graph', description: 'Inspect contains and blocks relationships', group: 'Navigation', shortcut: 'G R', run: () => navigate('/graph') },
      { id: 'go-inbox', label: 'Go to inbox', description: 'Open notifications and activity', group: 'Navigation', shortcut: 'G I', run: () => navigate('/inbox') },
      { id: 'go-my-issues', label: 'Go to my issues', description: 'Open your assigned issues', group: 'Navigation', shortcut: 'G M', run: () => navigate('/my-issues') },
      { id: 'go-projects', label: 'Go to projects', description: 'Open the projects list', group: 'Navigation', shortcut: 'G P', run: () => navigate('/projects') },
      { id: 'go-cycles', label: 'Go to milestones', description: 'Open the milestones & cycles view', group: 'Navigation', shortcut: 'G V', run: () => navigate('/cycles') },
      { id: 'go-views', label: 'Go to views', description: 'Open saved views', group: 'Navigation', shortcut: 'G W', run: () => navigate('/views') },
      { id: 'go-members', label: 'Go to members', description: 'Open workspace members', group: 'Navigation', shortcut: 'G E', run: () => navigate('/members') },
      { id: 'go-settings', label: 'Go to settings', description: 'Open workspace settings', group: 'Navigation', shortcut: 'G S', run: () => navigate('/settings') },
      { id: 'create-issue', label: 'Create issue', description: 'Open the quick issue composer on the active team', group: 'Actions', shortcut: 'C', run: () => openCreateIssueSurface(navigate, location.pathname) },
      { id: 'toggle-theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`, description: 'Toggle the workspace theme', group: 'Preferences', shortcut: 'T', run: () => setThemeState((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark')) },
      { id: 'open-tweaks', label: 'Open interface tweaks', description: 'Adjust density, theme, and sidebar width', group: 'Preferences', run: () => setTweaksOpen(true) },
    ];

    if (session?.authenticated) {
      nextActions.push({
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
        nextActions.push({
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
        nextActions.push({
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
      nextActions.push({
        id: `team-${team.key}`,
        label: `Open ${team.name}`,
        description: `${team.key} board`,
        group: 'Teams',
        hint: team.key,
        run: () => {
          writeStoredTeamKey(team.key);
          setActiveTeamKey(team.key);
          navigate('/');
        },
      });
    }

    for (const issue of shellIssues) {
      nextActions.push({
        id: `issue-${issue.id}`,
        label: `${issue.identifier} · ${issue.title}`,
        description: `${issue.teamKey} · ${issue.stateName}`,
        group: 'Issues',
        hint: issue.identifier,
        run: () => navigate(`/issue/${issue.id}`),
      });
    }

    return nextActions;
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

  return {
    actions,
    density,
    paletteOpen,
    session,
    setDensityState,
    setPaletteOpen,
    setSidebarWidthState,
    setThemeState,
    setTweaksOpen,
    sidebarWidth,
    theme,
    tweaksOpen,
  };
}
