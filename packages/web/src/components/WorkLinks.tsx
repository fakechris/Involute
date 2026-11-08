import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import { isRenderableImageUrl } from '@turnkeyai/involute-shared';

import type { PullRequestLink } from '../board/types';
import type { WorkEvidenceSummary } from '../work/types';
import { extraImageHosts } from '../image-hosts';
import { IcoCommit, IcoExternal, IcoGitHub } from './Icons';
import { PullRequestList } from './PullRequestLinks';
import { EvidenceVerificationStatus } from './ReviewEvidence';
import { SafeImage } from './SafeImage';

/**
 * What was delivered on a work item, where a person can open it (INV-1673):
 * each run's commit, pull request and external URL, the evidence attached to
 * it, and links to outside systems (Sentry, dashboards) grouped by where they
 * point. The same section on the issue page and the board drawer; it loads
 * its own data so neither page's query grows.
 */

export const WORK_LINKS_QUERY = gql`
  query WorkLinks($id: String!) {
    workContext(id: $id) {
      work { id repository pullRequests { repository number url title state mergeSha updatedAt } }
      runs { id publicId status repository commitSha pullRequestNumber externalUrl startedAt }
      evidence { id runId kind url summary createdAt retractedAt verifications { id status failureCode observedAt } }
    }
  }
`;

interface LinkRun {
  id: string;
  publicId: string;
  status: string;
  repository: string | null;
  commitSha: string | null;
  pullRequestNumber: number | null;
  externalUrl: string | null;
  startedAt: string;
}

type LinkEvidence = Pick<WorkEvidenceSummary, 'id' | 'runId' | 'kind' | 'url' | 'summary' | 'createdAt' | 'retractedAt' | 'verifications'>;

interface WorkLinksData {
  workContext: { work: { id: string; repository: string | null; pullRequests: PullRequestLink[] }; runs: LinkRun[]; evidence: LinkEvidence[] } | null;
}

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isCodeHost(url: string): boolean {
  const host = hostOf(url);
  return Boolean(host && (host === 'github.com' || host.endsWith('.github.com') || host.includes('gitlab')));
}

/** A recognisable name for where an outside link points. */
export function linkSource(url: string): string {
  if (url.startsWith('file:')) return 'Local file';
  const host = hostOf(url);
  if (!host) return 'Link';
  if (host.includes('sentry')) return 'Sentry';
  if (host.includes('grafana')) return 'Grafana';
  if (host.includes('datadog')) return 'Datadog';
  if (host.includes('slack.com')) return 'Slack';
  if (host.includes('figma.com')) return 'Figma';
  if (host.includes('notion.')) return 'Notion';
  return host;
}

function EvidenceShot({ url, kind }: { url: string; kind: string }) {
  const allowExtensionless = kind === 'screenshot';
  if (!isRenderableImageUrl(url, { allowExtensionless, extraHosts: extraImageHosts() })) return null;
  return <SafeImage src={url} alt={kind} className="work-links__shot" allowExtensionless={allowExtensionless} />;
}

function Href({ url, children }: { url: string; children: React.ReactNode }) {
  // file:// links only open on the machine that wrote them; show them, do not pretend they open.
  if (url.startsWith('file:')) return <span className="mono" title={url}>{children}</span>;
  return (
    <a className="external-link" href={url} target="_blank" rel="noreferrer">
      {isCodeHost(url) ? <IcoGitHub size={12} className="external-link__icon" /> : null}
      {children}
      <IcoExternal size={11} className="external-link__arrow" />
    </a>
  );
}

