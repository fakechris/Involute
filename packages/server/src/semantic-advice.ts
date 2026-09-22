import { randomUUID } from 'node:crypto';
import { baselineProvider, validateEvaluation } from './semantic-advice-provider.js';
import { hash, parseAdviceConfig, type AdviceConfig, type ExperimentPolicy } from './semantic-advice-config.js';
import { AdviceError, type AdviceJournal, type AdviceProvider, type Evaluation, type EvaluationInput, type Failure } from './semantic-advice/types.js';
export type { AdviceJournal, AdviceProvider, Evaluation, EvaluationInput, Check, Judgment } from './semantic-advice/types.js';
export { createPrismaAdviceJournal } from './semantic-advice-journal.js';
export { createJevProvider, baselineProvider } from './semantic-advice-provider.js';
export { parseAdviceConfig, defaultAdviceConfig } from './semantic-advice-config.js';

export interface AdviceRequest extends EvaluationInput {
  teamId: string;
  repository: string;
  scenario: string;
  workId: string;
  actorId: string;
  revision: string;
  contractDigest: string;
  /** Hash of the authorized projection, including principal and current permission generation. */
  authorizationDigest: string;
}
export interface AdviceObservation {
  id: string;
  assignmentId: string;
  assignedArm: 'control' | 'treatment' | 'unassigned';
  mode: ExperimentPolicy['mode'];
  configDigest: string;
  inputDigest: string;
  epoch: number;
  provider: string;
  requestedModel: string;
  actualModel: string | null;
  policy: ExperimentPolicy;
  binding: Omit<AdviceRequest, keyof EvaluationInput>;
  status: 'evaluated' | 'fallback' | 'stale';
  fallback: Failure | null;
  cacheHit: boolean;
  elapsedMs: number;
  evaluation: Evaluation | null;
  baseline: Evaluation;
}
export interface AdviceResult {
  status: 'disabled' | 'control' | 'shadow' | 'advice' | 'abstained' | 'fallback' | 'stale';
  visible: Evaluation | null;
  observationId?: string;
  failure?: Failure;
}
export interface AdviceOptions {
  providers: AdviceProvider[];
  journal: AdviceJournal;
  /** Must re-read authorization and revision/contract bindings; false rejects stale input. */
  isCurrent: (binding: AdviceObservation['binding']) => Promise<boolean>;
  config?: unknown;
  now?: () => number;
}

