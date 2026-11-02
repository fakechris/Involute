/**
 * Autonomy policy storage and lookup (INV-1488). The rules are in
 * autonomy-policy.ts; this file reads the active rows for a work item's
 * workspace, team and project plus the acting agent's trust, and writes new
 * policy versions with an OpsAudit row.
 *
 * Nothing here acts on a decision. Readers (GraphQL `Issue.autonomy`, MCP
 * `work_get_context`) show the resolved level so people and agents can see
 * what a later step will do; the gates themselves open in INV-1491 / 1492 / 1493.
 */
import { Prisma, type AgentTrustLevel, type AutonomyScope, type PrismaClient } from '@prisma/client';

import {
  type AutonomyFacts, type AutonomyLevel, type Gate, type GateTable, type PolicyRow, type ResolvedAutonomy,
  BUILT_IN_LOCKS, CONDITION_FIELDS, GATES, attrFieldsIn, LEVEL_DESCRIPTIONS, LEVEL_PRESETS, POLICY_AUDIT, decide, describeFacts, isAutonomyLevel, resolveAutonomy, validateGateTable, validatePredicate,
} from './autonomy-policy.js';
import { amendmentChanges } from './contract-amendment.js';
import { isTypeLabel } from './labels.js';
import { createValidationError } from './errors.js';
import { recordOpsAudit } from './ops-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const POLICY_REASON_REQUIRED_MESSAGE = 'A policy change needs a reason (1–2000 characters) so the change history can say why.';
export const POLICY_LEVEL_INVALID_MESSAGE = 'Autonomy level must be 0, 1, 2 or 3 (docs/autonomy-policy.md §1).';
export const POLICY_SCOPE_INVALID_MESSAGE = 'A TEAM policy names a team; a PROJECT policy names a committed PROJECT work item.';
export const POLICY_LOCKED_WORKSPACE_ONLY_MESSAGE = 'Locked gates are set on the workspace policy only.';

export interface PolicyScopeRef { scope: AutonomyScope; scopeId: string }

function toPolicyRow(row: { level: number; gates: Prisma.JsonValue; locked: string[]; observeUntil: Date | null; version: number; paused?: boolean } | null | undefined): PolicyRow | null {
  if (!row) return null;
  const level = (isAutonomyLevel(row.level) ? row.level : 0) as AutonomyLevel;
  return { level, gates: (row.gates ?? {}) as GateTable, locked: row.locked, observeUntil: row.observeUntil, version: row.version, paused: row.paused ?? false };
}

/** The active policy row for one scope, or null when none was ever set. */
export async function readActivePolicy(prisma: DatabaseClient, ref: PolicyScopeRef) {
  return prisma.workflowPolicy.findFirst({ where: { scope: ref.scope, scopeId: ref.scopeId, active: true }, orderBy: { version: 'desc' } });
}

/** The nearest PROJECT ancestor by CONTAINS parent chain; null when the item hangs under no project. */
export async function findProjectIdFor(prisma: DatabaseClient, issue: { id: string; kind: string; parentId: string | null }): Promise<string | null> {
  if (issue.kind === 'PROJECT') return issue.id;
  let parentId = issue.parentId;
  for (let depth = 0; parentId && depth < 32; depth += 1) {
    const parent: { id: string; kind: string; parentId: string | null } | null = await prisma.issue.findUnique({ where: { id: parentId }, select: { id: true, kind: true, parentId: true } });
    if (!parent) return null;
    if (parent.kind === 'PROJECT') return parent.id;
    parentId = parent.parentId;
  }
  return null;
}

export interface AutonomyView extends ResolvedAutonomy {
  projectId: string | null;
  versions: { workspace: number | null; team: number | null; project: number | null };
}

/**
 * The resolved autonomy for a work item, as seen by an optional acting agent.
 * The same object is returned by GraphQL `Issue.autonomy` and MCP
 * `work_get_context` (parity, INV-1004).
 */
