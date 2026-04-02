import { useEffect, useMemo, useState } from 'react';

import type { IssueSummary, TeamSummary } from '../board/types';

interface IssueDetailDrawerProps {
  issue: IssueSummary | null;
  team: TeamSummary | null;
  savingState: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onStateChange: (issue: IssueSummary, stateId: string) => Promise<void>;
}

export function IssueDetailDrawer({
  issue,
  team,
  savingState,
  errorMessage,
  onClose,
  onStateChange,
}: IssueDetailDrawerProps) {
  const [selectedStateId, setSelectedStateId] = useState<string>('');

  useEffect(() => {
    setSelectedStateId(issue?.state.id ?? '');
  }, [issue]);

  const states = useMemo(() => team?.states.nodes ?? [], [team]);

  if (!issue) {
    return null;
  }

  return (
    <aside className="issue-drawer" aria-label="Issue detail drawer">
      <div className="issue-drawer__backdrop" onClick={onClose} />
      <section className="issue-drawer__panel">
        <div className="issue-drawer__header">
          <div>
            <p className="app-shell__eyebrow">{issue.identifier}</p>
            <h2>{issue.title}</h2>
          </div>
          <button type="button" className="issue-drawer__close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="issue-drawer__section">
          <span className="issue-drawer__label">Description</span>
          <p>{issue.description?.trim() || 'No description yet.'}</p>
        </div>

        <div className="issue-drawer__section">
          <label className="team-selector">
            <span>State</span>
            <select
              aria-label="Issue state"
              value={selectedStateId}
              disabled={savingState}
              onChange={(event) => {
                const nextStateId = event.target.value;
                setSelectedStateId(nextStateId);
                void onStateChange(issue, nextStateId).catch(() => undefined);
              }}
            >
              {states.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {errorMessage ? (
          <p className="issue-drawer__error" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </section>
    </aside>
  );
}
