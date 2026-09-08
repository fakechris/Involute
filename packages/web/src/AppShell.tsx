import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';

import { CommandPalette, type PaletteAction } from './app/CommandPalette';
import { TweaksPanel, type DensityMode, type ThemeMode } from './app/TweaksPanel';
import {
  getStoredDensity,
  getStoredSidebarWidth,
  getStoredTheme,
  persistDensity,
  persistSidebarWidth,
  persistTheme,
} from './app/shellStorage';
import { IcoFilter, IcoGraph, IcoInbox, IcoIssues, IcoProject, IcoSearch, IcoSettings, IcoTeam, IcoViews } from './components/Icons';
import { NotificationsBell } from './components/NotificationsBell';

const BoardPage = lazy(async () => {
  const module = await import('./routes/BoardPage');
  return { default: module.BoardPage };
});
const InReviewPage = lazy(async () => {
  const module = await import('./routes/InReviewPage');
  return { default: module.InReviewPage };
});
const CandidatesPage = lazy(async () => {
  const module = await import('./routes/CandidatesPage');
  return { default: module.CandidatesPage };
});
const GraphPage = lazy(async () => {
  const module = await import('./routes/GraphPage');
  return { default: module.GraphPage };
});
const InboxPage = lazy(async () => {
  const module = await import('./routes/InboxPage');
  return { default: module.InboxPage };
});
const IssuePage = lazy(async () => {
  const module = await import('./routes/IssuePage');
  return { default: module.IssuePage };
});
const WorkContextPage = lazy(async () => {
  const module = await import('./routes/WorkContextPage');
  return { default: module.WorkContextPage };
});
const AccessPage = lazy(async () => {
  const module = await import('./routes/AccessPage');
  return { default: module.AccessPage };
});
const ProjectsPage = lazy(async () => {
  const module = await import('./routes/ProjectsPage');
  return { default: module.ProjectsPage };
});
const CyclesPage = lazy(async () => {
  const module = await import('./routes/CyclesPage');
  return { default: module.CyclesPage };
});
const MembersPage = lazy(async () => {
  const module = await import('./routes/MembersPage');
  return { default: module.MembersPage };
});
const SettingsPage = lazy(async () => {
  const module = await import('./routes/SettingsPage');
  return { default: module.SettingsPage };
});
const ViewsPage = lazy(async () => {
  const module = await import('./routes/ViewsPage');
  return { default: module.ViewsPage };
});
const MyIssuesPage = lazy(async () => {
  const module = await import('./routes/MyIssuesPage');
  return { default: module.MyIssuesPage };
});

function getNavLinkClassName({ isActive }: { isActive: boolean }) {
  return `app-shell__link${isActive ? ' app-shell__link--active' : ''}`;
}

