/**
 * Redmine → Involute export.
 *
 * The output is the same export directory the Linear importer writes, so the
 * existing import pipeline and its verifier read it unchanged (INV-1288).
 *
 * ## What a Redmine project becomes
 *
 * A Redmine project is a container of issues, which in the work graph is a
 * PROJECT node; the issues become its children. The project owns a
 * repository (`redmine/<project-identifier>`), and every child states the
 * same one — a CONTAINS edge needs both ends to agree.
 *
 * ## What becomes an identifier
 *
 * A Redmine number is how people talk about their work ("43238"), so it is
 * kept: an issue becomes `RD-43238`. Project ids live in the same space as
 * issue ids, so they are moved into a reserved band above every issue
 * (`RD-1000009` is Redmine project 9) and cannot collide. When a source has
 * issue numbers beyond the band, the exporter falls back to one sequential
 * series and records the Redmine number in the description instead.
 *
 * ## Legacy ids and the namespace
 *
 * The legacy id is how an import recognises an entity it has already seen,
 * so it must identify *this source* and no other. Every legacy id therefore
 * carries a namespace derived from the Redmine host: importing a second
 * Redmine into the same workspace can never mistake it for the first one.
 *
 * ## What becomes a state
 *
 * Redmine has its own status names; Involute has six. Each issue is placed
 * in the closest Involute state, and the original Redmine status is kept as a
 * label so nothing is lost in the translation.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ExportedComment,
  ExportedIssue,
  ExportedLabel,
  ExportedTeam,
  ExportedUser,
  ExportedWorkflowState,
} from '@turnkeyai/involute-shared/import-format';

import { RedmineClient } from './client.js';
import type {
  RedmineIssue,
  RedmineIssueDetail,
  RedmineIssueStatus,
  RedmineProject,
  RedmineUser,
} from './types.js';

export interface RedmineExportOptions {
  client: RedmineClient;
  /** Where the export directory is written. */
  outputDir: string;
  /** The Involute team key the identifiers use, e.g. `RD`. */
  teamKey: string;
  /** The team name shown in the workspace. */
  teamName: string;
  /** Base URL of the Redmine, used in the provenance line. */
  sourceUrl: string;
  /**
   * The namespace the legacy ids carry. Derived from the source host when
   * not given; two sources must never share one.
   */
  namespace?: string;
  /** Append "migrated from Redmine" to every description. Default true. */
  provenance?: boolean;
  /** Fetch each issue's notes, attachments and links. Default true. */
  includeComments?: boolean;
  onProgress?: (message: string) => void;
}

export interface RedmineExportSummary {
  comments: number;
  issues: number;
  labels: number;
  namespace: string;
  projects: number;
  /** People an issue names who the user list does not have — they lose their owner. */
  unmatchedUsers: number;
  users: number;
}

/** The legacy-id namespace of one source. */
export class RedmineNamespace {
  constructor(readonly prefix: string) {}

  team(): string {
    return `${this.prefix}-team`;
  }

  project(id: number): string {
    return `${this.prefix}-project-${String(id)}`;
  }

  issue(id: number): string {
    return `${this.prefix}-issue-${String(id)}`;
  }

  user(id: number): string {
    return `${this.prefix}-user-${String(id)}`;
  }

  comment(id: number): string {
    return `${this.prefix}-comment-${String(id)}`;
  }

  label(kind: string, id: number): string {
    return `${this.prefix}-label-${kind}-${String(id)}`;
  }

  state(name: string): string {
    return `${this.prefix}-state-${name}`;
  }
}

/**
 * The namespace for a source: readable, and different for different hosts.
 *
 * `https://redmine.91jinrong.com` becomes `rm-91jinrong`.
 */
export function deriveNamespace(sourceUrl: string): string {
  let host = 'redmine';

  try {
    host = new URL(sourceUrl).hostname || host;
  } catch {
    // A URL we cannot read still gets a namespace, just a generic one.
  }

  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `rm-${slug || 'redmine'}`;
}

/** The Involute board. Redmine statuses are mapped onto these six. */
const STATE_NAMES = [
  { name: 'Backlog', type: 'BACKLOG', position: 0 },
  { name: 'Ready', type: 'UNSTARTED', position: 1 },
  { name: 'In Progress', type: 'STARTED', position: 2 },
  { name: 'In Review', type: 'REVIEW', position: 3 },
  { name: 'Done', type: 'COMPLETED', position: 4 },
  { name: 'Canceled', type: 'CANCELED', position: 5 },
] as const;

function involuteStates(ns: RedmineNamespace): ExportedWorkflowState[] {
  return STATE_NAMES.map((state) => ({
    id: ns.state(state.name.toLowerCase().replace(/\s+/g, '-')),
    name: state.name,
    position: state.position,
    team: { id: ns.team() },
    type: state.type,
  }));
}

