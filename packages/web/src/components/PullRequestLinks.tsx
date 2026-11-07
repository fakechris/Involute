import type { PullRequestLink } from '../board/types';
import { IcoCommit, IcoExternal, IcoPullRequest } from './Icons';
import { Badge, type BadgeTone } from './status';

/**
 * The pull requests a work item names (INV-1703), as the server folds them:
 * one entry per PR, merged / open from GitHub's own deliveries, linked when
 * only a run names it. Each opens the PR on GitHub. The list sits in the
 * properties rail of the issue page and drawer; the badge on board cards.
 */

const STATE: Record<string, { label: string; tone: BadgeTone }> = {
  MERGED: { label: 'merged', tone: 'accent' },
  OPEN: { label: 'open', tone: 'success' },
  LINKED: { label: 'linked', tone: 'neutral' },
};

function stateOf(pr: PullRequestLink) {
  return STATE[pr.state] ?? { label: pr.state.toLowerCase(), tone: 'neutral' as BadgeTone };
}

export function PullRequestList({ pullRequests, repository }: { pullRequests: PullRequestLink[] | null | undefined; repository: string | null | undefined }) {
  const prs = pullRequests ?? [];
  if (prs.length === 0) {
    // Work outside a repository has nothing to link; code work says so plainly.
    return repository ? <span className="observation-card__meta">No pull request</span> : null;
  }
  return (
    <ul className="pull-requests" aria-label="Pull requests">
      {prs.map((pr) => {
        const state = stateOf(pr);
        return (
          <li key={pr.url} className="pull-requests__row">
            <Badge tone={state.tone}>{state.label}</Badge>
            <a href={pr.url} target="_blank" rel="noreferrer" title={`Open on GitHub${pr.title ? `: ${pr.title}` : ''}`} className={`external-link pull-requests__link pull-requests__link--${pr.state.toLowerCase()}`}>
              <IcoPullRequest size={13} className="external-link__icon" />
              <span className="mono">#{pr.number}</span>
              {pr.title ? <span className="pull-requests__title"> {pr.title}</span> : null}
              <IcoExternal size={11} className="external-link__arrow" />
            </a>
            {pr.mergeSha ? (
              <a className="external-link mono" href={`https://github.com/${pr.repository}/commit/${pr.mergeSha}`} target="_blank" rel="noreferrer" title="Merge commit on GitHub">
                <IcoCommit size={12} className="external-link__icon" />
                {pr.mergeSha.slice(0, 7)}
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The newest PR on a board card: number and state, the title on hover; more PRs show as "+n". */
export function PullRequestBadge({ pullRequests }: { pullRequests: PullRequestLink[] | null | undefined }) {
  const prs = pullRequests ?? [];
  const latest = prs[0];
  if (!latest) return null;
  const state = stateOf(latest);
  return (
    <a
      className={`pull-request-badge pull-request-badge--${latest.state.toLowerCase()}`}
      href={latest.url}
      target="_blank"
      rel="noreferrer"
      title={`PR #${latest.number} ${state.label}${latest.title ? ` — ${latest.title}` : ''}${prs.length > 1 ? ` (+${prs.length - 1} more)` : ''}`}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Pull request #${latest.number} ${state.label}`}
    >
      <IcoPullRequest size={11} />
      #{latest.number}
      {prs.length > 1 ? ` +${prs.length - 1}` : ''}
    </a>
  );
}
