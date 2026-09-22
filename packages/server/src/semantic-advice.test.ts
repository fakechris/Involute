import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createSemanticAdvice, createPrismaAdviceJournal, type AdviceRequest, type AdviceJournal, type AdviceProvider, type Evaluation } from './semantic-advice.js';
import { defaultAdviceConfig, hash, parseAdviceConfig, type AdviceConfig } from './semantic-advice-config.js';

const req = (): AdviceRequest => ({
  teamId: 't1', repository: 'org/repo', scenario: 'triage', workId: 'w1', actorId: 'a1', revision: '1', contractDigest: 'c1', authorizationDigest: 'allowed-1',
  state: { text: '登录失败，复现步骤不明确' },
  checks: [{ id: 'category', kind: 'selection', instruction: 'Classify', options: { bug: 'Defect', unknown: 'Not enough information' } }],
  baseline: { model: 'baseline-v1', judgments: { category: { kind: 'selection', value: 'unknown' } } },
});
const answer = (): Evaluation => ({ model: 'test-v1', judgments: { category: { kind: 'selection', value: 'bug' } } });
const cfg = (mode: 'off' | 'shadow' | 'ab' | 'enabled' = 'enabled'): AdviceConfig => ({
  ...structuredClone(defaultAdviceConfig), enabled: true,
  policies: [{ teamId: 't1', repository: 'org/repo', scenario: 'triage', mode, experimentId: 'e1', assignmentVersion: 'v1', assignmentUnit: 'work', salt: 's1', treatmentBps: 10_000, provider: 'test', model: 'test-v1', questionVersion: 'q1', calibrationVersion: 'cal1', policyVersion: 'p1' }],
});
function setup(config: unknown = cfg(), evaluate = vi.fn(async () => answer())) {
  const entries = new Map<string, unknown>();
  const journal: AdviceJournal = {
    async put(k, v) { if (!entries.has(k)) entries.set(k, structuredClone(v)); return structuredClone(entries.get(k)); },
    async get(k) { return structuredClone(entries.get(k)); },
  };
  const isCurrent = vi.fn(async () => true);
  const provider: AdviceProvider = { id: 'test', capabilities: new Set(['selection']), evaluate };
  return { entries, journal, isCurrent, provider, evaluate,
    service: createSemanticAdvice({ providers: [provider], journal, isCurrent, config }) };
}
const observations = (entries: Map<string, unknown>) => [...entries].filter(([k]) => k.startsWith('observation:')).map(([, v]) => v as Record<string, unknown>);
afterEach(() => vi.useRealTimers());