/** Above every plausible Redmine issue number; project ids move up here. */
const PROJECT_BAND = 1_000_000;

const REJECTED = /拒绝|驳回|reject/i;
const ON_HOLD = /挂起|暂缓|暂停|hold|suspend/i;
const REVIEW = /上线|发布|待验收|验收|release|review/i;
const NOT_STARTED = /新建|新增|需求|反馈|待处理|待办|new|open|backlog/i;

export async function exportRedmine(options: RedmineExportOptions): Promise<RedmineExportSummary> {
  const { client, outputDir, onProgress } = options;
  const log = onProgress ?? (() => undefined);
  const ns = new RedmineNamespace(options.namespace ?? deriveNamespace(options.sourceUrl));

  log('Reading Redmine metadata...');
  const [projects, users, trackers, statuses] = await Promise.all([
    client.listProjects(),
    client.listUsers(),
    client.listTrackers(),
    client.listIssueStatuses(),
  ]);
  log(`  ${String(projects.length)} projects, ${String(users.length)} users, ${String(trackers.length)} trackers, ${String(statuses.length)} statuses`);

  log('Reading Redmine issues...');
  const issues = await client.listIssues();
  log(`  ${String(issues.length)} issues`);

  const userMap = buildUserMap(users, ns);
  const labelMap = buildLabelMap(trackers, statuses, issues, ns);
  const statusById = new Map(statuses.map((status) => [status.id, status]));

  // The user list does not show everybody: a person who only ever appears as
  // somebody's assignee can be missing from it. Their own page still has
  // them, so they are fetched there — otherwise their issues lose an owner.
  const referencedUserIds = new Set<number>();
  for (const issue of issues) {
    if (issue.assigned_to) {
      referencedUserIds.add(issue.assigned_to.id);
    }
    if (issue.author) {
      referencedUserIds.add(issue.author.id);
    }
  }
  const missingUserIds = [...referencedUserIds].filter((id) => !userMap.has(id));
  if (missingUserIds.length > 0) {
    log(`  Fetching ${String(missingUserIds.length)} user(s) the list did not show...`);
    for (const id of missingUserIds) {
      const user = await client.getUser(id);
      if (!user) {
        continue;
      }
      userMap.set(user.id, mapUser(user, ns));
      users.push(user);
    }
  }

  const maxIssueId = issues.reduce((max, issue) => Math.max(max, issue.id), 0);
  const keepRedmineNumbers = maxIssueId > 0 && maxIssueId < PROJECT_BAND;

  // --- Teams -------------------------------------------------------------
  const teams: ExportedTeam[] = [
    { id: ns.team(), key: options.teamKey.toUpperCase(), name: options.teamName },
  ];

  // --- Labels ------------------------------------------------------------
  const labels: ExportedLabel[] = [...labelMap.values()];

  // --- Users -------------------------------------------------------------
  const exportedUsers: ExportedUser[] = users.map((user) => {
    const mapped = userMap.get(user.id)!;
    return {
      id: mapped.legacyId,
      name: mapped.name,
      email: mapped.email,
      displayName: mapped.name,
      active: true,
    };
  });

  // --- Work items --------------------------------------------------------
  // People an issue names that the user list does not have. Losing one means
  // an issue without an owner, so it is counted and reported, not swallowed.
  const unmatchedUserIds = new Set<number>();
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const exportedIssues: ExportedIssue[] = [];
  let sequential = 0;

  // Projects come first so a child always finds its parent.
  for (const project of projects) {
    sequential += 1;
    const identifier = keepRedmineNumbers
      ? `${options.teamKey.toUpperCase()}-${String(PROJECT_BAND + project.id)}`
      : `${options.teamKey.toUpperCase()}-${String(sequential)}`;

    exportedIssues.push({
      id: ns.project(project.id),
      identifier,
      title: project.name,
      description: project.description?.trim() ? project.description : null,
      priority: 0,
      createdAt: project.created_on ?? new Date(0).toISOString(),
      updatedAt: project.updated_on ?? project.created_on ?? new Date(0).toISOString(),
      state: { id: ns.state('ready'), name: 'Ready' },
      team: { id: ns.team(), key: options.teamKey.toUpperCase() },
      assignee: null,
      labels: { nodes: [] },
      parent: null,
      kind: 'PROJECT',
      repository: repositoryFor(project),
    });
  }

  for (const issue of issues) {
    sequential += 1;
    const project = projectById.get(issue.project.id);
    const identifier = keepRedmineNumbers
      ? `${options.teamKey.toUpperCase()}-${String(issue.id)}`
      : `${options.teamKey.toUpperCase()}-${String(sequential)}`;

    const status = statusById.get(issue.status.id);
    const state = mapStatus(status, issue.status.name, ns);

    if (issue.assigned_to && !userMap.has(issue.assigned_to.id)) {
      unmatchedUserIds.add(issue.assigned_to.id);
    }

    exportedIssues.push({
      id: ns.issue(issue.id),
      identifier,
      title: issue.subject,
      description: buildDescription(issue, project, options),
      priority: issue.priority?.id ?? 0,
      createdAt: issue.created_on,
      updatedAt: issue.updated_on,
      state: { id: state.id, name: state.name },
      team: { id: ns.team(), key: options.teamKey.toUpperCase() },
      assignee: issue.assigned_to ? userRef(issue.assigned_to.id, userMap) : null,
      labels: { nodes: issueLabelNodes(issue, labelMap) },
      parent: project ? { id: ns.project(project.id) } : null,
      kind: 'ISSUE',
      repository: project ? repositoryFor(project) : 'redmine/unassigned',
    });
  }

  // --- Comments ----------------------------------------------------------
  let commentCount = 0;
  if (options.includeComments !== false) {
    log('Reading Redmine notes...');
    const commentsDir = join(outputDir, 'comments');
    await mkdir(commentsDir, { recursive: true });

    let done = 0;
    for (const issue of issues) {
      done += 1;
      if (done % 500 === 0) {
        log(`  ${String(done)}/${String(issues.length)} issues`);
      }

      let detail: RedmineIssueDetail;
      try {
        detail = await client.getIssueDetail(issue.id);
      } catch {
        continue;
      }

      const comments = buildComments(detail, userMap, ns);
      if (comments.length === 0) {
        continue;
      }

      commentCount += comments.length;
      await writeFile(
        join(commentsDir, `${ns.issue(issue.id)}.json`),
        `${JSON.stringify(comments, null, 2)}\n`,
        'utf8',
      );
    }
  }

  // --- Write -------------------------------------------------------------
  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, 'teams.json'), teams);
  await writeJson(join(outputDir, 'workflow_states.json'), involuteStates(ns));
  await writeJson(join(outputDir, 'labels.json'), labels);
  await writeJson(join(outputDir, 'users.json'), exportedUsers);
  await writeJson(join(outputDir, 'issues.json'), exportedIssues);
  // This file tells the import pipeline that the export carries its own
  // hierarchy; without it the issues would land flat (INV-1288).
  await writeJson(join(outputDir, 'hierarchy.json'), { enabled: true });

  if (unmatchedUserIds.size > 0) {
    log(
      `  WARNING: ${String(unmatchedUserIds.size)} assignee(s) are not in the user list and lost their owner: ${[...unmatchedUserIds]
        .slice(0, 10)
        .join(', ')}${unmatchedUserIds.size > 10 ? ' …' : ''}`,
    );
  }

  return {
    comments: commentCount,
    issues: exportedIssues.length,
    labels: labels.length,
    namespace: ns.prefix,
    projects: projects.length,
    unmatchedUsers: unmatchedUserIds.size,
    users: exportedUsers.length,
  };
}

