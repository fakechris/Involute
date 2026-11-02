/**
 * Field definitions (INV-1503, decision INV-1501, docs/field-definitions.md).
 *
 * A work-item field that is configuration instead of a column. Definitions are
 * scoped to the workspace, a team or a PROJECT and apply to a Kind × Type; the
 * values live in `Issue.attributes`. Every write path calls `applyAttributes`,
 * which runs the one validator (`validateAttributes`) and checks references.
 *
 * System fields (priority, severity, the contract, incident times…) stay
 * columns; nothing here touches them.
 */
import { Prisma, type AutonomyScope, type FieldDefinition, type FieldIndexJob, type FieldType, type PrismaClient, type WorkKind } from '@prisma/client';

import { findProjectIdFor } from './autonomy-service.js';
import { createValidationError } from './errors.js';
import { isTypeLabel } from './labels.js';
import { recordOpsAudit } from './ops-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const FIELD_TYPES: readonly FieldType[] = ['TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'ENUM', 'MULTI_ENUM', 'WORK_REF', 'USER_REF', 'URL'];
export const WORK_KINDS: readonly WorkKind[] = ['PROJECT', 'MILESTONE', 'EPIC', 'ISSUE', 'DECISION'];
export const FIELD_TYPE_NAMES = ['bug', 'feature', 'improvement', 'research', 'incident'] as const;

/** Governance limits (docs/field-definitions.md §7). Raising one is a decision, not a setting. */
export const FIELD_LIMITS = {
  activePerScope: 30,
  enumOptions: 50,
  textLength: 2_000,
  multiEnumValues: 50,
} as const;

export const FIELD_AUDIT = { changed: 'field.changed' } as const;
export const FIELD_REASON_REQUIRED_MESSAGE = 'A field definition change needs a reason (1–2000 characters) so the change history can say why.';
export const FIELD_SCOPE_INVALID_MESSAGE = 'A TEAM field names a team; a PROJECT field names a committed PROJECT work item; a WORKSPACE field uses the workspace id.';
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

export interface FieldOption { value: string; label: string; archived?: boolean }
export interface AppliesTo { kinds: WorkKind[]; types: string[] | 'any' }

/** The item a set of definitions is resolved for. `typeName` is the Type label in lower case, or null. */
export interface FieldSubject {
  id?: string | null;
  teamId: string;
  kind: WorkKind;
  parentId: string | null;
  typeName: string | null;
}

export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue>;
export type AttributesInput = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Pure: definitions and values
// ---------------------------------------------------------------------------

export function readAppliesTo(value: Prisma.JsonValue | unknown): AppliesTo {
  const raw = (value ?? {}) as { kinds?: unknown; types?: unknown };
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter((kind): kind is WorkKind => WORK_KINDS.includes(kind as WorkKind)) : [];
  const types = raw.types === 'any' || raw.types === undefined ? 'any' : Array.isArray(raw.types) ? raw.types.map((type) => String(type).toLowerCase()) : 'any';
  return { kinds, types };
}

export function readOptions(value: Prisma.JsonValue | unknown): FieldOption[] {
  return Array.isArray(value) ? (value as FieldOption[]) : [];
}

/** Does this definition apply to an item of this Kind and Type? */
export function definitionApplies(definition: Pick<FieldDefinition, 'appliesTo'>, subject: Pick<FieldSubject, 'kind' | 'typeName'>): boolean {
  const appliesTo = readAppliesTo(definition.appliesTo);
  if (!appliesTo.kinds.includes(subject.kind)) return false;
  if (appliesTo.types === 'any') return true;
  return subject.typeName !== null && appliesTo.types.includes(subject.typeName);
}

