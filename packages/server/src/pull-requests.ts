import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * The pull requests a work item names (INV-1703), one entry per PR. Two
 * sources say a PR belongs to the work: evidence pointing at a GitHub PR URL
 * — the webhook writes one when the PR opens and another when it merges — and
 * a run bound to `pullRequestNumber`. They are folded into one entry per PR:
 * merged when any evidence says "(Merged in <sha>)", open when only the
 * opening is known, linked when only a run names it.
 */

export type PullRequestState = 'MERGED' | 'OPEN' | 'LINKED';

export interface PullRequestSummary {
  repository: string;
  number: number;
  url: string;
  title: string | null;
  state: PullRequestState;
  mergeSha: string | null;
  updatedAt: Date;
}

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i;
const SUMMARY = /^GitHub PR #\d+: (.*?)(?: \(Merged(?: in ([0-9a-f]{7,40}))?\))?$/;

interface EvidenceRow {
  url: string;
  summary: string | null;
  createdAt: Date;
  retractedAt: Date | null;
}

interface RunRow {
  repository: string | null;
  pullRequestNumber: number | null;
  updatedAt: Date;
}

export function summarizePullRequests(workRepository: string | null, runs: RunRow[], evidence: EvidenceRow[]): PullRequestSummary[] {
  const byKey = new Map<string, PullRequestSummary>();
  const entry = (repository: string, number: number, at: Date): PullRequestSummary => {
    const key = `${repository.toLowerCase()}#${number}`;
    let found = byKey.get(key);
    if (!found) {
      found = { repository, number, url: `https://github.com/${repository}/pull/${number}`, title: null, state: 'LINKED', mergeSha: null, updatedAt: at };
      byKey.set(key, found);
    }
    if (at > found.updatedAt) found.updatedAt = at;
    return found;
  };
  for (const item of evidence) {
    if (item.retractedAt) continue;
    const match = PR_URL.exec(item.url.trim());
    if (!match) continue;
    const pr = entry(match[1]!, Number(match[2]), item.createdAt);
    const parsed = item.summary ? SUMMARY.exec(item.summary.trim()) : null;
    if (parsed?.[1] && !pr.title) pr.title = parsed[1];
    const merged = Boolean(item.summary && /\(Merged(?: in [0-9a-f]{7,40})?\)$/.test(item.summary.trim()));
    if (merged) {
      pr.state = 'MERGED';
      pr.mergeSha = parsed?.[2] ?? pr.mergeSha;
    } else if (pr.state === 'LINKED') {
      pr.state = 'OPEN';
    }
  }
  for (const run of runs) {
    const repository = run.repository ?? workRepository;
    if (!repository || !run.pullRequestNumber) continue;
    entry(repository, run.pullRequestNumber, run.updatedAt);
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.number - a.number);
}

export async function loadPullRequests(prisma: DatabaseClient, works: Array<{ id: string; repository: string | null }>): Promise<Map<string, PullRequestSummary[]>> {
  const ids = works.map((work) => work.id);
  const result = new Map<string, PullRequestSummary[]>(ids.map((id) => [id, []]));
  if (!ids.length) return result;
  const [evidence, runs] = await Promise.all([
    prisma.workEvidence.findMany({
      where: { workId: { in: ids }, retractedAt: null, url: { startsWith: 'https://github.com/', contains: '/pull/' } },
      select: { workId: true, url: true, summary: true, createdAt: true, retractedAt: true },
    }),
    prisma.workRun.findMany({ where: { workId: { in: ids }, pullRequestNumber: { not: null } }, select: { workId: true, repository: true, pullRequestNumber: true, updatedAt: true } }),
  ]);
  for (const work of works) {
    result.set(
      work.id,
      summarizePullRequests(
        work.repository,
        runs.filter((run) => run.workId === work.id),
        evidence.filter((item) => item.workId === work.id),
      ),
    );
  }
  return result;
}

/**
 * One read for every Issue.pullRequests asked in the same tick (a board asks
 * for hundreds), instead of one per card.
 */
export function pullRequestBatcher(prisma: DatabaseClient) {
  let pending: Array<{ work: { id: string; repository: string | null }; resolve: (value: PullRequestSummary[]) => void; reject: (error: unknown) => void }> = [];
  return (work: { id: string; repository: string | null }): Promise<PullRequestSummary[]> =>
    new Promise((resolve, reject) => {
      pending.push({ work, resolve, reject });
      if (pending.length > 1) return;
      queueMicrotask(() => {
        const batch = pending;
        pending = [];
        loadPullRequests(prisma, batch.map((item) => item.work)).then(
          (map) => batch.forEach((item) => item.resolve(map.get(item.work.id) ?? [])),
          (error: unknown) => batch.forEach((item) => item.reject(error)),
        );
      });
    });
}
