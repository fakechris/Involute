import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';

import { BoardPage } from './routes/BoardPage';
import { AccessPage } from './routes/AccessPage';
import { IssuePage } from './routes/IssuePage';
import { fetchSessionState, getGoogleLoginUrl, logoutSession, type SessionState } from './lib/session';

function getNavLinkClassName({ isActive }: { isActive: boolean }) {
  return `app-shell__link${isActive ? ' app-shell__link--active' : ''}`;
}

export function App() {
  const [session, setSession] = useState<SessionState | null | undefined>(undefined);
  const [isSessionLoaded, setIsSessionLoaded] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

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

  return (
    <div className="app-shell">
      <nav className="app-shell__nav" aria-label="Primary">
        <div className="app-shell__brand-group">
          <div className="app-shell__brand">Involute</div>
          <div className="app-shell__links">
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
          </div>
        </div>

        <div className="app-shell__session">
          {sessionError ? <span className="app-shell__session-status">{sessionError}</span> : null}
          {session?.authenticated && session.viewer ? (
            <>
              <span className="app-shell__session-status">
                {session.viewer.name}
                {' · '}
                {session.viewer.globalRole}
              </span>
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
            </>
          ) : !isSessionLoaded ? (
            <span className="app-shell__session-status">Loading session…</span>
          ) : session?.googleOAuthConfigured ? (
            <a className="app-shell__session-action" href={getGoogleLoginUrl()}>
              Sign in with Google
            </a>
          ) : (
            <span className="app-shell__session-status">Google OAuth not configured</span>
          )}
        </div>
      </nav>

      <div className="app-shell__content">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/backlog" element={<BoardPage />} />
          <Route path="/settings/access" element={<AccessPage />} />
          <Route path="/issue/:id" element={<IssuePage />} />
        </Routes>
      </div>
    </div>
  );
}
