import { Link } from 'react-router-dom';

import type { RefusalNext } from '../board/types';
import { WorkReferenceText } from './WorkReference';

/** A save the server refused, with its reason and the way to do it instead. */
export class IssueUpdateRefused extends Error {
  constructor(
    readonly reason: string | null,
    readonly next: RefusalNext | null = null,
  ) {
    super(reason ?? 'Issue update refused');
  }
}

/**
 * The step to show beside an error: the refusal's next step while that
 * refusal is the error shown (other failures reuse the same error slot).
 */
export interface ShownRefusal {
  message: string;
  next: RefusalNext;
}

export function nextFor(shown: ShownRefusal | null, error: string | null): RefusalNext | null {
  return shown && error === shown.message ? shown.next : null;
}

/**
 * Why a save was refused, where the person acted (INV-1534), with a way to do
 * it instead (INV-1535). The work it names are links (WorkReferenceText), and
 * a refusal that names a place — "accept INV-972 from In Review" — carries a
 * button that goes there.
 *
 * `floating` stays in view over the page and its drawer (the board, where a
 * refused drag can happen anywhere); `panel` sits under the issue header.
 */
export function RefusalNotice({
  message,
  next,
  onDismiss,
  placement,
}: {
  message: string;
  next?: RefusalNext | null | undefined;
  onDismiss?: (() => void) | undefined;
  placement: 'floating' | 'panel';
}) {
  const className =
    placement === 'floating' ? 'page-notice page-notice--error page-notice--floating' : 'issue-panel__error';
  return (
    <section className={className} role="alert">
      <p className="page-notice__text">
        <WorkReferenceText text={message} />
      </p>
      {next ? (
        <Link className="ui-action ui-action--subtle refusal-notice__next" to={next.path}>
          {next.label}
        </Link>
      ) : null}
      {onDismiss ? (
        <button type="button" className="page-notice__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      ) : null}
    </section>
  );
}
