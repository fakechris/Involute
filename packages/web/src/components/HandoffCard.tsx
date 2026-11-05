import { WorkReferenceText } from './WorkReference';

/**
 * The hand-off card a delegation carries (INV-1583): where the delegate starts,
 * what to read, how far to go, what done means — and, in red, what its
 * reports went beyond. One rendering for the issue page, the work page and
 * anywhere else a request is shown.
 */
export interface HandoffCardData {
  baseCommit: string | null;
  inputs: string[];
  allowedActions: string[] | null;
  acceptance: string | null;
  exceededActions: string[];
}

export function HandoffCard({ handoff }: { handoff: HandoffCardData | null | undefined }) {
  if (!handoff) return null;
  return (
    <dl className="handoff-card" aria-label="Hand-off card">
      {handoff.baseCommit ? (
        <>
          <dt>Base commit</dt>
          <dd className="mono">{handoff.baseCommit}</dd>
        </>
      ) : null}
      {handoff.inputs.length > 0 ? (
        <>
          <dt>Inputs</dt>
          <dd>
            {handoff.inputs.map((input, index) => (
              <span key={index} className="handoff-card__input">
                {/^https?:\/\//.test(input) ? <a href={input} target="_blank" rel="noreferrer">{input}</a> : <WorkReferenceText text={input} />}
              </span>
            ))}
          </dd>
        </>
      ) : null}
      {handoff.allowedActions ? (
        <>
          <dt>Allowed</dt>
          <dd>{handoff.allowedActions.length ? handoff.allowedActions.join(', ') : 'nothing'}</dd>
        </>
      ) : null}
      {handoff.acceptance ? (
        <>
          <dt>Acceptance</dt>
          <dd><WorkReferenceText text={handoff.acceptance} /></dd>
        </>
      ) : null}
      {handoff.exceededActions.length > 0 ? (
        <>
          <dt className="handoff-card__exceeded">Went beyond</dt>
          <dd className="handoff-card__exceeded">{handoff.exceededActions.join(', ')} — reported without being allowed</dd>
        </>
      ) : null}
    </dl>
  );
}