export function App() {
  const navigate = useNavigate();
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme());
  const [density, setDensityState] = useState<DensityMode>(() => getStoredDensity());
  const [sidebarWidth, setSidebarWidthState] = useState(() => getStoredSidebarWidth());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const pendingShortcut = useRef<string | null>(null);

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
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (event.key.toLowerCase() === 'g') {
        pendingShortcut.current = 'g';
        window.setTimeout(() => {
          pendingShortcut.current = null;
        }, 800);
        return;
      }

      if (pendingShortcut.current === 'g') {
        const shortcutKey = event.key.toLowerCase();
        pendingShortcut.current = null;
        if (shortcutKey === 'n') {
          event.preventDefault();
          navigate('/in-review');
          return;
        }
        if (shortcutKey === 'b' || shortcutKey === 'i') {
          event.preventDefault();
          navigate('/');
          return;
        }
        if (shortcutKey === 'c') {
          event.preventDefault();
          navigate('/candidates');
          return;
        }
        if (shortcutKey === 'r') {
          event.preventDefault();
          navigate('/graph');
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: 'go-board',
        label: 'Go to board',
        group: 'Navigation',
        shortcut: 'G B',
        run: () => navigate('/'),
      },
      {
        id: 'go-in-review',
        label: 'Go to In Review',
        description: 'Batch accept or return committed work waiting in review',
        group: 'Navigation',
        shortcut: 'G N',
        run: () => navigate('/in-review'),
      },
      {
        id: 'go-candidates',
        label: 'Go to candidates',
        group: 'Navigation',
        shortcut: 'G C',
        run: () => navigate('/candidates'),
      },
      {
        id: 'go-graph',
        label: 'Go to graph',
        group: 'Navigation',
        shortcut: 'G R',
        run: () => navigate('/graph'),
      },
    ],
    [navigate],
  );

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar" style={{ width: sidebarWidth }}>
        <div className="app-shell__brand">Involute</div>
        <nav className="app-shell__nav" aria-label="Primary">
          <NavLink to="/" className={getNavLinkClassName} end title="Go to Board · G B">
            <span className="app-shell__nav-icon"><IcoIssues size={14} /></span>
            <span className="app-shell__link-label">Board</span>
            <kbd className="app-shell__link-kbd" aria-hidden="true">B</kbd>
          </NavLink>
          <NavLink to="/candidates" className={getNavLinkClassName} title="Go to Candidates · G C">
            <span className="app-shell__nav-icon"><IcoViews size={14} /></span>
            <span className="app-shell__link-label">Candidates</span>
            <kbd className="app-shell__link-kbd" aria-hidden="true">C</kbd>
          </NavLink>
          <NavLink to="/in-review" className={getNavLinkClassName} title="Go to In Review · G N">
            <span className="app-shell__nav-icon"><IcoFilter size={14} /></span>
            <span className="app-shell__link-label">In Review</span>
            <kbd className="app-shell__link-kbd" aria-hidden="true">N</kbd>
          </NavLink>
          <NavLink to="/graph" className={getNavLinkClassName} title="Go to Graph · G R">
            <span className="app-shell__nav-icon"><IcoGraph size={14} /></span>
            <span className="app-shell__link-label">Graph</span>
            <kbd className="app-shell__link-kbd" aria-hidden="true">R</kbd>
          </NavLink>
          <NavLink to="/inbox" className={getNavLinkClassName} title="Inbox">
            <span className="app-shell__nav-icon"><IcoInbox size={14} /></span>
            <span className="app-shell__link-label">Inbox</span>
          </NavLink>
          <NavLink to="/projects" className={getNavLinkClassName} title="Projects">
            <span className="app-shell__nav-icon"><IcoProject size={14} /></span>
            <span className="app-shell__link-label">Projects</span>
          </NavLink>
          <NavLink to="/members" className={getNavLinkClassName} title="Members">
            <span className="app-shell__nav-icon"><IcoTeam size={14} /></span>
            <span className="app-shell__link-label">Members</span>
          </NavLink>
          <NavLink to="/settings" className={getNavLinkClassName} title="Settings">
            <span className="app-shell__nav-icon"><IcoSettings size={14} /></span>
            <span className="app-shell__link-label">Settings</span>
          </NavLink>
        </nav>
        <div className="app-shell__sidebar-footer">
          <button type="button" className="app-shell__icon-button" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
            <IcoSearch size={14} />
          </button>
          <NotificationsBell />
          <button type="button" className="app-shell__icon-button" onClick={() => setTweaksOpen((v) => !v)} aria-label="Tweaks">
            Tweaks
          </button>
        </div>
      </aside>
      <div className="app-shell__main">
        <Suspense
          fallback={
            <main className="board-page board-page--state">
              <section className="shell-notice">
                <p>Loading view...</p>
              </section>
            </main>
          }
        >
          <Routes>
            <Route path="/" element={<BoardPage />} />
            <Route path="/backlog" element={<BoardPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/in-review" element={<InReviewPage />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/work/:id" element={<WorkContextPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/issues/:id" element={<IssuePage />} />
            <Route path="/my-issues" element={<MyIssuesPage />} />
            <Route path="/views" element={<ViewsPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/cycles" element={<CyclesPage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/access" element={<AccessPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </Suspense>
      </div>
      <CommandPalette actions={actions} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <TweaksPanel
        density={density}
        onClose={() => setTweaksOpen(false)}
        open={tweaksOpen}
        setDensity={setDensityState}
        setSidebarWidth={setSidebarWidthState}
        setTheme={setThemeState}
        sidebarWidth={sidebarWidth}
        theme={theme}
      />
    </div>
  );
}
