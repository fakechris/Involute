import { Navigate, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';

/**
 * /members?team=KEY and /settings/access showed one team's roster or
 * settings; they now live under the team (INV-850) and redirect there.
 */
export function LegacyTeamRedirect({ to }: { to: 'members' | 'settings' }) {
  const [searchParams] = useSearchParams();
  const key = searchParams.get('team') ?? readStoredTeamKey() ?? 'INV';
  return <Navigate to={`/teams/${encodeURIComponent(key)}/${to}`} replace />;
}