// --- Helpers ---------------------------------------------------------------

interface MappedUser {
  legacyId: string;
  email: string;
  name: string;
}

function buildUserMap(users: RedmineUser[], ns: RedmineNamespace): Map<number, MappedUser> {
  const map = new Map<number, MappedUser>();

  for (const user of users) {
    map.set(user.id, mapUser(user, ns));
  }

  return map;
}

/**
 * One Redmine account as Involute knows a person.
 *
 * Only these fields are read. The account's own API key is on the same
 * response and is deliberately not carried over.
 */
function mapUser(user: RedmineUser, ns: RedmineNamespace): MappedUser {
  const login = user.login?.trim() || `user${String(user.id)}`;
  const name = `${user.firstname ?? ''}${user.lastname ?? ''}`.trim() || login;
  // Involute keys people by email, so a Redmine account without one still
  // needs a distinct, stable address.
  const email = (user.mail?.trim() || `${login}@redmine.local`).toLowerCase();

  return { legacyId: ns.user(user.id), email, name };
}

function userRef(
  userId: number,
  userMap: Map<number, MappedUser>,
): { id: string; name: string; email: string } | null {
  const mapped = userMap.get(userId);
  if (!mapped) {
    return null;
  }

  return { id: mapped.legacyId, name: mapped.name, email: mapped.email };
}

/**
 * Labels carry what the translation would otherwise lose: the Redmine
 * tracker, priority and status. Names are unique across the workspace, so the
 * same name is one label however many kinds mention it.
 */
