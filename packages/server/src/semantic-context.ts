import type { Comment, WorkRun } from '@prisma/client';
import type { WorkContextBundle } from './context-service.js';
import { hash } from './semantic-advice-config.js';
import type { AdviceRequest, AdviceResult } from './semantic-advice.js';
import type { Check, Evaluation } from './semantic-advice/types.js';

/**
 * Optional handoff curation over getWorkContext (INV-649). The contract, blockers,
 * current claim and its runs, human review decisions, amendments and audits are a
 * core that is never trimmed. Only supplementary material (historical runs,
 * evidence, comments) is ranked by the semantic advice module (INV-647); what is
 * not selected stays as a reference to the original with an expand path. Any
 * advice outcome other than treatment advice returns the original full bundle, except a
 * stale one (permission or contract changed), which returns no content and asks for a re-read.
 */
export const CONTEXT_SCENARIO = 'context';
export const MAX_RANKED_MATERIALS = 32;
const MAX_PROVIDER_TEXT = 1_500;
const EXCERPT = 80;
export const FULL_CONTEXT_BASELINE_MODEL = 'full-context-v1';

export type HandoffRole = 'implementer' | 'reviewer';
export type MaterialSection = 'runs' | 'evidence' | 'comments';
type Evidence = WorkContextBundle['evidence'][number];

export interface HandoffContextInput {
  bundle: WorkContextBundle;
  /** Comments the caller may read, in the order the caller would show them. */
  comments?: Comment[];
  role: HandoffRole;
  actorId: string;
  /** Hash of the caller's authorized projection; the advisor re-checks it via isCurrent. */
  authorizationDigest: string;
  advisor: { evaluate(request: AdviceRequest, signal?: AbortSignal): Promise<AdviceResult> };
  signal?: AbortSignal;
}
export interface MaterialReference {
  section: MaterialSection;
  id: string;
  version: string;
  digest: string;
  /** Verbatim prefix of the original, never a model rewrite. */
  excerpt: string;
  expand: { tool: 'work_get_context'; id: string; section: MaterialSection };
}
export interface HandoffCore extends Omit<WorkContextBundle, 'runs' | 'evidence'> {
  /** Runs of the current claim: never ranked away. */
  activeRuns: WorkRun[];
}
export interface HandoffMetrics {
  fullTokens: number;
  curatedTokens: number;
  tokenReduction: number;
  coreFacts: number;
  coreFactsRetained: number;
  coreRetention: number;
  materials: number;
  includedMaterials: number;
  referencedMaterials: number;
}
export interface FullHandoffContext {
  mode: 'full';
  status: AdviceResult['status'] | 'error';
  failure?: string;
  observationId?: string;
  context: WorkContextBundle & { comments: Comment[] };
}
export interface CuratedHandoffContext {
  mode: 'curated';
  status: 'advice';
  observationId?: string;
  role: HandoffRole;
  binding: { workId: string; revision: string; contractDigest: string; inputDigest: string };
  core: HandoffCore;
  included: { runs: WorkRun[]; evidence: Evidence[]; comments: Comment[] };
  references: MaterialReference[];
  metrics: HandoffMetrics;
}
/** Authorization or the contract changed mid-evaluation: nothing is returned; re-read under current access. */
export interface StaleHandoffContext {
  mode: 'stale';
  status: 'stale';
  failure: string;
  observationId?: string;
  reread: { tool: 'work_get_context'; id: string };
}
export type HandoffContext = FullHandoffContext | CuratedHandoffContext | StaleHandoffContext;

type Material =
  | { section: 'runs'; item: WorkRun }
  | { section: 'evidence'; item: Evidence }
  | { section: 'comments'; item: Comment };

const INSTRUCTIONS: Record<HandoffRole, string> = {
  implementer: 'Likelihood that this material is needed by an agent taking over implementation of the work under the contract in state.work.',
  reviewer: 'Likelihood that this material is needed by a reviewer deciding whether the work meets the acceptance criteria in state.work.',
};

/** Rough token estimate: each CJK character ~1 token, other text ~4 characters per token. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const cjk = text.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function contractDigest(work: WorkContextBundle['work']): string {
  return hash([work.title, work.description, work.outcome, work.scope, work.constraints, work.acceptance, work.verification]);
}

/** Facts a handoff must never lose; used to measure retention against the full bundle. */
export function criticalFacts(view: Omit<HandoffCore, 'ancestors'> & Partial<Pick<HandoffCore, 'ancestors'>>): string[] {
  const w = view.work;
  return [
    ...(['title', 'description', 'outcome', 'scope', 'constraints', 'acceptance', 'verification'] as const)
      .map(field => `contract:${field}:${w[field] ?? ''}`),
    `revision:${w.revision}`, `state:${w.stateId}`, `commitment:${w.commitmentStatus}`,
    ...view.blockedBy.map(b => `blockedBy:${b.id}:${b.stateId}`),
    ...view.blocks.map(b => `blocks:${b.id}:${b.stateId}`),
    ...(view.claim ? [`claim:${view.claim.id}:${view.claim.actorId}:${new Date(view.claim.leaseUntil).toISOString()}`] : []),
    ...view.activeRuns.map(r => `activeRun:${r.id}:${r.status}`),
    ...view.reviewDecisions.map(d => `review:${d.id}:${d.decision}:${d.reason ?? ''}`),
    ...view.contractAmendments.map(a => `amendment:${a.id}:${a.status}:${a.decisionNote ?? ''}`),
    ...view.audits.map(a => `audit:${a.id}`),
  ];
}

