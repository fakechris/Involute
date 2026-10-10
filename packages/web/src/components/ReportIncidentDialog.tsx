import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client/react';
import { Link } from 'react-router-dom';

import { INCIDENT_DECLARE_MUTATION } from '../board/queries';
import type {
  IncidentDeclareMutationData,
  IncidentDeclareMutationVariables,
  IssueSeverity,
  LabelSummary,
  ProjectSummaryItem,
} from '../board/types';
import { SEVERITY_OPTIONS } from '../board/severity';
import { isTypeLabel } from '../work/labels';
import { readLastPlacement, rememberPlacement, resolveInitialPlacement, type CreatePlacement, type PlacementSource } from '../work/placement';
import { PlacementPicker } from './PlacementPicker';

const DECLARE_ERROR_MESSAGE = 'Could not report the incident. Please try again.';

interface ReportIncidentDialogProps {
  isOpen: boolean;
  teamId: string;
  teamKey: string;
  projects: ProjectSummaryItem[];
  labels: LabelSummary[];
  /** The board's project filter, to start the report there. */
  boardRepository?: string | null;
  onClose: () => void;
}

/**
 * Report an incident (Type: Incident, INV-1123). An incident has happened, so
 * like a placed bug it is committed at once — here In Progress, investigating,
 * with the reporter as Incident Lead — and the team is told. Where it belongs,
 * a severity and the impact are required; there is no triage.
 */
export function ReportIncidentDialog({ isOpen, teamId, teamKey, projects, labels, boardRepository, onClose }: ReportIncidentDialogProps) {
  const [title, setTitle] = useState('');
  const [impact, setImpact] = useState('');
  const [severity, setSeverity] = useState<IssueSeverity | ''>('');
  const [placement, setPlacement] = useState<CreatePlacement | null>(null);
  const [placementSource, setPlacementSource] = useState<PlacementSource | null>(null);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [declared, setDeclared] = useState<{ identifier: string } | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const [runDeclare, declareState] = useMutation<IncidentDeclareMutationData, IncidentDeclareMutationVariables>(INCIDENT_DECLARE_MUTATION);
  const isSaving = declareState?.loading ?? false;

  useEffect(() => {
    if (!isOpen) return;
    const initial = resolveInitialPlacement({
      boardRepository: boardRepository && boardRepository !== '__none__' ? boardRepository : null,
      last: readLastPlacement(teamKey),
      projects: projectsRef.current,
    });
    setTitle('');
    setImpact('');
    setSeverity('');
    setPlacement(initial?.placement ?? null);
    setPlacementSource(initial?.source ?? null);
    setSelectedLabelIds([]);
    setErrorMessage(null);
    setDeclared(null);
  }, [isOpen, boardRepository, teamKey]);

  useEffect(() => {
    if (isOpen) titleInputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  // Type is Incident by definition; the other Type labels do not apply.
  const extraLabels = labels.filter((label) => !isTypeLabel(label.name));
  const canSubmit = Boolean(title.trim() && impact.trim() && severity && placement) && !isSaving;

  function toggleLabel(labelId: string) {
    setSelectedLabelIds((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !severity || !placement) {
      return;
    }
    setErrorMessage(null);
    try {
      const result = await runDeclare({
        variables: {
          input: {
            teamId,
            title: title.trim(),
            description: impact.trim(),
            severity,
            parentId: placement.parentId,
            labels: ['incident', ...extraLabels.filter((label) => selectedLabelIds.includes(label.id)).map((label) => label.name)],
            source: 'incident-report',
          },
        },
      });
      const payload = result.data?.workPropose;
      if (!payload?.success || !payload.issue) {
        setErrorMessage(payload?.message ?? DECLARE_ERROR_MESSAGE);
        return;
      }
      rememberPlacement(teamKey, placement);
      setDeclared({ identifier: payload.issue.identifier });
    } catch {
      setErrorMessage(DECLARE_ERROR_MESSAGE);
    }
  }

  return (
    <aside className="issue-panel" aria-label="Report incident drawer" aria-modal="true" role="dialog">
      <button
        type="button"
        className="issue-panel__backdrop"
        aria-label="Close report incident drawer"
        onClick={onClose}
      />
      <section className="issue-panel__frame">
        <div className="issue-panel__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h2>Report incident</h2>
          </div>
          <button type="button" className="issue-panel__close" onClick={onClose}>
            Close
          </button>
        </div>

        {declared ? (
          <div className="issue-panel__section">
            <p role="status">
              Incident <span className="mono">{declared.identifier}</span> declared and in progress. You are the Incident Lead; the team was notified.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Link className="ui-action ui-action--accent" to={`/?issue=${encodeURIComponent(declared.identifier)}`} onClick={onClose}>
                Open on board
              </Link>
            </div>
          </div>
        ) : (
          <form className="discussion-form" onSubmit={(event) => void handleSubmit(event)}>
            <div className="issue-panel__section">
              <label className="issue-panel__label" htmlFor="report-incident-title">
                Title
              </label>
              <input
                id="report-incident-title"
                ref={titleInputRef}
                aria-label="Incident title"
                className="issue-panel__title-input"
                value={title}
                disabled={isSaving}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="issue-panel__section">
              <label className="issue-panel__label" htmlFor="report-incident-impact">
                Impact
              </label>
              <textarea
                id="report-incident-impact"
                aria-label="Incident impact"
                className="issue-panel__textarea"
                placeholder="Who or what is affected, how, since when…"
                value={impact}
                disabled={isSaving}
                onChange={(event) => setImpact(event.target.value)}
              />
            </div>

            <div className="issue-panel__section">
              <label className="field-stack">
                <span>Severity</span>
                <select
                  aria-label="Incident severity"
                  title="How bad the effect is. Unsure? Pick the higher one."
                  value={severity}
                  disabled={isSaving}
                  onChange={(event) => setSeverity(event.target.value as IssueSeverity | '')}
                >
                  <option value="" disabled>
                    Choose a severity
                  </option>
                  {SEVERITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="issue-panel__section">
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
              {isSaving ? 'Reporting…' : 'Report incident'}
            </button>
          </form>
        )}
      </section>
    </aside>
  );
}