/** Nearest scope wins on a key clash: project, then team, then workspace. */
export function mergeByScope(layers: { project: FieldDefinition[]; team: FieldDefinition[]; workspace: FieldDefinition[] }): FieldDefinition[] {
  const byKey = new Map<string, FieldDefinition>();
  for (const definition of [...layers.workspace, ...layers.team, ...layers.project]) byKey.set(definition.key, definition);
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export interface ValidationResult {
  /** The full attributes to store after merging the input onto the existing values. */
  attributes: Attributes;
  /** Keys this write changed (set or cleared). */
  changed: string[];
  /** Required fields that are still empty on a candidate (a warning, not a refusal). */
  missingRequired: string[];
  /** The applicable definitions the write was checked against (for the index and usage). */
  definitions: FieldDefinition[];
  /** References the caller must check against the database. */
  refs: { work: Array<{ key: string; value: string }>; user: Array<{ key: string; value: string }> };
}

function refuse(key: string, rule: string): never {
  throw createValidationError(`Field "${key}": ${rule}`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normaliseValue(definition: FieldDefinition, value: unknown): AttributeValue {
  const key = definition.key;
  switch (definition.type) {
    case 'TEXT': {
      if (typeof value !== 'string') refuse(key, 'expects text.');
      if (value.length > FIELD_LIMITS.textLength) refuse(key, `is at most ${FIELD_LIMITS.textLength} characters.`);
      return value;
    }
    case 'NUMBER': {
      if (typeof value !== 'number' || !Number.isFinite(value)) refuse(key, 'expects a finite number.');
      return value;
    }
    case 'BOOLEAN': {
      if (typeof value !== 'boolean') refuse(key, 'expects true or false.');
      return value;
    }
    case 'DATE': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) refuse(key, 'expects an ISO date or date-time.');
      return new Date(value).toISOString();
    }
    case 'ENUM': {
      if (typeof value !== 'string') refuse(key, 'expects one option value.');
      assertOption(definition, value);
      return value;
    }
    case 'MULTI_ENUM': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) refuse(key, 'expects a list of option values.');
      const unique = [...new Set(value as string[])];
      if (unique.length > FIELD_LIMITS.multiEnumValues) refuse(key, `takes at most ${FIELD_LIMITS.multiEnumValues} values.`);
      for (const entry of unique) assertOption(definition, entry);
      return unique;
    }
    case 'WORK_REF': {
      if (typeof value !== 'string' || !value.trim()) refuse(key, 'expects a work identifier or id.');
      return value.trim();
    }
    case 'USER_REF': {
      if (typeof value !== 'string' || !isUuid(value)) refuse(key, 'expects a user id.');
      return value;
    }
    case 'URL': {
      if (typeof value !== 'string' || value.length > FIELD_LIMITS.textLength) refuse(key, `expects an http(s) URL of at most ${FIELD_LIMITS.textLength} characters.`);
      let parsed: URL;
      try { parsed = new URL(value); } catch { refuse(key, 'expects an http(s) URL.'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') refuse(key, 'expects an http(s) URL.');
      return value;
    }
    default:
      return refuse(key, `has an unknown type ${String(definition.type)}.`);
  }
}

function assertOption(definition: FieldDefinition, value: string): void {
  const option = readOptions(definition.options).find((entry) => entry.value === value);
  if (!option) refuse(definition.key, `"${value}" is not one of its options (${readOptions(definition.options).filter((entry) => !entry.archived).map((entry) => entry.value).join(', ')}).`);
  if (option.archived) refuse(definition.key, `option "${value}" is archived.`);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * The one validator (docs/field-definitions.md §4). `definitions` are the
 * applicable, active definitions for the item; `existing` its stored values;
 * `input` a partial update where `null` clears a key. In `committed` mode a
 * required field left empty is refused; in `candidate` mode it is reported.
 * Defaults fill required fields that were never set.
 */
export function validateAttributes(
  definitions: FieldDefinition[],
  existing: Attributes,
  input: AttributesInput | null | undefined,
  mode: 'candidate' | 'committed',
): ValidationResult {
  if (input !== null && input !== undefined && (typeof input !== 'object' || Array.isArray(input))) {
    throw createValidationError('attributes must be an object of { key: value }.');
  }
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  // A renamed field still accepts its previous key for one version (INV-1504).
  const byPreviousKey = new Map(definitions.filter((definition) => definition.previousKey).map((definition) => [definition.previousKey!, definition]));
  const next: Attributes = { ...existing };
  const changed: string[] = [];
  const refs: ValidationResult['refs'] = { work: [], user: [] };
  for (const [givenKey, value] of Object.entries(input ?? {})) {
    const definition = byKey.get(givenKey) ?? byPreviousKey.get(givenKey);
    const key = definition?.key ?? givenKey;
    if (!definition) throw createValidationError(`Field "${key}" is not defined for this item (see work_catalog(kind: 'fields') or Issue.fieldDefinitions).`);
    if (value === null) {
      if (key in next) { delete next[key]; changed.push(key); }
      continue;
    }
    const normalised = normaliseValue(definition, value);
    if (definition.type === 'WORK_REF') refs.work.push({ key, value: normalised as string });
    if (definition.type === 'USER_REF') refs.user.push({ key, value: normalised as string });
    next[key] = normalised;
    changed.push(key);
  }
  const missingRequired: string[] = [];
  for (const definition of definitions) {
    if (!definition.required || !isEmpty(next[definition.key])) continue;
    if (!isEmpty(definition.defaultValue)) {
      next[definition.key] = normaliseValue(definition, definition.defaultValue);
      changed.push(definition.key);
      continue;
    }
    missingRequired.push(definition.key);
  }
  if (mode === 'committed' && missingRequired.length) {
    const labels = missingRequired.map((key) => `"${byKey.get(key)?.label ?? key}" (${key})`).join(', ');
    throw createValidationError(`Fill the required field${missingRequired.length > 1 ? 's' : ''} ${labels} before this work is committed.`);
  }
  return { attributes: next, changed: [...new Set(changed)], missingRequired, refs, definitions };
}

// ---------------------------------------------------------------------------
// Database: resolution, references, writes
// ---------------------------------------------------------------------------

export async function readActiveDefinitions(prisma: DatabaseClient, scope: AutonomyScope, scopeId: string): Promise<FieldDefinition[]> {
  return prisma.fieldDefinition.findMany({ where: { scope, scopeId, active: true }, orderBy: { key: 'asc' } });
}

/** The Type label of an item, lower case, or null. */
export async function typeNameOf(prisma: DatabaseClient, workId: string): Promise<string | null> {
  const labels = await prisma.issueLabel.findMany({ where: { issues: { some: { id: workId } } }, select: { name: true } });
  return typeNameFromLabels(labels.map((label) => label.name));
}

export function typeNameFromLabels(names: readonly string[]): string | null {
  const type = names.find((name) => isTypeLabel(name));
  return type ? type.toLowerCase() : null;
}

/**
 * The active definitions an item sees, before the Kind × Type filter:
 * project → team → workspace, nearest wins on a key clash. Not cached: it is
 * three indexed lookups, and a cache would have to be invalidated across
 * processes.
 */
export async function resolveScopedDefinitions(prisma: DatabaseClient, subject: Pick<FieldSubject, 'id' | 'teamId' | 'kind' | 'parentId'>): Promise<FieldDefinition[]> {
  const projectId = subject.id || subject.parentId
    ? await findProjectIdFor(prisma, { id: subject.id ?? '', kind: subject.id ? subject.kind : 'ISSUE', parentId: subject.parentId })
    : null;
  const [workspace, team, project] = await Promise.all([
    readActiveDefinitions(prisma, 'WORKSPACE', WORKSPACE_SETTINGS_ID),
    readActiveDefinitions(prisma, 'TEAM', subject.teamId),
    projectId ? readActiveDefinitions(prisma, 'PROJECT', projectId) : Promise.resolve([]),
  ]);
  return mergeByScope({ workspace, team, project });
}

/** The applicable, active definitions for an item (GraphQL `Issue.fieldDefinitions`, MCP `field_definitions`). */
export async function resolveDefinitionsFor(prisma: DatabaseClient, subject: FieldSubject): Promise<FieldDefinition[]> {
  return (await resolveScopedDefinitions(prisma, subject)).filter((definition) => definitionApplies(definition, subject));
}

export function readAttributes(value: Prisma.JsonValue | null | undefined): Attributes {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Attributes) : {};
}

async function resolveRefs(prisma: DatabaseClient, teamId: string, refs: ValidationResult['refs'], attributes: Attributes): Promise<void> {
  for (const { key, value } of refs.work) {
    const target = await prisma.issue.findFirst({
      where: isUuid(value) ? { id: value } : { identifier: value.toUpperCase() },
      select: { id: true, teamId: true },
    });
    if (!target) refuse(key, `work "${value}" was not found.`);
    if (target.teamId !== teamId) refuse(key, 'must reference work on the same team.');
    attributes[key] = target.id;
  }
  for (const { key, value } of refs.user) {
    const member = await prisma.teamMembership.findFirst({ where: { teamId, userId: value }, select: { userId: true } });
    if (!member) refuse(key, 'must name a member of the team.');
  }
}

/**
 * Validate and merge an attributes write for an item. Returns null when the
 * item has nothing to change (no input and no default to fill).
 */
export async function applyAttributes(
  prisma: DatabaseClient,
  subject: FieldSubject & { existing?: Prisma.JsonValue | null },
  input: AttributesInput | null | undefined,
  mode: 'candidate' | 'committed',
): Promise<ValidationResult> {
  const definitions = await resolveDefinitionsFor(prisma, subject);
  const result = validateAttributes(definitions, readAttributes(subject.existing), input, mode);
  await resolveRefs(prisma, subject.teamId, result.refs, result.attributes);
  return result;
}

export interface SetFieldDefinitionInput {
  scope: AutonomyScope;
  scopeId: string;
  key: string;
  label: string;
  description?: string | null;
  type: FieldType;
  options?: FieldOption[] | null;
  appliesTo: AppliesTo | { kinds: string[]; types?: string[] | 'any' | null };
  required?: boolean | null;
  defaultValue?: unknown;
  searchable?: boolean | null;
  reason: string;
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (!trimmed || trimmed.length > 2_000) throw createValidationError(FIELD_REASON_REQUIRED_MESSAGE);
  return trimmed;
}

function validateDefinitionShape(input: SetFieldDefinitionInput): { appliesTo: AppliesTo; options: FieldOption[] | null } {
  if (!KEY_PATTERN.test(input.key)) throw createValidationError('A field key is snake_case: a lower-case letter, then 1–39 letters, digits or underscores.');
  if (!input.label?.trim() || input.label.length > 80) throw createValidationError('A field label is 1–80 characters.');
  if (!FIELD_TYPES.includes(input.type)) throw createValidationError(`A field type is one of ${FIELD_TYPES.join(', ')}.`);
  const kinds = input.appliesTo?.kinds ?? [];
  if (!kinds.length || kinds.some((kind) => !WORK_KINDS.includes(kind as WorkKind))) throw createValidationError(`appliesTo.kinds lists at least one of ${WORK_KINDS.join(', ')}.`);
  const rawTypes = input.appliesTo.types ?? 'any';
  const types = rawTypes === 'any' ? 'any' as const : rawTypes.map((type) => type.toLowerCase());
  if (types !== 'any' && (!types.length || types.some((type) => !(FIELD_TYPE_NAMES as readonly string[]).includes(type)))) {
    throw createValidationError(`appliesTo.types is 'any' or a list of ${FIELD_TYPE_NAMES.join(', ')}.`);
  }
  let options: FieldOption[] | null = null;
  if (input.type === 'ENUM' || input.type === 'MULTI_ENUM') {
    options = input.options ?? [];
    if (!options.length) throw createValidationError('An ENUM or MULTI_ENUM field needs at least one option.');
    if (options.length > FIELD_LIMITS.enumOptions) throw createValidationError(`A field has at most ${FIELD_LIMITS.enumOptions} options; raising the limit is a decision (docs/field-definitions.md §7).`);
    const values = new Set<string>();
    for (const option of options) {
      if (typeof option?.value !== 'string' || !option.value.trim() || option.value.length > 80) throw createValidationError('Each option has a value of 1–80 characters.');
      if (values.has(option.value)) throw createValidationError(`Option "${option.value}" appears twice.`);
      values.add(option.value);
    }
    options = options.map((option) => ({ value: option.value, label: option.label?.trim() || option.value, ...(option.archived ? { archived: true } : {}) }));
  } else if (input.options && input.options.length) {
    throw createValidationError('Only ENUM and MULTI_ENUM fields have options.');
  }
  return { appliesTo: { kinds: kinds as WorkKind[], types }, options };
}

async function assertScope(prisma: DatabaseClient, scope: AutonomyScope, scopeId: string): Promise<void> {
  if (scope === 'WORKSPACE' && scopeId !== WORKSPACE_SETTINGS_ID) throw createValidationError(FIELD_SCOPE_INVALID_MESSAGE);
  if (scope === 'TEAM' && !(await prisma.team.findUnique({ where: { id: scopeId }, select: { id: true } }))) throw createValidationError(FIELD_SCOPE_INVALID_MESSAGE);
  if (scope === 'PROJECT') {
    const project = await prisma.issue.findUnique({ where: { id: scopeId }, select: { kind: true, commitmentStatus: true } });
    if (!project || project.kind !== 'PROJECT' || project.commitmentStatus !== 'COMMITTED') throw createValidationError(FIELD_SCOPE_INVALID_MESSAGE);
  }
}

/**
 * Create or change a definition: a new active version for the key, the
 * previous one deactivated (history stays). Permission is the caller's job
 * (workspace: Admin; team / project: team Owner or Admin). Audited as OpsAudit
 * `field.changed`. Values already stored are never rewritten.
 */
export async function setFieldDefinition(prisma: PrismaClient, input: SetFieldDefinitionInput, byActorId: string | null): Promise<FieldDefinition> {
  const reason = requireReason(input.reason);
  const { appliesTo, options } = validateDefinitionShape(input);
  await assertScope(prisma, input.scope, input.scopeId);
  return prisma.$transaction(async (tx) => {
    const previous = await tx.fieldDefinition.findFirst({ where: { scope: input.scope, scopeId: input.scopeId, key: input.key }, orderBy: { version: 'desc' } });
    if (previous?.active && previous.type !== input.type) {
      throw createValidationError(`Field "${input.key}" is ${previous.type}; a type cannot change because stored values would no longer fit. Deactivate it and define a new key.`);
    }
    if (!previous?.active) {
      const activeCount = await tx.fieldDefinition.count({ where: { scope: input.scope, scopeId: input.scopeId, active: true } });
      if (activeCount >= FIELD_LIMITS.activePerScope) {
        throw createValidationError(`This scope already has ${FIELD_LIMITS.activePerScope} active fields; deactivate one first. Raising the limit is a decision (docs/field-definitions.md §7).`);
      }
    }
    const draft = { ...input, options } as unknown as FieldDefinition;
    let defaultValue: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
    if (!isEmpty(input.defaultValue)) {
      if (input.type === 'WORK_REF' || input.type === 'USER_REF') throw createValidationError('Reference fields have no default value.');
      defaultValue = normaliseValue(draft, input.defaultValue) as Prisma.InputJsonValue;
    }
    if (previous?.active) await tx.fieldDefinition.update({ where: { id: previous.id }, data: { active: false } });
    const created = await tx.fieldDefinition.create({
      data: {
        scope: input.scope,
        scopeId: input.scopeId,
        key: input.key,
        label: input.label.trim(),
        description: input.description?.trim() || null,
        type: input.type,
        options: options ? (options as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        appliesTo: appliesTo as unknown as Prisma.InputJsonValue,
        required: input.required ?? false,
        defaultValue,
        searchable: input.searchable ?? false,
        version: (previous?.version ?? 0) + 1,
        reason,
        createdById: byActorId,
        lastWrittenAt: previous?.lastWrittenAt ?? null,
        indexJob: indexJobFor(previous, input.searchable ?? false),
      },
    });
    await recordOpsAudit(tx, {
      action: FIELD_AUDIT.changed,
      subject: `field:${input.scope.toLowerCase()}:${input.scopeId}:${input.key}`,
      byActorId,
      reason,
      details: { from: previous ? { version: previous.version, active: previous.active } : null, to: { version: created.version, type: created.type, required: created.required } },
    });
    return created;
  });
}

/** Deactivate a definition. Values stay on items and come back on reactivation; delete does not exist. */
export async function deactivateFieldDefinition(prisma: PrismaClient, input: { scope: AutonomyScope; scopeId: string; key: string; reason: string }, byActorId: string | null): Promise<FieldDefinition> {
  const reason = requireReason(input.reason);
  return prisma.$transaction(async (tx) => {
    const active = await tx.fieldDefinition.findFirst({ where: { scope: input.scope, scopeId: input.scopeId, key: input.key, active: true } });
    if (!active) throw createValidationError(`No active field "${input.key}" in this scope.`);
    // A searchable field leaves the index when it is retired; its values stay on the items.
    const updated = await tx.fieldDefinition.update({ where: { id: active.id }, data: { active: false, ...(active.searchable ? { indexJob: 'CLEANUP' as const, indexCursor: null, indexProcessed: 0 } : {}) } });
    await recordOpsAudit(tx, {
      action: FIELD_AUDIT.changed,
      subject: `field:${input.scope.toLowerCase()}:${input.scopeId}:${input.key}`,
      byActorId,
      reason,
      details: { from: { version: active.version, active: true }, to: { version: active.version, active: false } },
    });
    return updated;
  });
}

/** The shape both GraphQL and MCP return for a definition. */
export function fieldDefinitionView(definition: FieldDefinition) {
  return {
    id: definition.id,
    scope: definition.scope,
    scopeId: definition.scopeId,
    key: definition.key,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    options: readOptions(definition.options),
    appliesTo: readAppliesTo(definition.appliesTo),
    required: definition.required,
    defaultValue: definition.defaultValue ?? null,
    searchable: definition.searchable,
    active: definition.active,
    version: definition.version,
    previousKey: definition.previousKey,
    lastWrittenAt: definition.lastWrittenAt,
    indexJob: definition.indexJob,
    indexProcessed: definition.indexProcessed,
  };
}

/** Required fields still empty on an item — the candidate warning agents see (INV-1503). */
export async function missingRequiredFields(prisma: DatabaseClient, issue: { id: string; teamId: string; kind: WorkKind; parentId: string | null; attributes: Prisma.JsonValue }): Promise<FieldDefinition[]> {
  const definitions = await resolveDefinitionsFor(prisma, { ...issue, typeName: await typeNameOf(prisma, issue.id) });
  const values = readAttributes(issue.attributes);
  return definitions.filter((definition) => definition.required && isEmpty(values[definition.key]));
}

/** Every active definition a team's work can see: workspace, the team, and each of its PROJECTs (MCP work_catalog(kind: 'fields')). */
export async function listTeamFieldDefinitions(prisma: DatabaseClient, teamId: string) {
  const projects = await prisma.issue.findMany({ where: { teamId, kind: 'PROJECT', commitmentStatus: 'COMMITTED' }, select: { id: true, identifier: true, title: true } });
  const [workspace, team, projectRows] = await Promise.all([
    readActiveDefinitions(prisma, 'WORKSPACE', WORKSPACE_SETTINGS_ID),
    readActiveDefinitions(prisma, 'TEAM', teamId),
    projects.length ? prisma.fieldDefinition.findMany({ where: { scope: 'PROJECT', scopeId: { in: projects.map((project) => project.id) }, active: true }, orderBy: { key: 'asc' } }) : Promise.resolve([]),
  ]);
  return {
    workspace: workspace.map(fieldDefinitionView),
    team: team.map(fieldDefinitionView),
    projects: projects
      .map((project) => ({ projectId: project.id, identifier: project.identifier, title: project.title, definitions: projectRows.filter((row) => row.scopeId === project.id).map(fieldDefinitionView) }))
      .filter((project) => project.definitions.length > 0),
    note: 'Nearest scope wins on a key clash (project → team → workspace). Write values with attributes { key: value } on work_propose / work_file_bug / work_update; required fields must be set before work is committed.',
  };
}

/** The `attributes` argument of an MCP tool: an object of { key: value } (a null value clears that key); null or absent means not given. */
export function parseAttributesArg(value: unknown): AttributesInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw createValidationError('attributes must be an object of { key: value }; a null value clears that key.');
  return value as AttributesInput;
}


// ---------------------------------------------------------------------------
// INV-1504: FieldValueIndex, the backfill / cleanup job, rename, usage
// ---------------------------------------------------------------------------

/**
 * What the index needs after a new version: rows to add when the key becomes
 * searchable (newly, or again after deactivation), rows to remove when it
 * stops being searchable. Nothing when it stays as it was.
 */
export function indexJobFor(previous: Pick<FieldDefinition, 'active' | 'searchable'> | null, searchable: boolean): FieldIndexJob | null {
  const wasIndexed = Boolean(previous?.active && previous.searchable);
  if (searchable && !wasIndexed) return 'BACKFILL';
  if (!searchable && wasIndexed) return 'CLEANUP';
  return null;
}

type IndexRow = { key: string; textValue?: string | null; numberValue?: number | null; dateValue?: Date | null; refId?: string | null };

/** The typed rows for one value (MULTI_ENUM: one per option). */
export function indexRowsFor(definition: Pick<FieldDefinition, 'key' | 'type'>, value: unknown): IndexRow[] {
  if (value === undefined || value === null || value === '') return [];
  const key = definition.key;
  switch (definition.type) {
    case 'NUMBER': return typeof value === 'number' ? [{ key, numberValue: value }] : [];
    case 'DATE': return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? [{ key, dateValue: new Date(value) }] : [];
    case 'BOOLEAN': return typeof value === 'boolean' ? [{ key, textValue: String(value) }] : [];
    case 'MULTI_ENUM': return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => ({ key, textValue: entry })) : [];
    case 'WORK_REF':
    case 'USER_REF': return typeof value === 'string' && isUuid(value) ? [{ key, refId: value }] : [];
    default: return typeof value === 'string' ? [{ key, textValue: value }] : [];
  }
}