function splitBundle(bundle: WorkContextBundle): { core: HandoffCore; historicalRuns: WorkRun[] } {
  const { runs, evidence: _evidence, ...rest } = bundle;
  const claimId = bundle.claim?.id;
  const active = (r: WorkRun) => Boolean(claimId) && r.claimId === claimId;
  return { core: { ...rest, activeRuns: runs.filter(active) }, historicalRuns: runs.filter(r => !active(r)) };
}

function materialText(m: Material): string {
  if (m.section === 'runs') return [m.item.status, m.item.phase, m.item.summary, m.item.commitSha, m.item.pullRequestNumber && `PR #${m.item.pullRequestNumber}`].filter(Boolean).join(' · ');
  if (m.section === 'comments') return m.item.body;
  const verification = m.item.verifications[0];
  return [m.item.kind, m.item.url, m.item.summary, m.item.retractedAt && `RETRACTED: ${m.item.retractReason ?? ''}`,
    verification && `verification ${verification.status}${verification.failureCode ? ` (${verification.failureCode})` : ''}`].filter(Boolean).join(' · ');
}
function materialVersion(m: Material): string {
  const at = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : '');
  if (m.section === 'runs') return [m.item.status, at(m.item.endedAt), at(m.item.lastActivityAt)].join('|');
  if (m.section === 'comments') return at(m.item.updatedAt);
  return [at(m.item.createdAt), at(m.item.retractedAt), m.item.verifications[0]?.id ?? ''].join('|');
}
function reference(m: Material, identifier: string): MaterialReference {
  return {
    section: m.section, id: m.item.id, version: materialVersion(m), digest: hash(m.item).slice(0, 16),
    excerpt: [...materialText(m)].slice(0, EXCERPT).join(''),
    expand: { tool: 'work_get_context', id: identifier, section: m.section },
  };
}

const clip = (text: string | null | undefined) => (text ? [...text].slice(0, MAX_PROVIDER_TEXT).join('') : text ?? null);

function full(bundle: WorkContextBundle, comments: Comment[], status: FullHandoffContext['status'], extra: Pick<FullHandoffContext, 'failure' | 'observationId'> = {}): FullHandoffContext {
  return { mode: 'full', status, ...extra, context: { ...bundle, comments } };
}

