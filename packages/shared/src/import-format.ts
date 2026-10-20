export interface ExportedTeam {
  id: string;
  key: string;
  name: string;
}

export interface ExportedWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  team: { id: string };
}

export interface ExportedLabel {
  id: string;
  name: string;
  color: string;
}

export interface ExportedUser {
  id: string;
  name: string;
  email: string;
  displayName: string;
  active: boolean;
}

export interface ExportedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  state: { id: string; name: string };
  team: { id: string; key: string };
  assignee: { id: string; name: string; email: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  parent: { id: string } | null;
  /**
   * The work kind this node becomes (INV-1288). Absent means ISSUE, which is
   * what a Linear export produces.
   */
  kind?: ExportedWorkKind | undefined;
  /**
   * The repository this node belongs to. A CONTAINS edge needs both ends to
   * agree on it, so a source that builds a hierarchy states it here.
   */
  repository?: string | undefined;
}

/** The work kinds an import may create. */
export type ExportedWorkKind = 'PROJECT' | 'MILESTONE' | 'EPIC' | 'ISSUE' | 'DECISION';

const EXPORTED_WORK_KINDS: readonly ExportedWorkKind[] = [
  'PROJECT',
  'MILESTONE',
  'EPIC',
  'ISSUE',
  'DECISION',
];

/**
 * Whether an export carries its own hierarchy (INV-1288).
 *
 * The file is optional. Without it the pipeline imports issues flat and
 * reports every source parent as deferred — what a Linear export needs.
 * With it the pipeline creates the parents first and links the children.
 */
export interface ExportedHierarchy {
  enabled: boolean;
}

export interface ExportedComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string } | null;
}

export function parseExportedTeams(value: unknown): ExportedTeam[] {
  return expectArray(value, 'teams.json').map((team, index) =>
    parseExportedTeam(team, `teams.json[${index}]`),
  );
}

export function parseExportedWorkflowStates(value: unknown): ExportedWorkflowState[] {
  return expectArray(value, 'workflow_states.json').map((state, index) =>
    parseExportedWorkflowState(state, `workflow_states.json[${index}]`),
  );
}

export function parseExportedLabels(value: unknown): ExportedLabel[] {
  return expectArray(value, 'labels.json').map((label, index) =>
    parseExportedLabel(label, `labels.json[${index}]`),
  );
}

export function parseExportedUsers(value: unknown): ExportedUser[] {
  return expectArray(value, 'users.json').map((user, index) =>
    parseExportedUser(user, `users.json[${index}]`),
  );
}

export function parseExportedIssues(value: unknown): ExportedIssue[] {
  return expectArray(value, 'issues.json').map((issue, index) =>
    parseExportedIssue(issue, `issues.json[${index}]`),
  );
}

export function parseExportedComments(value: unknown, fileLabel = 'comments.json'): ExportedComment[] {
  return expectArray(value, fileLabel).map((comment, index) =>
    parseExportedComment(comment, `${fileLabel}[${index}]`),
  );
}

export function parseExportedHierarchy(value: unknown, fileLabel = 'hierarchy.json'): ExportedHierarchy {
  const object = expectObject(value, fileLabel);

  return {
    enabled: expectBoolean(object.enabled, `${fileLabel}.enabled`),
  };
}

function parseExportedTeam(value: unknown, path: string): ExportedTeam {
  const object = expectObject(value, path);

  return {
    id: expectString(object.id, `${path}.id`),
    key: expectString(object.key, `${path}.key`),
    name: expectString(object.name, `${path}.name`),
  };
}

function parseExportedWorkflowState(value: unknown, path: string): ExportedWorkflowState {
  const object = expectObject(value, path);
  const team = expectObject(object.team, `${path}.team`);

  return {
    id: expectString(object.id, `${path}.id`),
    name: expectString(object.name, `${path}.name`),
    type: expectString(object.type, `${path}.type`),
    position: expectNumber(object.position, `${path}.position`),
    team: {
      id: expectString(team.id, `${path}.team.id`),
    },
  };
}