async function writeIndexRows(prisma: DatabaseClient, issueId: string, definition: FieldDefinition, value: unknown): Promise<number> {
  await prisma.fieldValueIndex.deleteMany({ where: { issueId, key: definition.key } });
  const rows = indexRowsFor(definition, value);
  if (rows.length) await prisma.fieldValueIndex.createMany({ data: rows.map((row) => ({ issueId, ...row })) });
  return rows.length;
}

/**
 * After a write that changed attributes (in the same transaction): keep the
 * index rows of searchable fields in step and stamp when each field was last
 * written. Called by every write path that stores `ValidationResult.attributes`.
 */
export async function recordAttributeWrite(prisma: DatabaseClient, issueId: string, result: Pick<ValidationResult, 'attributes' | 'changed' | 'definitions'>): Promise<void> {
  if (!result.changed.length) return;
  const byKey = new Map(result.definitions.map((definition) => [definition.key, definition]));
  const touched: string[] = [];
  for (const key of result.changed) {
    const definition = byKey.get(key);
    if (!definition) continue;
    touched.push(definition.id);
    if (definition.searchable) await writeIndexRows(prisma, issueId, definition, result.attributes[key]);
  }
  if (touched.length) await prisma.fieldDefinition.updateMany({ where: { id: { in: touched } }, data: { lastWrittenAt: new Date() } });
}

