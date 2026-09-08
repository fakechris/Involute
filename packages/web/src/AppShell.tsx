import { lazy, Suspense } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';

import { CommandPalette } from './app/CommandPalette';
import { TweaksPanel } from './app/TweaksPanel';
import { useShellController } from './app/useShellController';
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
  const {
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
  } = useShellController();

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
          <NotificationsBell authenticated={Boolean(session?.authenticated)} />
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
            <Route path="/issue/:id" element={<IssuePage />} />
            <Route path="/issues/:id" element={<IssuePage />} />
            <Route path="/my-issues" element={<MyIssuesPage />} />
            <Route path="/views" element={<ViewsPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/cycles" element={<CyclesPage />} />
            <Route path="/milestones" element={<CyclesPage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/access" element={<AccessPage />} />
            <Route path="/settings/access" element={<AccessPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
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
