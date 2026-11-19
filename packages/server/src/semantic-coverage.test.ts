import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFindings, coverageCriteria, createCoverageService, lexicalCoverageProvider, loadCoverage, scoreCoverage, type CoverageEvidence } from './semantic-coverage.js';
import { snapshotContract } from './evidence-contract.js';
import { defaultAdviceConfig, type AdviceConfig } from './semantic-advice-config.js';
import type { AdviceProvider } from './semantic-advice.js';

const repository = 'org/repo';
const sha = 'a'.repeat(40);
const work = { acceptance: 'export invoices', repository, scope: null, constraints: null };
const criterion = coverageCriteria(work.acceptance);
const run = { id: 'r1', repository, commitSha: sha, pullRequestNumber: 1, contractRevision: snapshotContract(work).contractRevision };
const evidence: CoverageEvidence = { id: 'e1', kind: 'PR', url: `https://github.com/${repository}/pull/1`, summary: 'export invoices', runId: run.id, referenceExists: true, origin: 'api' };
const findings = (e = evidence, r = run) => codeFindings(work, criterion, [e], run, [r]).map(f => f.message);
describe('deterministic coverage findings', () => {
  it('preserves structured ids and splits human acceptance without losing text', () => {
    expect(coverageCriteria('1. Export;2. Import；\n- Save\n• Close')).toEqual(['Export', 'Import', 'Save', 'Close'].map((text, i) => ({ id: `c${i + 1}`, text })));
    expect(coverageCriteria(JSON.stringify({ version: 1, criteria: [{ id: 'deploy-job', required: true, workflowId: 1, job: 'Deploy' }] }))).toEqual([{ id: 'deploy-job', text: 'Deploy' }]);
    expect(coverageCriteria(null)).toEqual([]);
  });
  it('does not confuse a test total with acceptance', () => expect(findings({ ...evidence, summary: '100 tests passed' })).toContain('test total alone does not identify this acceptance criterion'));
  it('flags wrong mentioned or execution SHA', () => {
    expect(findings({ ...evidence, summary: `export invoices ${'b'.repeat(40)}` })).toContain('mentioned SHA differs from latest execution');
    expect(findings(evidence, { ...run, commitSha: 'b'.repeat(40) })).toContain('evidence execution SHA is missing or different');
  });
  it('checks reference existence, repository, PR, and contract in code', () => {
    expect(findings()).toEqual([]);
    expect(findings({ ...evidence, referenceExists: false })).toContain('reference existence has not been established by code');
    expect(findings({ ...evidence, url: 'https://github.com/other/repo/pull/2' })).toEqual(expect.arrayContaining(['reference repository differs from work', 'PR differs from latest execution']));
    expect(findings({ ...evidence, url: 'https://example.com/log' })).toContain('reference is not a supported GitHub PR/run');
    expect(findings(evidence, { ...run, contractRevision: 'old' })).toContain('execution contract is old or missing');
  });
  it.each(['Deploy production', '真实部署上线'])('fixture and test descriptions cannot prove %s', text => {
    const result = codeFindings(work, [{ id: 'c1', text }], [{ ...evidence, summary: 'fixture: production deployment passed' }], run, [run]);
    expect(result.map(f => f.message)).toContain('test evidence cannot prove deployment');
  });
  it('a real reference does not establish semantic support', async () => {
    const result = await lexicalCoverageProvider.evaluate({ state: { criteria: criterion, evidence: [{ ...evidence, summary: 'changes button colors' }], findings: [] }, checks: [{ id: 'c1', kind: 'selection', instruction: 'export invoices', options: { supports: 'supports', insufficient: 'insufficient' } }], baseline: { model: 'baseline', judgments: {} } }, 'heuristic-v1', new AbortController().signal);
    expect(result.judgments.c1.value).toBe('insufficient');
  });
  it('the local heuristic can support a criterion only with matching eligible evidence', async () => {
    const input = { state: { criteria: criterion, evidence: [evidence], findings: [] }, checks: [{ id: 'c1', kind: 'selection' as const, instruction: criterion[0].text, options: { supports: 'supports', insufficient: 'insufficient' } }], baseline: { model: 'baseline', judgments: {} } };
    expect((await lexicalCoverageProvider.evaluate(input, 'heuristic-v1', new AbortController().signal)).judgments.c1.value).toBe('supports');
    const aborted = new AbortController(); aborted.abort();
    await expect(lexicalCoverageProvider.evaluate(input, 'heuristic-v1', aborted.signal)).rejects.toThrow('canceled');
  });
  it('reports separate rates and review time for API and fixture samples, including empty denominators', () => {
    const score = scoreCoverage([
      { origin: 'api', expected: 'supports', actual: 'insufficient', reviewTimeMs: 100 },
      { origin: 'api', expected: 'unrelated', actual: 'supports', reviewTimeMs: 300 },
      { origin: 'fixture', expected: 'supports', actual: 'supports', reviewTimeMs: 10 },
    ]);
    expect(score.api).toMatchObject({ missRate: 1, falsePositiveRate: 1, wrongSupportRate: 1, meanReviewTimeMs: 200, medianReviewTimeMs: 200 });
    expect(score.fixture).toMatchObject({ missRate: 0, falsePositiveRate: null, wrongSupportRate: 0, meanReviewTimeMs: 10 });
    expect(scoreCoverage([]).api.missRate).toBeNull();
  });
});

