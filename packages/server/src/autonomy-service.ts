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
  type AutonomyLevel, type Gate, type GateTable, type PolicyRow, type ResolvedAutonomy,
  GATES, LEVEL_DESCRIPTIONS, POLICY_AUDIT, isAutonomyLevel, resolveAutonomy, validateGateTable, validatePredicate,
} from './autonomy-policy.js';
import { createValidationError } from './errors.js';
import { recordOpsAudit } from './ops-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const POLICY_REASON_REQUIRED_MESSAGE = 'A policy change needs a reason (1–2000 characters) so the change history can say why.';
export const POLICY_LEVEL_INVALID_MESSAGE = 'Autonomy level must be 0, 1, 2 or 3 (docs/autonomy-policy.md §1).';
export const POLICY_SCOPE_INVALID_MESSAGE = 'A TEAM policy names a team; a PROJECT policy names a committed PROJECT work item.';
export const POLICY_LOCKED_WORKSPACE_ONLY_MESSAGE = 'Locked gates are set on the workspace policy only.';

export interface PolicyScopeRef { scope: AutonomyScope; scopeId: string }

function toPolicyRow(row: { level: number; gates: Prisma.JsonValue; locked: string[]; observeUntil: Date | null; version: number } | null | undefined): PolicyRow | null {
  if (!row) return null;
  const level = (isAutonomyLevel(row.level) ? row.level : 0) as AutonomyLevel;
  return { level, gates: (row.gates ?? {}) as GateTable, locked: row.locked, observeUntil: row.observeUntil, version: row.version };
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
  if (input.locked && input.locked.length && input.scope !== 'WORKSPACE') throw createValidationError(POLICY_LOCKED_WORKSPACE_ONLY_MESSAGE);
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
        createdById: byActorId,
      },
    });
    await recordOpsAudit(tx, {
      action: POLICY_AUDIT.changed,
      subject: `${input.scope.toLowerCase()}:${input.scopeId}`,
      byActorId,
      reason,
      details: { from: previous ? { level: previous.level, version: previous.version } : null, to: { level: created.level, version: created.version, observeUntil: observeUntil?.toISOString() ?? null } },
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
