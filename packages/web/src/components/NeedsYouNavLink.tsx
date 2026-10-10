import { useQuery } from '@apollo/client/react';
import { NavLink } from 'react-router-dom';

import { IcoCheck } from './Icons';
import { ATTENTION_SUMMARY_QUERY } from '../work/queries';
import type { AttentionSummaryQueryData } from '../work/types';

/**
 * The sidebar's one number (INV-1092/1093): how many decisions wait on the
 * signed-in person. Hidden at zero; always next to its label. Polls like the
 * bell, and the Needs you page refreshes the same cached field as it decides.
 */
export function NeedsYouNavLink({
  authenticated,
  className,
}: {
  authenticated: boolean;
  className: (state: { isActive: boolean }) => string;
}) {
  const { data } = useQuery<AttentionSummaryQueryData>(ATTENTION_SUMMARY_QUERY, {
    pollInterval: 60_000,
    skip: !authenticated,
  });
  // Absent when the server predates the field: show no number rather than a wrong one.
  const total = data?.attentionSummary?.total ?? 0;
  return (
    <NavLink to="/todo" className={className} title="Go to Needs you · G T">
      <span className="app-shell__nav-icon"><IcoCheck size={14} /></span>
      <span className="app-shell__link-label">Needs you</span>
      {total > 0 ? (
        <span className="app-shell__badge" aria-label={`${total} waiting on your decision`}>{total}</span>
      ) : null}
      <kbd className="app-shell__link-kbd" aria-hidden="true">G T</kbd>
    </NavLink>
  );
}