export async function loadAutonomyFor(
  prisma: DatabaseClient,
  issue: { id: string; teamId: string; kind: string; parentId: string | null },
  actor?: { id: string; actorKind: string } | null,
  now = new Date(),
): Promise<AutonomyView> {
  const projectId = await findProjectIdFor(prisma, issue);
  const [workspace, team, project, trust] = await Promise.all([
    readActivePolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID }),
    readActivePolicy(prisma, { scope: 'TEAM', scopeId: issue.teamId }),
    projectId ? readActivePolicy(prisma, { scope: 'PROJECT', scopeId: projectId }) : Promise.resolve(null),
    actor?.actorKind === 'AGENT' ? prisma.agentTrust.findUnique({ where: { actorId: actor.id } }) : Promise.resolve(null),
  ]);
  // An agent with no trust row is a new agent: it observes (docs/autonomy-policy.md §2.4).
  const agentTrust: AgentTrustLevel | null = actor?.actorKind === 'AGENT' ? (trust?.level ?? 'OBSERVE') : null;
  const resolved = resolveAutonomy({ workspace: toPolicyRow(workspace), team: toPolicyRow(team), project: toPolicyRow(project), agentTrust, now });
  return { ...resolved, projectId, versions: { workspace: workspace?.version ?? null, team: team?.version ?? null, project: project?.version ?? null } };
}

export interface SetPolicyInput extends PolicyScopeRef {
  level: number;
  gates?: unknown;
  intake?: unknown;
  locked?: string[] | null;
  reason: string | null | undefined;
  /** Days to only observe before the level acts; null or 0 turns it on at once (decision INV-1486: optional). */
  observeDays?: number | null;
  /** WORKSPACE only (INV-1489). Omitted fields keep the previous version's value. */
  paused?: boolean | null;
  defaultLevel?: number | null;
  templates?: unknown;
  /** WORKSPACE only (INV-1493): the L3 completion reply template; null keeps the previous, '' restores the default. */
  completionReply?: string | null;
}

export interface AutonomyTemplate { name: string; level: AutonomyLevel; gates?: GateTable }

/** The three presets a workspace starts with (docs/autonomy-policy.md §2.1). */
export const DEFAULT_TEMPLATES: AutonomyTemplate[] = [
  { name: 'Low-risk pass-through', level: 1 },
  { name: 'Bugs on autopilot', level: 2, gates: autoAcceptBugsGates() },
  { name: 'Hands-off', level: 3 },
];

export const POLICY_WORKSPACE_ONLY_MESSAGE = 'Pause, default level and templates are set on the workspace policy only.';

function validateTemplates(value: unknown): AutonomyTemplate[] {
  if (value === undefined || value === null) return DEFAULT_TEMPLATES;
  if (!Array.isArray(value) || value.length > 20) throw createValidationError('Invalid policy: templates must be a list of at most 20.');
  return value.map((entry, index) => {
    const template = entry as Partial<AutonomyTemplate>;
    if (!template || typeof template.name !== 'string' || !template.name.trim() || template.name.length > 60) throw createValidationError(`Invalid policy: templates[${index}].name`);
    if (!isAutonomyLevel(template.level)) throw createValidationError(`Invalid policy: templates[${index}].level must be 0–3`);
    const problems = validateGateTable(template.gates);
    if (problems.length) throw createValidationError(`Invalid policy: templates[${index}] ${problems.join('; ')}`);
    return { name: template.name.trim(), level: template.level, ...(template.gates ? { gates: template.gates as GateTable } : {}) };
  });
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (!trimmed || trimmed.length > 2_000) throw createValidationError(POLICY_REASON_REQUIRED_MESSAGE);
  return trimmed;
}

/**
 * Writes a new active version for the scope and deactivates the previous
 * one; the history stays. Permission is the caller's job (workspace: Admin;
 * team / project: team Owner or Admin). Audited as OpsAudit `policy.changed`.
 */