export function WorkLinks({ workId }: { workId: string }) {
  // GitHub adds evidence while the page is open (INV-1703): read again every minute and on every visit.
  const { data, error } = useQuery<WorkLinksData, { id: string }>(WORK_LINKS_QUERY, { variables: { id: workId }, fetchPolicy: 'cache-and-network', pollInterval: 60_000 });
  if (error) return <p role="alert">Commits and links could not be loaded: {error.message}</p>;
  const context = data?.workContext;
  if (!context) return null;

  const evidence = context.evidence.filter((item) => !item.retractedAt);
  const runs = [...context.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  // Pull requests come folded from the server, one per PR; their evidence rows are not repeated.
  const pullRequests = context.work.pullRequests ?? [];
  const codeEvidence = evidence.filter((item) => isCodeHost(item.url) && !PR_URL.test(item.url));
  const outside = [
    ...evidence.filter((item) => !isCodeHost(item.url)).map((item) => ({ key: item.id, url: item.url, summary: item.summary, evidence: item })),
    ...runs.filter((run) => run.externalUrl && !isCodeHost(run.externalUrl)).map((run) => ({ key: `run-${run.id}`, url: run.externalUrl!, summary: `${run.publicId} external URL`, evidence: null })),
  ];
  const groups = new Map<string, typeof outside>();
  for (const link of outside) {
    const source = linkSource(link.url);
    groups.set(source, [...(groups.get(source) ?? []), link]);
  }
  const linkedRuns = runs.filter((run) => run.commitSha || (run.externalUrl && isCodeHost(run.externalUrl)));
  const total = pullRequests.length + linkedRuns.length + codeEvidence.length + outside.length;

  return (
    <div className="issue-panel__section" aria-label="Commits & links" role="region">
      <h2>Commits & links · {total}</h2>
      {total === 0 ? (
        <p className="observation-hint">
          No commit, pull request or link recorded yet{context.work.repository ? ` for ${context.work.repository}` : ''}. Runs that report a commit and PR, and evidence attached to the work, show here.
        </p>
      ) : null}
      {pullRequests.length ? <PullRequestList pullRequests={pullRequests} repository={context.work.repository} /> : null}
      {linkedRuns.length || codeEvidence.length ? (
        <ul className="issue-children" role="list" aria-label="Code">
          {linkedRuns.map((run) => {
            const repository = run.repository ?? context.work.repository;
            return (
              <li key={run.id} role="listitem" className="issue-children__row work-links__row">
                <span className="mono">{run.publicId}</span>
                <span className="observation-card__meta">{run.status.toLowerCase()}</span>
                {run.commitSha ? (
                  repository ? (
                    <a className="external-link mono" href={`https://github.com/${repository}/commit/${run.commitSha}`} target="_blank" rel="noreferrer" title={`Commit ${run.commitSha} on GitHub`}>
                      <IcoCommit size={12} className="external-link__icon" />
                      commit {run.commitSha.slice(0, 7)}
                      <IcoExternal size={11} className="external-link__arrow" />
                    </a>
                  ) : (
                    <span className="mono" title={run.commitSha}>commit {run.commitSha.slice(0, 7)}</span>
                  )
                ) : null}
                {run.externalUrl && isCodeHost(run.externalUrl) ? <Href url={run.externalUrl}>{run.externalUrl}</Href> : null}
              </li>
            );
          })}
          {codeEvidence.map((item) => (
            <li key={item.id} role="listitem" className="issue-children__row work-links__row">
              <EvidenceShot url={item.url} kind={item.kind} />
              <span className="observation-card__meta">{item.kind.toLowerCase()}</span>
              <Href url={item.url}>{item.summary || item.url}</Href>
              <EvidenceVerificationStatus evidence={item as WorkEvidenceSummary} />
            </li>
          ))}
        </ul>
      ) : null}
      {[...groups.entries()].map(([source, links]) => (
        <div key={source} className="work-links__group">
          <h3 className="work-links__source">{source}</h3>
          <ul className="issue-children" role="list" aria-label={source}>
            {links.map((link) => (
              <li key={link.key} role="listitem" className="issue-children__row work-links__row">
                {link.evidence ? <EvidenceShot url={link.url} kind={link.evidence.kind} /> : null}
                <Href url={link.url}>{link.summary || link.url}</Href>
                {link.evidence ? <EvidenceVerificationStatus evidence={link.evidence as WorkEvidenceSummary} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
