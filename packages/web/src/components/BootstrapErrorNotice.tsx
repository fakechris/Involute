import type { BoardBootstrapErrorState } from '../lib/apollo';
import { InlineError } from './status';

/**
 * The page-level error shown when a page cannot bootstrap at all
 * (no session, rejected token, API unreachable), as a block InlineError
 * (docs/design-system.md §3 rule 7). When the error carries an action —
 * today that is always "sign in" — it is rendered as a real link so a
 * visitor on a phone, where the sidebar is hidden, still has a way in.
 */
export function BootstrapErrorNotice({ state }: { state: BoardBootstrapErrorState }) {
  return (
    <InlineError variant="block">
      <strong className="bootstrap-error__title">{state.title}</strong>
      <span className="bootstrap-error__body">{state.description}</span>
      {state.action ? (
        <a className="ui-action ui-action--subtle ui-action--md bootstrap-error__action" href={state.action.href}>
          {state.action.label}
        </a>
      ) : null}
    </InlineError>
  );
}