export async function setWorkflowPolicy(prisma: PrismaClient, input: SetPolicyInput, byActorId: string | null) {
  if (!isAutonomyLevel(input.level)) throw createValidationError(POLICY_LEVEL_INVALID_MESSAGE);
  const reason = requireReason(input.reason);
  const problems = [...validateGateTable(input.gates), ...(input.intake === undefined || input.intake === null ? [] : validatePredicate(input.intake, 'intake'))];
  if (problems.length) throw createValidationError(`Invalid policy: ${problems.join('; ')}`);
  // attr.<key> conditions name searchable fields the scope can see (INV-1505).
  const attrFields = [...new Set([...attrFieldsIn(input.gates), ...attrFieldsIn(input.intake)])];
  if (attrFields.length) {
    const allowed = new Set(await searchableAttrFields(prisma, input));
    const unknown = attrFields.filter((field) => !allowed.has(field));
    if (unknown.length) throw createValidationError(`Invalid policy: ${unknown.join(', ')} ${unknown.length > 1 ? 'are not searchable fields' : 'is not a searchable field'} of this scope; mark the field searchable in Fields settings first.`);
  }
  if (input.locked && input.locked.length && input.scope !== 'WORKSPACE') throw createValidationError(POLICY_LOCKED_WORKSPACE_ONLY_MESSAGE);
  if (input.scope !== 'WORKSPACE' && (input.paused !== undefined && input.paused !== null || input.defaultLevel !== undefined && input.defaultLevel !== null || input.templates !== undefined && input.templates !== null || input.completionReply !== undefined && input.completionReply !== null)) throw createValidationError(POLICY_WORKSPACE_ONLY_MESSAGE);
  if (typeof input.completionReply === 'string' && input.completionReply.length > 4_000) throw createValidationError('Invalid policy: completionReply is at most 4000 characters.');
  if (input.defaultLevel !== undefined && input.defaultLevel !== null && !isAutonomyLevel(input.defaultLevel)) throw createValidationError(POLICY_LEVEL_INVALID_MESSAGE);
  if (input.locked?.some((id) => !GATES.includes(id as Gate) && !BUILT_IN_LOCKS.some((lock) => lock.id === id))) throw createValidationError('Invalid policy: locked names a gate or a built-in lock id.');
  if (input.scope === 'WORKSPACE' && input.scopeId !== WORKSPACE_SETTINGS_ID) throw createValidationError(POLICY_SCOPE_INVALID_MESSAGE);
  if (input.scope === 'TEAM' && !(await prisma.team.findUnique({ where: { id: input.scopeId }, select: { id: true } }))) throw createValidationError(POLICY_SCOPE_INVALID_MESSAGE);
  if (input.scope === 'PROJECT') {
    const project = await prisma.issue.findUnique({ where: { id: input.scopeId }, select: { kind: true, commitmentStatus: true } });
    if (!project || project.kind !== 'PROJECT' || project.commitmentStatus !== 'COMMITTED') throw createValidationError(POLICY_SCOPE_INVALID_MESSAGE);
  }
  const observeUntil = input.observeDays && input.observeDays > 0 ? new Date(Date.now() + input.observeDays * 86_400_000) : null;

  return prisma.$transaction(async (tx) => {
    const previous = await readActivePolicy(tx, input);
    if (previous) await tx.workflowPolicy.update({ where: { id: previous.id }, data: { active: false } });
    const created = await tx.workflowPolicy.create({
      data: {
        scope: input.scope,
        scopeId: input.scopeId,
        level: input.level,
        gates: (input.gates ?? {}) as Prisma.InputJsonValue,
        intake: input.intake === undefined || input.intake === null ? Prisma.JsonNull : (input.intake as Prisma.InputJsonValue),
        locked: input.scope === 'WORKSPACE' ? input.locked ?? previous?.locked ?? [] : [],
        version: (previous?.version ?? 0) + 1,
        reason,
        observeUntil,
        paused: input.scope === 'WORKSPACE' ? input.paused ?? previous?.paused ?? false : false,
        defaultLevel: input.scope === 'WORKSPACE' ? input.defaultLevel ?? previous?.defaultLevel ?? 0 : 0,
        templates: (input.scope === 'WORKSPACE' ? (input.templates === undefined || input.templates === null ? (previous?.templates ?? DEFAULT_TEMPLATES) : validateTemplates(input.templates)) : []) as Prisma.InputJsonValue,
        completionReply: input.scope === 'WORKSPACE' ? (input.completionReply === undefined || input.completionReply === null ? previous?.completionReply ?? null : (input.completionReply.trim() || null)) : null,
        createdById: byActorId,
      },
    });
    await recordOpsAudit(tx, {
      action: POLICY_AUDIT.changed,
      subject: `${input.scope.toLowerCase()}:${input.scopeId}`,
      byActorId,
      reason,
      details: { from: previous ? { level: previous.level, version: previous.version, paused: previous.paused } : null, to: { level: created.level, version: created.version, observeUntil: observeUntil?.toISOString() ?? null, paused: created.paused } },
    });
    return created;
  });
}

