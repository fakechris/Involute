import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useRef, useState } from 'react';
import { Btn } from './Primitives';
import { Field, Select } from './controls';
import { Badge } from './status';
import { RefusalNotice } from './RefusalNotice';
import { WorkReference } from './WorkReference';
import { ProjectBadge } from './ProjectBadge';

export const WORK_TRIAGE_SUGGESTIONS_QUERY = gql`
  query WorkTriageSuggestions($workId: String!) {
    workTriageSuggestions(workId: $workId) {
      status degraded observationId
      suggestions {
        checkId kind value quote
        candidate { id identifier title repository stateType revision crossProject }
      }
    }
  }
`;
export const TRIAGE_SUGGESTION_EXPOSURE_MUTATION = gql`
  mutation TriageSuggestionExposure($observationId: String!) {
    triageSuggestionExposure(observationId: $observationId) { success message }
  }
`;
export const TRIAGE_SUGGESTION_FEEDBACK_MUTATION = gql`
  mutation TriageSuggestionFeedback($input: TriageSuggestionFeedbackInput!) {
    triageSuggestionFeedback(input: $input) { success message }
  }
`;

interface Suggestion {
  checkId: string; kind: 'similar' | 'missing_info' | 'type'; value: string; quote: string;
  candidate: { id: string; identifier: string; title: string; repository: string | null; crossProject: boolean } | null;
}
interface Suggestions { status: string; degraded: boolean; observationId: string | null; suggestions: Suggestion[] }
interface Payload { success: boolean; message: string }
type Verdict = 'accepted' | 'corrected' | 'rejected';
interface FeedbackInput { observationId: string; workId: string; checkId: string; verdict: Verdict; correctedValue?: string }
const relationLabels: Record<string, string> = { same_issue: 'Same issue', related_distinct: 'Related but distinct', possible_regression: 'Possible regression', unrelated: 'Unrelated', insufficient_info: 'Insufficient information' };
const presenceLabels: Record<string, string> = { present: 'Present', missing: 'Missing' };
const typeLabels: Record<string, string> = { Bug: 'Bug', Feature: 'Feature', Improvement: 'Improvement', Research: 'Research' };
const fieldLabels: Record<string, string> = { acceptance: 'Acceptance criteria', steps: 'Steps to reproduce', expected_actual: 'Expected and actual behavior', environment: 'Environment or version', description: 'Description' };
const verdictLabels: Record<Verdict, string> = { accepted: 'Accepted', corrected: 'Corrected', rejected: 'Rejected' };
function labels(suggestion: Suggestion) { return suggestion.kind === 'similar' ? relationLabels : suggestion.kind === 'type' ? typeLabels : presenceLabels; }
function valueLabel(suggestion: Suggestion, value = suggestion.value) { return value === 'abstained' ? 'No judgment' : labels(suggestion)[value] ?? value; }

export function TriageSuggestions({ workId }: { workId: string }) {
  const { data, error } = useQuery<{ workTriageSuggestions: Suggestions }>(WORK_TRIAGE_SUGGESTIONS_QUERY, { variables: { workId }, fetchPolicy: 'network-only' });
  const result = data?.workTriageSuggestions;
  if (error || !result) return null;
  if (result.degraded) return <p className="observation-card__meta">Suggestions unavailable; showing the usual view.</p>;
  if (result.status !== 'advice' || !result.observationId || !result.suggestions.length) return null;
  return <Advice key={`${workId}:${result.observationId}`} workId={workId} observationId={result.observationId} suggestions={result.suggestions} />;
}