describe('coverage advice is read-only and content-bound', () => {
  const prisma = new PrismaClient();
  let teamId: string;
  let stateId: string;
  beforeAll(async () => {
    const team = await prisma.team.create({ data: { key: `COV${Date.now()}`, name: 'Coverage tests' } });
    teamId = team.id;
    stateId = (await prisma.workflowState.create({ data: { teamId, name: 'Review', type: 'REVIEW', position: 0 } })).id;
  });
  afterAll(async () => {
    await prisma.issue.deleteMany({ where: { teamId } });
    await prisma.workflowState.deleteMany({ where: { teamId } });
    await prisma.team.delete({ where: { id: teamId } });
    await prisma.$disconnect();
  });
  const config = (mode: 'enabled' | 'shadow' | 'ab' = 'enabled', treatmentBps = 10000): AdviceConfig => ({ ...defaultAdviceConfig, enabled: true, policies: [{ teamId, repository, scenario: 'coverage', mode, experimentId: 'coverage-test', assignmentVersion: 'v1', assignmentUnit: 'work', salt: 'coverage', treatmentBps, provider: 'lexical', model: 'heuristic-v1', questionVersion: 'v1', calibrationVersion: 'v1', policyVersion: 'v1' }] });
  async function setup() {
    const current = await prisma.issue.create({ data: { ...work, stateId, teamId, identifier: `COV-${randomUUID()}`, title: 'Coverage' } });
    const execution = await prisma.workRun.create({ data: { workId: current.id, publicId: `RUN-${randomUUID()}`, repository, commitSha: sha, pullRequestNumber: 1, contractRevision: snapshotContract(current).contractRevision } });
    const source = await prisma.workEvidence.create({ data: { workId: current.id, runId: execution.id, kind: 'PR', url: evidence.url, summary: evidence.summary } });
    return { current, execution, source };
  }
  it('shows advisory gaps, journals exposure, and never writes verification or acceptance state', async () => {
    const s = await setup();
    const before = await prisma.issue.findUniqueOrThrow({ where: { id: s.current.id } });
    const count = await prisma.evidenceVerification.count();
    const service = createCoverageService(prisma, { config: config() });
    const result = await service.read(s.current.id, 'reviewer', async () => {});
    expect(result.status).toBe('advice');
    expect(result.criteria[0]).toMatchObject({ judgment: 'insufficient' });
    expect(await prisma.evidenceVerification.count()).toBe(count);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: s.current.id } })).toEqual(before);
    expect(await prisma.semanticAdviceRecord.count({ where: { key: { startsWith: 'exposure:' } } })).toBeGreaterThan(0);
    const countBeforeDisable = await prisma.semanticAdviceRecord.count();
    service.configure({ enabled: false, policies: [] });
    expect(await service.read(s.current.id, 'reviewer', async () => {})).toEqual({ status: 'disabled', criteria: [] });
    expect(await prisma.semanticAdviceRecord.count()).toBe(countBeforeDisable);
  });
  it.each(['shadow', 'control', 'fallback'] as const)('hides %s judgments', async mode => {
    const s = await setup();
    const c = config(mode === 'control' ? 'ab' : mode === 'shadow' ? 'shadow' : 'enabled', 0);
    if (mode === 'fallback') c.policies[0].provider = 'missing';
    expect(await createCoverageService(prisma, { config: c }).read(s.current.id, 'reviewer', async () => {})).toEqual({ status: mode, criteria: [] });
  });
  it.each(['retraction', 'contract', 'sha', 'pr'] as const)('rejects await race after %s changes', async change => {
    const s = await setup();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: AdviceProvider = { ...lexicalCoverageProvider, async evaluate(input, model, signal) { enter(); await gate; return lexicalCoverageProvider.evaluate(input, model, signal); } };
    const service = createCoverageService(prisma, { config: config(), providers: [provider] });
    const pending = service.read(s.current.id, 'reviewer', async () => {});
    await entered;
    if (change === 'retraction') await prisma.workEvidence.update({ where: { id: s.source.id }, data: { retractedAt: new Date() } });
    if (change === 'contract') await prisma.issue.update({ where: { id: s.current.id }, data: { acceptance: 'changed contract' } });
    if (change === 'sha' || change === 'pr') await prisma.workRun.update({ where: { id: s.execution.id }, data: change === 'sha' ? { commitSha: 'b'.repeat(40) } : { pullRequestNumber: 2 } });
    release();
    expect(await pending).toEqual({ status: 'stale', criteria: [] });
    if (change === 'retraction') expect((await loadCoverage(prisma, s.current.id)).evidence).toEqual([]);
  });
  it('rejects revoked read access before serving hints', async () => {
    const s = await setup();
    await expect(createCoverageService(prisma, { config: config() }).read(s.current.id, 'reviewer', async () => { throw new Error('denied'); })).rejects.toThrow('denied');
  });
  it('shows abstention without treating it as verification and handles an empty contract', async () => {
    const s = await setup();
    const provider: AdviceProvider = { ...lexicalCoverageProvider, async evaluate(input, model) { return { model, judgments: Object.fromEntries(input.checks.map(c => [c.id, { kind: 'selection' as const, value: null }])) }; } };
    const service = createCoverageService(prisma, { config: config(), providers: [provider] });
    const result = await service.read(s.current.id, 'reviewer', async () => {});
    expect(result.status).toBe('abstained');
    expect(result.criteria[0]).toMatchObject({ judgment: 'insufficient' });
    await prisma.issue.update({ where: { id: s.current.id }, data: { acceptance: '' } });
    expect(await service.read(s.current.id, 'reviewer', async () => {})).toEqual({ status: 'disabled', criteria: [] });
  });
});
