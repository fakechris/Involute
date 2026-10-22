import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { Link } from 'react-router-dom';

import { BUG_REPORT_MUTATION, SERVER_BUILD_QUERY, SIMILAR_BUGS_QUERY } from '../board/queries';
import type {
  BugReportMutationData,
  BugReportMutationVariables,
  BugReproducibility,
  IssueSeverity,
  LabelSummary,
  ProjectSummaryItem,
  ServerBuildQueryData,
  SimilarBugsQueryData,
} from '../board/types';
import { SEVERITY_OPTIONS } from '../board/severity';
import { REPRODUCIBILITY_OPTIONS } from '../board/reproducibility';
import { isTypeLabel } from '../work/labels';
import { readLastPlacement, rememberPlacement, resolveInitialPlacement, type CreatePlacement, type PlacementSource } from '../work/placement';
import { Checkbox, Field, Select, TextArea, TextInput } from './controls';
import { DialogShell } from './DialogShell';
import { PlacementPicker } from './PlacementPicker';
import { Btn } from './Primitives';
import { RichTextEditor } from './RichTextEditor';

const PRIORITY_OPTIONS = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
];

const REPORT_ERROR_MESSAGE = 'Could not report the bug. Please try again.';
// A deploy SHA (INV-1121): 7–40 hex, optionally as the sha-… image tag.
const FOUND_IN_SHA = /^(sha-)?[0-9a-f]{7,40}$/i;

interface ReportBugDialogProps {
  isOpen: boolean;
  teamId: string;
  teamKey: string;
  projects: ProjectSummaryItem[];
  labels: LabelSummary[];
  /** The board's project filter, to start the report there (INV-749). */
  boardRepository?: string | null;
  /** What was typed in the create drawer before switching to Bug (INV-1132). */
  initialTitle?: string;
  initialDescription?: string;
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
export function ReportBugDialog({ isOpen, teamId, teamKey, projects, labels, boardRepository, initialTitle = '', initialDescription = '', onClose }: ReportBugDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [priority, setPriority] = useState(0);
  const [severity, setSeverity] = useState<IssueSeverity | ''>('');
  const [reproducibility, setReproducibility] = useState<BugReproducibility | ''>('');
  // null: not edited, so it follows the running build (INV-1121).
  const [foundInSha, setFoundInSha] = useState<string | null>(null);
  const [placement, setPlacement] = useState<CreatePlacement | null>(null);
  const [placementSource, setPlacementSource] = useState<PlacementSource | null>(null);
  const [triage, setTriage] = useState(false);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reported, setReported] = useState<{ id: string; identifier: string; triage: boolean } | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // Read when the dialog opens, not while it is open: typing must not be reset.
  const initialRef = useRef({ description: initialDescription, title: initialTitle });
  initialRef.current = { description: initialDescription, title: initialTitle };

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
  const build = useQuery<ServerBuildQueryData>(SERVER_BUILD_QUERY, { skip: !isOpen });
  const runningBuildSha = build.data?.serverBuild?.buildSha ?? null;
  const foundIn = (foundInSha ?? runningBuildSha ?? '').trim();
  const foundInValid = !foundIn || FOUND_IN_SHA.test(foundIn);

