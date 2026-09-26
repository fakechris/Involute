import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { Link } from 'react-router-dom';

import { BUG_REPORT_MUTATION, SIMILAR_BUGS_QUERY } from '../board/queries';
import type {
  BugReportMutationData,
  BugReportMutationVariables,
  LabelSummary,
  ProjectSummaryItem,
  SimilarBugsQueryData,
} from '../board/types';
import { isTypeLabel } from '../work/labels';
import { readLastPlacement, rememberPlacement, resolveInitialPlacement, type CreatePlacement, type PlacementSource } from '../work/placement';
import { PlacementPicker } from './PlacementPicker';
import { RichTextEditor } from './RichTextEditor';

const PRIORITY_OPTIONS = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
];

const REPORT_ERROR_MESSAGE = 'Could not report the bug. Please try again.';

interface ReportBugDialogProps {
  isOpen: boolean;
  teamId: string;
  teamKey: string;
  projects: ProjectSummaryItem[];
  labels: LabelSummary[];
  /** The board's project filter, to start the report there (INV-749). */
  boardRepository?: string | null;
  onClose: () => void;
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Report a bug (Bug route v1, INV-748/749). A bug says where it belongs — its
 * project, or a milestone in it — and is committed there; "not sure" sends it
 * to triage instead. Priority and steps to reproduce are required, and open
 * bugs with similar titles are shown so duplicates are caught before filing.
 */
export function ReportBugDialog({ isOpen, teamId, teamKey, projects, labels, boardRepository, onClose }: ReportBugDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [priority, setPriority] = useState(0);
  const [placement, setPlacement] = useState<CreatePlacement | null>(null);
  const [placementSource, setPlacementSource] = useState<PlacementSource | null>(null);
  const [triage, setTriage] = useState(false);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reported, setReported] = useState<{ id: string; identifier: string; triage: boolean } | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const [runBugReport, bugReportMutationState] = useMutation<BugReportMutationData, BugReportMutationVariables>(BUG_REPORT_MUTATION);
  // The app-level apollo mock returns a bare [fn] tuple for unmatched
  // mutations; tolerate a missing state entry.
  const isSaving = bugReportMutationState?.loading ?? false;

  const searchTitle = useDebounced(title.trim(), 300);
  const similar = useQuery<SimilarBugsQueryData, { teamId: string; title: string }>(SIMILAR_BUGS_QUERY, {
    variables: { teamId, title: searchTitle },
    skip: !isOpen || searchTitle.length < 3,
  });
  const similarBugs = searchTitle.length >= 3 ? (similar.data?.similarBugs ?? []) : [];

  useEffect(() => {
    if (!isOpen) return;
    const initial = resolveInitialPlacement({
      boardRepository: boardRepository && boardRepository !== '__none__' ? boardRepository : null,
      last: readLastPlacement(teamKey),
      projects: projectsRef.current,
    });
    setTitle('');
    setDescription('');
    setSteps('');
    setPriority(0);
    setPlacement(initial?.placement ?? null);
    setPlacementSource(initial?.source ?? null);
    setTriage(false);
    setSelectedLabelIds([]);
    setErrorMessage(null);
    setReported(null);
  }, [isOpen, boardRepository, teamKey]);

  useEffect(() => {
    if (isOpen) titleInputRef.current?.focus();
  }, [isOpen, reported]);

  if (!isOpen) {
    return null;
  }

  // Type is Bug by definition; the other Type labels do not apply.
  const extraLabels = labels.filter((label) => !isTypeLabel(label.name));
  const placed = triage || Boolean(placement);
  const canSubmit = Boolean(title.trim() && steps.trim() && priority > 0 && placed) && !isSaving;

  function toggleLabel(labelId: string) {
    setSelectedLabelIds((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
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
            stepsToReproduce: steps.trim(),
            priority,
            ...(triage || !placement ? {} : { parentId: placement.parentId }),
            labelIds: selectedLabelIds,
          },
        },
      });
      const payload = result.data?.bugReport;
      if (!payload?.success || !payload.issue) {
        setErrorMessage(payload?.message ?? REPORT_ERROR_MESSAGE);
        return;
      }
      if (!triage && placement) rememberPlacement(teamKey, placement);
      setReported({ id: payload.issue.id, identifier: payload.issue.identifier, triage });
    } catch {
      setErrorMessage(REPORT_ERROR_MESSAGE);
    }
  }

  function reportAnother() {
    setTitle('');
    setDescription('');
    setSteps('');
    setSelectedLabelIds([]);
    setErrorMessage(null);
    setReported(null);
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
            <p role="status">
              Bug <span className="mono">{reported.identifier}</span>{' '}
              {reported.triage
                ? 'sent to triage. Someone will place it and commit it or decline it.'
                : 'reported. The team was notified.'}
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Link
                className="ui-action ui-action--accent"
                to={reported.triage ? '/candidates' : `/?issue=${encodeURIComponent(reported.identifier)}`}
                onClick={onClose}
              >
                {reported.triage ? 'Open triage' : 'Open on board'}
              </Link>
              <button type="button" className="ui-action" onClick={reportAnother}>
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
              {similarBugs.length > 0 ? (
                <div className="similar-bugs" role="region" aria-label="Similar open bugs">
                  <span className="observation-hint">Similar open bugs — is it one of these?</span>
                  <ul>
                    {similarBugs.map((bug) => (
                      <li key={bug.id}>
                        <Link to={`/issue/${bug.id}`} onClick={onClose}>
                          <span className="mono">{bug.identifier}</span> {bug.title}
                        </Link>{' '}
                        <span className="observation-card__meta">{bug.state.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="issue-panel__section">
              <label className="issue-panel__label" htmlFor="report-bug-steps">
                Steps to reproduce
              </label>
              <textarea
                id="report-bug-steps"
                aria-label="Steps to reproduce"
                className="issue-panel__textarea"
                placeholder={'1. Open …\n2. Click …\n3. See …'}
                value={steps}
                disabled={isSaving}
                onChange={(event) => setSteps(event.target.value)}
              />
            </div>

            <div className="issue-panel__section">
              <span className="issue-panel__label">Description</span>
              <RichTextEditor
                value={description}
                onChange={setDescription}
                disabled={isSaving}
                placeholder="Expected vs actual behaviour, screenshots…"
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
                  <option value={0} disabled>
                    Choose a priority
                  </option>
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="issue-panel__section">
              {triage ? (
                <p className="observation-hint">It goes to triage; whoever commits it chooses where it belongs.</p>
              ) : (
                <PlacementPicker
                  projects={projects}
                  value={placement}
                  source={placementSource}
                  disabled={isSaving}
                  onChange={(next) => {
                    setPlacement(next);
                    setPlacementSource(null);
                  }}
                />
              )}
              <label className="create-issue__more" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={triage} disabled={isSaving} onChange={(event) => setTriage(event.target.checked)} />
                Not sure where it belongs — send to triage
              </label>
            </div>

            {extraLabels.length > 0 ? (
              <div className="issue-panel__section">
                <span className="issue-panel__label">Labels</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {extraLabels.map((label) => (
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

            <button type="submit" className="ui-action ui-action--accent" disabled={!canSubmit}>
              {isSaving ? 'Reporting…' : 'Report bug'}
            </button>
          </form>
        )}
      </section>
    </aside>
  );
}
