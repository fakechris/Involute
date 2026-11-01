/**
 * Autonomy policy (INV-1488, decision INV-1486, design docs/autonomy-policy.md).
 *
 * Who decides at each human gate, as data: a workspace sets a ceiling and
 * locked gates, a team picks a level, a project may override, and an agent's
 * trust level clamps all of it. This module is pure: it knows nothing about
 * the database. `autonomy-service.ts` loads the rows and calls `resolveAutonomy`.
 *
 * Nothing here opens a gate. Later steps (INV-1491 L1, INV-1492 L2, INV-1493
 * L3) read the resolved deciders; until then every surface still waits for a
 * person exactly as before.
 */

export const AUTONOMY_LEVELS = [0, 1, 2, 3] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const GATES = ['candidate_commit', 'contract_amendment', 'review_accept', 'agent_delegation', 'merge_signal', 'spend_budget'] as const;
export type Gate = (typeof GATES)[number];

export type Decider = 'human' | 'auto' | 'none';

/** Fields a condition may name. Anything else is refused when a policy is saved (§3). */
export const CONDITION_FIELDS = [
  'type', 'labels', 'priority', 'source', 'severity', 'reproducibility',
  'has_steps', 'has_acceptance', 'amendment_fields', 'auto_accept_grade',
  'pr_merged', 'checks', 'delivery_actions', 'budget_remaining', 'hops',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export type Scalar = string | number | boolean | null;

/** A typed predicate over stored fields: no free text, so it can be tested and explained. */
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { field: ConditionField; eq: Scalar }
  | { field: ConditionField; in: Scalar[] }
  | { field: ConditionField; not_in: Scalar[] }
  | { field: ConditionField; gte: number }
  | { field: ConditionField; lte: number }
  | { field: ConditionField; subset_of: string[] };

export interface GateRule { decider: Decider; condition?: Predicate }
export type GateTable = Partial<Record<Gate, GateRule>>;

/** Describes each level in both languages; shown wherever a level is shown (decision INV-1486). */
export const LEVEL_DESCRIPTIONS: Record<AutonomyLevel, { name: string; en: string; zh: string }> = {
  0: {
    name: 'L0 Review everything',
    en: 'A person commits every candidate, accepts every amendment and moves every item to Done. Agents propose, run and stop at In Review.',
    zh: '每一张候选由人承诺，每一次修约由人接受，每一项工作由人移到 Done。agent 只提案、执行、停在 In Review。',
  },
  1: {
    name: 'L1 Low-risk pass-through',
    en: 'Bug and improvement candidates with steps, acceptance and priority High or lower are committed when proposed. Amendments that only change verification are accepted automatically. Everything else waits for a person.',
    zh: '带复现步骤、验收标准且优先级不高于 High 的 bug / improvement 候选一经提案即承诺；只改 verification 的修约自动接受。其余照旧等人。',
  },
  2: {
    name: 'L2 Green-light accept',
    en: 'L1, plus: work in In Review whose evidence grades CLEAR (merged, checks green) moves to Done for every Type. Sometimes / Once bugs, SEV1 / SEV2 incidents and locked gates still wait for a person.',
    zh: '在 L1 之上：处于 In Review、证据评级 CLEAR（已合并、CI 绿）的工作对所有 Type 自动 Done。Sometimes / Once 的 bug、SEV1 / SEV2 事故与锁定门仍等人。',
  },
  3: {
    name: 'L3 Hands-off',
    en: 'L2, plus: candidates matching the team intake rule are committed and dispatched without a person; agents may delegate to agents through explicit, budgeted, bounded requests; the filer hears back once, on the item, when it is Done.',
    zh: '在 L2 之上：符合团队收单规则的候选无需人承诺即派给 agent；agent 之间可通过显式、带预算、有跳数上限的请求互相委派；提单人只在 Done 时在工单上收到一次回帖。',
  },
};

const L1_COMMIT: Predicate = { all: [
  { field: 'type', in: ['bug', 'improvement'] },
  { field: 'has_steps', eq: true },
  { field: 'has_acceptance', eq: true },
  { field: 'priority', gte: 2 },
] };
const L1_AMEND: Predicate = { field: 'amendment_fields', subset_of: ['verification'] };
const L2_ACCEPT: Predicate = { all: [
  { field: 'auto_accept_grade', eq: 'CLEAR' },
  { field: 'pr_merged', eq: true },
  { field: 'checks', eq: 'green' },
  { field: 'reproducibility', not_in: ['SOMETIMES', 'ONCE'] },
  { field: 'severity', not_in: ['SEV1', 'SEV2'] },
] };
const L3_DELEGATE: Predicate = { all: [
  { field: 'budget_remaining', gte: 1 },
  { field: 'hops', lte: 3 },
] };

/** The per-level gate table of docs/autonomy-policy.md §3.1. */
export const LEVEL_PRESETS: Record<AutonomyLevel, Record<Gate, GateRule>> = {
  0: {
    candidate_commit: { decider: 'human' },
    contract_amendment: { decider: 'human' },
    review_accept: { decider: 'human' },
    agent_delegation: { decider: 'none' },
    merge_signal: { decider: 'human' },
    spend_budget: { decider: 'none' },
  },
  1: {
    candidate_commit: { decider: 'auto', condition: L1_COMMIT },
    contract_amendment: { decider: 'auto', condition: L1_AMEND },
    review_accept: { decider: 'human' },
    agent_delegation: { decider: 'none' },
    merge_signal: { decider: 'human' },
    spend_budget: { decider: 'none' },
  },
  2: {
    candidate_commit: { decider: 'auto', condition: L1_COMMIT },
    contract_amendment: { decider: 'auto', condition: L1_AMEND },
    review_accept: { decider: 'auto', condition: L2_ACCEPT },
    agent_delegation: { decider: 'none' },
    merge_signal: { decider: 'human' },
    spend_budget: { decider: 'none' },
  },
  3: {
    // L3 commits what the team intake rule matches; without a rule nothing is committed unasked.
    candidate_commit: { decider: 'auto', condition: L1_COMMIT },
    contract_amendment: { decider: 'auto', condition: { field: 'amendment_fields', subset_of: ['verification', 'scope'] } },
    review_accept: { decider: 'auto', condition: L2_ACCEPT },
    agent_delegation: { decider: 'auto', condition: L3_DELEGATE },
    merge_signal: { decider: 'human' },
    spend_budget: { decider: 'human', condition: { field: 'budget_remaining', lte: 0 } },
  },
};

/**
 * Gates that stay with a person at every level and cannot be unlocked
 * (INV-1126 incidents, deploy / credentials, INV-1122 intermittent bugs).
 * They are expressed as conditions the resolver ANDs onto `review_accept` and
 * `candidate_commit` as "must be human when matched".
 */
export const BUILT_IN_LOCKS: ReadonlyArray<{ id: string; gate: Gate; when: Predicate; reason: string }> = [
  { id: 'sev1_sev2_done', gate: 'review_accept', when: { field: 'severity', in: ['SEV1', 'SEV2'] }, reason: 'SEV1 / SEV2 incidents reach Done only through a person (INV-1126).' },
  { id: 'deploy_or_credentials', gate: 'review_accept', when: { field: 'delivery_actions', in: ['deploy'] }, reason: 'Work whose delivery includes a deploy or touches credentials waits for a person.' },
  { id: 'intermittent_bug', gate: 'review_accept', when: { field: 'reproducibility', in: ['SOMETIMES', 'ONCE'] }, reason: 'A merged PR cannot prove an intermittent bug gone (INV-1122).' },
];

// ---------------------------------------------------------------------------
// Validation: a policy row is data a person typed; refuse what the resolver
// could not evaluate so the mistake is found when saved, not when it matters.

export type AutonomyFacts = Partial<Record<ConditionField, Scalar | Scalar[]>>;

export function validatePredicate(value: unknown, path = 'condition'): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: must be an object`];
  const node = value as Record<string, unknown>;
  if ('all' in node || 'any' in node) {
    const key = 'all' in node ? 'all' : 'any';
    if (!Array.isArray(node[key])) return [`${path}.${key}: must be a list`];
    return (node[key] as unknown[]).flatMap((child, index) => validatePredicate(child, `${path}.${key}[${index}]`));
  }
  const problems: string[] = [];
  if (!CONDITION_FIELDS.includes(node.field as ConditionField)) problems.push(`${path}.field: unknown field ${JSON.stringify(node.field)}`);
  const operators = ['eq', 'in', 'not_in', 'gte', 'lte', 'subset_of'].filter((operator) => operator in node);
  if (operators.length !== 1) problems.push(`${path}: exactly one of eq / in / not_in / gte / lte / subset_of`);
  for (const operator of operators) {
    const operand = node[operator];
    if ((operator === 'in' || operator === 'not_in' || operator === 'subset_of') && !Array.isArray(operand)) problems.push(`${path}.${operator}: must be a list`);
    if ((operator === 'gte' || operator === 'lte') && typeof operand !== 'number') problems.push(`${path}.${operator}: must be a number`);
  }
  return problems;
}

export function validateGateTable(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['gates: must be an object'];
  const problems: string[] = [];
  for (const [gate, rule] of Object.entries(value as Record<string, unknown>)) {
    if (!GATES.includes(gate as Gate)) { problems.push(`gates.${gate}: unknown gate`); continue; }
    if (!rule || typeof rule !== 'object') { problems.push(`gates.${gate}: must be an object`); continue; }
    const { decider, condition } = rule as Record<string, unknown>;
    if (decider !== 'human' && decider !== 'auto' && decider !== 'none') problems.push(`gates.${gate}.decider: human / auto / none`);
    if (condition !== undefined) problems.push(...validatePredicate(condition, `gates.${gate}.condition`));
  }
  return problems;
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === 'number' && (AUTONOMY_LEVELS as readonly number[]).includes(value);
}

// ---------------------------------------------------------------------------
// Evaluation

function asList(value: Scalar | Scalar[] | undefined): Scalar[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Evaluates a predicate against known facts. An unknown fact never matches, so auto falls back to human. */
export function evaluatePredicate(predicate: Predicate, facts: AutonomyFacts): boolean {
  if ('all' in predicate) return predicate.all.every((child) => evaluatePredicate(child, facts));
  if ('any' in predicate) return predicate.any.some((child) => evaluatePredicate(child, facts));
  const value = facts[predicate.field];
  if (value === undefined) return false;
  const values = asList(value);
  const normalise = (item: Scalar) => (typeof item === 'string' ? item.toLowerCase() : item);
  if ('eq' in predicate) return values.length === 1 && normalise(values[0]!) === normalise(predicate.eq);
  if ('in' in predicate) return values.some((item) => predicate.in.map(normalise).includes(normalise(item)));
  if ('not_in' in predicate) return values.every((item) => !predicate.not_in.map(normalise).includes(normalise(item)));
  if ('gte' in predicate) return values.length === 1 && typeof values[0] === 'number' && values[0] >= predicate.gte;
  if ('lte' in predicate) return values.length === 1 && typeof values[0] === 'number' && values[0] <= predicate.lte;
  if ('subset_of' in predicate) {
    const allowed = predicate.subset_of.map((item) => item.toLowerCase());
    return values.length > 0 && values.every((item) => typeof item === 'string' && allowed.includes(item.toLowerCase()));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolution

export type AgentTrust = 'OBSERVE' | 'L1' | 'L2' | 'L3';

export interface PolicyRow { level: AutonomyLevel; gates?: GateTable | null; locked?: string[] | null; observeUntil?: Date | null; version?: number; paused?: boolean | null }

export interface ResolveInput {
  workspace?: PolicyRow | null;
  team?: PolicyRow | null;
  project?: PolicyRow | null;
  /** Trust of the agent whose action is being judged; absent for a person or a system actor. */
  agentTrust?: AgentTrust | null;
  now?: Date;
}

export type LevelSource = 'default' | 'workspace' | 'team' | 'project' | 'agent_trust' | 'ceiling' | 'paused';

export interface ResolvedGate { decider: Decider; condition?: Predicate; from: 'preset' | 'workspace' | 'team' | 'project' | 'locked'; locked?: string }

export interface ResolvedAutonomy {
  level: AutonomyLevel;
  /** Why it is this level: what set it, before the ceiling and the agent's trust clamped it. */
  source: LevelSource;
  ceiling: AutonomyLevel;
  requested: AutonomyLevel;
  requestedBy: Exclude<LevelSource, 'agent_trust' | 'ceiling'>;
  agentTrust: AgentTrust | null;
  /** True while the chosen level is only being observed: deciders are reported as what they would be, nothing acts on them. */
  observing: boolean;
  /** The workspace switch is off: everything is L0 whatever the scopes say. */
  paused: boolean;
  gates: Record<Gate, ResolvedGate>;
  locked: string[];
}

const TRUST_LEVEL: Record<AgentTrust, AutonomyLevel> = { OBSERVE: 0, L1: 1, L2: 2, L3: 3 };

function clampLevel(value: number): AutonomyLevel {
  return Math.max(0, Math.min(3, Math.floor(value))) as AutonomyLevel;
}

/**
 * effective = min(ceiling, project ?? team, trust(agent)); each gate comes
 * from the most specific scope that defines it, then the workspace's locked
 * gates and the built-in locks are applied last (docs/autonomy-policy.md §6).
 */
export function resolveAutonomy(input: ResolveInput): ResolvedAutonomy {
  // Pause all autonomy (INV-1489): every scope reads as L0 until an Admin turns it back on.
  const paused = Boolean(input.workspace?.paused);
  const ceiling = paused ? 0 : clampLevel(input.workspace?.level ?? 0);
  const requestedRow = input.project ?? input.team ?? null;
  const requestedBy: ResolvedAutonomy['requestedBy'] = input.project ? 'project' : input.team ? 'team' : input.workspace ? 'workspace' : 'default';
  const requested = clampLevel(requestedRow?.level ?? 0);

  let level = requested;
  let source: LevelSource = requestedBy;
  if (ceiling < level) { level = ceiling; source = paused ? 'paused' : 'ceiling'; }
  if (input.agentTrust) {
    const trust = TRUST_LEVEL[input.agentTrust];
    if (trust < level) { level = trust; source = 'agent_trust'; }
  }

  const now = input.now ?? new Date();
  const observing = Boolean(requestedRow?.observeUntil && requestedRow.observeUntil > now);

  const gates = {} as Record<Gate, ResolvedGate>;
  for (const gate of GATES) {
    let resolved: ResolvedGate = { ...LEVEL_PRESETS[level][gate], from: 'preset' };
    // Scope overrides apply only within the effective level: a project cannot
    // loosen a gate the ceiling or the agent's trust closed.
    for (const [from, row] of [['workspace', input.workspace], ['team', input.team], ['project', input.project]] as const) {
      const rule = row?.gates?.[gate];
      if (!rule) continue;
      const presetAllowsAuto = LEVEL_PRESETS[level][gate].decider === 'auto';
      if (rule.decider === 'auto' && !presetAllowsAuto) continue;
      resolved = { ...rule, from };
    }
    gates[gate] = resolved;
  }

  const lockedIds = new Set<string>([...BUILT_IN_LOCKS.map((lock) => lock.id), ...(input.workspace?.locked ?? [])]);
  for (const lock of BUILT_IN_LOCKS) {
    const rule = gates[lock.gate];
    if (rule.decider !== 'auto') continue;
    // "auto unless the lock matches": AND the negation into the condition by
    // wrapping; evaluation treats a matched lock as human (see decide()).
    gates[lock.gate] = { ...rule, locked: rule.locked ? `${rule.locked},${lock.id}` : lock.id };
  }

  return { level, source, ceiling, requested, requestedBy, agentTrust: input.agentTrust ?? null, observing, paused, gates, locked: [...lockedIds] };
}

export interface Decision { decider: Decider; matched: boolean; reason: string }

/**
 * What a gate decides for one item: `auto` only when the gate is auto, its
 * condition matches, no lock matches and the policy is not merely observing.
 * Everything else is a person's decision, with the reason a Needs you row shows.
 */
export function decide(resolved: ResolvedAutonomy, gate: Gate, facts: AutonomyFacts): Decision {
  const rule = resolved.gates[gate];
  if (rule.decider === 'none') return { decider: 'none', matched: false, reason: `${gate} is not available at L${resolved.level}.` };
  if (rule.decider === 'human') return { decider: 'human', matched: false, reason: `${gate} waits for a person at L${resolved.level}.` };
  for (const lock of BUILT_IN_LOCKS) {
    if (lock.gate === gate && evaluatePredicate(lock.when, facts)) return { decider: 'human', matched: false, reason: `Locked: ${lock.reason}` };
  }
  const matched = rule.condition ? evaluatePredicate(rule.condition, facts) : true;
  if (!matched) return { decider: 'human', matched: false, reason: `Escalated: ${gate} condition not met.` };
  if (resolved.observing) return { decider: 'human', matched: true, reason: `Would be automatic under L${resolved.level} (observing).` };
  return { decider: 'auto', matched: true, reason: `Automatic under L${resolved.level}.` };
}

/** Audit actions written when policy changes or acts (OpsAudit.action / WorkAudit.reason prefix). */
export const POLICY_AUDIT = {
  changed: 'policy.changed',
  autoDecision: 'policy.auto_decision',
  override: 'policy.override',
} as const;

/** Human-readable summary of the facts a condition looked at, for "Would be handled under L2: type bug, priority 2". */
export function describeFacts(predicate: Predicate | undefined, facts: AutonomyFacts): string {
  if (!predicate) return '';
  const fields = new Set<ConditionField>();
  const walk = (node: Predicate) => {
    if ('all' in node) node.all.forEach(walk);
    else if ('any' in node) node.any.forEach(walk);
    else fields.add(node.field);
  };
  walk(predicate);
  return [...fields].filter((field) => facts[field] !== undefined && facts[field] !== null).map((field) => `${field} ${Array.isArray(facts[field]) ? (facts[field] as Scalar[]).join('/') : String(facts[field])}`).join(', ');
}
