/** Executor-authored facts remain distinct from independently verified CI and human acceptance. */
export interface ExecutorReceipt {
  version: 1;
  repository: string;
  commitSha: string;
  pullRequestNumber: number | null;
  mergedSha: string | null;
  environment: string | null;
  deployedSha: string | null;
  health: 'pass' | 'fail' | 'unknown';
  behavior: 'pass' | 'fail' | 'unknown';
  evidenceUrls: string[];
  observedAt: string;
}
export function parseExecutorReceipt(raw: unknown): ExecutorReceipt {
  const fail = () => { throw new Error('Invalid version 1 executor receipt.'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  const keys = ['version', 'repository', 'commitSha', 'pullRequestNumber', 'mergedSha', 'environment', 'deployedSha', 'health', 'behavior', 'evidenceUrls', 'observedAt'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || value.version !== 1 || typeof value.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) return fail();
  if (typeof value.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.commitSha)) return fail();
  if (value.pullRequestNumber !== null && (!Number.isSafeInteger(value.pullRequestNumber) || Number(value.pullRequestNumber) < 1)) return fail();
  if (value.mergedSha !== undefined && value.mergedSha !== null && (typeof value.mergedSha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.mergedSha))) return fail();
  if (value.environment !== null && (typeof value.environment !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.environment))) return fail();
  if (value.deployedSha !== null && (typeof value.deployedSha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.deployedSha) || value.environment === null)) return fail();
  if (![value.health, value.behavior].every((item) => ['pass', 'fail', 'unknown'].includes(String(item)))) return fail();
  if (!Array.isArray(value.evidenceUrls) || value.evidenceUrls.length > 100 || !value.evidenceUrls.every((url) => {
    if (typeof url !== 'string' || url.length > 2048) return false;
    try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
  })) return fail();
  if (typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) return fail();
  return { ...value, mergedSha: typeof value.mergedSha === 'string' ? value.mergedSha.toLowerCase() : null, commitSha: value.commitSha.toLowerCase(), deployedSha: typeof value.deployedSha === 'string' ? value.deployedSha.toLowerCase() : null } as unknown as ExecutorReceipt;
}
export function receiptAssessment(receipt: ExecutorReceipt, authorizedReleaseSha?: string | null) {
  return {
    provenance: 'executor-reported' as const,
    deploymentObserved: receipt.deployedSha !== null,
    versionMatches: receipt.deployedSha && authorizedReleaseSha ? receipt.deployedSha.toLowerCase() === authorizedReleaseSha.toLowerCase() : null,
    productionAccepted: false as const,
  };
}
export function executorVisibleState(row: { state: string; leaseUntil: Date | null }, now = new Date()): string {
  return ['RUNNING', 'STOP_REQUESTED'].includes(row.state) && (!row.leaseUntil || row.leaseUntil <= now) ? 'UNKNOWN' : row.state;
}
