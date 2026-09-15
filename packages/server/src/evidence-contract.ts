import { createHash } from 'node:crypto';

export interface AcceptanceCriterion {
  id: string;
  required: boolean;
  workflowId: number;
  job: string;
}
export interface AcceptanceContract { version: 1; criteria: AcceptanceCriterion[] }
export interface ContractFields {
  acceptance: string | null;
  scope: string | null;
  constraints: string | null;
  repository: string | null;
}

export const SHA_PATTERN = /^[a-f0-9]{40}$/;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const VERIFICATION_MAX_AGE_MS = 10 * 60_000;

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Free text is a valid human contract but has no machine-verifiable coverage. */
export function parseAcceptance(value: string | null): AcceptanceContract | null {
  try {
    const data = JSON.parse(value ?? '') as Partial<AcceptanceContract>;
    if (data?.version !== 1 || !Array.isArray(data.criteria) || !data.criteria.length || data.criteria.length > 100) return null;
    const ids = new Set<string>();
    const criteria: AcceptanceCriterion[] = [];
    for (const item of data.criteria) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id) ||
          typeof item.required !== 'boolean' || !Number.isSafeInteger(item.workflowId) || item.workflowId < 1 ||
          typeof item.job !== 'string' || !item.job.trim() || item.job.length > 200) return null;
      ids.add(item.id);
      criteria.push({ id: item.id, required: item.required, workflowId: item.workflowId, job: item.job });
    }
    if (!criteria.some(item => item.required)) return null;
    return { version: 1, criteria: criteria.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  } catch { return null; }
}

/** Semantic revisions are hashes, independent of workflow/priority/audit revisions. */
export function snapshotContract(work: ContractFields) {
  const acceptance = parseAcceptance(work.acceptance);
  const snapshot = { version: 1, scope: work.scope, constraints: work.constraints,
    repository: work.repository, acceptance: acceptance ?? work.acceptance };
  return { contractRevision: digest(snapshot), acceptanceDigest: digest(snapshot.acceptance),
    contractSnapshot: snapshot, acceptance };
}

export type EvidenceObject = { repository: string; type: 'pr' | 'run'; id: number };

/** Parse an object identifier only. Never use caller-supplied URLs for network IO. */
export function parseGitHubEvidence(value: string): EvidenceObject | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
    const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|actions\/runs)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
    return { repository: match[1]!, type: match[2] === 'pull' ? 'pr' : 'run', id: Number(match[3]) };
  } catch { return null; }
}

/** Both explicit execution and GitHub merge use the same shadow-only boundary. */
export const ACCEPTANCE_POLICY = { mode: 'shadow', mergeTarget: 'REVIEW' } as const;
