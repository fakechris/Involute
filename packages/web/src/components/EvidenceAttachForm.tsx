import { useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { EVIDENCE_ATTACH_MUTATION, type MutationResult } from '../ops/queries';

const KINDS = [
  ['pr', 'Pull request'],
  ['test', 'Test result'],
  ['log', 'Log'],
  ['artifact', 'Artifact'],
  ['screenshot', 'Screenshot'],
] as const;

/**
 * A person records evidence on work after the fact (INV-796) — typically a
 * merged PR the traceability audit found unrecorded. It is attached in the
 * person's name with no run, so it never counts as verified execution.
 */
export function EvidenceAttachForm({ workId }: { workId: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>('pr');
  const [url, setUrl] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [run, state] = useMutation<{ evidenceAttach: MutationResult }>(EVIDENCE_ATTACH_MUTATION, {
    refetchQueries: ['WorkContextPage'],
  });

  async function submit() {
    setError(null);
    try {
      const result = (await run({ variables: { input: { workId, kind, url: url.trim(), summary: summary.trim() || null } } })).data
        ?.evidenceAttach;
      if (!result?.success) {
        setError(result?.message ?? 'Could not attach the evidence.');
        return;
      }
      setOpen(false);
      setUrl('');
      setSummary('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not attach the evidence.');
    }
  }

  if (!open) {
    return (
      <button type="button" className="ui-action" onClick={() => setOpen(true)}>
        Attach evidence
      </button>
    );
  }
  return (
    <div className="request-actions">
      <select aria-label="Evidence kind" value={kind} onChange={(event) => setKind(event.target.value)}>
        {KINDS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input aria-label="Evidence URL" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} />
      <input aria-label="Evidence summary" placeholder="What it shows (optional)" value={summary} onChange={(event) => setSummary(event.target.value)} />
      <button type="button" className="ui-action ui-action--accent" disabled={!url.trim() || state?.loading} onClick={() => void submit()}>
        Attach
      </button>
      <button type="button" className="ui-action" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
