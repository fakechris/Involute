import { createContext, useContext, useId, useLayoutEffect, useState, type Dispatch, type PropsWithChildren, type SetStateAction } from 'react';

import { rememberSignInReturn } from '../lib/session';

export const SessionEndedContext = createContext<string | null | undefined>(undefined);
const InlineNoticesContext = createContext<[string[], Dispatch<SetStateAction<string[]>>]>([[], () => undefined]);

export function SessionEndedProvider({ signInUrl, children }: PropsWithChildren<{ signInUrl: string | null | undefined }>) {
  const inlineNotices = useState<string[]>([]);

  return (
    <SessionEndedContext.Provider value={signInUrl}>
      <InlineNoticesContext.Provider value={inlineNotices}>{children}</InlineNoticesContext.Provider>
    </SessionEndedContext.Provider>
  );
}

export function SessionEndedNotice({ floating = false }: { floating?: boolean }) {
  const signInUrl = useContext(SessionEndedContext);
  const [inlineNotices, setInlineNotices] = useContext(InlineNoticesContext);
  const id = useId();
  const sessionEnded = signInUrl !== undefined;

  useLayoutEffect(() => {
    if (!sessionEnded || floating) return;
    setInlineNotices((notices) => [...notices, id]);
    return () => setInlineNotices((notices) => notices.filter((notice) => notice !== id));
  }, [floating, id, sessionEnded, setInlineNotices]);

  const activeInlineNotice = inlineNotices.at(-1);
  if (!sessionEnded || (floating ? activeInlineNotice !== undefined : activeInlineNotice !== id)) return null;

  return (
    <div className={floating ? 'page-notice page-notice--floating' : 'page-notice'} role="alert">
      {signInUrl ? (
        <>
          <p className="page-notice__text">Your session ended. Copy any unsaved text before you sign in.</p>
          <a className="ui-action ui-action--accent ui-action--sm" href={signInUrl} onClick={rememberSignInReturn}>
            Sign in
          </a>
        </>
      ) : (
        <p className="page-notice__text">Your session ended. Copy any unsaved text, then contact your workspace admin to sign in.</p>
      )}
    </div>
  );
}