export async function curateHandoffContext(input: HandoffContextInput): Promise<HandoffContext> {
  // The caller's objects are never touched; every path returns from this copy.
  const bundle = structuredClone(input.bundle);
  const comments = structuredClone(input.comments ?? []);
  const { core, historicalRuns } = splitBundle(bundle);
  const all: Material[] = [
    ...historicalRuns.map(item => ({ section: 'runs' as const, item })),
    ...bundle.evidence.map(item => ({ section: 'evidence' as const, item })),
    ...comments.map(item => ({ section: 'comments' as const, item })),
  ];
  if (!all.length) return full(bundle, comments, 'disabled');
  // Beyond the ranking budget material is kept in full, never dropped unranked.
  const ranked = all.slice(0, MAX_RANKED_MATERIALS);
  const unranked = all.slice(MAX_RANKED_MATERIALS);
  const work = bundle.work;
  const checks: Check[] = ranked.map((_, i) => ({ id: `m${i}`, kind: 'likelihood', instruction: `${INSTRUCTIONS[input.role]} Material: state.materials.m${i}.` }));
  const baseline: Evaluation = { model: FULL_CONTEXT_BASELINE_MODEL, judgments: Object.fromEntries(checks.map(c => [c.id, { kind: 'likelihood', value: 1 }])) };
  const binding = {
    workId: work.id, revision: String(work.revision), contractDigest: contractDigest(work),
    inputDigest: hash([input.role, ranked.map(m => [m.section, m.item.id, materialVersion(m), hash(m.item)])]),
  };
  const request: AdviceRequest = {
    teamId: work.teamId, repository: work.repository ?? '', scenario: CONTEXT_SCENARIO, workId: work.id,
    actorId: input.actorId, revision: binding.revision, contractDigest: binding.contractDigest,
    authorizationDigest: input.authorizationDigest,
    state: {
      role: input.role,
      work: { identifier: work.identifier, title: work.title, description: clip(work.description), outcome: clip(work.outcome), scope: work.scope, constraints: work.constraints, acceptance: work.acceptance, verification: work.verification },
      materials: Object.fromEntries(ranked.map((m, i) => [`m${i}`, { section: m.section, text: [...materialText(m)].slice(0, MAX_PROVIDER_TEXT).join('') }])),
    },
    checks, baseline,
  };
  let result: AdviceResult;
  try { result = await input.advisor.evaluate(request, input.signal); }
  catch { return full(bundle, comments, 'error', { failure: 'provider_error' }); }
  const extra = { ...(result.failure ? { failure: result.failure } : {}), ...(result.observationId ? { observationId: result.observationId } : {}) };
  if (result.status === 'stale') return { mode: 'stale', status: 'stale', failure: result.failure ?? 'stale', ...(result.observationId ? { observationId: result.observationId } : {}), reread: { tool: 'work_get_context', id: work.identifier } };
  if (result.status !== 'advice' || !result.visible || input.signal?.aborted) return full(bundle, comments, result.status, input.signal?.aborted ? { ...extra, failure: 'canceled' } : extra);

  const keep = (i: number) => {
    const value = result.visible!.judgments[`m${i}`]?.value;
    return value === null || value === undefined || (typeof value === 'number' && value >= 0.5);
  };
  const included: CuratedHandoffContext['included'] = { runs: [], evidence: [], comments: [] };
  const references: MaterialReference[] = [];
  const add = (m: Material) => { (included[m.section] as Material['item'][]).push(m.item); };
  ranked.forEach((m, i) => (keep(i) ? add(m) : references.push(reference(m, work.identifier))));
  unranked.forEach(add);
  const curated: Omit<CuratedHandoffContext, 'metrics'> = {
    mode: 'curated', status: 'advice', ...(result.observationId ? { observationId: result.observationId } : {}),
    role: input.role, binding, core, included, references,
  };
  const fullFacts = criticalFacts(core);
  const fullTokens = estimateTokens({ ...bundle, comments });
  const curatedTokens = estimateTokens(curated);
  return { ...curated, metrics: measure(fullFacts, criticalFacts(curated.core), fullTokens, curatedTokens, all.length, references.length) };
}

function measure(fullFacts: string[], kept: string[], fullTokens: number, curatedTokens: number, materials: number, referenced: number): HandoffMetrics {
  const present = new Set(kept);
  const retained = fullFacts.filter(f => present.has(f)).length;
  return {
    fullTokens, curatedTokens, tokenReduction: fullTokens ? Math.round((1 - curatedTokens / fullTokens) * 1000) / 1000 : 0,
    coreFacts: fullFacts.length, coreFactsRetained: retained, coreRetention: fullFacts.length ? retained / fullFacts.length : 1,
    materials, includedMaterials: materials - referenced, referencedMaterials: referenced,
  };
}

/** Retention of the never-trimmed facts of a full bundle in any curated output. */
export function coreRetention(original: WorkContextBundle, curated: HandoffContext): number {
  const expected = criticalFacts(splitBundle(original).core);
  if (curated.mode === 'stale') return 0;
  const view = curated.mode === 'full' ? splitBundle(curated.context).core : curated.core;
  const present = new Set(criticalFacts(view));
  return expected.length ? expected.filter(f => present.has(f)).length / expected.length : 1;
}

/**
 * Handoff omission against a labelled set of material a successor needed: `omitted` is
 * neither shown nor referenced (a real loss), `collapsed` is only reachable by expanding.
 */
export function handoffOmissions(result: HandoffContext, needed: Array<{ section: MaterialSection; id: string }>): { omitted: string[]; collapsed: string[]; omissionRate: number; collapsedRate: number } {
  const key = (section: string, id: string) => `${section}:${id}`;
  const shown = new Set<string>();
  const referenced = new Set<string>();
  if (result.mode === 'stale') {
    // Nothing shown; everything must be re-read.
  } else if (result.mode === 'full') {
    for (const section of ['runs', 'evidence', 'comments'] as const) for (const item of result.context[section]) shown.add(key(section, item.id));
  } else {
    for (const r of result.core.activeRuns) shown.add(key('runs', r.id));
    for (const section of ['runs', 'evidence', 'comments'] as const) for (const item of result.included[section]) shown.add(key(section, item.id));
    for (const r of result.references) referenced.add(key(r.section, r.id));
  }
  const keys = needed.map(n => key(n.section, n.id));
  const omitted = keys.filter(k => !shown.has(k) && !referenced.has(k));
  const collapsed = keys.filter(k => !shown.has(k) && referenced.has(k));
  return { omitted, collapsed, omissionRate: keys.length ? omitted.length / keys.length : 0, collapsedRate: keys.length ? collapsed.length / keys.length : 0 };
}
