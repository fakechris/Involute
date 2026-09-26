import { useLocation, useNavigate } from 'react-router-dom';

import { openCreateIssueSurface } from '../app/shellStorage';
import { childPlacement } from '../work/placement';

interface AddSubIssueButtonProps {
  issue: { id: string; identifier: string; title: string; kind?: string | null; repository?: string | null };
}

/** Create issue, already placed under this item (INV-744). */
export function AddSubIssueButton({ issue }: AddSubIssueButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const placement = childPlacement(issue);
  if (!placement) return null;
  const label = !issue.kind || issue.kind === 'ISSUE' ? 'Add sub-issue' : 'Add issue';
  return (
    <button
      type="button"
      className="ui-action add-sub-issue"
      aria-label={`${label} to ${issue.identifier}`}
      onClick={() => openCreateIssueSurface(navigate, location.pathname, placement)}
    >
      + {label}
    </button>
  );
}