function buildLabelMap(
  trackers: Array<{ id: number; name: string }>,
  statuses: RedmineIssueStatus[],
  issues: RedmineIssue[],
  ns: RedmineNamespace,
): Map<string, ExportedLabel> {
  const map = new Map<string, ExportedLabel>();

  const add = (legacyId: string, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed || map.has(trimmed)) {
      return;
    }
    map.set(trimmed, { id: legacyId, name: trimmed, color: colorFor(trimmed) });
  };

  for (const tracker of trackers) {
    add(ns.label('tracker', tracker.id), tracker.name);
  }
  for (const status of statuses) {
    add(ns.label('status', status.id), status.name);
  }

  const priorities = new Map<number, string>();
  for (const issue of issues) {
    priorities.set(issue.priority.id, issue.priority.name);
  }
  for (const [id, name] of priorities) {
    add(ns.label('priority', id), name);
  }

  return map;
}

function issueLabelNodes(issue: RedmineIssue, labelMap: Map<string, ExportedLabel>): Array<{ id: string; name: string }> {
  const nodes: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();

  const push = (name: string | undefined): void => {
    const trimmed = name?.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    const label = labelMap.get(trimmed);
    if (!label) {
      return;
    }
    seen.add(trimmed);
    nodes.push({ id: label.id, name: label.name });
  };

  push(issue.tracker?.name);
  push(issue.status?.name);
  push(issue.priority?.name);

  return nodes;
}

/** The closest Involute state for a Redmine status. */
function mapStatus(
  status: RedmineIssueStatus | undefined,
  fallbackName: string,
  ns: RedmineNamespace,
): ExportedWorkflowState {
  const name = status?.name ?? fallbackName;
  const closed = status?.is_closed === true;

  if (REJECTED.test(name)) {
    return stateByName('Canceled', ns);
  }
  if (ON_HOLD.test(name)) {
    return stateByName('Backlog', ns);
  }
  if (closed) {
    return stateByName('Done', ns);
  }
  if (REVIEW.test(name)) {
    return stateByName('In Review', ns);
  }
  if (NOT_STARTED.test(name)) {
    return stateByName('Ready', ns);
  }

  return stateByName('In Progress', ns);
}

function stateByName(name: string, ns: RedmineNamespace): ExportedWorkflowState {
  const found = STATE_NAMES.find((state) => state.name === name)!;
  return {
    id: ns.state(name.toLowerCase().replace(/\s+/g, '-')),
    name: found.name,
    position: found.position,
    team: { id: ns.team() },
    type: found.type,
  };
}

function buildDescription(
  issue: RedmineIssue,
  project: RedmineProject | undefined,
  options: RedmineExportOptions,
): string | null {
  const body = issue.description ?? '';
  if (options.provenance === false) {
    return body.trim() ? body : null;
  }

  const where = `${options.sourceUrl.replace(/\/+$/, '')}/issues/${String(issue.id)}`;
  const footer = `--- \n迁移自 Redmine · ${project ? project.name : '未归属项目'} · #${String(issue.id)}\n${where}`;

  return body.trim() ? `${body}\n\n${footer}` : footer;
}

function buildComments(
  detail: RedmineIssueDetail,
  userMap: Map<number, MappedUser>,
  ns: RedmineNamespace,
): ExportedComment[] {
  const journals = detail.journals ?? [];

  return journals.map((journal) => {
    const notes = journal.notes?.trim() ? journal.notes : renderDetails(journal.details);

    return {
      id: ns.comment(journal.id),
      body: notes,
      createdAt: journal.created_on,
      updatedAt: journal.created_on,
      user: journal.user ? userRef(journal.user.id, userMap) : null,
    };
  });
}

/** A journal with no note still changed something; say what. */
function renderDetails(details: RedmineJournalDetailLike[] | undefined): string {
  if (!details || details.length === 0) {
    return '';
  }

  return details
    .map((detail) => {
      const property = detail.property ?? 'field';
      const name = detail.name ?? property;
      const from = detail.old_value?.trim();
      const to = detail.new_value?.trim();

      if (from && to) {
        return `${name}: ${from} → ${to}`;
      }
      if (to) {
        return `${name}: ${to}`;
      }
      if (from) {
        return `${name}: ${from}`;
      }
      return name;
    })
    .filter(Boolean)
    .join('\n');
}

type RedmineJournalDetailLike = {
  new_value?: string | null;
  name?: string;
  old_value?: string | null;
  property?: string;
};

function repositoryFor(project: RedmineProject): string {
  return `redmine/${project.identifier}`;
}

/** A stable colour per label name, so the same label always looks the same. */
function colorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 0xffffff;
  }
  return `#${hash.toString(16).padStart(6, '0')}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
