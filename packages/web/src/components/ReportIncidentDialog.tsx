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
import { Checkbox, Field, Select, TextArea, TextInput } from './controls';
import { DialogShell } from './DialogShell';
import { PlacementPicker } from './PlacementPicker';
import { Btn } from './Primitives';

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
    <DialogShell
      variant="side"
      title="Report incident"
      eyebrow="Involute"
      ariaLabel="Report incident drawer"
      backdropLabel="Close report incident drawer"
      onClose={onClose}
      onSubmit={declared ? undefined : (event) => void handleSubmit(event)}
      footer={declared ? (
        <Link className="ui-action ui-action--accent ui-action--md" to={`/?issue=${encodeURIComponent(declared.identifier)}`} onClick={onClose}>
          Open on board
        </Link>
      ) : (
        <>
          {errorMessage ? (
            <p className="dialog-shell__error dialog-shell__footer-start" role="alert">{errorMessage}</p>
          ) : null}
          <Btn variant="ghost" size="md" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" variant="accent" size="md" disabled={!canSubmit} loading={isSaving}>
            {isSaving ? 'Reporting…' : 'Report incident'}
          </Btn>
        </>
      )}
    >
      {declared ? (
        <p role="status">
          Incident <span className="mono">{declared.identifier}</span> declared and in progress. You are the Incident Lead; the team was notified.
        </p>
      ) : (
        <>
          <Field label="Title" htmlFor="report-incident-title">
            <TextInput
              ref={titleInputRef}
              aria-label="Incident title"
              value={title}
              disabled={isSaving}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          <Field label="Impact" htmlFor="report-incident-impact">
            <TextArea
              aria-label="Incident impact"
              placeholder="Who or what is affected, how, since when…"
              value={impact}
              disabled={isSaving}
              onChange={(event) => setImpact(event.target.value)}
            />
          </Field>

          <div className="field-grid">
            <Field label="Severity">
              <Select
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
              </Select>
            </Field>
          </div>

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

          {extraLabels.length > 0 ? (
            <div className="field">
              <span className="field__label">Labels</span>
              <div className="checkbox-group">
                {extraLabels.map((label) => (
                  <Checkbox
                    key={label.id}
                    label={label.name}
                    checked={selectedLabelIds.includes(label.id)}
                    disabled={isSaving}
                    onChange={() => toggleLabel(label.id)}
                    aria-label={label.name}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </DialogShell>
  );
}
