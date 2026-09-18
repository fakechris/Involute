import type { UserSummary } from '../board/types';

/**
 * Who said this, and what are they.
 *
 * "Mia" on its own is unreadable: you cannot tell whether it is a person or an
 * agent, which runtime it is, or whether it is still around. The data for all
 * three has always been on the actor row — it was simply never asked for or
 * shown (INV-573).
 */
export function ActorBadge({
  actor,
  onSelect,
}: {
  actor: UserSummary | null;
  /** Receives the handle, or the id for a legacy actor without one — both resolve on /agents/:handle. */
  onSelect?: (handleOrId: string) => void;
}) {
  if (!actor) {
    return <strong className="actor-badge__name">Unknown author</strong>;
  }

  const label = actor.name ?? actor.email ?? 'Unknown author';
  const isAgent = actor.actorKind === 'AGENT';
  const isService = actor.actorKind === 'SERVICE';

  if (!isAgent && !isService) {
    return <strong className="actor-badge__name">{label}</strong>;
  }

  const handle = actor.handle ?? null;
  const facts = (isService
    ? [actor.runtime]
    : [actor.runtime, presenceLabel(actor)]).filter(Boolean) as string[];

  return (
    <span className={`actor-badge actor-badge--${isService ? 'service' : 'agent'}`}>
      <span aria-hidden="true" className="actor-badge__glyph">
        {isService ? '◆' : '⬢'}
      </span>
      {onSelect ? (
        <button
          type="button"
          className="actor-badge__name actor-badge__name--link"
          onClick={() => onSelect(handle ?? actor.id)}
          title={actor.presenceDetail ?? undefined}
        >
          {label}
        </button>
      ) : (
        <strong className="actor-badge__name" title={actor.presenceDetail ?? undefined}>
          {label}
        </strong>
      )}
      {handle ? <span className="actor-badge__handle">@{handle}</span> : null}
      <span className="actor-badge__kind">{isService ? 'SYSTEM' : 'AGENT'}</span>
      {facts.map((fact) => (
        <span key={fact} className="actor-badge__fact">
          {fact}
        </span>
      ))}
    </span>
  );
}

/**
 * Presence as an observation. `away` deliberately reads "last seen …" rather
 * than "offline": the server knows when the credential was last used, not
 * whether the process is up.
 */
function presenceLabel(actor: UserSummary): string | null {
  switch (actor.presence) {
    case 'active':
      return 'active now';
    case 'idle':
      return 'active recently';
    case 'away':
      return actor.lastSeenAt
        ? `last seen ${formatRelative(actor.lastSeenAt)}`
        : 'not seen recently';
    case 'never-seen':
      return 'never connected';
    default:
      return null;
  }
}

function formatRelative(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);

  if (minutes < 60) {
    return `${Math.max(minutes, 1)}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}
