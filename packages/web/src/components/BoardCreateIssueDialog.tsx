import type { FormEvent } from 'react';

import type { TeamSummary } from '../board/types';

interface BoardCreateIssueDialogProps {
  createDescription: string;
  createTitle: string;
  isOpen: boolean;
  isSaving: boolean;
  selectedTeam: TeamSummary | null;
  teams: TeamSummary[];
  onClose: () => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTeamChange: (teamKey: string) => void;
  onTitleChange: (value: string) => void;
}

export function BoardCreateIssueDialog({
  createDescription,
  createTitle,
  isOpen,
  isSaving,
  selectedTeam,
  teams,
  onClose,
  onDescriptionChange,
  onSubmit,
  onTeamChange,
  onTitleChange,
}: BoardCreateIssueDialogProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <aside className="issue-drawer" aria-label="Create issue drawer" aria-modal="true" role="dialog">
      <button
        type="button"
        className="issue-drawer__backdrop"
        aria-label="Close create issue drawer"
        onClick={onClose}
      />
      <section className="issue-drawer__panel">
        <div className="issue-drawer__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h2>Create issue</h2>
          </div>
          <button type="button" className="issue-drawer__close" onClick={onClose}>
            Close
          </button>
        </div>

        <form className="issue-comment-composer" onSubmit={onSubmit}>
          <div className="issue-drawer__section">
            <label className="issue-drawer__label" htmlFor="create-issue-title">
              Title
            </label>
            <input
              id="create-issue-title"
              aria-label="Issue title"
              className="issue-drawer__title-input"
              value={createTitle}
              disabled={isSaving}
              onChange={(event) => onTitleChange(event.target.value)}
            />
          </div>

          <div className="issue-drawer__section">
            <label className="issue-drawer__label" htmlFor="create-issue-description">
              Description
            </label>
            <textarea
              id="create-issue-description"
              aria-label="Issue description"
              className="issue-drawer__textarea"
              value={createDescription}
              disabled={isSaving}
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </div>

          {teams.length > 1 ? (
            <div className="issue-drawer__section">
              <label className="team-selector">
                <span>Team</span>
                <select
                  aria-label="Select team"
                  value={selectedTeam?.key ?? ''}
                  disabled={isSaving}
                  onChange={(event) => onTeamChange(event.target.value)}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.key}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <button
            type="submit"
            className="issue-comment-composer__submit"
            disabled={isSaving || !createTitle.trim() || !selectedTeam}
          >
            Create issue
          </button>
        </form>
      </section>
    </aside>
  );
}