/** SQL limiting Issue rows to those a definition's scope covers. */
function scopeFilter(definition: Pick<FieldDefinition, 'scope' | 'scopeId'>): Prisma.Sql {
  if (definition.scope === 'TEAM') return Prisma.sql`"teamId" = ${definition.scopeId}::uuid`;
  if (definition.scope === 'PROJECT') {
    return Prisma.sql`id IN (WITH RECURSIVE subtree AS (SELECT id FROM "Issue" WHERE id = ${definition.scopeId}::uuid UNION SELECT child.id FROM "Issue" child JOIN subtree ON child."parentId" = subtree.id) SELECT id FROM subtree)`;
  }
  return Prisma.sql`TRUE`;
}

export const FIELD_INDEX_BATCH = 200;

/**
 * One step of each pending backfill / cleanup (docs/field-definitions.md §6):
 * walks the items in the definition's scope that hold a value for its key,
 * in id order from the cursor, and writes or removes their typed rows. An
 * item governed by another definition of the same key (a nearer scope) is
 * left to that definition. Returns how many definitions finished.
 */
export async function runFieldIndexJobs(prisma: PrismaClient, batch = FIELD_INDEX_BATCH): Promise<number> {
  const jobs = await prisma.fieldDefinition.findMany({ where: { indexJob: { not: null } }, orderBy: { createdAt: 'asc' } });
  let finished = 0;
  for (const job of jobs) {
    const cursor = job.indexCursor ? Prisma.sql`AND id > ${job.indexCursor}::uuid` : Prisma.empty;
    const items = await prisma.$queryRaw<Array<{ id: string; teamId: string; kind: WorkKind; parentId: string | null; attributes: Prisma.JsonValue }>>`
      SELECT id, "teamId", kind, "parentId", attributes FROM "Issue"
      WHERE jsonb_exists(attributes, ${job.key}) AND ${scopeFilter(job)} ${cursor}
      ORDER BY id LIMIT ${batch}`;
    for (const item of items) {
      const governing = (await resolveScopedDefinitions(prisma, item)).find((definition) => definition.key === job.key);
      const value = readAttributes(item.attributes)[job.key];
      if (job.indexJob === 'BACKFILL') {
        if (governing?.id === job.id && job.active && job.searchable) await writeIndexRows(prisma, item.id, job, value);
      } else if (!governing?.searchable) {
        await prisma.fieldValueIndex.deleteMany({ where: { issueId: item.id, key: job.key } });
      }
    }
    const done = items.length < batch;
    // Only the job this pass picked up is advanced; a newer version may have replaced it meanwhile.
    await prisma.fieldDefinition.updateMany({
      where: { id: job.id, indexJob: job.indexJob },
      data: done ? { indexJob: null, indexCursor: null, indexProcessed: job.indexProcessed + items.length } : { indexCursor: items.at(-1)!.id, indexProcessed: job.indexProcessed + items.length },
    });
    if (done) finished += 1;
  }
  return finished;
}