function parseExportedLabel(value: unknown, path: string): ExportedLabel {
  const object = expectObject(value, path);

  return {
    color: expectString(object.color, `${path}.color`),
    id: expectString(object.id, `${path}.id`),
    name: expectString(object.name, `${path}.name`),
  };
}

function parseExportedUser(value: unknown, path: string): ExportedUser {
  const object = expectObject(value, path);

  return {
    active: expectBoolean(object.active, `${path}.active`),
    displayName: expectString(object.displayName, `${path}.displayName`),
    email: expectString(object.email, `${path}.email`),
    id: expectString(object.id, `${path}.id`),
    name: expectString(object.name, `${path}.name`),
  };
}

function parseExportedIssue(value: unknown, path: string): ExportedIssue {
  const object = expectObject(value, path);
  const state = expectObject(object.state, `${path}.state`);
  const team = expectObject(object.team, `${path}.team`);
  const labels = expectObject(object.labels, `${path}.labels`);
  const labelNodes = expectArray(labels.nodes, `${path}.labels.nodes`).map((label, index) => {
    const labelObject = expectObject(label, `${path}.labels.nodes[${index}]`);

    return {
      id: expectString(labelObject.id, `${path}.labels.nodes[${index}].id`),
      name: expectString(labelObject.name, `${path}.labels.nodes[${index}].name`),
    };
  });

  return {
    assignee: parseNullableUserRef(object.assignee, `${path}.assignee`),
    createdAt: expectString(object.createdAt, `${path}.createdAt`),
    description: expectNullableString(object.description, `${path}.description`),
    id: expectString(object.id, `${path}.id`),
    identifier: expectString(object.identifier, `${path}.identifier`),
    kind: parseOptionalWorkKind(object.kind, `${path}.kind`),
    labels: { nodes: labelNodes },
    parent: parseNullableIdRef(object.parent, `${path}.parent`),
    priority: expectNumber(object.priority, `${path}.priority`),
    repository: parseOptionalString(object.repository, `${path}.repository`),
    state: {
      id: expectString(state.id, `${path}.state.id`),
      name: expectString(state.name, `${path}.state.name`),
    },
    team: {
      id: expectString(team.id, `${path}.team.id`),
      key: expectString(team.key, `${path}.team.key`),
    },
    title: expectString(object.title, `${path}.title`),
    updatedAt: expectString(object.updatedAt, `${path}.updatedAt`),
  };
}

function parseOptionalWorkKind(value: unknown, path: string): ExportedWorkKind | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const kind = expectString(value, path);

  if (!EXPORTED_WORK_KINDS.includes(kind as ExportedWorkKind)) {
    throw new Error(`${path} must be one of ${EXPORTED_WORK_KINDS.join(', ')}.`);
  }

  return kind as ExportedWorkKind;
}

function parseOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return expectString(value, path);
}

function parseExportedComment(value: unknown, path: string): ExportedComment {
  const object = expectObject(value, path);

  return {
    body: expectString(object.body, `${path}.body`),
    createdAt: expectString(object.createdAt, `${path}.createdAt`),
    id: expectString(object.id, `${path}.id`),
    updatedAt: expectString(object.updatedAt, `${path}.updatedAt`),
    user: parseNullableUserRef(object.user, `${path}.user`),
  };
}

function parseNullableUserRef(
  value: unknown,
  path: string,
): { id: string; name: string; email: string } | null {
  if (value === null) {
    return null;
  }

  const object = expectObject(value, path);

  return {
    email: expectString(object.email, `${path}.email`),
    id: expectString(object.id, `${path}.id`),
    name: expectString(object.name, `${path}.name`),
  };
}

function parseNullableIdRef(value: unknown, path: string): { id: string } | null {
  if (value === null) {
    return null;
  }

  const object = expectObject(value, path);

  return {
    id: expectString(object.id, `${path}.id`),
  };
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  return value;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }

  return value;
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }

  return expectString(value, path);
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }

  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }

  return value;
}