/** The L2 / Type Bug override that `autoAcceptBugs` maps onto until the setting moves to the policy page (INV-1489). */
export function autoAcceptBugsGates(): GateTable {
  return {
    review_accept: { decider: 'auto', condition: { all: [
      { field: 'type', in: ['bug'] },
      { field: 'auto_accept_grade', eq: 'CLEAR' },
      { field: 'pr_merged', eq: true },
      { field: 'checks', eq: 'green' },
      { field: 'reproducibility', not_in: ['SOMETIMES', 'ONCE'] },
      { field: 'severity', not_in: ['SEV1', 'SEV2'] },
    ] } },
  };
}

/**
 * Keeps the project policy in step with `PROJECT.autoAcceptBugs` (INV-1075):
 * on → an L2 override limited to bugs; off → back to inheriting the team.
 * Called inside the issue update transaction; it writes nothing when the
 * stored state already agrees.
 */
export async function syncAutoAcceptBugsPolicy(tx: DatabaseClient, projectId: string, on: boolean, byActorId: string | null): Promise<void> {
  const previous = await readActivePolicy(tx, { scope: 'PROJECT', scopeId: projectId });
  const alreadyOn = previous?.level === 2 && Boolean((previous.gates as GateTable | null)?.review_accept);
  if (on === alreadyOn) return;
  if (previous) await tx.workflowPolicy.update({ where: { id: previous.id }, data: { active: false } });
  const reason = on ? 'Auto-accept verified bug fixes turned on (INV-1075)' : 'Auto-accept verified bug fixes turned off (INV-1075)';
  if (on) {
    await tx.workflowPolicy.create({ data: { scope: 'PROJECT', scopeId: projectId, level: 2, gates: autoAcceptBugsGates() as Prisma.InputJsonValue, version: (previous?.version ?? 0) + 1, reason, createdById: byActorId } });
  }
  await recordOpsAudit(tx, { action: POLICY_AUDIT.changed, subject: `project:${projectId}`, byActorId, reason, details: { autoAcceptBugs: on } });
}

export { GATES };
export type { Gate };

/** The GraphQL shape of a resolved autonomy; MCP work_get_context returns the same object (INV-1488). */
export function autonomyToGraphQL(view: AutonomyView) {
  const description = LEVEL_DESCRIPTIONS[view.level];
  return {
    level: view.level,
    source: view.source,
    name: description.name,
    descriptionEn: description.en,
    descriptionZh: description.zh,
    ceiling: view.ceiling,
    requested: view.requested,
    requestedBy: view.requestedBy,
    observing: view.observing,
    gates: (Object.keys(view.gates) as Gate[]).map((gate) => ({ gate, decider: view.gates[gate].decider, condition: view.gates[gate].condition ?? null, from: view.gates[gate].from, locked: view.gates[gate].locked ?? null })),
    locked: view.locked,
    projectId: view.projectId,
  };
}