/** Items in the definition's scope that hold a value for its key. */
export async function countFieldUsage(prisma: DatabaseClient, definition: Pick<FieldDefinition, 'scope' | 'scopeId' | 'key'>): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Issue" WHERE jsonb_exists(attributes, ${definition.key}) AND ${scopeFilter(definition)}`;
  return Number(rows[0]?.count ?? 0);
}

export const FIELD_STALE_DAYS = 90;

/** "Defined, never written in 90 days" (docs/field-definitions.md §7): the cleanup prompt. */
export function isStaleDefinition(definition: Pick<FieldDefinition, 'lastWrittenAt'>, firstDefinedAt: Date, now: Date = new Date()): boolean {
  const since = definition.lastWrittenAt ?? firstDefinedAt;
  return now.getTime() - since.getTime() > FIELD_STALE_DAYS * 86_400_000;
}

/**
 * Rename a key with a reason (docs/field-definitions.md §7): a new version
 * under the new key that still accepts the old one on write until the next
 * version; stored values and index rows in the scope move to the new key in
 * the same transaction.
 */
export async function renameFieldDefinition(prisma: PrismaClient, input: { scope: AutonomyScope; scopeId: string; from: string; to: string; reason: string }, byActorId: string | null): Promise<FieldDefinition> {
  const reason = requireReason(input.reason);
  if (!KEY_PATTERN.test(input.to)) throw createValidationError('A field key is snake_case: a lower-case letter, then 1–39 letters, digits or underscores.');
  if (input.from === input.to) throw createValidationError('The new key is the same as the old one.');
  return prisma.$transaction(async (tx) => {
    const active = await tx.fieldDefinition.findFirst({ where: { scope: input.scope, scopeId: input.scopeId, key: input.from, active: true } });
    if (!active) throw createValidationError(`No active field "${input.from}" in this scope.`);
    if (await tx.fieldDefinition.findFirst({ where: { scope: input.scope, scopeId: input.scopeId, key: input.to }, select: { id: true } })) {
      throw createValidationError(`Key "${input.to}" was already used in this scope; pick another so its old values cannot mix in.`);
    }
    await tx.fieldDefinition.update({ where: { id: active.id }, data: { active: false } });
    const { id: _id, createdAt: _createdAt, ...rest } = active;
    const created = await tx.fieldDefinition.create({
      data: {
        ...rest,
        options: active.options ?? Prisma.JsonNull,
        appliesTo: active.appliesTo as Prisma.InputJsonValue,
        defaultValue: active.defaultValue ?? Prisma.JsonNull,
        key: input.to,
        previousKey: input.from,
        version: 1,
        reason,
        createdById: byActorId,
        indexJob: null,
        indexCursor: null,
        indexProcessed: 0,
      },
    });
    const scope = scopeFilter(active);
    await tx.$executeRaw`UPDATE "Issue" SET attributes = (attributes - ${input.from}::text) || jsonb_build_object(${input.to}::text, attributes -> ${input.from}::text)
      WHERE jsonb_exists(attributes, ${input.from}) AND ${scope}`;
    await tx.$executeRaw`UPDATE "FieldValueIndex" SET key = ${input.to} WHERE key = ${input.from} AND "issueId" IN (SELECT id FROM "Issue" WHERE ${scope})`;
    await recordOpsAudit(tx, {
      action: FIELD_AUDIT.changed,
      subject: `field:${input.scope.toLowerCase()}:${input.scopeId}:${input.to}`,
      byActorId,
      reason,
      details: { renamed: { from: input.from, to: input.to }, version: created.version },
    });
    return created;
  });
}
