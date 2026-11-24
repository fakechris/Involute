import { createContext, useContext } from 'react';

import { rememberSignInReturn } from '../lib/session';

export const SessionEndedContext = createContext<string | null | undefined>(undefined);

export function SessionEndedNotice({ floating = false }: { floating?: boolean }) {
  const signInUrl = useContext(SessionEndedContext);
  if (signInUrl === undefined) return null;

  return (
    <div className={floating ? 'page-notice page-notice--floating' : 'page-notice'} role={floating ? 'alert' : undefined}>
      {signInUrl ? (
        <>
          <p className="page-notice__text">Your session ended. Copy any unsaved text before you sign in.</p>
          <a className="ui-action ui-action--accent ui-action--sm" href={signInUrl} onClick={rememberSignInReturn}>
            Sign in
          </a>
        </>
      ) : (
        <p className="page-notice__text">Your session ended. Contact your workspace admin to sign in.</p>
      )}
    </div>
  );
}