/** Removes a TEAM or PROJECT override so the scope inherits again; the history stays (INV-1489). */
export async function clearWorkflowPolicy(prisma: PrismaClient, ref: PolicyScopeRef, reason: string | null | undefined, byActorId: string | null): Promise<boolean> {
  if (ref.scope === 'WORKSPACE') throw createValidationError('The workspace policy is edited, not cleared; set its level to 0 instead.');
  const trimmed = requireReason(reason);
  return prisma.$transaction(async (tx) => {
    const previous = await readActivePolicy(tx, ref);
    if (!previous) return false;
    await tx.workflowPolicy.update({ where: { id: previous.id }, data: { active: false } });
    await recordOpsAudit(tx, { action: POLICY_AUDIT.changed, subject: `${ref.scope.toLowerCase()}:${ref.scopeId}`, byActorId, reason: trimmed, details: { from: { level: previous.level, version: previous.version }, to: null } });
    return true;
  });
}

export interface AutonomySettingsView {
  scope: AutonomyScope;
  scopeId: string;
  active: Awaited<ReturnType<typeof readActivePolicy>>;
  history: NonNullable<Awaited<ReturnType<typeof readActivePolicy>>>[];
  ceiling: AutonomyLevel;
  paused: boolean;
  defaultLevel: AutonomyLevel;
  templates: AutonomyTemplate[];
  completionReply: string | null;
  levels: Array<{ level: AutonomyLevel; name: string; descriptionEn: string; descriptionZh: string; gates: Array<{ gate: Gate; decider: string }> }>;
  builtInLocks: Array<{ id: string; gate: Gate; reason: string }>;
  gates: Gate[];
  conditionFields: string[];
}

/** What a settings page needs for one scope: its active row and history, the workspace frame, and the level catalogue. */
export async function readAutonomySettings(prisma: DatabaseClient, ref: PolicyScopeRef): Promise<AutonomySettingsView> {
  const [active, history, workspace] = await Promise.all([
    readActivePolicy(prisma, ref),
    prisma.workflowPolicy.findMany({ where: { scope: ref.scope, scopeId: ref.scopeId }, orderBy: { version: 'desc' }, take: 50 }),
    ref.scope === 'WORKSPACE' ? Promise.resolve(null) : readActivePolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID }),
  ]);
  const frame = ref.scope === 'WORKSPACE' ? active : workspace;
  const level = (value: number | null | undefined): AutonomyLevel => (isAutonomyLevel(value) ? value : 0);
  return {
    scope: ref.scope,
    scopeId: ref.scopeId,
    active,
    history,
    ceiling: frame?.paused ? 0 : level(frame?.level),
    paused: frame?.paused ?? false,
    defaultLevel: level(frame?.defaultLevel),
    templates: (Array.isArray(frame?.templates) ? (frame!.templates as unknown as AutonomyTemplate[]) : DEFAULT_TEMPLATES),
    completionReply: frame?.completionReply ?? null,
    levels: ([0, 1, 2, 3] as const).map((value) => ({ level: value, name: LEVEL_DESCRIPTIONS[value].name, descriptionEn: LEVEL_DESCRIPTIONS[value].en, descriptionZh: LEVEL_DESCRIPTIONS[value].zh, gates: GATES.map((gate) => ({ gate, decider: LEVEL_PRESETS[value][gate].decider })) })),
    builtInLocks: BUILT_IN_LOCKS.map((lock) => ({ id: lock.id, gate: lock.gate, reason: lock.reason })),
    gates: [...GATES],
    conditionFields: [...CONDITION_FIELDS, ...(await searchableAttrFields(prisma, ref))],
  };
}

/**
 * The `attr.<key>` condition fields a scope's policy may name (INV-1505): keys
 * of active searchable field definitions in the workspace, and for a team or
 * project also in that team and its projects.
 */
export async function searchableAttrFields(prisma: DatabaseClient, ref: PolicyScopeRef): Promise<string[]> {
  let teamId: string | null = null;
  if (ref.scope === 'TEAM') teamId = ref.scopeId;
  if (ref.scope === 'PROJECT') teamId = (await prisma.issue.findUnique({ where: { id: ref.scopeId }, select: { teamId: true } }))?.teamId ?? null;
  const projectIds = teamId ? (await prisma.issue.findMany({ where: { teamId, kind: 'PROJECT' }, select: { id: true } })).map((row) => row.id) : [];
  const rows = await prisma.fieldDefinition.findMany({
    where: {
      active: true,
      searchable: true,
      OR: [
        { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID },
        ...(teamId ? [{ scope: 'TEAM' as const, scopeId: teamId }, { scope: 'PROJECT' as const, scopeId: { in: projectIds } }] : []),
      ],
    },
    select: { key: true },
  });
  return [...new Set(rows.map((row) => `attr.${row.key}`))].sort();
}

