import { useEffect, useRef, type FormEvent } from 'react';

import type { TeamSummary } from '../board/types';
import type { CreatePlacement, PlaceableProject, PlacementSource } from '../work/placement';
import { PlacementPicker } from './PlacementPicker';

interface BoardCreateIssueDialogProps {
  createDescription: string;
  createTitle: string;
  isOpen: boolean;
  isSaving: boolean;
  selectedTeam: TeamSummary | null;
  teams: TeamSummary[];
  projects: Array<PlaceableProject & { name: string }>;
  placement: CreatePlacement | null;
  placementSource: PlacementSource | null;
  createMore: boolean;
  errorMessage: string | null;
  onPlacementChange: (placement: CreatePlacement | null) => void;
  onCreateMoreChange: (value: boolean) => void;
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
  projects,
  placement,
  placementSource,
  createMore,
  errorMessage,
  onPlacementChange,
  onCreateMoreChange,
  onClose,
  onDescriptionChange,
  onSubmit,
  onTeamChange,
  onTitleChange,
}: BoardCreateIssueDialogProps) {
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (isOpen) titleInputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <aside className="issue-panel" aria-label="Create issue drawer" aria-modal="true" role="dialog">
      <button
        type="button"
        className="issue-panel__backdrop"
        aria-label="Close create issue drawer"
        onClick={onClose}
      />
      <section className="issue-panel__frame">
        <div className="issue-panel__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h2>Create issue</h2>
          </div>
          <button type="button" className="issue-panel__close" onClick={onClose}>
            Close
          </button>
        </div>

        <form
          ref={formRef}
          className="discussion-form"
          onSubmit={onSubmit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        >
          <div className="issue-panel__section">
            <label className="issue-panel__label" htmlFor="create-issue-title">
              Title
            </label>
            <input
              id="create-issue-title"
              ref={titleInputRef}
              aria-label="Issue title"
              className="issue-panel__title-input"
              value={createTitle}
              disabled={isSaving}
              onChange={(event) => onTitleChange(event.target.value)}
            />
          </div>

          <div className="issue-panel__section">
            <label className="issue-panel__label" htmlFor="create-issue-description">
              Description
            </label>
            <textarea
              id="create-issue-description"
              aria-label="Issue description"
              className="issue-panel__textarea"
              value={createDescription}
              disabled={isSaving}
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </div>

          {teams.length > 1 ? (
            <div className="issue-panel__section">
              <label className="field-stack">
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

          <div className="issue-panel__section">
            <PlacementPicker
              projects={projects}
              value={placement}
              source={placementSource}
              disabled={isSaving}
              onChange={onPlacementChange}
            />
          </div>

          {errorMessage ? (
            <p className="issue-relations__error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <div className="create-issue__actions">
            <label className="create-issue__more">
              <input type="checkbox" checked={createMore} onChange={(event) => onCreateMoreChange(event.target.checked)} />
              Create more
            </label>
            {!placement ? <span className="observation-hint">Choose where it belongs</span> : null}
            <button
              type="submit"
              className="ui-action ui-action--accent"
              disabled={isSaving || !createTitle.trim() || !selectedTeam || !placement}
              title="Create issue (⌘/Ctrl + Enter)"
            >
              Create issue
            </button>
          </div>
        </form>
      </section>
    </aside>
  );
}
