import { useContext, useEffect } from 'react';
import { getApolloContext } from '@apollo/client/react';

import { startSavedViewsSync } from '../lib/saved-views-sync';

/**
 * Runs the saved-views server sync (INV-1005) for the signed-in account and
 * the active team, as the app shell (INV-1196). It starts only once both are
 * known, restarts when either changes and stops on sign-out or unmount; one
 * instance at a time, since each start is paired with the previous stop.
 * Without an Apollo provider (most shell tests) there is nothing to sync with.
 */
export function useSavedViewsSync(accountId: string | null, teamKey: string | null): void {
  const client = useContext(getApolloContext()).client ?? null;
  useEffect(() => {
    if (!client || !accountId || !teamKey) return;
    return startSavedViewsSync(client, teamKey, accountId);
  }, [client, accountId, teamKey]);
}