type FactsWork = { id: string; priority: number; severity: string | null; reproducibility: string | null; source: string | null; description: string | null; acceptance: string | null; labels?: Array<{ name: string }>; attributes?: Prisma.JsonValue };

/** The structured facts a condition may look at, read from the stored item (docs/autonomy-policy.md §3). */
export async function factsForWork(prisma: DatabaseClient, work: FactsWork): Promise<AutonomyFacts> {
  const labels = work.labels ?? (await prisma.issue.findUnique({ where: { id: work.id }, select: { labels: { select: { name: true } } } }))?.labels ?? [];
  const names = labels.map((entry) => entry.name);
  const type = names.find((name) => isTypeLabel(name))?.toLowerCase() ?? null;
  const evaluation = await prisma.workAutoAcceptEvaluation.findFirst({ where: { workId: work.id }, orderBy: { createdAt: 'desc' }, select: { tier: true, signals: true } });
  const signals = (evaluation?.signals ?? {}) as Record<string, unknown>;
  const facts: AutonomyFacts = {
    type,
    labels: names.map((name) => name.toLowerCase()),
    priority: work.priority,
    severity: work.severity,
    reproducibility: work.reproducibility,
    source: work.source,
    has_steps: /steps to reproduce|复现步骤/i.test(work.description ?? ''),
    has_acceptance: Boolean(work.acceptance?.trim()),
  };
  if (evaluation) facts.auto_accept_grade = evaluation.tier;
  if (typeof signals.merged === 'boolean') facts.pr_merged = signals.merged;
  if (typeof signals.checks === 'string') facts.checks = signals.checks;
  // Field values as attr.<key> facts (INV-1505).
  const attributes = work.attributes !== undefined ? work.attributes : (await prisma.issue.findUnique({ where: { id: work.id }, select: { attributes: true } }))?.attributes;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') facts[`attr.${key}`] = value;
      else if (Array.isArray(value)) facts[`attr.${key}`] = value.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return facts;
}

/**
 * For a Needs you row while its scope is observing: what the chosen level
 * would have done, or null when nothing would change (INV-1489). Only a label;
 * the decision stays with the person.
 */
export async function observeLabelFor(
  prisma: DatabaseClient,
  item: { kind: string; subjectId: string; workId: string | null },
): Promise<string | null> {
  if (!item.workId) return null;
  const gate: Gate | null = item.kind === 'CANDIDATE_COMMIT' ? 'candidate_commit' : item.kind === 'CONTRACT_AMENDMENT' ? 'contract_amendment' : item.kind === 'WORK_REVIEW' ? 'review_accept' : null;
  if (!gate) return null;
  const work = await prisma.issue.findUnique({ where: { id: item.workId }, include: { labels: { select: { name: true } } } });
  if (!work) return null;
  const resolved = await loadAutonomyFor(prisma, work);
  const facts = await factsForWork(prisma, work);
  if (gate === 'contract_amendment') {
    const amendment = await prisma.contractAmendment.findUnique({ where: { id: item.subjectId } });
    if (!amendment) return null;
    facts.amendment_fields = amendmentChanges(amendment).map((change) => change.field);
  }
  const decision = decide(resolved, gate, facts);
  if (resolved.observing) {
    if (!decision.matched) return null;
    const summary = describeFacts(resolved.gates[gate].condition, facts);
    return `Would be handled under L${resolved.requested}${summary ? `: ${summary}` : ''}`;
  }
  // Live policy with an auto gate that did not act: say why it is still a person's decision (INV-1491).
  // A matched gate that did not act (a person proposed it, or the commit was refused) says nothing here: the gate acts at proposal time and its refusal is on the timeline.
  if (resolved.gates[gate].decider === 'auto' && !decision.matched) return decision.reason;
  return null;
}