  useEffect(() => {
    if (!isOpen) return;
    const initial = resolveInitialPlacement({
      boardRepository: boardRepository && boardRepository !== '__none__' ? boardRepository : null,
      last: readLastPlacement(teamKey),
      projects: projectsRef.current,
    });
    setTitle(initialRef.current.title);
    setDescription(initialRef.current.description);
    setSteps('');
    setPriority(0);
    setSeverity('');
    setReproducibility('');
    setFoundInSha(null);
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
  const canSubmit = Boolean(title.trim() && steps.trim() && priority > 0 && placed && foundInValid) && !isSaving;

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
            ...(severity ? { severity } : {}),
            ...(reproducibility ? { reproducibility } : {}),
            ...(foundIn ? { foundInSha: foundIn } : {}),
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
    <DialogShell
      variant="side"
      title="Report bug"
      eyebrow="Involute"
      ariaLabel="Report bug drawer"
      backdropLabel="Close report bug drawer"
      onClose={onClose}
      onSubmit={reported ? undefined : (event) => void handleSubmit(event)}
      footer={reported ? (
        <>
          <Btn variant="subtle" size="md" onClick={reportAnother}>Report another</Btn>
          <Link
            className="ui-action ui-action--accent ui-action--md"
            to={reported.triage ? '/candidates' : `/?issue=${encodeURIComponent(reported.identifier)}`}
            onClick={onClose}
          >
            {reported.triage ? 'Open triage' : 'Open on board'}
          </Link>
        </>
      ) : (
        <>
          {errorMessage ? (
            <p className="dialog-shell__error dialog-shell__footer-start" role="alert">{errorMessage}</p>
          ) : null}
          <Btn variant="ghost" size="md" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" variant="accent" size="md" disabled={!canSubmit} loading={isSaving}>
            {isSaving ? 'Reporting…' : 'Report bug'}
          </Btn>
        </>
      )}
    >
      {reported ? (
        <p role="status">
          Bug <span className="mono">{reported.identifier}</span>{' '}
          {reported.triage
            ? 'sent to triage. Someone will place it and commit it or decline it.'
            : 'reported. The team was notified.'}
        </p>
      ) : (
        <>
          <Field label="Title" htmlFor="report-bug-title">
            <TextInput
              ref={titleInputRef}
              aria-label="Bug title"
              value={title}
              disabled={isSaving}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
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

          <Field label="Steps to reproduce" htmlFor="report-bug-steps">
            <TextArea
              aria-label="Steps to reproduce"
              placeholder={'1. Open …\n2. Click …\n3. See …'}
              value={steps}
              disabled={isSaving}
              onChange={(event) => setSteps(event.target.value)}
            />
          </Field>

          <div className="field">
            <span className="field__label">Description</span>
            <RichTextEditor
              value={description}
              onChange={setDescription}
              disabled={isSaving}
              placeholder="Expected vs actual behaviour, screenshots…"
              ariaLabel="Bug description"
              hideSubmit
            />
          </div>

          <div className="field-grid">
            <Field label="Priority">
              <Select
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
              </Select>
            </Field>
            <Field label="Severity (optional)">
              <Select
                aria-label="Bug severity"
                title="How bad the effect is, apart from priority. Unsure? Pick the higher one."
                value={severity}
                disabled={isSaving}
                onChange={(event) => setSeverity(event.target.value as IssueSeverity | '')}
              >
                <option value="">Not judged</option>
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} title={option.description}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reproduces (optional)">
              <Select
                aria-label="Bug reproducibility"
                title="How often it shows up when you try. Sometimes / Once: a person accepts the fix; it is never auto-accepted."
                value={reproducibility}
                disabled={isSaving}
                onChange={(event) => setReproducibility(event.target.value as BugReproducibility | '')}
              >
                <option value="">Not known</option>
                {REPRODUCIBILITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} title={option.description}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Found in (deploy SHA)" error={!foundInValid ? 'A commit SHA: 7 to 40 hex characters.' : undefined}>
              <TextInput
                aria-label="Found in deploy SHA"
                title="The deploy you saw it on: its commit SHA. Starts as the build this server runs; clear it if you saw it elsewhere."
                value={foundInSha ?? runningBuildSha ?? ''}
                placeholder="Build unknown"
                spellCheck={false}
                disabled={isSaving}
                onChange={(event) => setFoundInSha(event.target.value)}
              />
            </Field>
          </div>

          <div className="field">
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
            <Checkbox
              label="Not sure where it belongs — send to triage"
              checked={triage}
              disabled={isSaving}
              onChange={(event) => setTriage(event.target.checked)}
            />
          </div>

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
