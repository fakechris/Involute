import { useEffect, useRef, type FormEvent } from 'react';

import type { TeamSummary } from '../board/types';
import type { CreatePlacement, PlaceableProject, PlacementSource } from '../work/placement';
import { Checkbox, Field, Select, TextInput } from './controls';
import { DialogShell } from './DialogShell';
import { PlacementPicker } from './PlacementPicker';
import { Btn } from './Primitives';
import { RichTextEditor } from './RichTextEditor';

export type CreatableKind = 'ISSUE' | 'EPIC' | 'DECISION';

/** A decision records what was decided and why (AGENTS.md §10); it starts from the three-part outline. */
export const DECISION_TEMPLATE = '### 1. 目标与架构定位\n\n### 2. 决策内容与依据\n\n### 3. 验收标准与验证方案\n';

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
  /** Issue, Epic or Decision (INV-791); milestones are created on the Cycles page. */
  createKind: CreatableKind;
  onCreateKindChange: (kind: CreatableKind) => void;
  errorMessage: string | null;
  onPlacementChange: (placement: CreatePlacement | null) => void;
  onCreateMoreChange: (value: boolean) => void;
  onClose: () => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTeamChange: (teamKey: string) => void;
  onTitleChange: (value: string) => void;
  /** Bug is a type here too, but a bug is filed with priority and steps: hand over to Report bug (INV-1132). */
  onReportBug?: () => void;
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
  createKind,
  onCreateKindChange,
  errorMessage,
  onPlacementChange,
  onCreateMoreChange,
  onClose,
  onDescriptionChange,
  onSubmit,
  onTeamChange,
  onTitleChange,
  onReportBug,
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
    <DialogShell
      variant="modal"
      title="Create issue"
      eyebrow="Involute"
      ariaLabel="Create issue drawer"
      backdropLabel="Close create issue drawer"
      onClose={onClose}
      onSubmit={onSubmit}
      formRef={formRef}
      formProps={{
        onKeyDown: (event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            formRef.current?.requestSubmit();
          }
        },
      }}
      footer={
        <>
          <div className="dialog-shell__footer-start">
            <Checkbox label="Create more" checked={createMore} onChange={(event) => onCreateMoreChange(event.target.checked)} />
            {!placement ? <span className="observation-hint">Choose where it belongs</span> : null}
          </div>
          <Btn
            type="submit"
            variant="accent"
            size="md"
            disabled={isSaving || !createTitle.trim() || !selectedTeam || !placement}
            title="Create issue (⌘/Ctrl + Enter)"
          >
            Create issue
          </Btn>
        </>
      }
    >
      <Field label="Type">
        <Select
          aria-label="Work type"
          value={createKind}
          disabled={isSaving}
          onChange={(event) => {
            if (event.target.value === 'BUG') onReportBug?.();
            else onCreateKindChange(event.target.value as CreatableKind);
          }}
        >
          <option value="ISSUE">Issue</option>
          <option value="EPIC">Epic</option>
          <option value="DECISION">Decision</option>
          {onReportBug ? <option value="BUG">Bug — report with steps and priority</option> : null}
        </Select>
      </Field>

      <Field label="Title" htmlFor="create-issue-title">
        <TextInput
          ref={titleInputRef}
          aria-label="Issue title"
          value={createTitle}
          disabled={isSaving}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </Field>

      <div className="field">
        <label className="field__label" htmlFor="create-issue-description">
          Description
        </label>
        {/* Paste, drop or attach screenshots like in a comment (INV-1132). */}
        <RichTextEditor
          id="create-issue-description"
          ariaLabel="Issue description"
          placeholder="Describe it; paste or drop screenshots"
          value={createDescription}
          disabled={isSaving}
          onChange={onDescriptionChange}
          hideSubmit
        />
      </div>

      {teams.length > 1 ? (
        <Field label="Team">
          <Select
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
          </Select>
        </Field>
      ) : null}

      <PlacementPicker
        projects={projects}
        value={placement}
        source={placementSource}
        kind={createKind}
        disabled={isSaving}
        onChange={onPlacementChange}
      />

      {errorMessage ? (
        <p className="dialog-shell__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </DialogShell>
  );
}