export function createSemanticAdvice(options: AdviceOptions) {
  let config = parseAdviceConfig(options.config);
  let epoch = 0;
  const active = new Set<AbortController>();
  const providers = new Map(options.providers.map(p => [p.id, p]));
  const cache = new Map<string, { expires: number; evaluation: Evaluation }>();
  const now = options.now ?? Date.now;
  let windowStart = now();
  let calls = 0;
  let providerRequests = 0;
  const instanceId = randomUUID();
  const localObservations = new Map<string, AdviceObservation>();

  function configure(value: unknown): void {
    config = parseAdviceConfig(value);
    epoch += 1;
    for (const controller of active) controller.abort();
    cache.clear();
    localObservations.clear();
  }
  function policyFor(r: AdviceRequest | AdviceObservation['binding']): ExperimentPolicy | undefined {
    return config.policies.find(p => p.teamId === r.teamId && p.repository === r.repository && p.scenario === r.scenario);
  }
  async function current(binding: AdviceObservation['binding']): Promise<boolean> {
    try { return await options.isCurrent(binding); } catch { return false; }
  }
  function validateInput(r: AdviceRequest): void {
    for (const field of ['teamId', 'repository', 'scenario', 'workId', 'actorId', 'revision', 'contractDigest', 'authorizationDigest'] as const) {
      if (typeof r[field] !== 'string' || !r[field].trim()) throw new AdviceError('invalid_input');
    }
    if (!Array.isArray(r.checks) || !r.checks.length || r.checks.length > config.limits.maxChecks) throw new AdviceError('invalid_input');
    if (Buffer.byteLength(JSON.stringify(r)) > config.limits.maxInputBytes) throw new AdviceError('invalid_input');
    const seen = new Set<string>();
    for (const c of r.checks) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(c.id) || seen.has(c.id) || typeof c.instruction !== 'string' || !c.instruction.trim()) throw new AdviceError('invalid_input');
      seen.add(c.id);
      if (c.kind === 'selection') {
        const entries = Object.entries(c.options);
        if (!entries.length || entries.length > config.limits.maxCandidates || entries.some(([k, v]) => !k || typeof v !== 'string')) throw new AdviceError('invalid_input');
      } else if (c.kind === 'rating') {
        if (c.levels.length < 2 || c.levels.length > 10 || c.levels.some(x => typeof x !== 'string' || !x.trim())) throw new AdviceError('invalid_input');
      } else if (c.kind !== 'likelihood') throw new AdviceError('invalid_input');
    }
  }
  async function assignment(r: AdviceRequest, p: ExperimentPolicy): Promise<{ id: string; arm: 'control' | 'treatment' }> {
    const namespace = [r.teamId, r.repository, r.scenario, p.experimentId, p.assignmentVersion];
    const definition = hash([p.assignmentUnit, p.salt, 'sha256-bps-v1']);
    const existing = await options.journal.put(`definition:${hash(namespace)}`, definition);
    if (existing !== definition) throw new AdviceError('invalid_input');
    const unit = p.assignmentUnit === 'work' ? r.workId : p.assignmentUnit === 'actor' ? r.actorId : r.teamId;
    const id = hash([...namespace, p.assignmentUnit, unit]);
    const bucket = Number.parseInt(hash([id, p.salt]).slice(0, 8), 16) / 0x1_0000_0000 * 10_000;
    const arm = bucket < p.treatmentBps ? 'treatment' : 'control';
    // Modes have separate assignments; shadow/enabled do not contaminate a later randomized trial.
    const key = `assignment:${p.mode}:${id}`;
    const saved = await options.journal.put(key, { id: key, arm: p.mode === 'ab' ? arm : 'treatment' });
    if (!saved || typeof saved !== 'object' || (saved as { id?: unknown }).id !== key || !['control', 'treatment'].includes(String((saved as { arm?: unknown }).arm))) throw new AdviceError('journal_error');
    return saved as { id: string; arm: 'control' | 'treatment' };
  }
  async function evaluate(request: AdviceRequest, signal?: AbortSignal): Promise<AdviceResult> {
    // Snapshot before any await: callers cannot mutate state or candidate options in flight.
    const r = structuredClone(request);
    const baseline = validateEvaluation(r.baseline, r.checks);
    const p = policyFor(r);
    if (!config.enabled || !p || p.mode === 'off') return { status: 'disabled', visible: baseline };
    const startEpoch = epoch;
    const configDigest = hash(config);
    const binding = { teamId: r.teamId, repository: r.repository, scenario: r.scenario, workId: r.workId,
      actorId: r.actorId, revision: r.revision, contractDigest: r.contractDigest, authorizationDigest: r.authorizationDigest };
    const started = now();
    const controller = new AbortController();
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, config.limits.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    active.add(controller);
    let assigned = { id: '', arm: 'unassigned' as 'control' | 'treatment' | 'unassigned' };
    let evaluation: Evaluation | null = null;
    let failure: Failure | null = null;
    let cacheHit = false;
    let invoked = false;
    const provider = providers.get(p.provider);
    const inputDigest = hash([binding, r.state, r.checks, baseline]);
    // All awaited dependencies share one deadline, even a provider that ignores AbortSignal.
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      if (controller.signal.aborted) { void promise.catch(() => {}); throw new AdviceError(timeout ? 'timeout' : 'canceled'); }
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new AdviceError(timeout ? 'timeout' : 'canceled'));
        controller.signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort)).catch(() => {});
      });
    }
    try {
      validateInput(r);
      if (!await bounded(current(binding))) throw new AdviceError('stale');
      assigned = await bounded(assignment(r, p));
      if (epoch !== startEpoch || !await bounded(current(binding))) throw new AdviceError('stale');
      if (assigned.arm === 'control') evaluation = await bounded(baselineProvider.evaluate(r, baseline.model, controller.signal));
      else {
        if (!provider) throw new AdviceError('not_configured');
        if (r.checks.some(c => !provider.capabilities.has(c.kind))) throw new AdviceError('unsupported');
        const cacheKey = hash([inputDigest, configDigest]);
        const cached = cache.get(cacheKey);
        if (cached && cached.expires > now()) { evaluation = structuredClone(cached.evaluation); cacheHit = true; }
        else {
          if (providerRequests >= config.limits.maxConcurrent) throw new AdviceError('capacity');
          if (now() - windowStart >= 60_000) { windowStart = now(); calls = 0; }
          if (calls >= config.limits.maxCallsPerMinute) throw new AdviceError('budget');
          calls += 1;
          invoked = true;
          providerRequests += 1;
          const pending = Promise.resolve().then(() => provider.evaluate(r, p.model, controller.signal));
          void pending.finally(() => { providerRequests -= 1; }).catch(() => {});
          evaluation = validateEvaluation(await bounded(pending), r.checks);
          if (evaluation.model !== p.model) throw new AdviceError('invalid_response');
          if (epoch !== startEpoch || !await bounded(current(binding))) throw new AdviceError('stale');
          cache.set(cacheKey, { evaluation: structuredClone(evaluation), expires: now() + config.limits.cacheTtlMs });
          while (cache.size > config.limits.cacheEntries) cache.delete(cache.keys().next().value!);
        }
      }
      if (epoch !== startEpoch || !await bounded(current(binding))) throw new AdviceError('stale');
    } catch (error) {
      failure = epoch !== startEpoch ? 'stale' : error instanceof AdviceError ? error.code : 'provider_error';
    }
    const observation: AdviceObservation = {
      id: randomUUID(), assignmentId: assigned.id, assignedArm: assigned.arm, mode: p.mode, configDigest, inputDigest,
      epoch: startEpoch, provider: assigned.arm === 'control' ? 'baseline' : p.provider, requestedModel: p.model,
      actualModel: evaluation?.model ?? null, policy: p, binding, status: failure === 'stale' ? 'stale' : failure ? 'fallback' : 'evaluated',
      fallback: failure, cacheHit, elapsedMs: now() - started, evaluation, baseline,
    };
    // Cleanup must not reuse the expired provider deadline. A failure is not permission
    // to display the old baseline. Each recovery operation has its own bounded deadline.
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    active.delete(controller);
    async function recover<T>(operation: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AdviceError('journal_error')), config.limits.timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    async function stillCurrent(): Promise<boolean> {
      try { return epoch === startEpoch && await recover(current(binding)) && epoch === startEpoch; }
      catch { return false; }
    }
    let journaled = false;
    try {
      // This is an execution observation, not a claim of visibility/current authority.
      await recover(options.journal.put(`observation:${observation.id}`, { ...observation, invoked, instanceId }));
      journaled = true;
    } catch { if (failure !== 'stale') failure = 'journal_error'; }
    if (!await stillCurrent()) failure = 'stale';
    if (signal?.aborted && failure !== 'stale') failure = 'canceled';
    observation.status = failure === 'stale' ? 'stale' : failure ? 'fallback' : 'evaluated';
    observation.fallback = failure;
    if (journaled) {
      const proposedFailure = failure;
      try {
        await recover(options.journal.put(`resolution:${observation.id}`, {
          status: observation.status, failure, epoch: startEpoch, assignmentId: assigned.id,
          visibleProvider: failure || assigned.arm === 'control' || p.mode === 'shadow' ? 'baseline' : p.provider,
        }));
      } catch { if (failure !== 'stale') failure = 'journal_error'; journaled = false; }
      if (!await stillCurrent()) failure = 'stale';
      if (signal?.aborted && failure !== 'stale') failure = 'canceled';
      if (failure !== proposedFailure) {
        // Also supersede writes whose acknowledgement timed out: they may commit late.
        try { await recover(options.journal.put(`invalidation:${observation.id}`, { reason: failure })); }
        catch { journaled = false; }
        // The invalidation already makes the proposal unusable regardless of its reason.
        if (!await stillCurrent()) failure = 'stale';
        if (signal?.aborted && failure !== 'stale') failure = 'canceled';
      }
    }
    observation.status = failure === 'stale' ? 'stale' : failure ? 'fallback' : 'evaluated';
    observation.fallback = failure;
    if (failure !== 'stale' && journaled && assigned.id) {
      localObservations.set(observation.id, observation);
      while (localObservations.size > config.limits.cacheEntries) localObservations.delete(localObservations.keys().next().value!);
    }
    if (failure) return { status: failure === 'stale' ? 'stale' : 'fallback', visible: failure === 'stale' ? null : baseline, failure, observationId: observation.id };
    const status = assigned.arm === 'control' ? 'control' : p.mode === 'shadow' ? 'shadow'
      : Object.values(evaluation!.judgments).every(x => x.value === null) ? 'abstained' : 'advice';
    return { status, visible: p.mode === 'shadow' || assigned.arm === 'control' ? baseline : evaluation!, observationId: observation.id };
  }
  async function recordInteraction(id: string, actorId: string, kind: 'exposure' | 'feedback', value?: 'accepted' | 'corrected' | 'rejected'): Promise<boolean> {
    const o = localObservations.get(id);
    if (!o || o.binding.actorId !== actorId || o.mode === 'shadow' || o.epoch !== epoch || !config.enabled) return false;
    if (kind === 'feedback' && !['accepted', 'corrected', 'rejected'].includes(String(value))) return false;
    if (!await current(o.binding) || o.epoch !== epoch) return false;
    if (kind === 'feedback' && !await options.journal.get(`exposure:${hash([o.assignmentId, o.configDigest, actorId])}`)) return false;
    if (o.epoch !== epoch || !config.enabled) return false;
    const token = randomUUID();
    const saved = await options.journal.put(`${kind}:${hash([o.assignmentId, o.configDigest, actorId])}`, { token, observationId: id, actorId, kind, value: value ?? null, at: now(), assignedArm: o.assignedArm, visibleProvider: o.fallback || o.assignedArm === 'control' ? 'baseline' : o.provider, fallback: o.fallback });
    return (saved as { token: string }).token === token;
  }
  return { configure, evaluate, recordInteraction };
}
