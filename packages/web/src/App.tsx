import { NavLink, Route, Routes } from 'react-router-dom';

import { BacklogPage } from './routes/BacklogPage';
import { BoardPage } from './routes/BoardPage';
import { IssuePage } from './routes/IssuePage';

function getNavLinkClassName({ isActive }: { isActive: boolean }) {
  return `app-shell__link${isActive ? ' app-shell__link--active' : ''}`;
}

export function App() {
  return (
    <div className="app-shell">
      <nav className="app-shell__nav" aria-label="Primary">
        <div className="app-shell__brand">Involute</div>

        <div className="app-shell__links">
          <NavLink to="/" end className={getNavLinkClassName}>
            Board
          </NavLink>
          <NavLink to="/backlog" className={getNavLinkClassName}>
            Backlog
          </NavLink>
        </div>
      </nav>

      <div className="app-shell__content">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/backlog" element={<BacklogPage />} />
          <Route path="/issue/:id" element={<IssuePage />} />
        </Routes>
      </div>
    </div>
  );
}
