import { createHash } from 'node:crypto';
import { record } from './semantic-advice-provider.js';

export interface ExperimentPolicy {
  teamId: string;
  repository: string;
  scenario: string;
  mode: 'off' | 'shadow' | 'ab' | 'enabled';
  experimentId: string;
  assignmentVersion: string;
  assignmentUnit: 'work' | 'actor' | 'team';
  salt: string;
  treatmentBps: number;
  provider: string;
  model: string;
  questionVersion: string;
  calibrationVersion: string;
  policyVersion: string;
}
export interface AdviceConfig {
  enabled: boolean;
  policies: ExperimentPolicy[];
  limits: { timeoutMs: number; maxConcurrent: number; maxInputBytes: number; maxChecks: number; maxCandidates: number; maxCallsPerMinute: number; cacheEntries: number; cacheTtlMs: number };
}
export const defaultAdviceConfig: AdviceConfig = {
  enabled: false, policies: [],
  limits: { timeoutMs: 1500, maxConcurrent: 4, maxInputBytes: 64_000, maxChecks: 32, maxCandidates: 100, maxCallsPerMinute: 60, cacheEntries: 200, cacheTtlMs: 30_000 },
};
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Unknown or malformed configuration disables the entire module, never partially enables it. */
export function parseAdviceConfig(value: unknown): AdviceConfig {
  try {
    const c = record(typeof value === 'string' ? JSON.parse(value) : value);
    if (typeof c.enabled !== 'boolean' || !Array.isArray(c.policies)) throw new Error();
    const limits = { ...defaultAdviceConfig.limits, ...record(c.limits ?? {}) };
    for (const [key, n] of Object.entries(limits)) {
      if (!(key in defaultAdviceConfig.limits) || !Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new Error();
    }
    if (limits.timeoutMs > 30_000 || limits.maxChecks > 128 || limits.maxCandidates > 255 || limits.maxConcurrent > 64) throw new Error();
    const seen = new Set<string>();
    const policies = c.policies.map(value => {
      const p = record(value);
      for (const key of ['teamId', 'repository', 'scenario', 'experimentId', 'assignmentVersion', 'salt', 'provider', 'model', 'questionVersion', 'calibrationVersion', 'policyVersion']) {
        if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > 200) throw new Error();
      }
      if (!['off', 'shadow', 'ab', 'enabled'].includes(String(p.mode)) || !['work', 'actor', 'team'].includes(String(p.assignmentUnit))) throw new Error();
      if (!Number.isSafeInteger(p.treatmentBps) || Number(p.treatmentBps) < 0 || Number(p.treatmentBps) > 10_000) throw new Error();
      const scope = hash([p.teamId, p.repository, p.scenario]);
      if (seen.has(scope)) throw new Error();
      seen.add(scope);
      return p as unknown as ExperimentPolicy;
    });
    return structuredClone({ enabled: c.enabled, policies, limits });
  } catch { return structuredClone(defaultAdviceConfig); }
}
