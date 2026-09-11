import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client/react';
import { Link } from 'react-router-dom';

import { BUG_REPORT_MUTATION } from '../board/queries';
import type {
  BugReportMutationData,
  BugReportMutationVariables,
  LabelSummary,
  ProjectSummaryItem,
} from '../board/types';
import { RichTextEditor } from './RichTextEditor';

const PRIORITY_OPTIONS = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
];

const REPORT_ERROR_MESSAGE = 'Could not report the bug. Please try again.';

interface ReportBugDialogProps {
  isOpen: boolean;
  teamId: string;
  projects: ProjectSummaryItem[];
  labels: LabelSummary[];
  onClose: () => void;
}

export function ReportBugDialog({ isOpen, teamId, projects, labels, onClose }: ReportBugDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [repository, setRepository] = useState('');
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reported, setReported] = useState<{ id: string; identifier: string } | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const [runBugReport, bugReportMutationState] = useMutation<
    BugReportMutationData,
    BugReportMutationVariables
  >(BUG_REPORT_MUTATION);
  // The app-level apollo mock returns a bare [fn] tuple for unmatched
  // mutations; tolerate a missing state entry.
  const isSaving = bugReportMutationState?.loading ?? false;

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setPriority(0);
      setRepository('');
      setSelectedLabelIds([]);
      setErrorMessage(null);
      setReported(null);
    }
  }, [isOpen]);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const typeLabels = labels.filter((label) => label.name.toLowerCase() !== 'bug');

  function toggleLabel(labelId: string) {
    setSelectedLabelIds((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || isSaving) {
      return;
    }
    setErrorMessage(null);
    try {
      const result = await runBugReport({
        variables: {
          input: {
            teamId,
            title: title.trim(),
            description: description.trim() || null,
            priority,
            repository: repository || null,
            labelIds: selectedLabelIds,
          },
        },
      });
      const payload = result.data?.bugReport;
      if (!payload?.success || !payload.issue) {
        setErrorMessage(REPORT_ERROR_MESSAGE);
        return;
      }
      setReported({ id: payload.issue.id, identifier: payload.issue.identifier });
    } catch {
      setErrorMessage(REPORT_ERROR_MESSAGE);
    }
  }

  return (
    <aside className="issue-panel" aria-label="Report bug drawer" aria-modal="true" role="dialog">
      <button
        type="button"
        className="issue-panel__backdrop"
        aria-label="Close report bug drawer"
        onClick={onClose}
      />
      <section className="issue-panel__frame">
        <div className="issue-panel__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h2>Report bug</h2>
          </div>
          <button type="button" className="issue-panel__close" onClick={onClose}>
            Close
          </button>
        </div>

        {reported ? (
          <div className="issue-panel__section">
            <p>
              Bug <span className="mono">{reported.identifier}</span> reported. The team was
              notified.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Link
                className="ui-action ui-action--accent"
                to={`/?issue=${encodeURIComponent(reported.identifier)}`}
                onClick={onClose}
              >
                Open on board
              </Link>
              <button type="button" className="ui-action" onClick={() => setReported(null)}>
                Report another
              </button>
            </div>
          </div>
        ) : (
          <form className="discussion-form" onSubmit={(event) => void handleSubmit(event)}>
            <div className="issue-panel__section">
              <label className="issue-panel__label" htmlFor="report-bug-title">
                Title
              </label>
              <input
                id="report-bug-title"
                ref={titleInputRef}
                aria-label="Bug title"
                className="issue-panel__title-input"
                value={title}
                disabled={isSaving}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="issue-panel__section">
              <span className="issue-panel__label">Description</span>
              <RichTextEditor
                value={description}
                onChange={setDescription}
                disabled={isSaving}
                placeholder="Steps to reproduce, expected vs actual behavior…"
                ariaLabel="Bug description"
              />
            </div>

            <div className="issue-panel__section">
              <label className="field-stack">
                <span>Priority</span>
                <select
                  aria-label="Bug priority"
                  value={priority}
                  disabled={isSaving}
                  onChange={(event) => setPriority(Number(event.target.value))}
                >
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="issue-panel__section">
              <label className="field-stack">
                <span>Project</span>
                <select
                  aria-label="Bug project"
                  value={repository}
                  disabled={isSaving}
                  onChange={(event) => setRepository(event.target.value)}
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.repository} value={project.repository}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {typeLabels.length > 0 ? (
              <div className="issue-panel__section">
                <span className="issue-panel__label">Labels</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {typeLabels.map((label) => (
                    <label
                      key={label.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedLabelIds.includes(label.id)}
                        disabled={isSaving}
                        onChange={() => toggleLabel(label.id)}
                        aria-label={label.name}
                      />
                      {label.name}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {errorMessage ? (
              <p role="alert" style={{ color: 'var(--fg-danger, #e5484d)', fontSize: 13 }}>
                {errorMessage}
              </p>
            ) : null}

            <button
              type="submit"
              className="ui-action ui-action--accent"
              disabled={isSaving || !title.trim()}
            >
              {isSaving ? 'Reporting…' : 'Report bug'}
            </button>
          </form>
        )}
      </section>
    </aside>
  );
}