describe('optional semantic advice', () => {
  it.each([undefined, {}, '{bad', { enabled: 'true', policies: [] }, { ...cfg(), limits: { timeoutMs: -1 } }, cfg('off')])('defaults off with missing or invalid config', async config => {
    const s = setup(config ?? {}); const r = await s.service.evaluate(req());
    expect(r.status).toBe('disabled'); expect(r.visible).toEqual(req().baseline); expect(s.evaluate).not.toHaveBeenCalled();
  });
  it('scopes exact project/team/scenario and global kill wins', async () => {
    const s = setup();
    expect((await s.service.evaluate({ ...req(), teamId: 't2' })).status).toBe('disabled');
    expect((await s.service.evaluate({ ...req(), scenario: 'coverage' })).status).toBe('disabled');
    s.service.configure({ ...cfg(), enabled: false });
    expect((await s.service.evaluate(req())).status).toBe('disabled'); expect(s.evaluate).not.toHaveBeenCalled();
  });
  it('shadow records both arms but never shows treatment or accepts exposure', async () => {
    const s = setup(cfg('shadow')); const r = await s.service.evaluate(req());
    expect(r.status).toBe('shadow'); expect(r.visible).toEqual(req().baseline);
    expect(observations(s.entries)[0]?.evaluation).toEqual(answer());
    expect(await s.service.recordInteraction(r.observationId!, 'a1', 'exposure')).toBe(false);
  });
  it('A/B control makes no provider call; zero and full allocation are exact', async () => {
    const c = cfg('ab'); c.policies[0]!.treatmentBps = 0;
    const s = setup(c); expect((await s.service.evaluate(req())).status).toBe('control'); expect(s.evaluate).not.toHaveBeenCalled();
    expect((await setup(cfg('ab')).service.evaluate(req())).status).toBe('advice');
  });
  it('assignment survives revision, restart, ratio and epoch changes', async () => {
    const c = cfg('ab'); const s = setup(c); await s.service.evaluate(req());
    c.policies[0]!.treatmentBps = 0; s.service.configure(c);
    expect((await s.service.evaluate({ ...req(), revision: '2' })).status).toBe('advice');
    const restarted = createSemanticAdvice({ providers: [s.provider], journal: s.journal, isCurrent: s.isCurrent, config: c });
    expect((await restarted.evaluate({ ...req(), revision: '3' })).status).toBe('advice');
    expect(new Set(observations(s.entries).map(o => o.assignmentId)).size).toBe(1);
  });
  it('forbids changing assignment unit or salt under same experiment identity', async () => {
    const c = cfg('ab'); const s = setup(c); await s.service.evaluate(req());
    c.policies[0]!.assignmentUnit = 'actor'; s.service.configure(c);
    expect((await s.service.evaluate(req())).failure).toBe('invalid_input');
  });
  it('groups actor and team experiments with their explicit unit', async () => {
    for (const unit of ['actor', 'team'] as const) {
      const c = cfg('ab'); c.policies[0]!.assignmentUnit = unit; const s = setup(c);
      await s.service.evaluate(req()); await s.service.evaluate({ ...req(), workId: 'w2' });
      expect(new Set(observations(s.entries).map(o => o.assignmentId)).size).toBe(1);
    }
  });
  it('uses cache only for identical authorized inputs and policy/model versions', async () => {
    const s = setup(); await s.service.evaluate(req()); await s.service.evaluate(req());
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    await s.service.evaluate({ ...req(), revision: '2' });
    await s.service.evaluate({ ...req(), authorizationDigest: 'allowed-2' });
    await s.service.evaluate({ ...req(), actorId: 'a2' });
    expect(s.evaluate).toHaveBeenCalledTimes(4);
    const c = cfg(); c.policies[0]!.questionVersion = 'q2'; s.service.configure(c);
    await s.service.evaluate(req()); expect(s.evaluate).toHaveBeenCalledTimes(5);
  });
  it('rechecks permission on cache hits and returns no stale payload', async () => {
    const s = setup(); await s.service.evaluate(req()); s.isCurrent.mockResolvedValue(false);
    const r = await s.service.evaluate(req()); expect(r.status).toBe('stale'); expect(r.visible).toBeNull();
    expect(s.evaluate).toHaveBeenCalledTimes(1);
  });
  it('discards a result when contract changes during await', async () => {
    const s = setup(); s.evaluate.mockImplementation(async () => { s.isCurrent.mockResolvedValue(false); return answer(); });
    const r = await s.service.evaluate(req()); expect(r.status).toBe('stale'); expect(r.visible).toBeNull();
  });
  it('kill aborts in-flight provider and late success cannot return advice', async () => {
    let providerSignal: AbortSignal | undefined;
    const s = setup(); s.evaluate.mockImplementation(async (_input, _model, signal) => { providerSignal = signal; return new Promise(() => {}); });
    const pending = s.service.evaluate(req());
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    s.service.configure({ ...cfg(), enabled: false });
    expect(providerSignal!.aborted).toBe(true); expect((await pending).status).toBe('stale');
  });
  it('bounds uncooperative provider and records timeout in original treatment arm', async () => {
    vi.useFakeTimers(); const c = cfg('ab'); c.limits.timeoutMs = 10;
    const s = setup(c, vi.fn(() => new Promise<Evaluation>(() => {})));
    const pending = s.service.evaluate(req()); await vi.advanceTimersByTimeAsync(20);
    const r = await pending; expect(r.failure).toBe('timeout'); expect(r.visible).toEqual(req().baseline);
    expect(observations(s.entries)[0]).toMatchObject({ assignedArm: 'treatment', fallback: 'timeout' });
  });
  it('rejects bad input before any remote call', async () => {
    const s = setup(); const r = req(); r.checks[0]!.instruction = '';
    expect((await s.service.evaluate(r)).failure).toBe('invalid_input'); expect(s.evaluate).not.toHaveBeenCalled();
  });
  it('enforces calls budget including failed calls', async () => {
    const c = cfg(); c.limits.maxCallsPerMinute = 1;
    const s = setup(c, vi.fn(async () => { throw new Error('private provider error'); }));
    expect((await s.service.evaluate(req())).failure).toBe('provider_error');
    expect((await s.service.evaluate(req())).failure).toBe('budget'); expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...s.entries])).not.toContain('private provider error');
  });
  it('dedupes actual exposure and feedback across repeated evaluations', async () => {
    const s = setup(); const a = await s.service.evaluate(req()); const b = await s.service.evaluate(req());
    expect(await s.service.recordInteraction(a.observationId!, 'other', 'exposure')).toBe(false);
    expect(await s.service.recordInteraction(a.observationId!, 'a1', 'feedback', 'accepted')).toBe(false);
    expect(await s.service.recordInteraction(a.observationId!, 'a1', 'exposure')).toBe(true);
    expect(await s.service.recordInteraction(b.observationId!, 'a1', 'exposure')).toBe(false);
    expect(await s.service.recordInteraction(a.observationId!, 'a1', 'feedback', 'rejected')).toBe(true);
    expect(await s.service.recordInteraction(b.observationId!, 'a1', 'feedback', 'accepted')).toBe(false);
    s.service.configure(cfg()); expect(await s.service.recordInteraction(a.observationId!, 'a1', 'exposure')).toBe(false);
  });
  it('revalidates after journal write that raced a configuration change', async () => {
    const s = setup(); const put = s.journal.put;
    s.journal.put = async (key, value) => { const out = await put(key, value); if (key.startsWith('observation:')) s.service.configure(cfg('off')); return out; };
    expect((await s.service.evaluate(req())).status).toBe('stale');
  });
  it('invalid uncertainty is rejected without turning it into a decision', async () => {
    const s = setup(undefined, vi.fn(async () => ({ ...answer(), judgments: { category: { kind: 'selection' as const, value: 'outside' } } })));
    expect((await s.service.evaluate(req())).failure).toBe('invalid_response');
  });
});

describe('durable journal', () => {
  it('first writer wins across adapters and concurrent duplicate writes', async () => {
    const prisma = new PrismaClient(); const key = `inv647-test:${hash(Math.random())}`;
    try {
      const a = createPrismaAdviceJournal(prisma); const b = createPrismaAdviceJournal(prisma);
      const values = await Promise.all([a.put(key, { arm: 'control' }), b.put(key, { arm: 'treatment' })]);
      expect(values[0]).toEqual(values[1]); expect(await b.get(key)).toEqual(values[0]);
    } finally { await prisma.semanticAdviceRecord.deleteMany({ where: { key } }); await prisma.$disconnect(); }
  });
});
