import type { BoardBootstrapErrorState } from '../lib/apollo';

/**
 * The shell-level error card shown when a page cannot bootstrap at all
 * (no session, rejected token, API unreachable). When the error carries an
 * action — today that is always "sign in" — it is rendered as a real link so
 * a visitor on a phone, where the sidebar is hidden, still has a way in.
 */
export function BootstrapErrorNotice({ state }: { state: BoardBootstrapErrorState }) {
  return (
    <section className="shell-notice shell-notice--error" role="alert">
      <h2>{state.title}</h2>
      <p>{state.description}</p>
      {state.action ? (
        <p className="shell-notice__actions">
          <a className="shell-notice__action" href={state.action.href}>
            {state.action.label}
          </a>
        </p>
      ) : null}
    </section>
  );
}