function Advice({ workId, observationId, suggestions }: { workId: string; observationId: string; suggestions: Suggestion[] }) {
  const [acknowledge] = useMutation<{ triageSuggestionExposure: Payload }, { observationId: string }>(TRIAGE_SUGGESTION_EXPOSURE_MUTATION);
  const attempted = useRef(false);
  const [exposed, setExposed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    void acknowledge({ variables: { observationId } }).then(result => {
      const payload = result.data?.triageSuggestionExposure;
      if (!payload?.success) { setError(payload?.message ?? 'Could not acknowledge suggestions. Refresh to try again.'); return; }
      setExposed(true);
    }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not acknowledge suggestions.'));
  }, [acknowledge, observationId]);
  const similar = suggestions.filter(s => s.kind === 'similar');
  const missing = suggestions.filter(s => s.kind === 'missing_info');
  const types = suggestions.filter(s => s.kind === 'type');
  const rows = (items: Suggestion[]) => <ul className="triage-suggestions__list">{items.map(suggestion => <SuggestionRow key={suggestion.checkId} suggestion={suggestion} workId={workId} observationId={observationId} exposed={exposed} />)}</ul>;
  return <section className="triage-suggestions" aria-label="Triage suggestions">
    <h3><Badge>Advisory</Badge> Triage suggestions</h3>
    <p className="observation-card__meta">Advice only. Accepting feedback never links or changes work. Use Mark duplicate to link a duplicate.</p>
    {error ? <RefusalNotice placement="panel" message={error} /> : null}
    {similar.length ? <><h4>Similar work</h4>{rows(similar)}</> : null}
    {missing.length ? <><h4>Missing information</h4>{rows(missing)}</> : null}
    {types.length ? <><h4>Suggested type</h4>{rows(types)}</> : null}
  </section>;
}

function SuggestionRow({ suggestion, workId, observationId, exposed }: { suggestion: Suggestion; workId: string; observationId: string; exposed: boolean }) {
  const [feedback] = useMutation<{ triageSuggestionFeedback: Payload }, { input: FeedbackInput }>(TRIAGE_SUGGESTION_FEEDBACK_MUTATION);
  const [correcting, setCorrecting] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ verdict: Verdict; value: string } | null>(null);
  const choices = Object.entries(labels(suggestion)).filter(([value]) => value !== suggestion.value && !(suggestion.candidate?.crossProject && value === 'same_issue'));
  async function decide(verdict: Verdict) {
    setPending(true); setError(null);
    try {
      const input: FeedbackInput = { workId, observationId, checkId: suggestion.checkId, verdict, ...(verdict === 'corrected' ? { correctedValue: replacement } : {}) };
      const result = await feedback({ variables: { input } });
      const payload = result.data?.triageSuggestionFeedback;
      if (!payload?.success) { setError(payload?.message ?? 'Could not save triage feedback.'); return; }
      setSaved({ verdict, value: verdict === 'corrected' ? replacement : suggestion.value });
      setCorrecting(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save triage feedback.'); }
    finally { setPending(false); }
  }
  return <li className="triage-suggestions__item">
    <div>
      {suggestion.kind === 'missing_info' ? `${fieldLabels[suggestion.checkId] ?? suggestion.checkId}: ` : null}
      <Badge>{valueLabel(suggestion)}</Badge>{' '}
      {suggestion.candidate ? <><WorkReference reference={suggestion.candidate.identifier} />{' '}{suggestion.candidate.title}{' '}
        {suggestion.candidate.crossProject ? <><Badge>Cross-project</Badge>{' '}<ProjectBadge repository={suggestion.candidate.repository} emptyLabel="No project" /></> : null}
      </> : null}
    </div>
    <blockquote className="triage-suggestions__quote">{suggestion.quote}</blockquote>
    {saved ? <p role="status">Saved: {verdictLabels[saved.verdict]} — {valueLabel(suggestion, saved.value)}</p> : null}
    {error ? <RefusalNotice placement="panel" message={error} /> : null}
    <div className="triage-suggestions__actions">
      <Btn size="sm" variant="subtle" disabled={!exposed || pending} onClick={() => void decide('accepted')}>Accept</Btn>
      <Btn size="sm" variant="subtle" disabled={!exposed || pending} onClick={() => setCorrecting(!correcting)}>Correct</Btn>
      <Btn size="sm" variant="ghost" disabled={!exposed || pending} onClick={() => void decide('rejected')}>Reject</Btn>
    </div>
    {correcting ? <div className="triage-suggestions__actions">
      <Field label="Correction">
        <Select value={replacement} onChange={event => setReplacement(event.target.value)} disabled={pending}>
          <option value="">Choose another value</option>
          {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </Field>
      <Btn size="sm" variant="subtle" disabled={!exposed || pending || !replacement} onClick={() => void decide('corrected')}>Save correction</Btn>
    </div> : null}
  </li>;
}
