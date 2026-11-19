import { describe, expect, it, vi } from 'vitest';
import type { Comment } from '@prisma/client';
import type { WorkContextBundle } from './context-service.js';
import { createSemanticAdvice, type AdviceJournal, type AdviceProvider, type Evaluation, type EvaluationInput } from './semantic-advice.js';
import { defaultAdviceConfig, type AdviceConfig } from './semantic-advice-config.js';
import { CONTEXT_SCENARIO, MAX_RANKED_MATERIALS, coreRetention, curateHandoffContext, handoffOmissions, type CuratedHandoffContext, type HandoffContext } from './semantic-context.js';

const T0 = new Date('2026-11-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const work = (over: Record<string, unknown> = {}) => ({
  id: 'w1', identifier: 'INV-1', teamId: 't1', repository: 'org/repo', revision: 3, stateId: 's-progress', commitmentStatus: 'COMMITTED',
  title: '登录失败处理', description: '### 1. 目标\n修复登录失败时的重试逻辑。', outcome: '用户可以重新登录',
  scope: '只改登录重试', constraints: '不得修改会话格式；不得自动 Done', acceptance: '重试三次后提示错误；中文提示文案保持不变', verification: 'pnpm test src/login.test.ts',
  ...over,
});
const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, publicId: id, workId: 'w1', actorId: 'a-old', claimId: 'c-old', status: 'COMPLETED', phase: 'done', summary: `历史运行 ${id}：调整了无关的日志格式`,
  contractRevision: 'rev-1', commitSha: null, pullRequestNumber: null, startedAt: at(0), endedAt: at(1), lastActivityAt: at(1), ...over,
});
const evidence = (id: string, over: Record<string, unknown> = {}) => ({
  id, workId: 'w1', runId: null, kind: 'TEST', url: `https://ci.example/${id}`, summary: `测试日志 ${id}`, createdAt: at(2), retractedAt: null, retractReason: null, verifications: [], ...over,
});
const comment = (id: string, body: string, minutes = 3) => ({ id, issueId: 'w1', userId: 'u1', body, createdAt: at(minutes), updatedAt: at(minutes) }) as unknown as Comment;

function bundle(over: Partial<Record<keyof WorkContextBundle, unknown>> = {}): WorkContextBundle {
  return {
    work: work(), ancestors: [{ id: 'p1', identifier: 'INV-0', title: '父项目', stateId: 's-progress' }],
    blockedBy: [{ id: 'b1', identifier: 'INV-2', title: '供应商适配层', stateId: 's-done' }], blocks: [{ id: 'b2', identifier: 'INV-3', title: '下游', stateId: 's-backlog' }],
    claim: { id: 'c-now', workId: 'w1', actorId: 'a1', leaseUntil: at(600), actor: { id: 'a1', name: 'agent' } },
    audits: [{ id: 'au1', action: 'work.committed', actor: null }],
    runs: [
      run('r-now', { claimId: 'c-now', actorId: 'a1', status: 'RUNNING', summary: '当前运行：正在修复登录重试', endedAt: null }),
      run('r-legacy', { contractRevision: null, phase: null, summary: null }),
      run('r-rejected', { summary: '上一次实现：登录重试改成无限次（被人工否决）', pullRequestNumber: 7 }),
    ],
    evidence: [
      evidence('e-retracted', { summary: '登录测试通过', retractedAt: at(4), retractReason: 'CI 链接指向错误分支' }),
      evidence('e-failed', { summary: '登录 e2e', verifications: [{ id: 'v1', status: 'FAILED', failureCode: 'not_found' }] }),
    ],
    reviewDecisions: [{ id: 'rd1', runId: 'r-rejected', decision: 'REJECTED', reason: '不允许无限重试，必须三次后提示', reviewer: { id: 'u1', name: 'Chris' } }],
    contractAmendments: [{ id: 'am1', status: 'REJECTED', decisionNote: '验收不改' }],
    ...over,
  } as unknown as WorkContextBundle;
}

