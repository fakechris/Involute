import { createValidationError } from './errors.js';

export const DELIVERY_ACTIONS = ['edit', 'test', 'pull_request', 'merge', 'deploy'] as const;
export type DeliveryAction = typeof DELIVERY_ACTIONS[number];
export interface DeliveryUnit {
  key: string;
  title: string;
  criteria: number[];
  paths: string[];
  actions: DeliveryAction[];
  dependsOn: string[];
  executorActorId?: string;
  maxAttempts?: number;
  checks: Array<{ workflowId: number; job: string }>;
}
export interface DeliveryPolicy { units: DeliveryUnit[]; environments: string[] }
export interface DeliveryContract {
  outcome?: string | null;
  acceptance: string | null;
  scope: string | null;
  constraints: string | null;
  repository: string | null;
  verification: string | null;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw createValidationError('Delivery policy must contain objects.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) throw createValidationError('Unknown delivery policy field; new goals require a candidate change.');
  return result;
}
function strings(value: unknown, field: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim())) throw createValidationError(`Invalid delivery ${field}.`);
  const result = [...new Set((value as string[]).map((item) => item.trim()))];
  if (nonempty && !result.length) throw createValidationError(`Delivery ${field} must not be empty.`);
  return result;
}
export function deliveryCriteria(contract: DeliveryContract): string[] {
  return (contract.acceptance ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** A finite implementation plan, approved at the candidate boundary. No child supplies its own business contract. */
export function parseDeliveryPolicy(raw: unknown, contract: DeliveryContract): DeliveryPolicy {
  if (!contract.repository?.trim() || !contract.scope?.trim() || !contract.acceptance?.trim()) throw createValidationError('A delivery package needs repository, scope and acceptance.');
  const value = object(raw, ['units', 'environments']);
  const environments = strings(value.environments ?? [], 'environments');
  if (environments.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name))) throw createValidationError('Use explicit environment names.');
  if (!Array.isArray(value.units) || !value.units.length || value.units.length > 100) throw createValidationError('A delivery policy needs 1–100 implementation units.');
  const criteria = deliveryCriteria(contract);
  const units = value.units.map((rawUnit): DeliveryUnit => {
    const unit = object(rawUnit, ['key', 'title', 'criteria', 'paths', 'actions', 'dependsOn', 'checks', 'executorActorId', 'maxAttempts']);
    if (typeof unit.key !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(unit.key)) throw createValidationError('Invalid delivery unit key.');
    if (typeof unit.title !== 'string' || !unit.title.trim() || unit.title.length > 250) throw createValidationError('An implementation unit needs a title.');
    if (!Array.isArray(unit.criteria) || !unit.criteria.length || unit.criteria.some((index) => !Number.isInteger(index) || index < 0 || index >= criteria.length)) throw createValidationError('Unit criteria must reference existing acceptance lines.');
    if (unit.executorActorId !== undefined && (typeof unit.executorActorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unit.executorActorId))) throw createValidationError('An executor must be an explicit agent ID.');
    if (unit.maxAttempts !== undefined && (!Number.isSafeInteger(unit.maxAttempts) || Number(unit.maxAttempts) < 1 || Number(unit.maxAttempts) > 10 || !unit.executorActorId)) throw createValidationError('Executor attempts must be between 1 and 10 with an explicit agent.');
    const paths = strings(unit.paths, 'paths', true);
    if (paths.some((path) => path.startsWith('/') || path.includes('\\') || /[*?\[\]\0]/.test(path) || path.replace(/\/$/, '').split('/').some((part) => !part || part === '.' || part === '..'))) throw createValidationError('A delivery path must be a literal repository-relative path or directory prefix.');
    const actions = strings(unit.actions, 'actions', true);
    if (actions.some((action) => !(DELIVERY_ACTIONS as readonly string[]).includes(action))) throw createValidationError('Unknown delivery action.');
    if (actions.includes('deploy') && !environments.length) throw createValidationError('Deployment requires explicit approved environments.');
    const rawChecks = unit.checks ?? [];
    if (!Array.isArray(rawChecks) || rawChecks.length > 100) throw createValidationError('Invalid technical checks.');
    const checks = rawChecks.map((raw) => {
      const check = object(raw, ['workflowId', 'job']);
      if (!Number.isSafeInteger(check.workflowId) || Number(check.workflowId) < 1 || typeof check.job !== 'string' || !check.job.trim() || check.job.length > 200) throw createValidationError('Technical checks need a workflow ID and exact job name.');
      return { workflowId: Number(check.workflowId), job: check.job.trim() };
    });
    return { ...(unit.executorActorId ? { executorActorId: unit.executorActorId as string, maxAttempts: Number(unit.maxAttempts ?? 1) } : {}), key: unit.key, title: unit.title.trim(), criteria: [...new Set(unit.criteria)] as number[], paths, actions: actions as DeliveryAction[], checks, dependsOn: strings(unit.dependsOn ?? [], 'predecessors') };
  });
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  if (byKey.size !== units.length) throw createValidationError('Delivery unit keys must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw createValidationError('Delivery dependency cycle.');
    if (visited.has(key)) return;
    const unit = byKey.get(key);
    if (!unit) throw createValidationError('Unknown delivery predecessor.');
    visiting.add(key);
    unit.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  }
  units.forEach((unit) => visit(unit.key));
  for (const unit of units) for (const key of unit.dependsOn) {
    if (!byKey.get(key)!.checks.length) throw createValidationError('A technical predecessor needs approved CI checks.');
  }
  return { units, environments };
}

export function executionContract(policy: DeliveryPolicy, key: string, contract: DeliveryContract) {
  const unit = policy.units.find((candidate) => candidate.key === key);
  if (!unit) throw createValidationError('This implementation unit was not approved.');
  const criteria = deliveryCriteria(contract);
  return { title: unit.title, acceptance: unit.criteria.map((index) => criteria[index]).join('\n'), scope: contract.scope, constraints: contract.constraints, repository: contract.repository, verification: contract.verification };
}