const policy = (mode: 'off' | 'shadow' | 'ab' | 'enabled', treatmentBps = 10_000): AdviceConfig => ({
  ...structuredClone(defaultAdviceConfig), enabled: true,
  policies: [{ teamId: 't1', repository: 'org/repo', scenario: CONTEXT_SCENARIO, mode, experimentId: 'ctx-1', assignmentVersion: 'v1', assignmentUnit: 'work', salt: 's', treatmentBps, provider: 'ranker', model: 'ranker-v1', questionVersion: 'q1', calibrationVersion: 'c1', policyVersion: 'p1' }],
});
/** Keeps material that mentions 登录 (login), like a relevance ranker would. */
const relevant = (input: EvaluationInput): Evaluation => {
  const materials = (input.state as { materials: Record<string, { text: string }> }).materials;
  return { model: 'ranker-v1', judgments: Object.fromEntries(input.checks.map(c => [c.id, { kind: 'likelihood' as const, value: materials[c.id]!.text.includes('登录') ? 0.9 : 0.1 }])) };
};
function setup(config: unknown = policy('enabled'), evaluate: AdviceProvider['evaluate'] = async input => relevant(input)) {
  const entries = new Map<string, unknown>();
  const journal: AdviceJournal = { async put(k, v) { if (!entries.has(k)) entries.set(k, structuredClone(v)); return structuredClone(entries.get(k)); }, async get(k) { return structuredClone(entries.get(k)); } };
  const isCurrent = vi.fn(async () => true);
  const spy = vi.fn(evaluate);
  const advisor = createSemanticAdvice({ providers: [{ id: 'ranker', capabilities: new Set(['likelihood']), evaluate: spy }], journal, isCurrent, config });
  return { advisor, isCurrent, evaluate: spy };
}
const curate = (s: ReturnType<typeof setup>, b: WorkContextBundle, comments: Comment[] = [], extra: { signal?: AbortSignal; role?: 'implementer' | 'reviewer' } = {}) =>
  curateHandoffContext({ bundle: b, comments, role: extra.role ?? 'implementer', actorId: 'a1', authorizationDigest: 'auth-1', advisor: s.advisor, signal: extra.signal });
const asCurated = (r: HandoffContext): CuratedHandoffContext => { expect(r.mode).toBe('curated'); return r as CuratedHandoffContext; };
const longComments = () => [
  comment('k-login', '复现：登录失败后按钮一直转圈'),
  ...Array.from({ length: 20 }, (_, i) => comment(`k-noise-${i}`, `无关讨论 ${i}：周会时间调整到周三下午，请大家注意日程安排。`.repeat(10), 10 + i)),
];

describe('handoff context curation (INV-649)', () => {
  it('is off by default and returns the original full bundle untouched', async () => {
    for (const config of [{}, policy('off')]) {
      const s = setup(config); const original = bundle(); const comments = longComments(); const before = structuredClone({ original, comments });
      const r = await curate(s, original, comments);
      expect(r).toEqual({ mode: 'full', status: 'disabled', context: { ...before.original, comments: before.comments } });
      expect({ original, comments }).toEqual(before); expect(s.evaluate).not.toHaveBeenCalled();
    }
  });

  it('A/B control and shadow keep the complete original; treatment shows the selection plus expansion', async () => {
    const control = await curate(setup(policy('ab', 0)), bundle(), longComments());
    expect(control).toMatchObject({ mode: 'full', status: 'control' });
    const shadow = setup(policy('shadow')); const shadowed = await curate(shadow, bundle(), longComments());
    expect(shadowed).toMatchObject({ mode: 'full', status: 'shadow' }); expect(shadow.evaluate).toHaveBeenCalledTimes(1);
    expect(asCurated(await curate(setup(policy('ab')), bundle(), longComments())).status).toBe('advice');
  });

  it('never trims contract, blockers, claim, active run, human rejection, amendments or audits', async () => {
    const s = setup(policy('enabled'), async input => ({ model: 'ranker-v1', judgments: Object.fromEntries(input.checks.map(c => [c.id, { kind: 'likelihood' as const, value: 0 }])) }));
    const original = bundle();
    const r = asCurated(await curate(s, original, longComments()));
    expect(r.core.work).toEqual(original.work);
    expect(r.core.blockedBy).toEqual(original.blockedBy); expect(r.core.blocks).toEqual(original.blocks);
    expect(r.core.claim).toEqual(original.claim);
    expect(r.core.activeRuns.map(x => x.id)).toEqual(['r-now']);
    expect(r.core.reviewDecisions).toEqual(original.reviewDecisions);
    expect(r.core.contractAmendments).toEqual(original.contractAmendments);
    expect(r.core.audits).toEqual(original.audits);
    expect(r.metrics.coreRetention).toBe(1); expect(coreRetention(original, r)).toBe(1);
    expect(r.included).toEqual({ runs: [], evidence: [], comments: [] });
    expect(r.references).toHaveLength(2 + 2 + 21);
  });

  it('references keep original id, version, digest, verbatim excerpt and an expand path, including legacy runs and invalid evidence', async () => {
    const r = asCurated(await curate(setup(), bundle(), longComments()));
    const byId = new Map(r.references.map(x => [x.id, x]));
    expect(byId.get('r-legacy')).toMatchObject({ section: 'runs', excerpt: 'COMPLETED', expand: { tool: 'work_get_context', id: 'INV-1', section: 'runs' } });
    expect(byId.get('r-legacy')!.digest).toMatch(/^[0-9a-f]{16}$/);
    // Retracted and failed evidence mention 登录 and are shown, with their invalid status intact.
    expect(r.included.evidence.map(e => e.id)).toEqual(['e-retracted', 'e-failed']);
    expect(r.included.evidence[0]).toMatchObject({ retractReason: 'CI 链接指向错误分支' });
    expect(r.included.runs.map(x => x.id)).toEqual(['r-rejected']);
    expect(byId.get('k-noise-0')!.excerpt.startsWith('无关讨论 0：周会时间')).toBe(true);
    expect(byId.get('k-noise-0')!.version).toBe(at(10).toISOString());
  });

  it('measures token reduction and handoff omissions against the full control, not compression alone', async () => {
    const original = bundle(); const comments = longComments();
    const needed = [{ section: 'comments' as const, id: 'k-login' }, { section: 'runs' as const, id: 'r-rejected' }, { section: 'evidence' as const, id: 'e-retracted' }, { section: 'runs' as const, id: 'r-now' }];
    const control = await curate(setup({}), original, comments);
    const treatment = asCurated(await curate(setup(), original, comments));
    expect(handoffOmissions(control, needed)).toMatchObject({ omissionRate: 0, collapsedRate: 0 });
    expect(handoffOmissions(treatment, needed)).toMatchObject({ omitted: [], collapsed: [], omissionRate: 0 });
    expect(treatment.metrics.tokenReduction).toBeGreaterThan(0.3);
    expect(treatment.metrics.curatedTokens).toBeLessThan(treatment.metrics.fullTokens);
    expect(treatment.metrics).toMatchObject({ materials: 25, includedMaterials: 4, referencedMaterials: 21, coreRetention: 1 });
    // A ranker that drops needed material only collapses it behind expansion; it is never lost.
    const dropAll = asCurated(await curate(setup(policy('enabled'), async input => ({ model: 'ranker-v1', judgments: Object.fromEntries(input.checks.map(c => [c.id, { kind: 'likelihood' as const, value: 0 }])) })), original, comments));
    expect(handoffOmissions(dropAll, needed)).toMatchObject({ omitted: [], omissionRate: 0, collapsedRate: 0.75 });
  });

  it('treats same-text comments and same-title work as distinct items', async () => {
    const twins = [comment('k-a', '登录失败截图'), comment('k-b', '登录失败截图', 5)];
    const s = setup(policy('enabled'), async input => ({ model: 'ranker-v1', judgments: { m0: { kind: 'likelihood', value: 0 }, ...Object.fromEntries(input.checks.slice(1).map(c => [c.id, { kind: 'likelihood' as const, value: 1 }])) } }));
    const r = asCurated(await curate(s, bundle({ runs: [], evidence: [] }), twins));
    expect(r.included.comments.map(c => c.id)).toEqual(['k-b']);
    expect(r.references.map(x => x.id)).toEqual(['k-a']);
    // A different item with the same title and material is evaluated on its own binding.
    const other = asCurated(await curate(s, bundle({ runs: [], evidence: [], work: work({ id: 'w2', identifier: 'INV-9' }) }), twins));
    expect(other.binding.workId).toBe('w2'); expect(s.evaluate).toHaveBeenCalledTimes(2);
    expect(other.references[0]!.expand.id).toBe('INV-9');
  });

  it('binds the selection to work revision, contract and input', async () => {
    const s = setup(); const first = asCurated(await curate(s, bundle()));
    const revised = asCurated(await curate(s, bundle({ work: work({ revision: 4, acceptance: '重试五次' }) })));
    expect(revised.binding.revision).toBe('4');
    expect(revised.binding.contractDigest).not.toBe(first.binding.contractDigest);
    const moreInput = asCurated(await curate(s, bundle(), [comment('k-new', '登录新线索')]));
    expect(moreInput.binding.inputDigest).not.toBe(first.binding.inputDigest);
    expect(s.evaluate).toHaveBeenCalledTimes(3);
  });

  it('returns the full original when permission is revoked mid-evaluation', async () => {
    const s = setup(); s.isCurrent.mockResolvedValueOnce(true).mockResolvedValue(false);
    const original = bundle(); const before = structuredClone(original);
    const r = await curate(s, original, longComments());
    expect(r).toMatchObject({ mode: 'full', status: 'stale', failure: 'stale' });
    expect((r as Extract<HandoffContext, { mode: 'full' }>).context.runs).toEqual(before.runs);
    expect(original).toEqual(before);
  });

  it('falls back to the full original on timeout, cancellation, model error and malformed output', async () => {
    const slow = { ...policy('enabled'), limits: { ...defaultAdviceConfig.limits, timeoutMs: 20 } };
    const hang: AdviceProvider['evaluate'] = (_input, _model, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await curate(setup(slow, hang), bundle())).toMatchObject({ mode: 'full', status: 'fallback', failure: 'timeout' });

    const controller = new AbortController();
    const pending = curate(setup(policy('enabled'), hang), bundle(), [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect(await pending).toMatchObject({ mode: 'full', failure: 'canceled' });

    const original = bundle(); const before = structuredClone(original);
    const broken = await curate(setup(policy('enabled'), async () => { throw new Error('model unavailable'); }), original);
    expect(broken).toMatchObject({ mode: 'full', status: 'fallback' });
    expect((broken as Extract<HandoffContext, { mode: 'full' }>).context).toEqual({ ...before, comments: [] });
    expect(original).toEqual(before);

    expect(await curate(setup(policy('enabled'), async () => ({ model: 'other-model', judgments: {} })), bundle())).toMatchObject({ mode: 'full', status: 'fallback' });
    const throwingAdvisor = { evaluate: async () => { throw new Error('boom'); } };
    expect(await curateHandoffContext({ bundle: bundle(), role: 'reviewer', actorId: 'a1', authorizationDigest: 'x', advisor: throwingAdvisor })).toMatchObject({ mode: 'full', status: 'error' });
  });

  it('keeps material beyond the ranking budget and abstained items in full', async () => {
    const many = Array.from({ length: MAX_RANKED_MATERIALS + 5 }, (_, i) => comment(`k-${i}`, `闲聊 ${i}`, i));
    const s = setup(policy('enabled'), async input => ({ model: 'ranker-v1', judgments: Object.fromEntries(input.checks.map((c, i) => [c.id, { kind: 'likelihood' as const, value: i === 0 ? null : 0 }])) }));
    const r = asCurated(await curate(s, bundle({ runs: [], evidence: [] }), many));
    expect(r.included.comments.map(c => c.id)).toEqual(['k-0', ...many.slice(MAX_RANKED_MATERIALS).map(c => c.id)]);
    expect(r.references).toHaveLength(MAX_RANKED_MATERIALS - 1);
  });
});
