import type {
  AgentCredential,
  AgentRequest,
  Attachment,
  ContractAmendment,
  DecisionReceipt,
  Comment,
  Cycle,
  Issue,
  IssueLabel,
  Prisma,
  PrismaClient,
  Project,
  Team,
  TeamMembership,
  TeamMembershipRole,
  TeamVisibility,
  User,
  WebhookSubscription,
  WorkClaim,
  WorkLink,
  WorkLinkType,
  WorkflowState,
  WorkEvidence,
  WorkShare,
  WorkShareRole,
  GlobalRole,
} from '@prisma/client';

import { assertOpsAdmin, clearSyncDeadLetter, readOpsOverview, recordOpsAudit, replayInboundDelivery } from './ops-service.js';
import { makeExecutableSchema } from '@graphql-tools/schema';

import {
  assertSettingsAdmin,
  createLabel,
  createWorkflowState,
  deleteLabel,
  deleteWorkflowState,
  listServerFeatures,
  renameLabel,
  setGlobalRole,
  updateWorkflowState,
  type ServerFeature,
} from './admin-settings.js';
import {
  GraphQLError,
  GraphQLScalarType,
  Kind,
  valueFromASTUntyped,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLResolveInfo,
  type SelectionSetNode,
} from 'graphql';

import {
  AGENT_CREDENTIAL_NOT_FOUND_MESSAGE,
  AGENT_SCOPE_INVALID_MESSAGE,
  createNotFoundError,
  createValidationError,
  getExposedError,
  isPrismaInvalidInputError,
  ISSUE_NOT_FOUND_MESSAGE,
  CONTRACT_AMENDMENT_NOT_FOUND_MESSAGE,
  MEMBERSHIP_NOT_FOUND_MESSAGE,
  NOTIFICATION_NOT_FOUND_MESSAGE,
  ACTOR_MANAGE_FORBIDDEN_MESSAGE,
  TEAM_ROSTER_HUMANS_ONLY_MESSAGE,
  TEAM_MANAGE_FORBIDDEN_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  TEAM_OWNER_REQUIRED_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  WEBHOOK_EVENT_TYPE_INVALID_MESSAGE,
  WEBHOOK_NOT_FOUND_MESSAGE,
  WEBHOOK_URL_INVALID_MESSAGE,
  WORK_LINK_NOT_FOUND_MESSAGE,
  AGENT_EMAIL_INVALID_MESSAGE,
  AGENT_HANDLE_INVALID_MESSAGE,
  AGENT_HANDLE_TAKEN_MESSAGE,
  REQUEST_ANSWER_STATE_INVALID_MESSAGE,
  GUEST_CANNOT_OWN_TEAM_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
} from './errors.js';
import {
  assertCanDeleteComment,
  assertCanActOnRequest,
  assertCanReadIssue,
  assertCanManageActor,
  assertCanRepresentActor,
  assertCanRevokeCredential,
  assertCanManageTeam,
  assertCanReadTeam,
  assertCanWriteIssue,
  assertCanWriteTeam,
  buildReadableIssueWhere,
  buildReadableTeamWhere,
  buildVisibleUsersWhere,
  canSeeTeamRoster,
} from './access-control.js';
import type {
  CreateCommentInput,
  CreateIssueInput,
  UpdateIssueInput,
} from './issue-service.js';
import { buildIssueWhere, type IssueFilterInput } from './issue-filter.js';
import { searchIssues, type IssueSearchHit } from './issue-search.js';
import { compileIqlToIssueWhere, parseIqlOrThrow } from './iql-compile.js';

import { requireAuthentication, type GraphQLContext } from './auth.js';
import { isPlausibleEmail, issueAgentCredential, parseAgentScopeList } from './agent-credentials.js';
import type { AgentScope } from './agent-credentials.js';
import { WORK_EVENT_TYPES, enqueueWorkEvent } from './event-outbox.js';
import { toWireState } from './agent-request-state.js';
import { PRESENCE_COPY, agentRequestPresence } from './agent-request-presence.js';
import { ACTOR_PRESENCE_COPY, actorPresence } from './actor-presence.js';
import { deactivateActor, transferActorOwner, reactivateActor, recordActorAudit, setActorSuccessor } from './actor-lifecycle.js';
import { isValidHandle, normalizeHandle } from './mention-parser.js';
import { listWorkShares, removeWorkShare, upsertWorkShare } from './project-sharing.js';
import { getServerEnvironment } from './environment.js';
import { isNotificationEmailReady } from './notification-email.js';
import { createNotificationEmailSender } from './notification-email.js';
import { createTeam, joinTeam, leaveTeam, setTeamArchived, updateTeam } from './team-lifecycle.js';
import {
  canInvite,
  deliverInvite,
  getWorkspaceSettings,
  inviteUser,
  reactivateUser,
  revokeInvite,
  suspendUser,
  updateWorkspaceSettings,
  userAccessStatus,
} from './workspace-access.js';
import { EVIDENCE_NOT_FOUND_MESSAGE, retractEvidence } from './evidence-retract.js';
import {
  acceptContractAmendment,
  amendmentChanges,
  isAmendmentStale,
  rejectContractAmendment,
} from './contract-amendment.js';
import { answerAgentRequestAsHuman, replyToAgentRequest } from './agent-request-service.js';
import { provisionServiceActor } from './service-actors.js';
import {
  findWorkProvenance,
  getAgentProfile,
  listAgentActors,
  type AgentProfile as AgentProfileResult,
  type WorkProvenance as WorkProvenanceResult,
} from './agent-directory.js';
import { createComment, createIssue, createIssueInTransaction, deleteComment, deleteIssue, mentionTexts, updateIssue } from './issue-service.js';
import { projectWorkNotifications } from './notification-service.js';
import { auditMergedPrTraceability } from './traceability-audit.js';
import { suggestedBranchName } from './branch-name.js';
import { createWorkLink, deleteWorkLink, listIncidentLinks } from './link-service.js';
import { writeActorFromViewer } from './work-service.js';
import { getUploadsDirectory } from './uploads.js';
import { loadProjectWorkGraph, type ProjectWorkGraph } from './work-graph-view.js';
import { loadWorkTimelines } from './work-timeline.js';
import { dependencyHints } from './mention-links.js';
import { loadWorkHygiene } from './work-hygiene.js';
import { BUG_LABEL_NAME, findSimilarBugs, reportBug, type BugReportInput } from './bug-report.js';
import { loadBugSlas } from './bug-sla.js';
import { snapshotContract } from './evidence-contract.js';
import { loadBugMetrics, type BugMetrics } from './bug-metrics.js';
import { currentTriager, parseRotation, setTriageRotation } from './bug-triage.js';
import { releaseClaim } from './claim-release.js';
import { restoreWork } from './work-restore.js';
import {
  findWorkByIdOrIdentifier,
  getWorkContext,
  listReadyWork,
  OPEN_BLOCKER_LINK_WHERE,
  type ListReadyWorkInput,
  type WorkContextBundle,
} from './context-service.js';
import {
  claimWork,
  commitWork,
  placeNewWork,
  proposeWork,
  rejectWork,
  type ClaimWorkInput,
  type CommitWorkInput,
  type ProposeWorkInput,
  type RejectWorkInput,
} from './claim-service.js';
import { attachEvidence, reportRun, reviewWork } from './run-service.js';
import { uncommitWork } from './work-uncommit.js';
import { createProject, updateProject, deleteProject, type CreateProjectInput, type UpdateProjectInput } from './project-service.js';
import { createCycle, updateCycle, deleteCycle, type CreateCycleInput, type UpdateCycleInput } from './cycle-service.js';
import { orderWorkflowStates } from './workflow-state-order.js';

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type TeamParent = Team & { memberships?: TeamMembershipParent[] | null; states?: WorkflowState[] | null };
type TeamMembershipParent = TeamMembership & { user?: User | null };
type UserParent = User;
type CommentParent = Comment & { user?: User | null };
type AgentRequestParent = AgentRequest;
type DatabaseClient = PrismaClient | Prisma.TransactionClient;
type ProjectParent = Project & { lead?: User | null; team?: Team | null; issues?: Issue[] | null };
type CycleParent = Cycle & { team?: Team | null; issues?: Issue[] | null };
type IssueParent = Issue & {
  assignee?: User | null;
  comments?: CommentParent[] | null;
  children?: Issue[] | null;
  labels?: IssueLabel[] | null;
  parent?: Issue | null;
  state?: WorkflowState | null;
  team?: TeamParent | null;
  project?: Project | null;
  cycle?: Cycle | null;
  /** Present only when the list read batched `openBlockers`; each link carries its blocker. */
  incomingLinks?: Array<WorkLink & { from?: Issue | null }> | null;
};
type WorkLinkParent = WorkLink & { from?: Issue | null; to?: Issue | null };
type WorkClaimParent = WorkClaim & { actor?: User | null };
type AgentCredentialParent = AgentCredential & { user?: User | null };
type WorkShareParent = WorkShare & { createdBy?: User | null; user?: User | null };

interface StringComparatorInput {
  eq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
}

interface TeamFilterInput {
  key?: StringComparatorInput | null;
}

interface IssueLabelFilterInput {
  name?: StringComparatorInput | null;
}

interface BugSummaryResultShape {
  openCount: number;
  closedCount: number;
  byPriority: Array<{ priority: number; count: number }>;
  byRepository: Array<{ repository: string | null; openCount: number; closedCount: number }>;
  byTypeLabel: Array<{ label: string; count: number }>;
  unclaimedOpenCount: number;
  oldestOpenAgeDays: number | null;
  avgOpenAgeDays: number | null;
  createdPerWeek: Array<{ weekStart: string; count: number }>;
  metrics: BugMetrics;
}

type CommentOrderByInput = 'createdAt';
interface CursorPayload {
  createdAt: string;
  id: string;
}

const COMMENT_ORDER_BY: Prisma.CommentOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];
const MAX_COMMENTS_CONNECTION_FIRST = 100;
const MAX_AGENT_REQUESTS_CONNECTION_FIRST = 200;

const MAX_ISSUES_CONNECTION_FIRST = 200;

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const BUG_TREND_WEEKS = 8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function buildIssueListInclude(
  options: {
    includeChildren?: boolean;
    includeComments?: boolean;
    /** Readable-team filter for the blockers; set to batch `openBlockers` into the list read. */
    openBlockers?: { readableWhere: Prisma.IssueWhereInput | undefined };
  } = {},
): Prisma.IssueInclude {
  const include: Prisma.IssueInclude = {
    assignee: true,
    labels: {
      orderBy: {
        name: 'asc',
      },
    },
    parent: true,
    state: true,
    team: {
      include: {
        states: true,
      },
    },
  };

  if (options.includeChildren) {
    include.children = {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    };
  }

  if (options.openBlockers) {
    include.incomingLinks = buildOpenBlockerLinkQuery(options.openBlockers.readableWhere);
  }

  if (options.includeComments) {
    include.comments = {
      include: {
        user: true,
      },
      orderBy: COMMENT_ORDER_BY.slice(),
    };
  }

  return include;
}

function buildOpenBlockerLinkQuery(readableWhere: Prisma.IssueWhereInput | undefined) {
  return {
    where: readableWhere
      ? { ...OPEN_BLOCKER_LINK_WHERE, from: { ...OPEN_BLOCKER_LINK_WHERE.from, ...readableWhere } }
      : OPEN_BLOCKER_LINK_WHERE,
    include: { from: true },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  };
}

function buildIssueDetailInclude(): Prisma.IssueInclude {
  return buildIssueListInclude({
    includeChildren: true,
    includeComments: true,
  });
}

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value: unknown): string {
    return serializeDateTime(value);
  },
  parseValue(value: unknown): Date {
    if (typeof value !== 'string') {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return parseDateTime(value);
  },
  parseLiteral(ast): Date {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return parseDateTime(ast.value);
  },
});

const typeDefs = /* GraphQL */ `
  scalar DateTime

  type IssueSearchHit {
    issue: Issue!
    score: Float!
    "identifier, title, contract, description or comment: the strongest field a word was found in."
    matchedField: String!
    "Text around the first match outside the title."
    snippet: String
    "The comment the snippet came from, when it came from one."
    commentId: String
  }

  type Query {
    viewer: User
    viewerCapabilities: ViewerCapabilities!
    workspaceSettings: WorkspaceSettings!
    issue(id: String!): Issue
    issues(first: Int!, after: String, filter: IssueFilter, query: String): IssueConnection!
    "Archived teams are left out unless includeArchived is true."
    teams(filter: TeamFilter, includeArchived: Boolean): TeamConnection!
    issueLabels(filter: IssueLabelFilter): IssueLabelConnection!
    "Optional server features this deployment runs (on/off only; never URLs or secrets). Admins only."
    serverFeatures: [ServerFeature!]!
    users: UserConnection!
    projects(teamId: String!): ProjectConnection! @deprecated(reason: "Use issues query with kind: PROJECT and CONTAINS links instead.")
    project(id: String!): Project @deprecated(reason: "Use issue query with kind: PROJECT instead.")
    cycles(teamId: String!): CycleConnection! @deprecated(reason: "Use issues query with kind: MILESTONE and CONTAINS links instead.")
    cycle(id: String!): Cycle @deprecated(reason: "Use issue query with kind: MILESTONE instead.")
    workContext(id: String!): WorkContext
    readyWork(filter: ReadyWorkFilter, query: String): IssueConnection!
    """
    One project's work graph (INV-681): the nodes the project resolves to —
    by PROJECT identifier/UUID or by repository, the same resolution the ready
    queue uses — and every typed link touching them.
    """
    workGraph(project: String!, includeCandidates: Boolean): WorkGraph!
    """
    Where a team's committed work falls short of work-graph norm v1 (INV-718/721):
    unplaced items, mentions without links, prose dependencies without BLOCKS,
    finished research nothing derives from. Lists are capped at 200; counts are exact.
    """
    workHygiene(teamKey: String!): WorkHygiene!
    candidateSummary(teamFilter: TeamFilter): CandidateSummary!
    projectSummary(teamFilter: TeamFilter): ProjectSummaryResult!
    bugSummary(teamFilter: TeamFilter): BugSummaryResult!
    "Open bugs whose titles share words with the given title, best match first (INV-749)."
    similarBugs(teamId: String!, title: String!, first: Int): [Issue!]!
    """
    Free-text search over work items (INV-925): identifier, title, description,
    contract fields and comments, best match first. Every word must be found
    somewhere; "quoted phrases" stay together; INV-925, inv925 and 925 find the
    item by number. iql narrows the results. Same search as MCP work_search.
    """
    search(query: String!, first: Int, iql: String): [IssueSearchHit!]!
    traceabilityAudit(days: Int): TraceabilityAuditResult!
    """Non-human actors (AGENT and SERVICE), most recently active first. Backs the directory and @ completion."""
    agents(teamKey: String, includeDeactivated: Boolean): [User!]!
    """One agent's profile, by handle or id."""
    agentProfile(handle: String!): AgentProfile
    agentCredentials(teamId: String!): [AgentCredentialRecord!]!
    webhooks(teamId: String!): [WebhookSubscriptionRecord!]!
    "Sync, inbound queue, outbox and webhooks at a glance; admins only (INV-796)."
    opsOverview: OpsOverview!
    notifications(first: Int, after: String, unreadOnly: Boolean): NotificationConnection!
    unreadNotificationCount: Int!
  }

  type Mutation {
    issueCreate(input: IssueCreateInput!): IssueCreatePayload!
    bugReport(input: BugReportInput!): BugReportPayload!
    issueUpdate(id: String!, input: IssueUpdateInput!): IssueUpdatePayload!
    issueDelete(id: String!): IssueDeletePayload!
    commentCreate(input: CommentCreateInput!): CommentCreatePayload!
    commentDelete(id: String!): CommentDeletePayload!
    teamUpdateAccess(input: TeamUpdateAccessInput!): TeamUpdateAccessPayload!
    teamTriageRotationUpdate(input: TeamTriageRotationInput!): TeamTriageRotationPayload!
    "A person ends an agent's claim now, with a reason (INV-789); open runs under it are closed."
    workClaimRelease(workId: String!, reason: String!): WorkClaimReleasePayload!
    "Clear a sync dead letter so the next reconciliation retries that PR; admins only, audited (INV-796)."
    opsSyncDeadLetterClear(id: String!, reason: String!): OpsMutationPayload!
    "Replay a dead inbound GitHub delivery; admins only, audited (INV-796)."
    opsInboundReplay(id: String!, reason: String!, expectedAttempts: Int!): OpsMutationPayload!
    "A person turns rejected work back into a candidate, with a reason (INV-792)."
    workRestore(id: String!, reason: String!): WorkRestorePayload!
    teamMembershipUpsert(input: TeamMembershipUpsertInput!): TeamMembershipUpsertPayload!
    teamMembershipRemove(input: TeamMembershipRemoveInput!): TeamMembershipRemovePayload!
    projectCreate(input: ProjectCreateInput!): ProjectCreatePayload! @deprecated(reason: "Use issueCreate with kind: PROJECT instead.")
    projectUpdate(id: String!, input: ProjectUpdateInput!): ProjectUpdatePayload! @deprecated(reason: "Use issueUpdate instead.")
    projectDelete(id: String!): ProjectDeletePayload! @deprecated(reason: "Use issueDelete instead.")
    cycleCreate(input: CycleCreateInput!): CycleCreatePayload! @deprecated(reason: "Use issueCreate with kind: MILESTONE instead.")
    cycleUpdate(id: String!, input: CycleUpdateInput!): CycleUpdatePayload! @deprecated(reason: "Use issueUpdate instead.")
    cycleDelete(id: String!): CycleDeletePayload! @deprecated(reason: "Use issueDelete instead.")
    userUpdate(input: UserUpdateInput!): UserUpdatePayload!
    fileUpload(input: FileUploadInput!): FileUploadPayload!
    workPropose(input: WorkProposeInput!): WorkProposePayload!
    workLink(fromId: String!, toId: String!, type: WorkLinkType!): WorkLinkMutationPayload!
    workLinkDelete(id: String!): WorkLinkDeletePayload!
    """Share a PROJECT node with a person or agent, or change their role. Team OWNER or ADMIN only."""
    workShareUpsert(workId: String!, userId: String!, role: WorkShareRole!): WorkShareMutationPayload!
    workShareRemove(workId: String!, userId: String!): WorkShareMutationPayload!
    """Invite a person by email: a pending user with a workspace role and teams. Admins, or members when allowed."""
    userInvite(input: UserInviteInput!): UserAccessPayload!
    userInviteRevoke(id: String!): UserAccessPayload!
    """Sign a person out and refuse their sign-in. Admins only; never the last admin."""
    userSuspend(id: String!, reason: String): UserAccessPayload!
    userReactivate(id: String!, reason: String): UserAccessPayload!
    workspaceSettingsUpdate(input: WorkspaceSettingsUpdateInput!): WorkspaceSettingsPayload!
    """Create a team; the creator becomes its Owner (INV-848). Admins, or members when allowed."""
    teamCreate(input: TeamCreateInput!): TeamLifecyclePayload!
    """Rename a team or change its visibility. Team Owner or Admin."""
    teamUpdate(input: TeamUpdateInput!): TeamLifecyclePayload!
    teamArchive(teamId: String!): TeamLifecyclePayload!
    teamUnarchive(teamId: String!): TeamLifecyclePayload!
    """Join a public team as a Member."""
    teamJoin(teamId: String!): TeamLifecyclePayload!
    """Leave a team; its last Owner cannot."""
    teamLeave(teamId: String!): TeamLifecyclePayload!
    workCommit(id: String!, input: WorkCommitInput!): WorkCommitPayload!
    "A person reverses one commit, returning the work to the candidate queue (INV-844)."
    workUncommit(id: String!, expectedRevision: Int!): WorkCommitPayload!
    workReject(id: String!, input: WorkRejectInput!): WorkRejectPayload!
    workClaim(id: String!, input: WorkClaimInput): WorkClaimPayload!
    runReport(input: RunReportInput!): RunReportPayload!
    evidenceAttach(input: EvidenceAttachInput!): EvidenceAttachPayload!
    workReview(id: String!, input: WorkReviewInput!): WorkReviewPayload!
    agentCredentialCreate(input: AgentCredentialCreateInput!): AgentCredentialCreatePayload!
    """Deactivate an actor: keeps its id and history, revokes its credentials, ends its ability to act. Human-only."""
    actorDeactivate(id: String!, reason: String): ActorLifecyclePayload!
    """Undo a deactivation. Human-only, recorded in ActorAudit. Revoked credentials stay revoked."""
    actorReactivate(id: String!, reason: String): ActorLifecyclePayload!
    """A person retracts wrongly attached evidence: marked, audited, emitted — never deleted (INV-598)."""
    evidenceRetract(input: EvidenceRetractInput!): EvidenceRetractPayload!
    "Human-only. Apply an agent's proposed contract change as your own edit (INV-869)."
    contractAmendmentAccept(input: ContractAmendmentAcceptInput!): ContractAmendmentPayload!
    "Human-only. Decline an agent's proposed contract change, with a note (INV-869)."
    contractAmendmentReject(input: ContractAmendmentRejectInput!): ContractAmendmentPayload!
    """A person completes a request addressed to them (INV-596): comment, answeredCommentId, COMPLETED, audit and event in one transaction. An ADMIN may answer for someone else with an overrideReason."""
    agentRequestAnswer(input: AgentRequestAnswerInput!): AgentRequestAnswerPayload!
    "The requester answers a request that asked back (input-required); it goes back to its target (INV-794)."
    agentRequestReply(requestId: String!, body: String!, overrideReason: String): AgentRequestAnswerPayload!
    "Declare who takes over when this actor stops answering; null clears it. Set by people, recorded in ActorAudit (INV-794)."
    actorSetSuccessor(id: String!, successorId: String, reason: String): ActorLifecyclePayload!
    """Transfer accountability for a non-human actor to another human. Human-only, recorded in ActorAudit."""
    actorTransferOwner(id: String!, ownerId: String!, reason: String): ActorLifecyclePayload!
    """Provision a SERVICE actor for an external program (CI, cron, a bridge). Human-only."""
    serviceActorCreate(input: ServiceActorCreateInput!): ActorLifecyclePayload!
    agentCredentialRevoke(id: String!): AgentCredentialRevokePayload!
    webhookCreate(input: WebhookCreateInput!): WebhookMutationPayload!
    webhookUpdate(id: String!, input: WebhookUpdateInput!): WebhookMutationPayload!
    webhookDelete(id: String!): WebhookMutationPayload!
    webhookRotateSecret(id: String!): WebhookMutationPayload!
    notificationMarkRead(id: String!): NotificationMutationPayload!
    notificationsMarkAllRead: NotificationMarkAllPayload!
    notificationPreferencesUpdate(emailNotifications: Boolean!): NotificationPreferencesPayload!
    "Workspace settings (INV-797), admins only."
    labelCreate(name: String!): LabelMutationPayload!
    labelUpdate(id: String!, name: String!): LabelMutationPayload!
    labelDelete(id: String!): LabelDeletePayload!
    workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStateMutationPayload!
    workflowStateUpdate(id: String!, input: WorkflowStateUpdateInput!): WorkflowStateMutationPayload!
    workflowStateDelete(id: String!): WorkflowStateDeletePayload!
    userSetGlobalRole(userId: String!, role: GlobalRole!, reason: String): UserRolePayload!
  }

  type Team {
    id: ID!
    key: String!
    name: String!
    visibility: TeamVisibility!
    states: WorkflowStateConnection!
    memberships: TeamMembershipConnection!
    issueCount: Int!
    "Weekly bug triage rotation (INV-750); null when not configured."
    triageRotation: TriageRotation
    "Who triages bugs this week under the rotation."
    currentTriager: User
    "Whether the viewer may create and edit work in this team (EDITOR, OWNER, bound agent or ADMIN)."
    viewerCanWrite: Boolean!
    "Whether the viewer may manage this team's roster, access and agents (OWNER or ADMIN)."
    viewerCanManage: Boolean!
    "When the team was archived (read-only, hidden from the sidebar); null while active."
    archivedAt: DateTime
    "Whether the viewer may join this team themself (a public team they are not on)."
    viewerCanJoin: Boolean!
    "Whether the viewer is on this team's roster."
    viewerIsMember: Boolean!
  }

  type TriageRotation {
    users: [User!]!
    startsAt: String!
  }

  "A committed bug's SLA (INV-750): Urgent 24h, High 48h, otherwise 7 days; the clock stops in Review and when closed."
  type BugSla {
    status: BugSlaStatus!
    budgetHours: Int!
    elapsedMs: Float!
    remainingMs: Float!
    "When it runs out if nothing changes; null while paused or closed."
    dueAt: String
    startedAt: String!
  }

  enum BugSlaStatus {
    ON_TRACK
    AT_RISK
    BREACHED
    PAUSED
    MET
  }

  type WorkRestorePayload {
    success: Boolean!
    "Why the restore was refused; null on success."
    message: String
    issue: Issue
  }

  type OpsMutationPayload {
    success: Boolean!
    "Why it was refused; null on success."
    message: String
  }

  type OpsWatermark {
    key: String!
    repository: String!
    watermark: DateTime!
    updatedAt: DateTime!
  }

  type OpsSyncDeadLetter {
    id: ID!
    repository: String!
    itemRef: String!
    error: String!
    attempts: Int!
    lastFailedAt: DateTime!
  }

  type OpsInboundCount {
    status: String!
    count: Int!
  }

  type OpsInboundDelivery {
    id: ID!
    deliveryId: String!
    eventType: String!
    repository: String!
    attempts: Int!
    lastErrorCode: String
    receivedAt: DateTime!
    "False once the payload was compacted away; such a delivery cannot be replayed."
    replayable: Boolean!
  }

  type OpsInbound {
    counts: [OpsInboundCount!]!
    oldestPendingAt: DateTime
    dead: [OpsInboundDelivery!]!
  }

  type OpsOutboxFailure {
    id: ID!
    type: String!
    attempts: Int!
    lastError: String
    createdAt: DateTime!
    deadLetteredAt: DateTime
  }

  type OpsAuditRecord {
    id: ID!
    action: String!
    subject: String!
    byActor: User
    reason: String
    createdAt: DateTime!
  }

  type OpsOverview {
    watermarks: [OpsWatermark!]!
    syncDeadLetters: [OpsSyncDeadLetter!]!
    inbound: OpsInbound!
    outboxFailures: [OpsOutboxFailure!]!
    "Every subscription, all teams and global."
    webhooks: [WebhookSubscriptionRecord!]!
    "The latest ops actions, newest first."
    audits: [OpsAuditRecord!]!
  }

  type WorkClaimReleasePayload {
    success: Boolean!
    "Why the release was refused; null on success."
    message: String
    issue: Issue
  }

  input TeamTriageRotationInput {
    teamId: String!
    "Human members in rotation order; empty clears the rotation."
    userIds: [String!]!
    "When the first person's week starts (ISO); defaults to now."
    startsAt: String
  }

  type TeamTriageRotationPayload {
    success: Boolean!
    message: String
    team: Team
  }

  enum TeamVisibility {
    PRIVATE
    PUBLIC
  }

  enum TeamMembershipRole {
    VIEWER
    EDITOR
    OWNER
  }

  type TeamMembership {
    id: ID!
    role: TeamMembershipRole!
    user: User!
    team: Team!
  }

  enum WorkflowStateType {
    BACKLOG
    UNSTARTED
    STARTED
    REVIEW
    COMPLETED
    CANCELED
  }

  type WorkflowState {
    id: ID!
    name: String!
    type: WorkflowStateType!
    position: Int!
    "How many work items are in this state."
    issueCount: Int!
  }

  type IssueLabel {
    id: ID!
    name: String!
    "How many work items carry the label."
    issueCount: Int!
  }

  type ServerFeature {
    key: String!
    label: String!
    enabled: Boolean!
    detail: String!
  }

  type LabelMutationPayload {
    success: Boolean!
    label: IssueLabel
    "Why the mutation was refused; null on success."
    message: String
  }

  type LabelDeletePayload {
    success: Boolean!
    labelId: String
    "Why the mutation was refused; null on success."
    message: String
  }

  input WorkflowStateCreateInput {
    teamId: String!
    name: String!
    type: WorkflowStateType!
  }

  input WorkflowStateUpdateInput {
    name: String
    position: Int
  }

  type WorkflowStateMutationPayload {
    success: Boolean!
    state: WorkflowState
    "Why the mutation was refused; null on success."
    message: String
  }

  type WorkflowStateDeletePayload {
    success: Boolean!
    stateId: String
    "Why the mutation was refused; null on success."
    message: String
  }

  type UserRolePayload {
    success: Boolean!
    user: User
    "Why the mutation was refused; null on success."
    message: String
  }

  type User {
    id: ID!
    name: String
    email: String
    isMe: Boolean
    "Whether inbox notifications are also emailed. Only readable for yourself; null for anyone else."
    emailNotifications: Boolean
    globalRole: GlobalRole!
    actorKind: ActorKind!
    """Who picks up this actor's unanswered requests (INV-562)."""
    successorActor: User
    """The human accountable for a non-human actor. A responsibility, not a permission (INV-586)."""
    owner: User
    """Set when the actor was deactivated. Deactivated actors keep their id and history but cannot act."""
    deactivatedAt: DateTime
    """Lowercase alias this actor is addressed by in comments, as in @mia."""
    handle: String
    """Self-declared runtime, e.g. lumenbox / codex-cli / claude-code. Involute stores it, never interprets it."""
    runtime: String
    """What this actor is for."""
    description: String
    """A2A Agent Card location, when declared."""
    agentCardUrl: String
    """Last time this actor authenticated."""
    lastSeenAt: DateTime
    """Derived from lastSeenAt: active / idle / away / never-seen. Never stored."""
    presence: String!
    """Display copy for presence. States what was observed, never why."""
    presenceDetail: String!
    """How many credentials can act as this actor, and how many were revoked (INV-607)."""
    credentialCounts: AgentCredentialCounts!
    """ACTIVE, PENDING (invited, never signed in) or SUSPENDED (INV-847)."""
    accessStatus: String!
    invitedAt: DateTime
    """Teams this person is on that the viewer may see, with their role."""
    teamMemberships: [TeamMembership!]!
    """When the row was made; null for actors older than INV-604 with no earlier trace."""
    createdAt: DateTime
  }

  type AgentCredentialCounts {
    active: Int!
    revoked: Int!
  }

  enum GlobalRole {
    ADMIN
    "Shown as Member."
    USER
    "Sees only the teams they were added to and projects shared with them."
    GUEST
  }

  enum ActorKind {
    HUMAN
    AGENT
    SERVICE
  }

  enum WorkKind {
    ISSUE
    PROJECT
    MILESTONE
    DECISION
    EPIC
  }

  enum CommitmentStatus {
    CANDIDATE
    COMMITTED
    REJECTED
  }

  enum WorkLinkType {
    CONTAINS
    BLOCKS
    DERIVED_FROM
    DISCOVERED_DURING
    RELATED_TO
    DUPLICATE_OF
  }

  type Comment {
    id: ID!
    body: String!
    createdAt: DateTime!
    user: User
    """Actors resolved server-side from the @handles in the body (INV-558)."""
    mentions: [CommentMention!]!
    """Thread root this comment replies to; null when it is itself a root (INV-561)."""
    parentCommentId: String
    """Replies in this thread, oldest first. Empty for a reply — threads are one level deep."""
    replies(first: Int): [Comment!]!
  }

  """
  Where a work item came from. The actor is null when the creating path
  recorded none (internal/service writes); actorKind, surface and source still
  say what happened, so the UI is never silent (INV-573).
  """
  type WorkProvenance {
    actor: User
    actorKind: String
    surface: String
    source: String
  }

  type AgentTimelineEntry {
    at: DateTime!
    kind: String!
    detail: String
    workId: String
    workIdentifier: String
  }

  """A credential is the record of an agent being brought into existence."""
  type AgentCredentialSummary {
    id: ID!
    name: String!
    scopes: [String!]!
    teamKey: String
    createdAt: DateTime!
    expiresAt: DateTime
    revokedAt: DateTime
    """The human who minted it; null for operator-CLI issuance or rows older than INV-604."""
    issuedBy: User
  }

  type AgentActivityCounts {
    proposedWork: Int!
    openRequests: Int!
    answeredRequests: Int!
    runs: Int!
    evidence: Int!
  }

  """Who an agent is and what it has actually done (INV-573)."""
  type AgentProfile {
    actor: User!
    counts: AgentActivityCounts!
    """When and how this actor was created, and what it was granted."""
    credentials: [AgentCredentialSummary!]!
    """Whether the viewer may deactivate, reactivate or re-own this actor (owner or ADMIN)."""
    viewerCanManage: Boolean!
    """The actor's decision receipts — its own claims about what it knew and why, each bound to the audited write it explains. Not system-verified facts."""
    receipts: [AgentReceiptEntry!]!
    timeline: [AgentTimelineEntry!]!
  }

  type AgentReceiptEntry {
    auditId: String!
    surface: String
    work: Issue!
    receipt: DecisionReceiptRecord!
  }

  type CommentMention {
    id: ID!
    actor: User!
    createdAt: DateTime!
  }

  """A question put to one actor. States are A2A's task lifecycle (INV-560)."""
  type AgentRequest {
    id: ID!
    state: String!
    """Whether anyone appears to be working on it: waiting / live / unresponsive / stale / settled. Derived, never stored — it answers 'will it reply', which the A2A state does not."""
    presence: String!
    """Display copy for the presence. States what is observed, never why."""
    presenceDetail: String!
    body: String!
    deadlineAt: DateTime!
    createdAt: DateTime!
    failureReason: String
    rootCommentId: String!
    targetActor: User!
    requestedByActor: User!
    """Who to ask instead when this one does not answer."""
    successorActor: User
    answeredCommentId: String
    """Hand-off chain (INV-589): 0 for the original request, +1 per hand-off."""
    hopCount: Int!
    """The first request in this chain; null when this is it."""
    rootRequestId: String
    """The request this one was handed off from; null when it was asked directly."""
    handedOffFromId: String
    """When the whole chain must have reached a person."""
    chainDeadlineAt: DateTime
  }

  enum CommentOrderBy {
    createdAt
  }

  type Issue {
    id: ID!
    identifier: String!
    title: String!
    description: String
    priority: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    state: WorkflowState!
    labels: IssueLabelConnection!
    assignee: User
    parent: Issue
    children: IssueConnection!
    team: Team!
    project: Project
    cycle: Cycle
    projectId: String
    cycleId: String
    kind: WorkKind!
    commitmentStatus: CommitmentStatus!
    revision: Int!
    snoozedUntil: DateTime
    source: String
    outcome: String
    scope: String
    constraints: String
    acceptance: String
    verification: String
    repository: String
    alias: String
    links(type: WorkLinkType): WorkLinkConnection!
    """
    Committed work that still blocks this item: incoming BLOCKS links whose
    blocker is neither Done nor Canceled — the rule that keeps it out of the
    ready queue. Batched when read through the issues connection (INV-679).
    """
    openBlockers: [Issue!]!
    """
    Identifiers this item's text mentions next to dependency wording ("依赖",
    "blocked by", …) that have no BLOCKS edge either way — a prompt to record
    the dependency, never an automatic one (INV-720).
    """
    dependencyHints: [String!]!
    "SLA for committed Type: Bug work; null otherwise (INV-750)."
    bugSla: BugSla
    "Hash of the current execution contract (scope, constraints, repository, acceptance); a run whose contractRevision differs ran against an older contract (INV-790)."
    contractDigest: String!
    "The open proposal to change this committed contract, if an agent made one (INV-869)."
    pendingContractAmendment: ContractAmendment
    "Why it was rejected, from the audit that rejected it; null unless REJECTED (INV-792)."
    rejectionReason: String
    claim: WorkClaimRecord
    comments(first: Int, after: String, orderBy: CommentOrderBy, rootsOnly: Boolean): CommentConnection!
    """
    Questions put to agents on this work item (INV-560/562). The newest "first"
    requests, each with the rest of its hand-off chain filled in, returned
    oldest first. The cap limits which chains are shown, never a chain's hops,
    so the request currently awaiting an answer is always present with its root
    (INV-597 follow-up).
    """
    agentRequests(first: Int): [AgentRequest!]!
    """Who this PROJECT node is shared with beyond its team (INV-832). Empty unless the viewer may manage the team."""
    shares: [WorkShare!]!
    """Whether the viewer may share this PROJECT node (team OWNER or ADMIN)."""
    viewerCanShare: Boolean!
    """The actor that created this work — human or agent (INV-573)."""
    proposedByActor: User
    """How this work got here. Always answerable, even when no actor was recorded."""
    provenance: WorkProvenance!
  }

  type WorkLink {
    id: ID!
    type: WorkLinkType!
    from: Issue!
    to: Issue!
    createdAt: DateTime!
  }

  type WorkLinkConnection {
    nodes: [WorkLink!]!
  }

  type WorkAuditRecord {
    id: ID!
    revision: Int!
    actorKind: ActorKind!
    actor: User
    surface: String
    reason: String
    sessionId: String
    claimGeneration: Int
    createdAt: DateTime!
    """The actor's own statement of what it knew when it made this write. Always a claim (INV-588)."""
    receipt: DecisionReceiptRecord
  }

  type ReceiptReference {
    kind: String!
    ref: String!
    version: String
    digest: String
    excerpt: String
    """False when the reference is a bare pointer: what was seen cannot be reconstructed from it."""
    preserved: Boolean!
  }

  type DecisionReceiptRecord {
    id: ID!
    actor: User!
    sessionId: String
    runtime: String
    contractRevision: Int!
    reasoning: String!
    evidence: [ReceiptReference!]!
    inputs: [ReceiptReference!]!
    createdAt: DateTime!
  }

  type WorkGraph {
    root: Issue
    repository: String
    nodes: [Issue!]!
    """Readable work outside the project that a project item links to."""
    externalNodes: [Issue!]!
    edges: [WorkGraphEdge!]!
    """True when the project has more nodes than one read returns."""
    truncated: Boolean!
    """
    Each in-project node's actual path through the workflow, derived from its
    audit trail (INV-682). Computed only when asked for.
    """
    timeline: [WorkTimelineEntry!]!
    """The team's cycles, for the timeline's cycle band."""
    cycles: [Cycle!]!
  }

  enum WorkHistoryCompleteness {
    FULL
    PARTIAL
    NONE
  }

  type WorkStateTransition {
    at: DateTime!
    stateId: ID!
    stateName: String!
    stateType: WorkflowStateType!
  }

  type WorkTimelineEntry {
    workId: ID!
    committedAt: DateTime
    """First entry into In Progress, In Review or Done."""
    startedAt: DateTime
    reviewAt: DateTime
    """Entry into the current Done spell; null once reopened."""
    completedAt: DateTime
    canceledAt: DateTime
    transitions: [WorkStateTransition!]!
    """FULL when auditing covers the whole life; PARTIAL when it began later; NONE when there is no trail."""
    history: WorkHistoryCompleteness!
  }

  type WorkHygiene {
    unplacedCount: Int!
    unplaced: [Issue!]!
    unlinkedMentionCount: Int!
    unlinkedMentions: [WorkReferencePair!]!
    dependencyWithoutBlocksCount: Int!
    dependencyWithoutBlocks: [WorkReferencePair!]!
    researchWithoutDownstreamCount: Int!
    researchWithoutDownstream: [Issue!]!
  }

  type WorkReferencePair {
    from: Issue!
    to: Issue!
  }

  type WorkGraphEdge {
    id: ID!
    type: WorkLinkType!
    fromId: ID!
    toId: ID!
  }

  type WorkContext {
    work: Issue!
    ancestors: [Issue!]!
    blockedBy: [Issue!]!
    blocks: [Issue!]!
    claim: WorkClaimRecord
    audits: [WorkAuditRecord!]!
    runs: [WorkRunRecord!]!
    evidence: [WorkEvidenceRecord!]!
    reviewDecisions: [WorkReviewDecisionRecord!]!
  }

  enum WorkRunStatus {
    QUEUED
    RUNNING
    BLOCKED
    COMPLETED
    FAILED
  }

  enum WorkEvidenceKind {
    PR
    TEST
    LOG
    SCREENSHOT
    ARTIFACT
    DECISION
  }

  type WorkRunRecord {
    id: ID!
    publicId: String!
    actorId: String
    "Who ran it — e.g. the agent to reply to about a decision it asked for (INV-794)."
    actor: User
    claimId: String
    baseRevision: Int
    contractRevision: String
    acceptanceDigest: String
    repository: String
    commitSha: String
    pullRequestNumber: Int
    status: WorkRunStatus!
    phase: String
    summary: String
    externalUrl: String
    startedAt: DateTime!
    endedAt: DateTime
  }

  type EvidenceVerificationRecord {
    id: ID!
    status: String!
    verifierId: String!
    verifierVersion: String!
    contractRevision: String
    acceptanceDigest: String
    commitSha: String
    externalRunId: String
    failureCode: String
    resultDigest: String!
    observedAt: DateTime!
  }
  type WorkEvidenceRecord {
    verifications: [EvidenceVerificationRecord!]!
    id: ID!
    kind: WorkEvidenceKind!
    actorId: String
    runId: String
    url: String!
    summary: String
    createdAt: DateTime!
    """Retraction (INV-598): set when a person marked this evidence as wrongly attached. Never deleted."""
    retractedAt: DateTime
    retractReason: String
    retractedBy: User
    """The work item this evidence should have pointed at, when known."""
    supersededByWork: Issue
  }

  input EvidenceRetractInput {
    evidenceId: String!
    reason: String!
    correctWorkId: String
  }

  input ContractAmendmentAcceptInput {
    amendmentId: String!
    "Optional; recorded with the decision."
    note: String
  }

  input ContractAmendmentRejectInput {
    amendmentId: String!
    "Why: the agent reads it in work_get_context."
    note: String!
  }

  type ContractAmendmentPayload {
    success: Boolean!
    "Why the decision was refused; null on success."
    message: String
    amendment: ContractAmendment
    issue: Issue
  }

  type EvidenceRetractPayload {
    success: Boolean!
    "Why the retraction was refused; null on success."
    message: String
    evidence: WorkEvidenceRecord
  }

  enum WorkReviewDecisionKind {
    ACCEPTED
    REJECTED
  }

  type WorkReviewDecisionRecord {
    id: ID!
    decision: WorkReviewDecisionKind!
    reason: String
    fromRevision: Int!
    toRevision: Int!
    createdAt: DateTime!
    reviewer: User!
    run: WorkRunRecord
  }

  "One field of a proposed contract change (INV-869)."
  type ContractFieldChange {
    field: String!
    "What the field said when the change was proposed."
    before: String
    "What the agent proposes it should say; null clears it."
    after: String
  }

  enum ContractAmendmentStatus {
    PENDING
    ACCEPTED
    REJECTED
    SUPERSEDED
  }

  """
  A change to a committed contract that an agent proposed (INV-869). Agents may
  not rewrite a committed contract; a person accepts the change (applied as
  their own edit) or rejects it with a note.
  """
  type ContractAmendment {
    id: ID!
    status: ContractAmendmentStatus!
    reason: String!
    changes: [ContractFieldChange!]!
    proposedBy: User!
    "The proposer holds the claim on this work: it is asking to change the terms its own work is judged by."
    proposedByClaimant: Boolean!
    "A field it changes no longer says what it said when proposed, so it cannot be accepted as is."
    stale: Boolean!
    createdAt: DateTime!
    decidedBy: User
    decidedAt: DateTime
    decisionNote: String
  }

  type WorkClaimRecord {
    id: ID!
    actor: User!
    leaseUntil: DateTime!
    createdAt: DateTime!
  }

  type AgentCredentialRecord {
    id: ID!
    name: String!
    scopes: [String!]!
    teamId: String
    createdAt: DateTime!
    expiresAt: DateTime
    revokedAt: DateTime
    user: User!
    issuedBy: User
  }

  input AgentRequestAnswerInput {
    requestId: String!
    body: String!
    overrideReason: String
    "completed (default), failed, or input-required to ask the requester back — the same choices an agent has (INV-794)."
    state: String
  }

  type AgentRequestAnswerPayload {
    success: Boolean!
    request: AgentRequest
    comment: Comment
    "Why the mutation was refused; null on success."
    message: String
  }

  type ActorLifecyclePayload {
    success: Boolean!
    actor: User
    "Why the mutation was refused; null on success."
    message: String
  }

  input ServiceActorCreateInput {
    name: String!
    handle: String!
    description: String
    email: String
    """Defaults to the caller."""
    ownerId: String
  }

  input AgentCredentialCreateInput {
    team: String!
    name: String!
    email: String
    scopes: [String!]
    expiresAt: DateTime
    """Mention handle (@handle). Derived from the name when omitted; must be unused."""
    handle: String
    """The human accountable for a new actor. Defaults to the caller."""
    ownerId: String
    runtime: String
    description: String
    agentCardUrl: String
  }

  type AgentCredentialCreatePayload {
    success: Boolean!
    credential: AgentCredentialRecord
    token: String
    "Why the mutation was refused; null on success."
    message: String
  }

  type AgentCredentialRevokePayload {
    success: Boolean!
    credential: AgentCredentialRecord
    "Why the mutation was refused; null on success."
    message: String
  }

  type WebhookSubscriptionRecord {
    id: ID!
    label: String
    url: String!
    teamId: String
    eventTypes: [String!]!
    filterQuery: String
    enabled: Boolean!
    consecutiveFailures: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input WebhookCreateInput {
    team: String
    url: String!
    label: String
    eventTypes: [String!]
    filterQuery: String
  }

  input WebhookUpdateInput {
    url: String
    label: String
    eventTypes: [String!]
    filterQuery: String
    enabled: Boolean
  }

  type WebhookMutationPayload {
    success: Boolean!
    subscription: WebhookSubscriptionRecord
    secret: String
    "Why the mutation was refused; null on success."
    message: String
  }

  scalar Json

  type NotificationRecord {
    id: ID!
    type: String!
    work: Issue
    payload: Json!
    readAt: DateTime
    createdAt: DateTime!
  }

  type NotificationConnection {
    nodes: [NotificationRecord!]!
    pageInfo: PageInfo!
  }

  type NotificationMutationPayload {
    success: Boolean!
    notification: NotificationRecord
    "Why the mutation was refused; null on success."
    message: String
  }

  type NotificationMarkAllPayload {
    success: Boolean!
    count: Int!
    "Why the mutation was refused; null on success."
    message: String
  }

  type NotificationPreferencesPayload {
    success: Boolean!
    emailNotifications: Boolean!
    "Why the mutation was refused; null on success."
    message: String
  }

  type Project {
    id: ID!
    name: String!
    description: String
    color: String!
    status: String!
    targetDate: DateTime
    team: Team!
    lead: User
    issues: IssueConnection!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Cycle {
    id: ID!
    name: String!
    number: Int!
    startsAt: DateTime!
    endsAt: DateTime!
    team: Team!
    issues: IssueConnection!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Attachment {
    id: ID!
    filename: String!
    mimeType: String!
    size: Int!
    url: String!
    createdAt: DateTime!
  }

  type TeamConnection {
    nodes: [Team!]!
  }

  type WorkflowStateConnection {
    nodes: [WorkflowState!]!
  }

  type IssueLabelConnection {
    nodes: [IssueLabel!]!
  }

  type IssueConnection {
    nodes: [Issue!]!
    pageInfo: PageInfo!
  }

  type UserConnection {
    nodes: [User!]!
  }

  type TeamMembershipConnection {
    nodes: [TeamMembership!]!
  }

  type ProjectConnection {
    nodes: [Project!]!
  }

  type CycleConnection {
    nodes: [Cycle!]!
  }

  type CommentConnection {
    nodes: [Comment!]!
    pageInfo: PageInfo!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type CandidateProjectSummary {
    repository: String!
    totalCount: Int!
  }

  type CandidateSummary {
    totalCount: Int!
    noRepositoryCount: Int!
    projects: [CandidateProjectSummary!]!
  }

  type ProjectSummaryItem {
    repository: String!
    name: String!
    identifier: String
    totalCount: Int!
  }

  type ProjectSummaryResult {
    totalCount: Int!
    noRepositoryCount: Int!
    projects: [ProjectSummaryItem!]!
  }

  input StringComparator {
    eq: String
    in: [String!]
    nin: [String!]
    isNull: Boolean
  }

  input BooleanComparator {
    eq: Boolean
  }

  input TeamFilter {
    key: StringComparator
  }

  input WorkflowStateFilterRef {
    name: StringComparator
    "Match by lifecycle type: names can be renamed, types cannot."
    type: WorkflowStateTypeComparator
  }

  input WorkflowStateTypeComparator {
    eq: WorkflowStateType
  }

  input UserFilterRef {
    isMe: BooleanComparator
  }

  input IssueLabelFilterRef {
    name: StringComparator
  }

  input IssueLabelRelationFilter {
    some: IssueLabelFilterRef
    every: IssueLabelFilterRef
  }

  input IntComparator {
    eq: Int
  }

  input DateTimeComparator {
    gte: DateTime
  }

  input IssueFilter {
    and: [IssueFilter!]
    team: TeamFilter
    state: WorkflowStateFilterRef
    assignee: UserFilterRef
    labels: IssueLabelRelationFilter
    kind: WorkKind
    commitmentStatus: CommitmentStatus
    priority: IntComparator
    repository: StringComparator
    updatedAt: DateTimeComparator
  }

  input ReadyWorkFilter {
    first: Int
    kind: WorkKind
    priority: Int
    projectId: String
    repository: String
    teamKey: String
  }

  input IssueLabelFilter {
    name: StringComparator
  }

  input IssueCreateInput {
    teamId: String!
    title: String!
    description: String
    "What is true once it is done (e.g. a milestone's outcome, INV-792)."
    outcome: String
    stateId: String
    priority: Int
    projectId: String
    cycleId: String
    kind: WorkKind
    assigneeId: String
    labelIds: [String!]
    repository: String
    "Required unless kind is PROJECT (INV-744): id or identifier of the PROJECT (No milestone), MILESTONE, EPIC or ISSUE it goes under. The repository is inherited when omitted."
    parentId: String
  }

  input BugReportInput {
    teamId: String!
    title: String!
    description: String
    "Required (INV-749); appended to the description as a Steps to reproduce section."
    stepsToReproduce: String
    "Required, 1 (Urgent) to 4 (Low)."
    priority: Int
    "Where it belongs (id or identifier: its PROJECT for No milestone, a MILESTONE, EPIC or ISSUE). Omit when unsure: the report goes to triage as a candidate."
    parentId: String
    repository: String
    labelIds: [String!]
  }

  type BugReportPayload {
    success: Boolean!
    "Why the report was refused; null on success."
    message: String
    issue: Issue
  }

  type BugPriorityCount {
    priority: Int!
    count: Int!
  }

  type BugRepositoryCount {
    repository: String
    openCount: Int!
    closedCount: Int!
  }

  type BugTypeLabelCount {
    label: String!
    count: Int!
  }

  type BugWeekCount {
    weekStart: String!
    count: Int!
  }

  type BugSummaryResult {
    openCount: Int!
    closedCount: Int!
    byPriority: [BugPriorityCount!]!
    byRepository: [BugRepositoryCount!]!
    byTypeLabel: [BugTypeLabelCount!]!
    unclaimedOpenCount: Int!
    oldestOpenAgeDays: Float
    avgOpenAgeDays: Float
    createdPerWeek: [BugWeekCount!]!
    "Triage, SLA, source and placement (INV-751)."
    metrics: BugMetrics!
  }

  type BugMetrics {
    "Hours from report to commit or decline, for bugs that went through triage."
    triageHoursP50: Float
    triageHoursP90: Float
    triagedCount: Int!
    "Bug candidates waiting in triage."
    untriagedCount: Int!
    slaMetCount: Int!
    slaBreachedClosedCount: Int!
    "Share of closed bugs fixed within their SLA; null before any closed."
    slaMetRate: Float
    atRiskOpenCount: Int!
    breachedOpen: [BugBreach!]!
    bySource: [BugSourceCount!]!
    "Committed open bugs no parent contains; the goal is zero."
    unplacedOpenCount: Int!
  }

  type BugBreach {
    id: ID!
    identifier: String!
    title: String!
    overdueHours: Float!
  }

  enum BugSource {
    HUMAN_REPORT
    AGENT
    OTHER
  }

  type BugSourceCount {
    source: BugSource!
    count: Int!
  }

  type TraceabilityAnomaly {
    repository: String!
    prNumber: Int!
    prTitle: String!
    prUrl: String!
    identifier: String
    reason: String!
  }

  type TraceabilityRepoError {
    repository: String!
    message: String!
  }

  type TraceabilityAuditResult {
    scannedPrCount: Int!
    days: Int!
    anomalies: [TraceabilityAnomaly!]!
    repoErrors: [TraceabilityRepoError!]!
  }

  input IssueUpdateInput {
    expectedRevision: Int
    stateId: String
    labelIds: [String!]
    parentId: String
    title: String
    description: String
    assigneeId: String
    priority: Int
    projectId: String
    cycleId: String
    snoozedUntil: DateTime
    kind: WorkKind
    alias: String
    repository: String
    cascadeRepository: Boolean
    # Contract fields. Humans may rewrite them on committed work; agents are
    # refused once the work is committed.
    outcome: String
    scope: String
    constraints: String
    acceptance: String
    verification: String
  }

  input ProjectCreateInput {
    teamId: String!
    name: String!
    description: String
    color: String
    status: String
    targetDate: String
    leadId: String
  }

  input ProjectUpdateInput {
    name: String
    description: String
    color: String
    status: String
    targetDate: String
    leadId: String
  }

  input CycleCreateInput {
    teamId: String!
    name: String!
    startsAt: String!
    endsAt: String!
  }

  input CycleUpdateInput {
    name: String
    startsAt: String
    endsAt: String
  }

  input UserUpdateInput {
    name: String
    email: String
  }

  input FileUploadInput {
    filename: String!
    mimeType: String!
    content: String!
  }

  input CommentCreateInput {
    issueId: String!
    body: String!
    """Reply into an existing thread on the same work item. A reply to a reply attaches to the same root."""
    parentCommentId: String
  }

  input TeamUpdateAccessInput {
    teamId: String!
    visibility: TeamVisibility!
  }

  input TeamMembershipUpsertInput {
    teamId: String!
    email: String!
    name: String
    role: TeamMembershipRole!
  }

  input TeamMembershipRemoveInput {
    teamId: String!
    userId: String!
  }

  type IssueCreatePayload {
    success: Boolean!
    "Why the server refused the creation; null on success."
    message: String
    issue: Issue
  }

  type IssueUpdatePayload {
    success: Boolean!
    issue: Issue
    "Why the update was refused (revision conflict, missing acceptance, ...); null on success."
    message: String
  }

  type IssueDeletePayload {
    success: Boolean!
    issueId: ID
    "Why the mutation was refused; null on success."
    message: String
  }

  type CommentCreatePayload {
    success: Boolean!
    comment: Comment
    "Why the mutation was refused; null on success."
    message: String
  }

  type CommentDeletePayload {
    success: Boolean!
    commentId: ID
    "Why the mutation was refused; null on success."
    message: String
  }

  type TeamUpdateAccessPayload {
    success: Boolean!
    team: Team
    "Why the mutation was refused; null on success."
    message: String
  }

  type TeamMembershipUpsertPayload {
    success: Boolean!
    membership: TeamMembership
    "Why the mutation was refused; null on success."
    message: String
  }

  type TeamMembershipRemovePayload {
    success: Boolean!
    membershipId: ID
    "Why the mutation was refused; null on success."
    message: String
  }

  type ProjectCreatePayload {
    success: Boolean!
    project: Project
    "Why the mutation was refused; null on success."
    message: String
  }

  type ProjectUpdatePayload {
    success: Boolean!
    project: Project
    "Why the mutation was refused; null on success."
    message: String
  }

  type ProjectDeletePayload {
    success: Boolean!
    projectId: ID
    "Why the mutation was refused; null on success."
    message: String
  }

  type CycleCreatePayload {
    success: Boolean!
    cycle: Cycle
    "Why the mutation was refused; null on success."
    message: String
  }

  type CycleUpdatePayload {
    success: Boolean!
    cycle: Cycle
    "Why the mutation was refused; null on success."
    message: String
  }

  type CycleDeletePayload {
    success: Boolean!
    cycleId: ID
    "Why the mutation was refused; null on success."
    message: String
  }

  type UserUpdatePayload {
    success: Boolean!
    user: User
    "Why the mutation was refused; null on success."
    message: String
  }

  type FileUploadPayload {
    success: Boolean!
    attachment: Attachment
    "Why the mutation was refused; null on success."
    message: String
  }

  input WorkProposeInput {
    teamId: String!
    title: String!
    description: String
    outcome: String
    scope: String
    constraints: String
    acceptance: String
    verification: String
    repository: String
    kind: WorkKind
    """Parent that CONTAINS this item (identifier or id). Committing requires one; DISCOVERED_DURING/DERIVED_FROM proposals inherit it when omitted."""
    parentId: String
    relatedWorkId: String
    relatedWorkType: WorkLinkType
    """Label names, created when missing (e.g. research)."""
    labels: [String!]
    """Required when labels include bug: 1 (Urgent) to 4 (Low). Sets the SLA. The bug is committed directly (INV-787) and never enters Candidates; missing parent or steps is refused."""
    priority: Int
    """Steps to reproduce a bug; appended to the description."""
    stepsToReproduce: String
    """Existing work this proposal is blocked by (each X BLOCKS the new item)."""
    blockedBy: [String!]
    """Existing work this proposal blocks."""
    blocks: [String!]
    idempotencyKey: String
    source: String
    initialState: String
  }

  input WorkCommitInput {
    expectedRevision: Int!
    "1 (Urgent) to 4 (Low). Required to commit a bug: it sets the SLA (INV-750)."
    priority: Int
    """Place the candidate under this parent (identifier or id) as part of committing it. Committed work needs a parent (INV-719)."""
    parentId: String
    acceptance: String
    assigneeId: String
    outcome: String
    scope: String
    constraints: String
    verification: String
    idempotencyKey: String
    stateId: String
  }

  input WorkClaimInput {
    leaseSeconds: Int
    idempotencyKey: String
  }

  input WorkRejectInput {
    expectedRevision: Int!
    reason: String
    idempotencyKey: String
  }

  type WorkProposePayload {
    success: Boolean!
    issue: Issue
    "Why the mutation was refused; null on success."
    message: String
  }

  enum WorkShareRole {
    VIEWER
    EDITOR
  }

  """A PROJECT node shared with one person or agent outside its team (INV-832)."""
  type WorkShare {
    id: ID!
    role: WorkShareRole!
    user: User!
    createdBy: User
    createdAt: DateTime!
  }

  """Workspace-wide access switches (docs/permissions.md). Admins only."""
  type WorkspaceSettings {
    approvedDomains: [String!]!
    defaultTeams: [Team!]!
    membersCanInvite: Boolean!
    membersCanCreateTeams: Boolean!
  }

  input WorkspaceSettingsUpdateInput {
    approvedDomains: [String!]
    defaultTeamIds: [String!]
    membersCanInvite: Boolean
    membersCanCreateTeams: Boolean
  }

  type WorkspaceSettingsPayload {
    success: Boolean!
    message: String
    settings: WorkspaceSettings
  }

  input TeamCreateInput {
    key: String!
    name: String!
    visibility: TeamVisibility
  }

  input TeamUpdateInput {
    teamId: String!
    name: String
    visibility: TeamVisibility
  }

  type TeamLifecyclePayload {
    success: Boolean!
    message: String
    team: Team
  }

  """What the viewer may do at workspace level; the UI shows controls from this."""
  type ViewerCapabilities {
    isAdmin: Boolean!
    canInvite: Boolean!
    canCreateTeams: Boolean!
  }

  input InviteTeamInput {
    teamId: String!
    role: TeamMembershipRole!
  }

  input UserInviteInput {
    email: String!
    name: String
    role: GlobalRole!
    teams: [InviteTeamInput!]
  }

  type UserAccessPayload {
    success: Boolean!
    message: String
    user: User
    """Invites only: whether an email left the server (needs SMTP), why not, and the link to send by hand."""
    emailSent: Boolean
    emailNote: String
    signInUrl: String
  }

  type WorkShareMutationPayload {
    success: Boolean!
    message: String
    share: WorkShare
  }

  type WorkLinkMutationPayload {
    success: Boolean!
    link: WorkLink
    """Why the link was refused (unknown work, cycle, hierarchy rule); null on success."""
    message: String
  }

  type WorkLinkDeletePayload {
    success: Boolean!
    id: String
    """Why the removal was refused; null on success."""
    message: String
  }

  type WorkCommitPayload {
    success: Boolean!
    issue: Issue
    """Why the commit was refused (e.g. no parent, no acceptance); null on success."""
    message: String
  }

  type WorkRejectPayload {
    success: Boolean!
    "Why the rejection was refused, e.g. a bug declined without a reason; null on success."
    message: String
    issue: Issue
  }

  type WorkClaimPayload {
    success: Boolean!
    issue: Issue
    claim: WorkClaimRecord
    suggestedBranch: String
    "Why the mutation was refused; null on success."
    message: String
  }

  input RunReportInput {
    commitSha: String
    pullRequestNumber: Int
    workId: String!
    runId: String
    status: String
    phase: String
    summary: String
    externalUrl: String
    decisionRequested: Boolean
    idempotencyKey: String
  }

  input EvidenceAttachInput {
    workId: String!
    "The run the evidence backs. Required for agents; a person recording evidence after the fact may omit it (INV-796)."
    runId: String
    kind: String!
    url: String!
    summary: String
    idempotencyKey: String
  }

  input WorkReviewInput {
    expectedRevision: Int!
    decision: WorkReviewDecisionKind!
    reason: String
    runId: String
    idempotencyKey: String
  }

  type RunReportPayload {
    success: Boolean!
    issue: Issue
    run: WorkRunRecord
    "Why the mutation was refused; null on success."
    message: String
  }

  type EvidenceAttachPayload {
    success: Boolean!
    issue: Issue
    evidence: WorkEvidenceRecord
    "Why the mutation was refused; null on success."
    message: String
  }

  type WorkReviewPayload {
    success: Boolean!
    "Why the review was refused (e.g. revision changed, not in Review); null on success."
    message: String
    issue: Issue
    decision: WorkReviewDecisionRecord
  }
`;

const resolvers = {
  ContractAmendment: {
    changes: (parent: ContractAmendment) => amendmentChanges(parent),
    proposedBy: (parent: ContractAmendment, _args: Record<string, never>, context: GraphQLContext): Promise<User> =>
      context.prisma.user.findUniqueOrThrow({ where: { id: parent.proposedById } }),
    decidedBy: (parent: ContractAmendment, _args: Record<string, never>, context: GraphQLContext): Promise<User | null> =>
      parent.decidedById ? context.prisma.user.findUnique({ where: { id: parent.decidedById } }) : Promise.resolve(null),
    proposedByClaimant: async (parent: ContractAmendment, _args: Record<string, never>, context: GraphQLContext): Promise<boolean> => {
      const claim = await context.prisma.workClaim.findUnique({ where: { workId: parent.workId }, select: { actorId: true } });
      return claim?.actorId === parent.proposedById;
    },
    stale: async (parent: ContractAmendment, _args: Record<string, never>, context: GraphQLContext): Promise<boolean> => {
      if (parent.status !== 'PENDING') return false;
      const work = await context.prisma.issue.findUniqueOrThrow({ where: { id: parent.workId } });
      return isAmendmentStale(parent, work);
    },
  },
  WorkEvidenceRecord: {
    retractedBy: async (parent: WorkEvidence, _args: Record<string, never>, context: GraphQLContext): Promise<User | null> =>
      parent.retractedById ? context.prisma.user.findUnique({ where: { id: parent.retractedById } }) : null,
    supersededByWork: async (parent: WorkEvidence, _args: Record<string, never>, context: GraphQLContext): Promise<Issue | null> => {
      if (!parent.supersededByWorkId) return null;
      // Read authorization on the referenced item: a reader of this evidence
      // who may not read the other team's work gets null, not the item.
      try {
        await assertCanReadIssue(context.prisma, context, parent.supersededByWorkId);
      } catch {
        return null;
      }
      return getIssueById(context.prisma, parent.supersededByWorkId);
    },
    verifications: (parent: { id: string }, _args: unknown, context: GraphQLContext) =>
      context.prisma.evidenceVerification.findMany({ where: { evidenceId: parent.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
  },
  DateTime: DateTimeScalar,
  Json: new GraphQLScalarType({
    name: 'Json',
    description: 'Arbitrary JSON payload.',
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: (ast) => valueFromASTUntyped(ast),
  }),
  Query: {
    serverFeatures: (_parent: unknown, _args: unknown, context: GraphQLContext): ServerFeature[] => {
      assertSettingsAdmin(context);
      return listServerFeatures();
    },
    viewer: (_parent: unknown, _args: Record<string, never>, context: GraphQLContext): User | null =>
      context.viewer,
    viewerCapabilities: async (_parent: unknown, _args: Record<string, never>, context: GraphQLContext) => {
      const viewer = context.viewer;
      const human = viewer && viewer.actorKind === 'HUMAN' ? viewer : null;
      const settings = await getWorkspaceSettings(context.prisma);
      return {
        canCreateTeams: human?.globalRole === 'ADMIN' || (human?.globalRole === 'USER' && settings.membersCanCreateTeams),
        canInvite: await canInvite(context.prisma, human ? { actorId: human.id, actorKind: human.actorKind, globalRole: human.globalRole } : null),
        isAdmin: human?.globalRole === 'ADMIN',
      };
    },
    workspaceSettings: async (_parent: unknown, _args: Record<string, never>, context: GraphQLContext) => {
      assertSettingsAdmin(context);
      return getWorkspaceSettings(context.prisma);
    },
    issue: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<IssueParent | null> => {
      try {
        const issue = await context.prisma.issue.findUnique({
          where: {
            id: args.id,
          },
          include: buildIssueDetailInclude(),
        });

        if (issue) {
          await assertCanReadIssue(context.prisma, context, issue.id);
          return issue;
        }
      } catch (error) {
        if (!isPrismaInvalidInputError(error)) {
          throw error;
        }
      }

      const issue = await context.prisma.issue.findUnique({
        where: {
          identifier: args.id,
        },
        include: buildIssueDetailInclude(),
      });

      if (issue) {
        await assertCanReadIssue(context.prisma, context, issue.id);
      }

      return issue;
    },
    issues: async (
      _parent: unknown,
      args: { after?: string | null; filter?: IssueFilterInput | null; first: number; query?: string | null },
      context: GraphQLContext,
      info: GraphQLResolveInfo,
    ): Promise<{ nodes: IssueParent[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const first = clampConnectionFirst(args.first, MAX_ISSUES_CONNECTION_FIRST);
      const iqlWhere = args.query?.trim()
        ? compileIqlToIssueWhere(parseIqlOrThrow(args.query), { viewerId: context.viewer?.id ?? null })
        : undefined;
      const where = combineIssueWhere(
        combineIssueWhere(
          combineIssueWhere(
            buildIssueWhere(args.filter, context.viewer?.id ?? null),
            buildReadableIssueWhere(context),
          ),
          iqlWhere,
        ),
        buildIssueCursorWhere(args.after),
      );
      const requestedIssueFields = getRequestedIssueConnectionFields(info);
      const issues = await context.prisma.issue.findMany({
        ...(where ? { where } : {}),
        include: buildIssueListInclude({
          includeChildren: requestedIssueFields.has('children'),
          includeComments: requestedIssueFields.has('comments'),
          ...(requestedIssueFields.has('openBlockers')
            ? { openBlockers: { readableWhere: buildReadableIssueWhere(context) } }
            : {}),
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: first + 1,
      });
      const nodes = issues.slice(0, first);

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, issues.length > first),
      };
    },
    teams: async (
      _parent: unknown,
      args: { filter?: TeamFilterInput | null; includeArchived?: boolean | null },
      context: GraphQLContext,
    ): Promise<{ nodes: Team[] }> => {
      const where = combineTeamWhere(
        combineTeamWhere(buildTeamWhere(args.filter), buildReadableTeamWhere(context)),
        args.includeArchived ? undefined : { archivedAt: null },
      );

      return {
        nodes: await context.prisma.team.findMany({
          ...(where ? { where } : {}),
          orderBy: {
            key: 'asc',
          },
        }),
      };
    },
    candidateSummary: async (
      _parent: unknown,
      args: { teamFilter?: TeamFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ totalCount: number; noRepositoryCount: number; projects: Array<{ repository: string; totalCount: number }> }> => {
      const readableWhere = buildReadableIssueWhere(context);
      const teamKey = args.teamFilter?.key?.eq;
      const where: Prisma.IssueWhereInput = {
        commitmentStatus: 'CANDIDATE',
        ...(teamKey ? { team: { is: { key: teamKey } } } : {}),
        ...(readableWhere ? readableWhere : {}),
      };

      const groups = await context.prisma.issue.groupBy({
        by: ['repository'],
        where,
        _count: { _all: true },
      });

      let totalCount = 0;
      let noRepositoryCount = 0;
      const projects: Array<{ repository: string; totalCount: number }> = [];

      for (const group of groups) {
        const count = group._count._all;
        totalCount += count;
        if (group.repository) {
          projects.push({
            repository: group.repository,
            totalCount: count,
          });
        } else {
          noRepositoryCount += count;
        }
      }

      projects.sort((a, b) => a.repository.localeCompare(b.repository));

      return {
        totalCount,
        noRepositoryCount,
        projects,
      };
    },
    projectSummary: async (
      _parent: unknown,
      args: { teamFilter?: TeamFilterInput | null },
      context: GraphQLContext,
    ): Promise<{
      totalCount: number;
      noRepositoryCount: number;
      projects: Array<{
        repository: string;
        name: string;
        identifier: string | null;
        totalCount: number;
      }>;
    }> => {
      const readableWhere = buildReadableIssueWhere(context);
      const teamKey = args.teamFilter?.key?.eq;
      const teamKeyIn = args.teamFilter?.key?.in;
      const teamClause = teamKey
        ? { team: { is: { key: teamKey } } }
        : teamKeyIn && teamKeyIn.length > 0
          ? { team: { is: { key: { in: teamKeyIn } } } }
          : {};

      const where: Prisma.IssueWhereInput = {
        commitmentStatus: 'COMMITTED',
        ...teamClause,
        ...(readableWhere ? readableWhere : {}),
      };

      const groups = await context.prisma.issue.groupBy({
        by: ['repository'],
        where,
        _count: { _all: true },
      });

      const projectNodes = await context.prisma.issue.findMany({
        where: {
          commitmentStatus: 'COMMITTED',
          kind: 'PROJECT',
          repository: { not: null },
          ...teamClause,
          ...(readableWhere ? readableWhere : {}),
        },
        select: {
          id: true,
          identifier: true,
          title: true,
          repository: true,
        },
      });

      const projectMap = new Map(
        projectNodes
          .filter((p): p is typeof p & { repository: string } => Boolean(p.repository))
          .map((p) => [p.repository, p]),
      );

      let totalCount = 0;
      let noRepositoryCount = 0;
      const projects: Array<{
        repository: string;
        name: string;
        identifier: string | null;
        totalCount: number;
      }> = [];

      for (const group of groups) {
        const count = group._count._all;
        totalCount += count;
        if (group.repository) {
          const projectNode = projectMap.get(group.repository);
          projects.push({
            repository: group.repository,
            name: projectNode?.title || group.repository,
            identifier: projectNode?.identifier ?? null,
            totalCount: count,
          });
        } else {
          noRepositoryCount += count;
        }
      }

      projects.sort((a, b) => a.repository.localeCompare(b.repository));

      return {
        totalCount,
        noRepositoryCount,
        projects,
      };
    },
    search: async (
      _parent: unknown,
      args: { query: string; first?: number | null; iql?: string | null },
      context: GraphQLContext,
    ): Promise<IssueSearchHit[]> => {
      requireAuthentication(context);
      const iqlWhere = args.iql?.trim()
        ? compileIqlToIssueWhere(parseIqlOrThrow(args.iql), { viewerId: context.viewer?.id ?? null })
        : undefined;
      return searchIssues(
        context.prisma,
        { query: args.query, first: args.first ?? null, where: iqlWhere ?? null },
        buildReadableIssueWhere(context),
      );
    },
    similarBugs: async (
      _parent: unknown,
      args: { teamId: string; title: string; first?: number | null },
      context: GraphQLContext,
    ): Promise<IssueParent[]> => {
      requireAuthentication(context);
      const similar = await findSimilarBugs(context.prisma, {
        teamId: args.teamId,
        title: args.title,
        limit: Math.min(Math.max(args.first ?? 5, 1), 20),
        readableWhere: buildReadableIssueWhere(context) ?? null,
      });
      return similar as IssueParent[];
    },
    bugSummary: async (
      _parent: unknown,
      args: { teamFilter?: TeamFilterInput | null },
      context: GraphQLContext,
    ): Promise<BugSummaryResultShape> => {
      const readableWhere = buildReadableIssueWhere(context);
      const teamKey = args.teamFilter?.key?.eq;
      const teamKeyIn = args.teamFilter?.key?.in;
      const teamClause = teamKey
        ? { team: { is: { key: teamKey } } }
        : teamKeyIn && teamKeyIn.length > 0
          ? { team: { is: { key: { in: teamKeyIn } } } }
          : {};

      const now = new Date();
      const metrics = await loadBugMetrics(context.prisma, { ...teamClause, ...(readableWhere ? readableWhere : {}) }, now);
      const emptyWeeks = [...buildBugWeekBuckets().entries()].map(([weekStart, count]) => ({ weekStart, count }));
      const bugLabel = await context.prisma.issueLabel.findFirst({
        where: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!bugLabel) {
        return {
          openCount: 0,
          closedCount: 0,
          byPriority: [],
          byRepository: [],
          byTypeLabel: [],
          unclaimedOpenCount: 0,
          oldestOpenAgeDays: null,
          avgOpenAgeDays: null,
          createdPerWeek: emptyWeeks,
          metrics,
        };
      }

      const baseWhere: Prisma.IssueWhereInput = {
        commitmentStatus: 'COMMITTED',
        labels: { some: { id: bugLabel.id } },
        ...teamClause,
        ...(readableWhere ? readableWhere : {}),
      };
      const openWhere: Prisma.IssueWhereInput = {
        ...baseWhere,
        state: { type: { notIn: ['COMPLETED', 'CANCELED'] } },
      };
      const closedWhere: Prisma.IssueWhereInput = {
        ...baseWhere,
        state: { type: { in: ['COMPLETED', 'CANCELED'] } },
      };
      const trendCutoff = startOfUtcWeek(now);
      trendCutoff.setUTCDate(trendCutoff.getUTCDate() - (BUG_TREND_WEEKS - 1) * 7);

      const [openBugs, closedRepoGroups, recentCreations] = await Promise.all([
        context.prisma.issue.findMany({
          where: openWhere,
          select: {
            createdAt: true,
            priority: true,
            repository: true,
            labels: { select: { id: true, name: true } },
            claim: { select: { leaseUntil: true } },
          },
        }),
        context.prisma.issue.groupBy({
          by: ['repository'],
          where: closedWhere,
          _count: { _all: true },
        }),
        context.prisma.issue.findMany({
          where: { ...baseWhere, createdAt: { gte: trendCutoff } },
          select: { createdAt: true },
        }),
      ]);

      const priorityCounts = new Map<number, number>();
      const repoOpenCounts = new Map<string | null, number>();
      const typeLabelCounts = new Map<string, number>();
      let unclaimedOpenCount = 0;
      let oldestCreatedAt: Date | null = null;
      let ageSumDays = 0;

      for (const bug of openBugs) {
        priorityCounts.set(bug.priority, (priorityCounts.get(bug.priority) ?? 0) + 1);
        repoOpenCounts.set(bug.repository, (repoOpenCounts.get(bug.repository) ?? 0) + 1);
        for (const label of bug.labels) {
          if (label.id === bugLabel.id) {
            continue;
          }
          typeLabelCounts.set(label.name, (typeLabelCounts.get(label.name) ?? 0) + 1);
        }
        if (!bug.claim || bug.claim.leaseUntil.getTime() <= now.getTime()) {
          unclaimedOpenCount += 1;
        }
        ageSumDays += (now.getTime() - bug.createdAt.getTime()) / MS_PER_DAY;
        if (!oldestCreatedAt || bug.createdAt < oldestCreatedAt) {
          oldestCreatedAt = bug.createdAt;
        }
      }

      const byPriority = [...priorityCounts.entries()]
        .map(([priority, count]) => ({ priority, count }))
        .sort(
          (a, b) =>
            (a.priority === 0 ? Number.MAX_SAFE_INTEGER : a.priority) -
            (b.priority === 0 ? Number.MAX_SAFE_INTEGER : b.priority),
        );

      const repoClosedCounts = new Map<string | null, number>(
        closedRepoGroups.map((group) => [group.repository, group._count._all]),
      );
      const repositories = new Set<string | null>([...repoOpenCounts.keys(), ...repoClosedCounts.keys()]);
      const byRepository = [...repositories]
        .map((repository) => ({
          repository,
          openCount: repoOpenCounts.get(repository) ?? 0,
          closedCount: repoClosedCounts.get(repository) ?? 0,
        }))
        .sort((a, b) => {
          if (a.repository === null) return 1;
          if (b.repository === null) return -1;
          return a.repository.localeCompare(b.repository);
        });

      const byTypeLabel = [...typeLabelCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

      const weekBuckets = buildBugWeekBuckets();
      for (const creation of recentCreations) {
        const key = startOfUtcWeek(creation.createdAt).toISOString().slice(0, 10);
        if (weekBuckets.has(key)) {
          weekBuckets.set(key, (weekBuckets.get(key) ?? 0) + 1);
        }
      }
      const createdPerWeek = [...weekBuckets.entries()].map(([weekStart, count]) => ({ weekStart, count }));

      const openCount = openBugs.length;
      const closedCount = closedRepoGroups.reduce((sum, group) => sum + group._count._all, 0);

      return {
        openCount,
        closedCount,
        byPriority,
        byRepository,
        byTypeLabel,
        unclaimedOpenCount,
        oldestOpenAgeDays: oldestCreatedAt
          ? Math.round(((now.getTime() - oldestCreatedAt.getTime()) / MS_PER_DAY) * 10) / 10
          : null,
        avgOpenAgeDays: openCount > 0 ? Math.round((ageSumDays / openCount) * 10) / 10 : null,
        createdPerWeek,
        metrics,
      };
    },
    traceabilityAudit: async (
      _parent: unknown,
      args: { days?: number | null },
      context: GraphQLContext,
    ) => {
      assertOpsAdmin(context);
      return auditMergedPrTraceability({
        prisma: context.prisma,
        ...(args.days !== undefined && args.days !== null ? { days: args.days } : {}),
      });
    },
    workContext: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<WorkContextBundle | null> => {
      const work = await findWorkByIdOrIdentifier(context.prisma, args.id);

      if (!work) {
        return null;
      }

      await assertCanReadIssue(context.prisma, context, work.id);
      return getWorkContext(context.prisma, work.id);
    },
    workHygiene: async (
      _parent: unknown,
      args: { teamKey: string },
      context: GraphQLContext,
    ) => {
      const team = await context.prisma.team.findFirst({
        where: { AND: [{ key: args.teamKey }, buildReadableTeamWhere(context) ?? {}] },
        select: { id: true, key: true },
      });
      if (!team) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
      return loadWorkHygiene(context.prisma, { teamId: team.id, teamKey: team.key });
    },
    workGraph: async (
      _parent: unknown,
      args: { project: string; includeCandidates?: boolean | null },
      context: GraphQLContext,
    ): Promise<ProjectWorkGraph> =>
      loadProjectWorkGraph(
        context.prisma,
        { project: args.project, includeCandidates: args.includeCandidates ?? false },
        buildReadableIssueWhere(context),
      ),
    readyWork: async (
      _parent: unknown,
      args: { filter?: ListReadyWorkInput | null; query?: string | null },
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const result = await listReadyWork(
        context.prisma,
        { ...args.filter, iql: args.query ?? null, viewerId: context.viewer?.id ?? null },
        buildReadableIssueWhere(context),
      );

      return {
        nodes: result.nodes,
        pageInfo: buildPageInfo(result.nodes, result.hasNextPage),
      };
    },
    issueLabels: async (
      _parent: unknown,
      args: { filter?: IssueLabelFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => {
      const where = buildIssueLabelWhere(args.filter);

      return {
        nodes: await context.prisma.issueLabel.findMany({
          ...(where ? { where } : {}),
          orderBy: {
            name: 'asc',
          },
        }),
      };
    },
    users: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: User[] }> => {
      const where = buildVisibleUsersWhere(context);

      return {
        nodes: await context.prisma.user.findMany({
          ...(where ? { where } : {}),
          orderBy: [{ email: 'asc' }, { id: 'asc' }],
        }),
      };
    },
    agents: async (
      _parent: unknown,
      args: { includeDeactivated?: boolean | null; teamKey?: string | null },
      context: GraphQLContext,
    ): Promise<User[]> => {
      requireAuthentication(context);
      // Only the actors this viewer may see: someone on no team sees none.
      return listAgentActors(context.prisma, {
        includeDeactivated: args.includeDeactivated ?? false,
        teamKey: args.teamKey ?? null,
        visible: buildVisibleUsersWhere(context),
      });
    },
    agentProfile: async (
      _parent: unknown,
      args: { handle: string },
      context: GraphQLContext,
    ): Promise<(AgentProfileResult & { viewerCanManage: boolean }) | null> => {
      requireAuthentication(context);
      // Bounded by what the viewer may read: no private team's work, receipts
      // or credentials leak through an agent's handle (INV-597 follow-up).
      const profile = await getAgentProfile(context.prisma, args.handle, {
        readableTeam: buildReadableTeamWhere(context),
        readableWork: buildReadableIssueWhere(context),
      });
      if (!profile) return null;
      // An actor outside the viewer's visible set has no page for them.
      const visible = buildVisibleUsersWhere(context);
      if (visible && !(await context.prisma.user.findFirst({ where: { AND: [{ id: profile.actor.id }, visible] }, select: { id: true } }))) {
        return null;
      }
      const viewerCanManage = await assertCanManageActor(context.prisma, context, profile.actor.id)
        .then(() => true, () => false);
      return { ...profile, viewerCanManage };
    },
    agentCredentials: async (
      _parent: unknown,
      args: { teamId: string },
      context: GraphQLContext,
    ): Promise<AgentCredentialParent[]> => {
      const team = await resolveTeamByIdOrKey(context.prisma, args.teamId);
      if (!team) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
      await assertCanManageTeam(context.prisma, context, team.id);
      // Credentials are bound to their issuing team; the membership fallback
      // covers legacy rows issued before the binding existed.
      return context.prisma.agentCredential.findMany({
        where: {
          OR: [
            { teamId: team.id },
            { teamId: null, user: { memberships: { some: { teamId: team.id } } } },
          ],
        },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
      });
    },
    opsOverview: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      assertOpsAdmin(context);
      const [overview, webhooks] = await Promise.all([
        readOpsOverview(context.prisma),
        context.prisma.webhookSubscription.findMany({ orderBy: { createdAt: 'asc' } }),
      ]);
      return { ...overview, webhooks };
    },
    webhooks: async (
      _parent: unknown,
      args: { teamId: string },
      context: GraphQLContext,
    ): Promise<WebhookSubscription[]> => {
      const team = await resolveTeamByIdOrKey(context.prisma, args.teamId);
      if (!team) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
      await assertCanManageTeam(context.prisma, context, team.id);
      // Team owners see their team's subscriptions plus the global ones that
      // also receive their team's events. Secrets are never listed.
      return context.prisma.webhookSubscription.findMany({
        where: { OR: [{ teamId: team.id }, { teamId: null }] },
        orderBy: { createdAt: 'asc' },
      });
    },
    notifications: async (
      _parent: unknown,
      args: { after?: string | null; first?: number | null; unreadOnly?: boolean | null },
      context: GraphQLContext,
    ): Promise<{ nodes: Array<Prisma.NotificationGetPayload<{ include: { work: true } }>>; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const viewer = requireAuthentication(context);
      const first = clampConnectionFirst(args.first ?? 20, 100);
      const cursor = args.after ? decodeCursor(args.after) : null;
      const cursorDate = cursor ? parseDateTime(cursor.createdAt) : null;
      const notifications = await context.prisma.notification.findMany({
        where: {
          userId: viewer.id,
          ...(args.unreadOnly ? { readAt: null } : {}),
          ...(cursor && cursorDate
            ? {
                OR: [
                  { createdAt: { lt: cursorDate } },
                  { createdAt: cursorDate, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        include: { work: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: first + 1,
      });
      const nodes = notifications.slice(0, first);

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, notifications.length > first),
      };
    },
    unreadNotificationCount: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<number> => {
      const viewer = requireAuthentication(context);
      return context.prisma.notification.count({ where: { userId: viewer.id, readAt: null } });
    },
    projects: async (
      _parent: unknown,
      args: { teamId: string },
      context: GraphQLContext,
    ): Promise<{ nodes: ProjectParent[] }> => {
      await assertCanReadTeam(context.prisma, context, args.teamId);
      return {
        nodes: await context.prisma.project.findMany({
          where: { teamId: args.teamId },
          include: { lead: true, issues: true },
          orderBy: { createdAt: 'desc' },
        }),
      };
    },
    project: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<ProjectParent | null> => {
      const project = await context.prisma.project.findUnique({
        where: { id: args.id },
        include: { lead: true, issues: true, team: true },
      });
      if (project) {
        await assertCanReadTeam(context.prisma, context, project.teamId);
      }
      return project;
    },
    cycles: async (
      _parent: unknown,
      args: { teamId: string },
      context: GraphQLContext,
    ): Promise<{ nodes: CycleParent[] }> => {
      await assertCanReadTeam(context.prisma, context, args.teamId);
      return {
        nodes: await context.prisma.cycle.findMany({
          where: { teamId: args.teamId },
          include: { issues: true },
          orderBy: { number: 'desc' },
        }),
      };
    },
    cycle: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<CycleParent | null> => {
      const cycle = await context.prisma.cycle.findUnique({
        where: { id: args.id },
        include: { issues: true, team: true },
      });
      if (cycle) {
        await assertCanReadTeam(context.prisma, context, cycle.teamId);
      }
      return cycle;
    },
  },
  Mutation: {
    issueCreate: async (
      _parent: unknown,
      args: { input: CreateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        const issue = await createIssue(
          context.prisma,
          await placeNewWork(context.prisma, args.input),
          writeActorFromViewer(context.viewer),
        );

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    bugReport: async (
      _parent: unknown,
      args: { input: BugReportInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        requireAuthentication(context);
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        const created = await reportBug(context.prisma, args.input, writeActorFromViewer(context.viewer));
        return {
          issue: await getIssueById(context.prisma, created.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    issueUpdate: async (
      _parent: unknown,
      args: { id: string; input: UpdateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        await assertCanWriteIssue(context.prisma, context, args.id);
        // GraphQL delivers snoozedUntil as an ISO string while the service
        // layer wants Date|null.
        const { snoozedUntil, ...input } = args.input as UpdateIssueInput & { snoozedUntil?: string | null };
        const issue = await updateIssue(
          context.prisma,
          args.id,
          {
            ...input,
            ...(snoozedUntil !== undefined
              ? { snoozedUntil: snoozedUntil === null ? null : parseDateTime(snoozedUntil) }
              : {}),
          },
          writeActorFromViewer(context.viewer),
        );

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    issueDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ issueId: string | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanWriteIssue(context.prisma, context, args.id);
        const issue = await deleteIssue(context.prisma, args.id, writeActorFromViewer(context.viewer));

        return {
          issueId: issue.id,
          success: true as const,
        };
      }, {
        issueId: null,
        success: false as const,
      }),
    workPropose: async (
      _parent: unknown,
      args: { input: ProposeWorkInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        const issue = await proposeWork(
          context.prisma,
          args.input,
          writeActorFromViewer(context.viewer),
        );

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    workLink: async (
      _parent: unknown,
      args: { fromId: string; toId: string; type: WorkLinkType },
      context: GraphQLContext,
    ): Promise<{ link: WorkLink | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const from = await findWorkByIdOrIdentifier(context.prisma, args.fromId);
        if (!from) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        const to = await findWorkByIdOrIdentifier(context.prisma, args.toId);
        if (!to) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        await assertCanWriteIssue(context.prisma, context, from.id);
        await assertCanWriteIssue(context.prisma, context, to.id);
        const link = await createWorkLink(context.prisma, {
          actor: writeActorFromViewer(context.viewer),
          fromId: from.id,
          toId: to.id,
          type: args.type,
        });
        return { link, success: true as const };
      }, { link: null, success: false as const }),
    teamCreate: async (
      _parent: unknown,
      args: { input: { key: string; name: string; visibility?: TeamVisibility | null } },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean; team: Team | null }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        const team = await createTeam(context.prisma, {
          creator: viewer,
          key: args.input.key,
          name: args.input.name,
          ...(args.input.visibility ? { visibility: args.input.visibility } : {}),
        });
        return { success: true as const, team };
      }, { success: false as const, team: null }),
    teamUpdate: async (
      _parent: unknown,
      args: { input: { name?: string | null; teamId: string; visibility?: TeamVisibility | null } },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean; team: Team | null }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        return { success: true as const, team: await updateTeam(context.prisma, args.input) };
      }, { success: false as const, team: null }),
    teamArchive: async (_parent: unknown, args: { teamId: string }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; team: Team | null }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.teamId);
        return { success: true as const, team: await setTeamArchived(context.prisma, args.teamId, true) };
      }, { success: false as const, team: null }),
    teamUnarchive: async (_parent: unknown, args: { teamId: string }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; team: Team | null }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.teamId);
        return { success: true as const, team: await setTeamArchived(context.prisma, args.teamId, false) };
      }, { success: false as const, team: null }),
    teamJoin: async (_parent: unknown, args: { teamId: string }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; team: Team | null }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await joinTeam(context.prisma, { teamId: args.teamId, user: viewer });
        return { success: true as const, team: await context.prisma.team.findUniqueOrThrow({ where: { id: args.teamId } }) };
      }, { success: false as const, team: null }),
    teamLeave: async (_parent: unknown, args: { teamId: string }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; team: Team | null }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await leaveTeam(context.prisma, { teamId: args.teamId, userId: viewer.id });
        return { success: true as const, team: await context.prisma.team.findUniqueOrThrow({ where: { id: args.teamId } }) };
      }, { success: false as const, team: null }),
    userInvite: async (
      _parent: unknown,
      args: { input: { email: string; name?: string | null; role: GlobalRole; teams?: Array<{ role: TeamMembershipRole; teamId: string }> | null } },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean; user: User | null }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        const teams = args.input.teams ?? [];
        // Placing someone in a team is managing that team.
        for (const team of teams) await assertCanManageTeam(context.prisma, context, team.teamId);
        const user = await inviteUser(context.prisma, {
          by: { actorId: viewer.id, actorKind: viewer.actorKind, globalRole: viewer.globalRole },
          email: args.input.email,
          name: args.input.name ?? null,
          role: args.input.role,
          teams,
        });
        const environment = getServerEnvironment();
        const mailRuntime = { appOrigin: environment.appOrigin, email: environment.notificationEmail };
        const delivery = await deliverInvite(
          { email: user.email, inviterName: viewer.name },
          {
            appOrigin: environment.appOrigin,
            send: isNotificationEmailReady(mailRuntime) ? createNotificationEmailSender(environment.notificationEmail) : null,
          },
        );
        return { ...delivery, success: true as const, user };
      }, { success: false as const, user: null }),
    userInviteRevoke: async (_parent: unknown, args: { id: string }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; user: User | null }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        const user = await revokeInvite(context.prisma, {
          by: { actorId: viewer.id, actorKind: viewer.actorKind, globalRole: viewer.globalRole },
          userId: args.id,
        });
        return { success: true as const, user };
      }, { success: false as const, user: null }),
    userSuspend: async (_parent: unknown, args: { id: string; reason?: string | null }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; user: User | null }> =>
      runMutationWithReason(async () => {
        assertSettingsAdmin(context);
        const viewer = requireAuthentication(context);
        const user = await suspendUser(context.prisma, { byActorId: viewer.id, reason: args.reason ?? null, userId: args.id });
        return { success: true as const, user };
      }, { success: false as const, user: null }),
    userReactivate: async (_parent: unknown, args: { id: string; reason?: string | null }, context: GraphQLContext): Promise<{ message?: string | null; success: boolean; user: User | null }> =>
      runMutationWithReason(async () => {
        assertSettingsAdmin(context);
        const viewer = requireAuthentication(context);
        const user = await reactivateUser(context.prisma, { byActorId: viewer.id, reason: args.reason ?? null, userId: args.id });
        return { success: true as const, user };
      }, { success: false as const, user: null }),
    workspaceSettingsUpdate: async (
      _parent: unknown,
      args: { input: { approvedDomains?: string[] | null; defaultTeamIds?: string[] | null; membersCanCreateTeams?: boolean | null; membersCanInvite?: boolean | null } },
      context: GraphQLContext,
    ) =>
      runMutationWithReason(async () => {
        assertSettingsAdmin(context);
        const viewer = requireAuthentication(context);
        const input = args.input;
        const settings = await updateWorkspaceSettings(context.prisma, {
          byActorId: viewer.id,
          ...(input.approvedDomains != null ? { approvedDomains: input.approvedDomains } : {}),
          ...(input.defaultTeamIds != null ? { defaultTeamIds: input.defaultTeamIds } : {}),
          ...(input.membersCanCreateTeams != null ? { membersCanCreateTeams: input.membersCanCreateTeams } : {}),
          ...(input.membersCanInvite != null ? { membersCanInvite: input.membersCanInvite } : {}),
        });
        return { settings, success: true as const };
      }, { settings: null, success: false as const }),
    workShareUpsert: async (
      _parent: unknown,
      args: { role: WorkShareRole; userId: string; workId: string },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; share: WorkShareParent | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const work = await findWorkByIdOrIdentifier(context.prisma, args.workId);
        if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        // Sharing outward is a team-management act, like adding a member.
        await assertCanManageTeam(context.prisma, context, work.teamId);
        const share = await upsertWorkShare(context.prisma, {
          actor: writeActorFromViewer(context.viewer),
          role: args.role,
          userId: args.userId,
          workId: work.id,
        });
        return {
          share: await context.prisma.workShare.findUniqueOrThrow({ where: { id: share.id }, include: { createdBy: true, user: true } }),
          success: true as const,
        };
      }, { share: null, success: false as const }),
    workShareRemove: async (
      _parent: unknown,
      args: { userId: string; workId: string },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; share: WorkShareParent | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const work = await findWorkByIdOrIdentifier(context.prisma, args.workId);
        if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        await assertCanManageTeam(context.prisma, context, work.teamId);
        await removeWorkShare(context.prisma, {
          actor: writeActorFromViewer(context.viewer),
          userId: args.userId,
          workId: work.id,
        });
        return { share: null, success: true as const };
      }, { share: null, success: false as const }),
    workLinkDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ id: string | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const existing = await context.prisma.workLink.findUnique({
          where: { id: args.id },
          select: { fromId: true, toId: true },
        });
        if (!existing) throw createNotFoundError(WORK_LINK_NOT_FOUND_MESSAGE);
        await assertCanWriteIssue(context.prisma, context, existing.fromId);
        await assertCanWriteIssue(context.prisma, context, existing.toId);
        const result = await deleteWorkLink(context.prisma, args.id, writeActorFromViewer(context.viewer));
        return { id: result.id, success: true as const };
      }, { id: null, success: false as const }),
    workCommit: async (
      _parent: unknown,
      args: { id: string; input: CommitWorkInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const existing = await findWorkByIdOrIdentifier(context.prisma, args.id);
        if (!existing) {
          throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        }

        await assertCanWriteIssue(context.prisma, context, existing.id);
        const issue = await commitWork(
          context.prisma,
          existing.id,
          args.input,
          writeActorFromViewer(context.viewer),
        );

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    workReject: async (
      _parent: unknown,
      args: { id: string; input: RejectWorkInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const existing = await findWorkByIdOrIdentifier(context.prisma, args.id);
        if (!existing) {
          throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        }

        await assertCanWriteIssue(context.prisma, context, existing.id);
        const issue = await rejectWork(
          context.prisma,
          existing.id,
          args.input,
          writeActorFromViewer(context.viewer),
        );

        return {
          issue: await getIssueById(context.prisma, issue.id),
          success: true as const,
        };
      }, {
        issue: null,
        success: false as const,
      }),
    workClaim: async (
      _parent: unknown,
      args: { id: string; input?: ClaimWorkInput | null },
      context: GraphQLContext,
    ): Promise<{ claim: WorkClaimParent | null; issue: IssueParent | null; success: boolean; suggestedBranch: string | null }> =>
      runMutation(async () => {
        const existing = await findWorkByIdOrIdentifier(context.prisma, args.id);
        if (!existing) {
          throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        }

        await assertCanWriteIssue(context.prisma, context, existing.id);
        const result = await claimWork(
          context.prisma,
          existing.id,
          args.input ?? {},
          writeActorFromViewer(context.viewer),
        );

        return {
          claim: await context.prisma.workClaim.findUniqueOrThrow({
            where: { id: result.claim.id },
            include: { actor: true },
          }),
          issue: await getIssueById(context.prisma, result.work.id),
          success: true as const,
          suggestedBranch: suggestedBranchName(result.work.identifier, result.work.title),
        };
      }, {
        claim: null,
        issue: null,
        success: false as const,
        suggestedBranch: null,
      }),
    runReport: async (
      _parent: unknown,
      args: {
        input: {
          commitSha?: string | null;
          pullRequestNumber?: number | null;
          decisionRequested?: boolean | null;
          externalUrl?: string | null;
          idempotencyKey?: string | null;
          phase?: string | null;
          runId?: string | null;
          status?: string | null;
          summary?: string | null;
          workId: string;
        };
      },
      context: GraphQLContext,
    ) =>
      runMutation(async () => {
        const existing = await findWorkByIdOrIdentifier(context.prisma, args.input.workId);
        if (!existing) {
          throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        }
        await assertCanWriteIssue(context.prisma, context, existing.id);
        const result = await reportRun(
          context.prisma,
          args.input,
          writeActorFromViewer(context.viewer),
        );
        return {
          issue: await getIssueById(context.prisma, result.work.id),
          run: result.run,
          success: true as const,
        };
      }, {
        issue: null,
        run: null,
        success: false as const,
      }),
    evidenceAttach: async (
      _parent: unknown,
      args: {
        input: {
          idempotencyKey?: string | null;
          kind: string;
          runId?: string | null;
          summary?: string | null;
          url: string;
          workId: string;
        };
      },
      context: GraphQLContext,
    ) =>
      runMutation(async () => {
        const existing = await findWorkByIdOrIdentifier(context.prisma, args.input.workId);
        if (!existing) {
          throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        }
        await assertCanWriteIssue(context.prisma, context, existing.id);
        const result = await attachEvidence(
          context.prisma,
          args.input,
          writeActorFromViewer(context.viewer),
        );
        return {
          evidence: result.evidence,
          issue: await getIssueById(context.prisma, result.work.id),
          success: true as const,
        };
      }, {
        evidence: null,
        issue: null,
        success: false as const,
      }),
    workReview: async (
      _parent: unknown,
      args: {
        id: string;
        input: {
          decision: 'ACCEPTED' | 'REJECTED';
          expectedRevision: number;
          idempotencyKey?: string | null;
          reason?: string | null;
          runId?: string | null;
        };
      },
      context: GraphQLContext,
    ) => runMutationWithReason(async () => {
      const existing = await findWorkByIdOrIdentifier(context.prisma, args.id);
      if (!existing) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
      await assertCanWriteIssue(context.prisma, context, existing.id);
      const result = await reviewWork(
        context.prisma,
        existing.id,
        args.input,
        writeActorFromViewer(context.viewer),
      );
      return {
        decision: await context.prisma.workReviewDecision.findUniqueOrThrow({
          where: { id: result.decision.id },
          include: { reviewer: true, run: true },
        }),
        issue: await getIssueById(context.prisma, result.work.id),
        success: true as const,
      };
    }, { decision: null, issue: null, success: false as const }),
    evidenceRetract: async (
      _parent: unknown,
      args: { input: { correctWorkId?: string | null; evidenceId: string; reason: string } },
      context: GraphQLContext,
    ): Promise<{ evidence: WorkEvidence | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        const evidence = await context.prisma.workEvidence.findUnique({ where: { id: args.input.evidenceId }, select: { workId: true } });
        if (!evidence) throw createNotFoundError(EVIDENCE_NOT_FOUND_MESSAGE);
        await assertCanWriteIssue(context.prisma, context, evidence.workId);
        // Pointing evidence at a work item is a write to that item too; it
        // must not become a way to probe or reference another team's work.
        if (args.input.correctWorkId) {
          await assertCanWriteIssue(context.prisma, context, args.input.correctWorkId);
        }
        const updated = await retractEvidence(context.prisma, {
          correctWorkId: args.input.correctWorkId ?? null,
          evidenceId: args.input.evidenceId,
          reason: args.input.reason,
        }, { actorId: viewer.id, actorKind: viewer.actorKind, surface: 'graphql' });
        return { evidence: updated, success: true as const };
      }, { evidence: null, success: false as const }),
    contractAmendmentAccept: async (
      _parent: unknown,
      args: { input: { amendmentId: string; note?: string | null } },
      context: GraphQLContext,
    ): Promise<{ amendment: ContractAmendment | null; issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await assertCanWriteIssue(context.prisma, context, await amendmentWorkId(context.prisma, args.input.amendmentId));
        const result = await acceptContractAmendment(
          context.prisma,
          { amendmentId: args.input.amendmentId, note: args.input.note ?? null },
          writeActorFromViewer(viewer),
        );
        return { amendment: result.amendment, issue: await getIssueById(context.prisma, result.work.id), success: true as const };
      }, { amendment: null, issue: null, success: false as const }),
    contractAmendmentReject: async (
      _parent: unknown,
      args: { input: { amendmentId: string; note: string } },
      context: GraphQLContext,
    ): Promise<{ amendment: ContractAmendment | null; issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await assertCanWriteIssue(context.prisma, context, await amendmentWorkId(context.prisma, args.input.amendmentId));
        const result = await rejectContractAmendment(
          context.prisma,
          { amendmentId: args.input.amendmentId, note: args.input.note },
          writeActorFromViewer(viewer),
        );
        return { amendment: result.amendment, issue: await getIssueById(context.prisma, result.work.id), success: true as const };
      }, { amendment: null, issue: null, success: false as const }),
    agentRequestAnswer: async (
      _parent: unknown,
      args: { input: { body: string; overrideReason?: string | null; requestId: string; state?: string | null } },
      context: GraphQLContext,
    ): Promise<{ comment: Comment | null; message?: string | null; request: AgentRequestParent | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await assertCanActOnRequest(context.prisma, context, args.input.requestId);
        const state = args.input.state ?? 'completed';
        if (state !== 'completed' && state !== 'failed' && state !== 'input-required') {
          throw createValidationError(REQUEST_ANSWER_STATE_INVALID_MESSAGE);
        }
        const answered = await answerAgentRequestAsHuman(context.prisma, {
          body: args.input.body,
          by: { actorId: viewer.id, actorKind: viewer.actorKind, globalRole: viewer.globalRole },
          id: args.input.requestId,
          overrideReason: args.input.overrideReason ?? null,
          state,
        });
        const comment = await context.prisma.comment.findUniqueOrThrow({ where: { id: answered.commentId } });
        return { comment, request: answered.request, success: true as const };
      }, { comment: null, request: null, success: false as const }),
    agentRequestReply: async (
      _parent: unknown,
      args: { requestId: string; body: string; overrideReason?: string | null },
      context: GraphQLContext,
    ): Promise<{ comment: Comment | null; message?: string | null; request: AgentRequestParent | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await assertCanActOnRequest(context.prisma, context, args.requestId);
        const request = await replyToAgentRequest(context.prisma, {
          body: args.body,
          by: { actorId: viewer.id, actorKind: viewer.actorKind, globalRole: viewer.globalRole },
          id: args.requestId,
          overrideReason: args.overrideReason ?? null,
        });
        return { comment: null, request, success: true as const };
      }, { comment: null, request: null, success: false as const }),
    actorSetSuccessor: async (
      _parent: unknown,
      args: { id: string; successorId?: string | null; reason?: string | null },
      context: GraphQLContext,
    ): Promise<{ actor: User | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        const viewer = requireAuthentication(context);
        await assertCanManageActor(context.prisma, context, args.id);
        const actor = await setActorSuccessor(context.prisma, {
          actorId: args.id,
          by: { actorId: viewer.id, actorKind: viewer.actorKind },
          successorId: args.successorId ?? null,
          reason: args.reason ?? null,
        });
        return { actor, success: true as const };
      }, { actor: null, success: false as const }),
    actorDeactivate: async (
      _parent: unknown,
      args: { id: string; reason?: string | null },
      context: GraphQLContext,
    ): Promise<{ actor: User | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        await assertCanManageActor(context.prisma, context, args.id);
        const actor = await deactivateActor(context.prisma, {
          actorId: args.id,
          by: { actorId: viewer.id, actorKind: viewer.actorKind },
          reason: args.reason ?? null,
        });
        return { actor, success: true as const };
      }, { actor: null, success: false as const }),
    actorReactivate: async (
      _parent: unknown,
      args: { id: string; reason?: string | null },
      context: GraphQLContext,
    ): Promise<{ actor: User | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        await assertCanManageActor(context.prisma, context, args.id);
        const actor = await reactivateActor(context.prisma, {
          actorId: args.id,
          by: { actorId: viewer.id, actorKind: viewer.actorKind },
          reason: args.reason ?? null,
        });
        return { actor, success: true as const };
      }, { actor: null, success: false as const }),
    actorTransferOwner: async (
      _parent: unknown,
      args: { id: string; ownerId: string; reason?: string | null },
      context: GraphQLContext,
    ): Promise<{ actor: User | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        await assertCanManageActor(context.prisma, context, args.id);
        const actor = await transferActorOwner(context.prisma, {
          actorId: args.id,
          by: { actorId: viewer.id, actorKind: viewer.actorKind },
          newOwnerId: args.ownerId,
          reason: args.reason ?? null,
        });
        return { actor, success: true as const };
      }, { actor: null, success: false as const }),
    serviceActorCreate: async (
      _parent: unknown,
      args: { input: { description?: string | null; email?: string | null; handle: string; name: string; ownerId?: string | null } },
      context: GraphQLContext,
    ): Promise<{ actor: User | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        if (viewer.actorKind !== 'HUMAN') {
          throw createValidationError('Only a human may provision a service actor.');
        }
        // A service writes on behalf of the whole workspace: provisioning one is an admin act (docs/permissions.md §7).
        if (viewer.globalRole !== 'ADMIN') {
          throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
        }
        const ownerId = args.input.ownerId ?? viewer.id;
        // Making someone else accountable for a new service is an admin act.
        if (ownerId !== viewer.id && viewer.globalRole !== 'ADMIN') {
          throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
        }
        const created = await provisionServiceActor(context.prisma, {
          byActorId: viewer.id,
          description: args.input.description ?? null,
          email: args.input.email ?? null,
          handle: args.input.handle,
          name: args.input.name,
          ownerId,
        });
        const actor = await context.prisma.user.findUniqueOrThrow({ where: { id: created.actorId } });
        return { actor, success: true as const };
      }, { actor: null, success: false as const }),
    agentCredentialCreate: async (
      _parent: unknown,
      args: {
        input: {
          agentCardUrl?: string | null;
          description?: string | null;
          email?: string | null;
          expiresAt?: string | null;
          handle?: string | null;
          name: string;
          ownerId?: string | null;
          runtime?: string | null;
          scopes?: string[] | null;
          team: string;
        };
      },
      context: GraphQLContext,
    ): Promise<{ credential: AgentCredentialParent | null; success: boolean; token: string | null }> =>
      runMutation(async () => {
        const team = await resolveTeamByIdOrKey(context.prisma, args.input.team);
        if (!team) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
        // Gate 1: may the caller manage the target team?
        await assertCanManageTeam(context.prisma, context, team.id);
        // Gate 2: if the email names an existing actor, may the caller act
        // for it? Managing team B never makes one able to mint credentials
        // for someone else's actor (INV-594).
        const email = args.input.email?.trim().toLowerCase() || null;
        if (email && !isPlausibleEmail(email)) {
          throw createValidationError(AGENT_EMAIL_INVALID_MESSAGE);
        }
        const handle = args.input.handle?.trim() ? normalizeHandle(args.input.handle) : null;
        if (handle && !isValidHandle(handle)) {
          throw createValidationError(AGENT_HANDLE_INVALID_MESSAGE);
        }
        if (handle) {
          const taken = await context.prisma.user.findUnique({ where: { handle }, select: { email: true } });
          if (taken && taken.email !== email) {
            throw createValidationError(AGENT_HANDLE_TAKEN_MESSAGE);
          }
        }
        if (email) {
          const existing = await context.prisma.user.findUnique({ where: { email }, select: { id: true } });
          if (existing) {
            await assertCanRepresentActor(context.prisma, context, existing.id);
          }
        }
        let scopes: AgentScope[] | undefined;
        try {
          scopes = args.input.scopes == null ? undefined : parseAgentScopeList(args.input.scopes);
        } catch {
          throw createValidationError(AGENT_SCOPE_INVALID_MESSAGE);
        }
        // The human creating the credential is accountable for the agent
        // unless they say otherwise; an agent token cannot own an agent.
        const { credential, token } = await issueAgentCredential(context.prisma, {
          agentCardUrl: args.input.agentCardUrl?.trim() || null,
          description: args.input.description?.trim() || null,
          email: args.input.email ?? null,
          expiresAt: args.input.expiresAt ? new Date(args.input.expiresAt) : null,
          handle,
          issuedById: requireAuthentication(context).id,
          name: args.input.name,
          ownerId: args.input.ownerId?.trim() || requireAuthentication(context).id,
          runtime: args.input.runtime?.trim() || null,
          scopes,
          teamKey: team.key,
        });
        return {
          credential: await context.prisma.agentCredential.findUniqueOrThrow({
            where: { id: credential.id },
            include: { user: true },
          }),
          success: true as const,
          token,
        };
      }, { credential: null, success: false as const, token: null }),
    agentCredentialRevoke: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ credential: AgentCredentialParent | null; success: boolean }> =>
      runMutation(async () => {
        const credential = await context.prisma.agentCredential.findUnique({
          where: { id: args.id },
          select: { id: true, teamId: true, userId: true },
        });
        if (!credential) throw createNotFoundError(AGENT_CREDENTIAL_NOT_FOUND_MESSAGE);
        await assertCanRevokeCredential(context.prisma, context, credential);
        const now = new Date();
        const updated = await context.prisma.$transaction(async (tx) => {
          const row = await tx.agentCredential.update({
            where: { id: credential.id },
            data: { revokedAt: now },
            include: { user: true },
          });
          await recordActorAudit(tx, {
            action: 'credential-revoked',
            after: { credentialId: row.id, name: row.name, revokedAt: now.toISOString() },
            byActorId: context.viewer?.id ?? null,
            subjectId: credential.userId,
          });
          return row;
        });
        return { credential: updated, success: true as const };
      }, { credential: null, success: false as const }),
    webhookCreate: async (
      _parent: unknown,
      args: {
        input: {
          eventTypes?: string[] | null;
          filterQuery?: string | null;
          label?: string | null;
          team?: string | null;
          url: string;
        };
      },
      context: GraphQLContext,
    ): Promise<{ secret: string | null; subscription: WebhookSubscription | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        const teamId = await resolveWebhookTeamId(context, args.input.team ?? null);
        const eventTypes = normalizeWebhookEventTypes(args.input.eventTypes ?? null);
        const filterQuery = normalizeWebhookFilterQuery(args.input.filterQuery ?? null);
        const secret = randomBytes(32).toString('hex');
        const subscription = await context.prisma.webhookSubscription.create({
          data: {
            createdById: viewer.id,
            eventTypes,
            filterQuery,
            label: args.input.label?.trim() || null,
            secret,
            teamId,
            url: normalizeWebhookUrl(args.input.url),
          },
        });
        await auditWebhook(context, 'webhook-created', subscription);
        return { secret, subscription, success: true as const };
      }, { secret: null, subscription: null, success: false as const }),
    webhookUpdate: async (
      _parent: unknown,
      args: {
        id: string;
        input: {
          enabled?: boolean | null;
          eventTypes?: string[] | null;
          filterQuery?: string | null;
          label?: string | null;
          url?: string | null;
        };
      },
      context: GraphQLContext,
    ): Promise<{ secret: string | null; subscription: WebhookSubscription | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await requireWebhookSubscription(context, args.id);
        const data: Prisma.WebhookSubscriptionUpdateInput = {};
        if (args.input.url !== undefined && args.input.url !== null) {
          data.url = normalizeWebhookUrl(args.input.url);
        }
        if (args.input.label !== undefined) {
          data.label = args.input.label?.trim() || null;
        }
        if (args.input.eventTypes !== undefined && args.input.eventTypes !== null) {
          data.eventTypes = normalizeWebhookEventTypes(args.input.eventTypes);
        }
        if (args.input.filterQuery !== undefined) {
          data.filterQuery = normalizeWebhookFilterQuery(args.input.filterQuery);
        }
        if (args.input.enabled !== undefined && args.input.enabled !== null) {
          data.enabled = args.input.enabled;
          if (args.input.enabled) {
            data.consecutiveFailures = 0;
          }
        }
        const subscription = await context.prisma.webhookSubscription.update({
          where: { id: existing.id },
          data,
        });
        await auditWebhook(context, 'webhook-updated', subscription, { changed: Object.keys(data) });
        return { secret: null, subscription, success: true as const };
      }, { secret: null, subscription: null, success: false as const }),
    webhookDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ secret: string | null; subscription: WebhookSubscription | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await requireWebhookSubscription(context, args.id);
        await context.prisma.webhookSubscription.delete({ where: { id: existing.id } });
        await auditWebhook(context, 'webhook-deleted', existing);
        return { secret: null, subscription: null, success: true as const };
      }, { secret: null, subscription: null, success: false as const }),
    webhookRotateSecret: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ secret: string | null; subscription: WebhookSubscription | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await requireWebhookSubscription(context, args.id);
        const secret = randomBytes(32).toString('hex');
        const subscription = await context.prisma.webhookSubscription.update({
          where: { id: existing.id },
          data: { consecutiveFailures: 0, secret },
        });
        await auditWebhook(context, 'webhook-secret-rotated', subscription);
        return { secret, subscription, success: true as const };
      }, { secret: null, subscription: null, success: false as const }),
    notificationMarkRead: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ notification: Prisma.NotificationGetPayload<{ include: { work: true } }> | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        // Scoped to the viewer: marking someone else's notification is a 404,
        // not a silent success.
        const updated = await context.prisma.notification.updateMany({
          where: { id: args.id, readAt: null, userId: viewer.id },
          data: { readAt: new Date() },
        });
        if (updated.count !== 1) {
          const existing = await context.prisma.notification.findFirst({
            include: { work: true },
            where: { id: args.id, userId: viewer.id },
          });
          if (!existing) throw createNotFoundError(NOTIFICATION_NOT_FOUND_MESSAGE);
          return { notification: existing, success: true as const };
        }
        const notification = await context.prisma.notification.findUniqueOrThrow({
          include: { work: true },
          where: { id: args.id },
        });
        return { notification, success: true as const };
      }, { notification: null, success: false as const }),
    notificationsMarkAllRead: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ count: number; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        const { count } = await context.prisma.notification.updateMany({
          where: { readAt: null, userId: viewer.id },
          data: { readAt: new Date() },
        });
        return { count, success: true as const };
      }, { count: 0, success: false as const }),
    labelCreate: async (
      _parent: unknown,
      args: { name: string },
      context: GraphQLContext,
    ): Promise<{ label: IssueLabel | null; message?: string | null; success: boolean }> =>
      runMutation(async () => {
        assertSettingsAdmin(context);
        return { label: await createLabel(context.prisma, args.name), success: true as const };
      }, { label: null, success: false as const }),
    labelUpdate: async (
      _parent: unknown,
      args: { id: string; name: string },
      context: GraphQLContext,
    ): Promise<{ label: IssueLabel | null; message?: string | null; success: boolean }> =>
      runMutation(async () => {
        assertSettingsAdmin(context);
        return { label: await renameLabel(context.prisma, args.id, args.name), success: true as const };
      }, { label: null, success: false as const }),
    labelDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ labelId: string | null; message?: string | null; success: boolean }> =>
      runMutation(async () => {
        assertSettingsAdmin(context);
        return { labelId: (await deleteLabel(context.prisma, args.id)).id, success: true as const };
      }, { labelId: null, success: false as const }),
    workflowStateCreate: async (
      _parent: unknown,
      args: { input: { name: string; teamId: string; type: WorkflowState['type'] } },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; state: WorkflowState | null; success: boolean }> =>
      runMutation(async () => {
        // A team's workflow is the team's: its owners manage it (docs/permissions.md §3).
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        return { state: await createWorkflowState(context.prisma, args.input), success: true as const };
      }, { state: null, success: false as const }),
    workflowStateUpdate: async (
      _parent: unknown,
      args: { id: string; input: { name?: string | null; position?: number | null } },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; state: WorkflowState | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanManageTeam(context.prisma, context, await workflowStateTeamId(context.prisma, args.id));
        return { state: await updateWorkflowState(context.prisma, args.id, args.input), success: true as const };
      }, { state: null, success: false as const }),
    workflowStateDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; stateId: string | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanManageTeam(context.prisma, context, await workflowStateTeamId(context.prisma, args.id));
        return { stateId: (await deleteWorkflowState(context.prisma, args.id)).id, success: true as const };
      }, { stateId: null, success: false as const }),
    userSetGlobalRole: async (
      _parent: unknown,
      args: { reason?: string | null; role: User['globalRole']; userId: string },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean; user: User | null }> =>
      runMutation(async () => {
        assertSettingsAdmin(context);
        const user = await setGlobalRole(context.prisma, {
          byActorId: context.viewer?.id ?? null,
          reason: args.reason ?? null,
          role: args.role,
          userId: args.userId,
        });
        return { success: true as const, user };
      }, { success: false as const, user: null }),
    notificationPreferencesUpdate: async (
      _parent: unknown,
      args: { emailNotifications: boolean },
      context: GraphQLContext,
    ): Promise<{ emailNotifications: boolean; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        const prefs: Record<string, Prisma.InputJsonValue> = { ...(viewer.notificationPrefs as Prisma.InputJsonValue | null ?? {}) as Record<string, Prisma.InputJsonValue> };
        prefs.emailNotifications = args.emailNotifications;
        await context.prisma.user.update({
          where: { id: viewer.id },
          data: { notificationPrefs: prefs },
        });
        return { emailNotifications: args.emailNotifications, success: true as const };
      }, { emailNotifications: true, success: false as const }),
    commentCreate: async (
      _parent: unknown,
      args: { input: CreateCommentInput },
      context: GraphQLContext,
    ): Promise<{ comment: CommentParent | null; success: boolean }> => {
      const viewer = requireAuthentication(context);

      return runMutation(async () => {
        await assertCanWriteIssue(context.prisma, context, args.input.issueId);
        const createdComment = await createComment(context.prisma, args.input, viewer.id);

        return {
          comment: {
            ...createdComment,
            user: viewer,
          },
          success: true as const,
        };
      }, {
        comment: null,
        success: false as const,
      });
    },
    commentDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ commentId: string | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanDeleteComment(context.prisma, context, args.id);
        const comment = await deleteComment(context.prisma, args.id);

        return {
          commentId: comment.id,
          success: true as const,
        };
      }, {
        commentId: null,
        success: false as const,
      }),
    teamUpdateAccess: async (
      _parent: unknown,
      args: { input: { teamId: string; visibility: TeamVisibility } },
      context: GraphQLContext,
    ): Promise<{ success: boolean; team: TeamParent | null }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        const team = await context.prisma.team.update({
          where: {
            id: args.input.teamId,
          },
          data: {
            visibility: args.input.visibility,
          },
        });

        return {
          success: true as const,
          team,
        };
      }, {
        success: false as const,
        team: null,
      }),
    workUncommit: async (
      _parent: unknown,
      args: { id: string; expectedRevision: number },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        requireAuthentication(context);
        const work = await findWorkByIdOrIdentifier(context.prisma, args.id);
        if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        await assertCanWriteIssue(context.prisma, context, work.id);
        const restored = await uncommitWork(
          context.prisma,
          work.id,
          { expectedRevision: args.expectedRevision },
          writeActorFromViewer(context.viewer),
        );
        return { issue: await getIssueById(context.prisma, restored.id), success: true as const };
      }, { issue: null, success: false as const }),
    workRestore: async (
      _parent: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        requireAuthentication(context);
        const work = await findWorkByIdOrIdentifier(context.prisma, args.id);
        if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        await assertCanWriteIssue(context.prisma, context, work.id);
        const restored = await restoreWork(context.prisma, { id: work.id, reason: args.reason }, writeActorFromViewer(context.viewer));
        return { issue: await getIssueById(context.prisma, restored.id), success: true as const };
      }, { issue: null, success: false as const }),
    opsSyncDeadLetterClear: async (
      _parent: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        assertOpsAdmin(context);
        await clearSyncDeadLetter(context.prisma, { id: args.id, reason: args.reason, byActorId: context.viewer?.id ?? null });
        return { success: true as const };
      }, { success: false as const }),
    opsInboundReplay: async (
      _parent: unknown,
      args: { id: string; reason: string; expectedAttempts: number },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        assertOpsAdmin(context);
        await replayInboundDelivery(context.prisma, {
          id: args.id,
          reason: args.reason,
          expectedAttempts: args.expectedAttempts,
          byActorId: context.viewer?.id ?? null,
        });
        return { success: true as const };
      }, { success: false as const }),
    workClaimRelease: async (
      _parent: unknown,
      args: { workId: string; reason: string },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; message?: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        requireAuthentication(context);
        const work = await findWorkByIdOrIdentifier(context.prisma, args.workId);
        if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
        await assertCanWriteIssue(context.prisma, context, work.id);
        await releaseClaim(context.prisma, { workId: work.id, reason: args.reason }, writeActorFromViewer(context.viewer));
        return { issue: await getIssueById(context.prisma, work.id), success: true as const };
      }, { issue: null, success: false as const }),
    teamTriageRotationUpdate: async (
      _parent: unknown,
      args: { input: { teamId: string; userIds: string[]; startsAt?: string | null } },
      context: GraphQLContext,
    ): Promise<{ message?: string | null; success: boolean; team: TeamParent | null }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        await setTriageRotation(context.prisma, args.input);
        return {
          success: true as const,
          team: await context.prisma.team.findUniqueOrThrow({ where: { id: args.input.teamId } }),
        };
      }, {
        success: false as const,
        team: null,
      }),
    teamMembershipUpsert: async (
      _parent: unknown,
      args: { input: { email: string; name?: string | null; role: TeamMembershipRole; teamId: string } },
      context: GraphQLContext,
    ): Promise<{ membership: TeamMembershipParent | null; success: boolean }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        // Adding an email nobody has used yet is an invite, and follows the
        // invite rules (docs/permissions.md §2.2).
        const email = args.input.email.trim().toLowerCase();
        const known = await context.prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (!known) {
          const viewer = requireAuthentication(context);
          await inviteUser(context.prisma, {
            by: { actorId: viewer.id, actorKind: viewer.actorKind, globalRole: viewer.globalRole },
            email,
            name: args.input.name ?? null,
            role: 'USER',
          });
        }
        const membership = await context.prisma.$transaction(async (transaction) => {
          const user = await upsertTeamMemberUser(transaction, args.input.email, args.input.name ?? null);
          if (user.actorKind !== 'HUMAN') {
            throw createValidationError(TEAM_ROSTER_HUMANS_ONLY_MESSAGE);
          }
          if (user.globalRole === 'GUEST' && args.input.role === 'OWNER') {
            throw createValidationError(GUEST_CANNOT_OWN_TEAM_MESSAGE);
          }
          const existingMembership = await transaction.teamMembership.findUnique({
            where: {
              teamId_userId: {
                teamId: args.input.teamId,
                userId: user.id,
              },
            },
            select: {
              role: true,
              userId: true,
            },
          });

          if (existingMembership?.role === 'OWNER' && args.input.role !== 'OWNER') {
            await assertTeamRetainsOwner(transaction, args.input.teamId, {
              excludedUserId: existingMembership.userId,
              nextRole: args.input.role,
            });
          }

          return transaction.teamMembership.upsert({
            where: {
              teamId_userId: {
                teamId: args.input.teamId,
                userId: user.id,
              },
            },
            create: {
              role: args.input.role,
              teamId: args.input.teamId,
              userId: user.id,
            },
            update: {
              role: args.input.role,
            },
            include: {
              user: true,
            },
          });
        });

        return {
          membership,
          success: true as const,
        };
      }, {
        membership: null,
        success: false as const,
      }),
    teamMembershipRemove: async (
      _parent: unknown,
      args: { input: { teamId: string; userId: string } },
      context: GraphQLContext,
    ): Promise<{ membershipId: string | null; success: boolean }> =>
      runMutationWithReason(async () => {
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        const membershipId = await context.prisma.$transaction(async (transaction) => {
          const membership = await transaction.teamMembership.findUnique({
            where: {
              teamId_userId: {
                teamId: args.input.teamId,
                userId: args.input.userId,
              },
            },
            select: {
              id: true,
              role: true,
              userId: true,
            },
          });

          if (!membership) {
            throw createNotFoundError(MEMBERSHIP_NOT_FOUND_MESSAGE);
          }

          if (membership.role === 'OWNER') {
            await assertTeamRetainsOwner(transaction, args.input.teamId, {
              excludedUserId: membership.userId,
              nextRole: null,
            });
          }

          await transaction.teamMembership.delete({
            where: {
              teamId_userId: {
                teamId: args.input.teamId,
                userId: args.input.userId,
              },
            },
          });

          return membership.id;
        });

        return {
          membershipId,
          success: true as const,
        };
      }, {
        membershipId: null,
        success: false as const,
      }),
    projectCreate: async (
      _parent: unknown,
      args: { input: CreateProjectInput },
      context: GraphQLContext,
    ): Promise<{ project: ProjectParent | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        const project = await createProject(context.prisma, args.input);
        const full = await context.prisma.project.findUniqueOrThrow({
          where: { id: project.id },
          include: { lead: true, issues: true },
        });
        return { project: full, success: true as const };
      }, { project: null, success: false as const }),
    projectUpdate: async (
      _parent: unknown,
      args: { id: string; input: UpdateProjectInput },
      context: GraphQLContext,
    ): Promise<{ project: ProjectParent | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await context.prisma.project.findUnique({ where: { id: args.id }, select: { teamId: true } });
        if (!existing) throw createNotFoundError('Project not found.');
        await assertCanWriteTeam(context.prisma, context, existing.teamId);
        await updateProject(context.prisma, args.id, args.input);
        const full = await context.prisma.project.findUniqueOrThrow({
          where: { id: args.id },
          include: { lead: true, issues: true },
        });
        return { project: full, success: true as const };
      }, { project: null, success: false as const }),
    projectDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ projectId: string | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await context.prisma.project.findUnique({ where: { id: args.id }, select: { teamId: true } });
        if (!existing) throw createNotFoundError('Project not found.');
        await assertCanWriteTeam(context.prisma, context, existing.teamId);
        const result = await deleteProject(context.prisma, args.id);
        return { projectId: result.id, success: true as const };
      }, { projectId: null, success: false as const }),
    cycleCreate: async (
      _parent: unknown,
      args: { input: CreateCycleInput },
      context: GraphQLContext,
    ): Promise<{ cycle: CycleParent | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        const cycle = await createCycle(context.prisma, args.input);
        const full = await context.prisma.cycle.findUniqueOrThrow({
          where: { id: cycle.id },
          include: { issues: true },
        });
        return { cycle: full, success: true as const };
      }, { cycle: null, success: false as const }),
    cycleUpdate: async (
      _parent: unknown,
      args: { id: string; input: UpdateCycleInput },
      context: GraphQLContext,
    ): Promise<{ cycle: CycleParent | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await context.prisma.cycle.findUnique({ where: { id: args.id }, select: { teamId: true } });
        if (!existing) throw createNotFoundError('Cycle not found.');
        await assertCanWriteTeam(context.prisma, context, existing.teamId);
        await updateCycle(context.prisma, args.id, args.input);
        const full = await context.prisma.cycle.findUniqueOrThrow({
          where: { id: args.id },
          include: { issues: true },
        });
        return { cycle: full, success: true as const };
      }, { cycle: null, success: false as const }),
    cycleDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ cycleId: string | null; success: boolean }> =>
      runMutation(async () => {
        const existing = await context.prisma.cycle.findUnique({ where: { id: args.id }, select: { teamId: true } });
        if (!existing) throw createNotFoundError('Cycle not found.');
        await assertCanWriteTeam(context.prisma, context, existing.teamId);
        const result = await deleteCycle(context.prisma, args.id);
        return { cycleId: result.id, success: true as const };
      }, { cycleId: null, success: false as const }),
    userUpdate: async (
      _parent: unknown,
      args: { input: { name?: string | null; email?: string | null } },
      context: GraphQLContext,
    ): Promise<{ user: User | null; success: boolean }> => {
      const viewer = requireAuthentication(context);
      return runMutation(async () => {
        const data: Prisma.UserUpdateInput = {};
        if (args.input.name !== undefined && args.input.name !== null) data.name = args.input.name;
        if (args.input.email !== undefined && args.input.email !== null) {
          const targetEmail = args.input.email.trim().toLowerCase();
          const currentUser = await context.prisma.user.findUnique({
            where: { id: viewer.id },
            select: { googleSubject: true, email: true },
          });
          if (currentUser?.googleSubject && currentUser.email !== targetEmail) {
            throw createValidationError('Cannot change email for Google-authenticated accounts.');
          }
          data.email = targetEmail;
        }
        const user = await context.prisma.user.update({ where: { id: viewer.id }, data });
        return { user, success: true as const };
      }, { user: null, success: false as const });
    },
    fileUpload: async (
      _parent: unknown,
      args: { input: { filename: string; mimeType: string; content: string } },
      context: GraphQLContext,
    ): Promise<{ attachment: Attachment | null; success: boolean }> => {
      const viewer = requireAuthentication(context);
      return runMutation(async () => {
        const buffer = Buffer.from(args.input.content, 'base64');
        if (buffer.length > MAX_UPLOAD_BYTES) {
          throw createValidationError(UPLOAD_TOO_LARGE_MESSAGE);
        }
        const uploadsDir = getUploadsDirectory();
        if (!existsSync(uploadsDir)) {
          mkdirSync(uploadsDir, { recursive: true });
        }
        const requestedExt = extname(args.input.filename).toLowerCase();
        const ext = /^\.[a-z0-9]{1,10}$/.test(requestedExt) ? requestedExt : '';
        const storedName = `${randomUUID()}${ext}`;
        const filePath = join(uploadsDir, storedName);
        writeFileSync(filePath, buffer);
        const url = `/uploads/${storedName}`;
        try {
          const attachment = await context.prisma.attachment.create({
            data: {
              filename: args.input.filename,
              mimeType: args.input.mimeType,
              size: buffer.length,
              url,
              uploaderId: viewer.id,
            },
          });
          return { attachment, success: true as const };
        } catch (error) {
          try {
            unlinkSync(filePath);
          } catch {
            // Best effort: the DB write already failed, don't mask it.
          }
          throw error;
        }
      }, { attachment: null, success: false as const });
    },
  },
  OpsAuditRecord: {
    byActor: (parent: { byActorId: string | null }, _args: unknown, context: GraphQLContext) =>
      parent.byActorId ? context.prisma.user.findUnique({ where: { id: parent.byActorId } }) : null,
  },
  WorkRunRecord: {
    actor: (parent: { actorId?: string | null }, _args: Record<string, never>, context: GraphQLContext) =>
      parent.actorId ? context.prisma.user.findUnique({ where: { id: parent.actorId } }) : null,
  },
  Team: {
    viewerCanWrite: (parent: TeamParent, _args: Record<string, never>, context: GraphQLContext): Promise<boolean> =>
      assertCanWriteTeam(context.prisma, context, parent.id).then(() => true, () => false),
    viewerCanManage: (parent: TeamParent, _args: Record<string, never>, context: GraphQLContext): Promise<boolean> =>
      assertCanManageTeam(context.prisma, context, parent.id).then(() => true, () => false),
    viewerIsMember: async (parent: TeamParent, _args: Record<string, never>, context: GraphQLContext): Promise<boolean> =>
      Boolean(context.viewer && await context.prisma.teamMembership.findUnique({
        where: { teamId_userId: { teamId: parent.id, userId: context.viewer.id } },
        select: { id: true },
      })),
    viewerCanJoin: async (parent: TeamParent, _args: Record<string, never>, context: GraphQLContext): Promise<boolean> => {
      const viewer = context.viewer;
      if (!viewer || viewer.actorKind !== 'HUMAN' || viewer.globalRole === 'GUEST') return false;
      if (parent.visibility !== 'PUBLIC' || parent.archivedAt) return false;
      const member = await context.prisma.teamMembership.findUnique({
        where: { teamId_userId: { teamId: parent.id, userId: viewer.id } },
        select: { id: true },
      });
      return !member;
    },
    triageRotation: async (parent: TeamParent, _args: Record<string, never>, context: GraphQLContext) => {
      const rotation = parseRotation((parent as TeamParent & { triageRotation?: Prisma.JsonValue | null }).triageRotation);
      if (!rotation) return null;
      const users = await context.prisma.user.findMany({ where: { id: { in: rotation.userIds } } });
      const byId = new Map(users.map((user) => [user.id, user]));
      return { users: rotation.userIds.map((id) => byId.get(id)).filter(Boolean), startsAt: rotation.startsAt };
    },
    currentTriager: async (parent: TeamParent, _args: Record<string, never>, context: GraphQLContext) => {
      const id = currentTriager((parent as TeamParent & { triageRotation?: Prisma.JsonValue | null }).triageRotation, new Date());
      return id ? context.prisma.user.findUnique({ where: { id } }) : null;
    },
    states: async (
      parent: TeamParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: WorkflowState[] }> => {
      const states =
        parent.states ??
        (await context.prisma.workflowState.findMany({
          where: {
            teamId: parent.id,
          },
        }));

      return {
        nodes: orderWorkflowStates(states),
      };
    },
    memberships: async (
      parent: TeamParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: TeamMembershipParent[] }> => {
      // Every member sees the roster with roles; changing it stays with owners (docs/permissions.md §3).
      const canSee = await canSeeTeamRoster(context.prisma, context, parent.id);

      if (!canSee) {
        return {
          nodes: [],
        };
      }

      return {
        nodes:
          parent.memberships ??
          (await context.prisma.teamMembership.findMany({
            where: {
              teamId: parent.id,
            },
            include: {
              user: true,
            },
            orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          })),
      };
    },
    issueCount: async (
      parent: TeamParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<number> => {
      return context.prisma.issue.count({
        where: {
          teamId: parent.id,
          commitmentStatus: 'COMMITTED',
        },
      });
    },
  },
  IssueLabel: {
    issueCount: (parent: { id: string }, _args: unknown, context: GraphQLContext): Promise<number> =>
      context.prisma.issue.count({ where: { labels: { some: { id: parent.id } } } }),
  },
  WorkflowState: {
    issueCount: (parent: { id: string }, _args: unknown, context: GraphQLContext): Promise<number> =>
      context.prisma.issue.count({ where: { stateId: parent.id } }),
  },
  WorkspaceSettings: {
    defaultTeams: (parent: { defaultTeamIds: string[] }, _args: Record<string, never>, context: GraphQLContext) =>
      parent.defaultTeamIds.length === 0 ? [] : context.prisma.team.findMany({ where: { id: { in: parent.defaultTeamIds } }, orderBy: { key: 'asc' } }),
  },
  User: {
    accessStatus: (parent: UserParent): string => userAccessStatus(parent),
    invitedAt: (parent: UserParent): Date | null => parent.invitedAt ?? null,
    teamMemberships: async (parent: UserParent, _args: Record<string, never>, context: GraphQLContext) => {
      const readableTeam = buildReadableTeamWhere(context);
      return context.prisma.teamMembership.findMany({
        where: { userId: parent.id, ...(readableTeam ? { team: readableTeam } : {}) },
        include: { team: true, user: true },
        orderBy: { team: { key: 'asc' } },
      });
    },
    isMe: (parent: UserParent, _args: Record<string, never>, context: GraphQLContext): boolean =>
      context.viewer?.id === parent.id,
    emailNotifications: (parent: UserParent, _args: Record<string, never>, context: GraphQLContext): boolean | null => {
      if (context.viewer?.id !== parent.id) return null;
      const prefs = parent.notificationPrefs as { emailNotifications?: unknown } | null;
      return prefs?.emailNotifications !== false;
    },
    globalRole: (parent: UserParent): User['globalRole'] => parent.globalRole,
    actorKind: (parent: UserParent): User['actorKind'] => parent.actorKind,
    successorActor: async (
      parent: UserParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> =>
      parent.successorActorId
        ? context.prisma.user.findUnique({ where: { id: parent.successorActorId } })
        : null,
    owner: async (
      parent: UserParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> =>
      parent.ownerId ? context.prisma.user.findUnique({ where: { id: parent.ownerId } }) : null,
    presence: (parent: UserParent): string => actorPresence(parent.lastSeenAt),
    presenceDetail: (parent: UserParent): string =>
      ACTOR_PRESENCE_COPY[actorPresence(parent.lastSeenAt)],
    credentialCounts: async (
      parent: UserParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ active: number; revoked: number }> => {
      if (parent.actorKind === 'HUMAN') return { active: 0, revoked: 0 };
      const [active, revoked] = await Promise.all([
        context.prisma.agentCredential.count({ where: { userId: parent.id, revokedAt: null } }),
        context.prisma.agentCredential.count({ where: { userId: parent.id, revokedAt: { not: null } } }),
      ]);
      return { active, revoked };
    },
  },
  WorkClaimRecord: {
    id: (parent: WorkClaimParent): string => parent.id,
    actor: async (
      parent: WorkClaimParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User> =>
      parent.actor ??
      context.prisma.user.findUniqueOrThrow({
        where: { id: parent.actorId },
      }),
  },
  WorkGraph: {
    timeline: (parent: ProjectWorkGraph, _args: Record<string, never>, context: GraphQLContext) =>
      loadWorkTimelines(
        context.prisma,
        parent.nodes.map((node) => ({
          id: node.id,
          stateId: node.stateId,
          commitmentStatus: node.commitmentStatus,
          updatedAt: node.updatedAt,
        })),
      ),
    cycles: (parent: ProjectWorkGraph, _args: Record<string, never>, context: GraphQLContext) => {
      const teamId = parent.root?.teamId ?? parent.nodes[0]?.teamId;
      return teamId
        ? context.prisma.cycle.findMany({ where: { teamId }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] })
        : [];
    },
  },
  WorkLink: {
    from: async (
      parent: WorkLinkParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Issue> =>
      parent.from ??
      context.prisma.issue.findUniqueOrThrow({
        where: {
          id: parent.fromId,
        },
      }),
    to: async (
      parent: WorkLinkParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Issue> =>
      parent.to ??
      context.prisma.issue.findUniqueOrThrow({
        where: {
          id: parent.toId,
        },
      }),
  },
  TeamMembership: {
    team: (parent: TeamMembershipParent & { team?: Team | null }, _args: Record<string, never>, context: GraphQLContext) =>
      parent.team ?? context.prisma.team.findUniqueOrThrow({ where: { id: parent.teamId } }),
    user: async (
      parent: TeamMembershipParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User> =>
      parent.user ??
      context.prisma.user.findUniqueOrThrow({
        where: {
          id: parent.userId,
        },
      }),
  },
  AgentCredentialRecord: {
    issuedBy: async (
      parent: AgentCredentialParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> =>
      parent.issuedById ? context.prisma.user.findUnique({ where: { id: parent.issuedById } }) : null,
    user: async (
      parent: AgentCredentialParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User> =>
      parent.user ??
      context.prisma.user.findUniqueOrThrow({
        where: {
          id: parent.userId,
        },
      }),
  },
  Comment: {
    user: async (
      parent: CommentParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> =>
      parent.user ??
      context.prisma.user.findUnique({
        where: {
          id: parent.userId,
        },
      }),
    replies: async (
      parent: CommentParent,
      args: { first?: number | null },
      context: GraphQLContext,
    ): Promise<Comment[]> =>
      context.prisma.comment.findMany({
        where: { parentCommentId: parent.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(args.first === undefined || args.first === null
          ? {}
          : { take: clampConnectionFirst(args.first, MAX_COMMENTS_CONNECTION_FIRST) }),
      }),
    mentions: async (
      parent: CommentParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Array<{ actor: User; createdAt: Date; id: string }>> => {
      const mentions = await context.prisma.commentMention.findMany({
        where: { commentId: parent.id },
        include: { actor: true },
        orderBy: { createdAt: 'asc' },
      });
      return mentions.map((mention) => ({
        actor: mention.actor,
        createdAt: mention.createdAt,
        id: mention.id,
      }));
    },
  },
  Issue: {
    priority: (parent: IssueParent): number => parent.priority,
    state: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<WorkflowState> =>
      parent.state ??
      context.prisma.workflowState.findUniqueOrThrow({
        where: {
          id: parent.stateId,
        },
      }),
    labels: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => ({
      nodes:
        parent.labels ??
        (await context.prisma.issueLabel.findMany({
          where: {
            issues: {
              some: {
                id: parent.id,
              },
            },
          },
          orderBy: {
            name: 'asc',
          },
        })),
    }),
    assignee: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> => {
      if (!parent.assigneeId) {
        return null;
      }

      return (
        parent.assignee ??
        context.prisma.user.findUnique({
          where: {
            id: parent.assigneeId,
          },
        })
      );
    },
    parent: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Issue | null> => {
      if (!parent.parentId) {
        return null;
      }

      return (
        parent.parent ??
        context.prisma.issue.findUnique({
          where: {
            id: parent.parentId,
          },
        })
      );
    },
    children: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const nodes =
        parent.children ??
        (await context.prisma.issue.findMany({
          where: {
            parentId: parent.id,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }));

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, false),
      };
    },
    team: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Team> =>
      parent.team ??
      context.prisma.team.findUniqueOrThrow({
        where: {
          id: parent.teamId,
        },
      }),
    project: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Project | null> => {
      if (!parent.projectId) return null;
      return parent.project ?? context.prisma.project.findUnique({ where: { id: parent.projectId } });
    },
    links: async (
      parent: IssueParent,
      args: { type?: WorkLinkType | null },
      context: GraphQLContext,
    ): Promise<{ nodes: WorkLink[] }> => ({
      nodes: await listIncidentLinks(context.prisma, parent.id, args.type),
    }),
    dependencyHints: (parent: IssueParent, _args: Record<string, never>, context: GraphQLContext): Promise<string[]> =>
      dependencyHints(context.prisma, { id: parent.id, teamId: parent.teamId, texts: mentionTexts(parent) }),
    contractDigest: (parent: IssueParent) => snapshotContract(parent).contractRevision,
    rejectionReason: async (parent: IssueParent, _args: Record<string, never>, context: GraphQLContext) => {
      if (parent.commitmentStatus !== 'REJECTED') return null;
      const audit = await context.prisma.workAudit.findFirst({
        where: { workId: parent.id, after: { path: ['commitmentStatus'], equals: 'REJECTED' } },
        orderBy: { createdAt: 'desc' },
        select: { reason: true },
      });
      return audit?.reason ?? null;
    },
    bugSla: async (parent: IssueParent, _args: Record<string, never>, context: GraphQLContext) => {
      if (parent.commitmentStatus !== 'COMMITTED') return null;
      // Labels are usually loaded with the issue: skip non-bugs without a query.
      if (parent.labels && !parent.labels.some((label) => label.name.toLowerCase() === BUG_LABEL_NAME.toLowerCase())) return null;
      const sla = (await loadBugSlas(context.prisma, [parent.id])).get(parent.id);
      if (!sla) return null;
      return {
        status: sla.status,
        budgetHours: Math.round(sla.budgetMs / 3_600_000),
        elapsedMs: sla.elapsedMs,
        remainingMs: sla.remainingMs,
        dueAt: sla.dueAt?.toISOString() ?? null,
        startedAt: sla.startedAt.toISOString(),
      };
    },
    openBlockers: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Issue[]> => {
      if (parent.incomingLinks) return parent.incomingLinks.flatMap((link) => (link.from ? [link.from] : []));
      const query = buildOpenBlockerLinkQuery(buildReadableIssueWhere(context));
      const links = await context.prisma.workLink.findMany({ ...query, where: { ...query.where, toId: parent.id } });
      return links.map((link) => link.from);
    },
    pendingContractAmendment: (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<ContractAmendment | null> =>
      context.prisma.contractAmendment.findFirst({
        where: { status: 'PENDING', workId: parent.id },
        orderBy: { createdAt: 'desc' },
      }),
    claim: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<WorkClaimParent | null> =>
      context.prisma.workClaim.findUnique({
        where: { workId: parent.id },
        include: { actor: true },
      }),
    cycle: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Cycle | null> => {
      if (!parent.cycleId) return null;
      return parent.cycle ?? context.prisma.cycle.findUnique({ where: { id: parent.cycleId } });
    },
    projectId: (parent: IssueParent): string | null => parent.projectId,
    cycleId: (parent: IssueParent): string | null => parent.cycleId,
    comments: async (
      parent: IssueParent,
      args: {
        after?: string | null;
        first?: number;
        orderBy?: CommentOrderByInput;
        rootsOnly?: boolean | null;
      },
      context: GraphQLContext,
    ): Promise<{ nodes: Comment[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const first = args.first === undefined
        ? undefined
        : clampConnectionFirst(args.first, MAX_COMMENTS_CONNECTION_FIRST);

      if (
        parent.comments &&
        (args.after === undefined || args.after === null) &&
        !args.rootsOnly &&
        isDefaultCommentOrder(args.orderBy)
      ) {
        const nodes = first === undefined ? parent.comments : parent.comments.slice(0, first);

        return {
          nodes,
          pageInfo: buildPageInfo(nodes, first !== undefined && parent.comments.length > first),
        };
      }

      const comments = await context.prisma.comment.findMany({
        where: buildCommentWhere(parent.id, args.after, args.rootsOnly),
        orderBy: buildCommentOrderBy(args.orderBy),
        ...(first === undefined ? {} : { take: first + 1 }),
      });
      const nodes = first === undefined ? comments : comments.slice(0, first);

      return {
        nodes,
        pageInfo: buildPageInfo(nodes, first !== undefined && comments.length > first),
      };
    },
    proposedByActor: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> => {
      const provenance = await findWorkProvenance(context.prisma, parent.id);
      return provenance.actor;
    },
    provenance: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<WorkProvenanceResult> => {
      const provenance = await findWorkProvenance(context.prisma, parent.id);
      return { ...provenance, source: parent.source ?? null };
    },
    shares: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<WorkShareParent[]> => {
      if (parent.kind !== 'PROJECT') return [];
      const canManage = await assertCanManageTeam(context.prisma, context, parent.teamId).then(() => true, () => false);
      return canManage ? listWorkShares(context.prisma, parent.id) : [];
    },
    viewerCanShare: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<boolean> =>
      parent.kind === 'PROJECT'
        && assertCanManageTeam(context.prisma, context, parent.teamId).then(() => true, () => false),
    agentRequests: async (
      parent: IssueParent,
      args: { first?: number | null },
      context: GraphQLContext,
    ): Promise<AgentRequestParent[]> => {
      // Newest first, so a fresh hand-off on a busy work item is never hidden
      // behind the cap (INV-597 follow-up). Then every chain touched is
      // completed: a hop without its root is unreadable, and a chain has at
      // most MAX_HANDOFF_HOPS hops, so the overshoot is bounded.
      const newest = await context.prisma.agentRequest.findMany({
        where: { workId: parent.id },
        orderBy: [{ createdAt: 'desc' }],
        take: args.first === undefined || args.first === null
          ? MAX_AGENT_REQUESTS_CONNECTION_FIRST
          : clampConnectionFirst(args.first, MAX_AGENT_REQUESTS_CONNECTION_FIRST),
      });
      const roots = [...new Set(newest.map((request) => request.rootRequestId ?? request.id))];
      const rest = roots.length === 0
        ? []
        : await context.prisma.agentRequest.findMany({
          where: {
            id: { notIn: newest.map((request) => request.id) },
            workId: parent.id,
            OR: [{ id: { in: roots } }, { rootRequestId: { in: roots } }],
          },
        });
      return [...newest, ...rest].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
  },
  WorkAuditRecord: {
    receipt: async (
      parent: { id: string },
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<DecisionReceipt | null> =>
      context.prisma.decisionReceipt.findUnique({ where: { auditId: parent.id } }),
  },
  DecisionReceiptRecord: {
    actor: async (
      parent: DecisionReceipt,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User> => context.prisma.user.findUniqueOrThrow({ where: { id: parent.actorId } }),
    evidence: (parent: DecisionReceipt): unknown[] => (Array.isArray(parent.evidence) ? parent.evidence : []),
    inputs: (parent: DecisionReceipt): unknown[] => (Array.isArray(parent.inputs) ? parent.inputs : []),
  },
  AgentRequest: {
    state: (parent: AgentRequestParent): string => toWireState(parent.state),
    presence: (parent: AgentRequestParent): string => agentRequestPresence(parent),
    presenceDetail: (parent: AgentRequestParent): string =>
      PRESENCE_COPY[agentRequestPresence(parent)],
    targetActor: async (
      parent: AgentRequestParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User> =>
      context.prisma.user.findUniqueOrThrow({ where: { id: parent.targetActorId } }),
    requestedByActor: async (
      parent: AgentRequestParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User> =>
      context.prisma.user.findUniqueOrThrow({ where: { id: parent.requestedByActorId } }),
    successorActor: async (
      parent: AgentRequestParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> => {
      const target = await context.prisma.user.findUnique({
        where: { id: parent.targetActorId },
        select: { successorActorId: true },
      });
      if (!target?.successorActorId) {
        return null;
      }
      return context.prisma.user.findUnique({ where: { id: target.successorActorId } });
    },
  },
  Project: {
    lead: async (
      parent: ProjectParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> => {
      if (!parent.leadId) return null;
      return parent.lead ?? context.prisma.user.findUnique({ where: { id: parent.leadId } });
    },
    team: async (
      parent: ProjectParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Team> =>
      parent.team ?? context.prisma.team.findUniqueOrThrow({ where: { id: parent.teamId } }),
    issues: async (
      parent: ProjectParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const nodes = parent.issues ?? await context.prisma.issue.findMany({
        where: { projectId: parent.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return { nodes, pageInfo: buildPageInfo(nodes, false) };
    },
  },
  Cycle: {
    team: async (
      parent: CycleParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Team> =>
      parent.team ?? context.prisma.team.findUniqueOrThrow({ where: { id: parent.teamId } }),
    issues: async (
      parent: CycleParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }> => {
      const nodes = parent.issues ?? await context.prisma.issue.findMany({
        where: { cycleId: parent.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return { nodes, pageInfo: buildPageInfo(nodes, false) };
    },
  },
};

export function createGraphQLSchema(_prisma: PrismaClient) {
  return makeExecutableSchema({
    typeDefs,
    resolvers,
  });
}

async function getIssueById(prisma: PrismaClient, id: string): Promise<IssueParent> {
  return prisma.issue.findUniqueOrThrow({
    where: {
      id,
    },
    include: buildIssueDetailInclude(),
  });
}

// ISO week starts on Monday; buckets are keyed by the UTC date of that Monday.
function startOfUtcWeek(date: Date): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

function buildBugWeekBuckets(): Map<string, number> {
  const buckets = new Map<string, number>();
  const currentWeek = startOfUtcWeek(new Date());
  for (let offset = BUG_TREND_WEEKS - 1; offset >= 0; offset -= 1) {
    const weekStart = new Date(currentWeek.getTime() - offset * 7 * MS_PER_DAY);
    buckets.set(weekStart.toISOString().slice(0, 10), 0);
  }
  return buckets;
}

async function resolveTeamByIdOrKey(prisma: PrismaClient, idOrKey: string): Promise<Team | null> {
  try {
    const byId = await prisma.team.findUnique({ where: { id: idOrKey } });
    if (byId) return byId;
  } catch {
    // Non-UUID values fall through to key lookup.
  }
  return prisma.team.findUnique({ where: { key: idOrKey } });
}

// Webhook scope gate (Linear parity: only workspace admins manage webhooks).
// Team-scoped subscriptions need team OWNER; global (all-teams) ones need a
// global ADMIN or trusted system caller.
async function resolveWebhookTeamId(context: GraphQLContext, team: string | null): Promise<string | null> {
  if (!team) {
    if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
      return null;
    }
    throw createValidationError(TEAM_MANAGE_FORBIDDEN_MESSAGE);
  }
  const record = await resolveTeamByIdOrKey(context.prisma, team);
  if (!record) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  await assertCanManageTeam(context.prisma, context, record.id);
  return record.id;
}

/** Webhook changes go on the ops audit (INV-796); the secret never does. */
async function auditWebhook(
  context: GraphQLContext,
  action: string,
  subscription: WebhookSubscription,
  details: Record<string, unknown> = {},
): Promise<void> {
  await recordOpsAudit(context.prisma, {
    action,
    subject: subscription.label ? `${subscription.label} (${subscription.url})` : subscription.url,
    byActorId: context.viewer?.id ?? null,
    details: { subscriptionId: subscription.id, teamId: subscription.teamId, ...details } as Prisma.InputJsonValue,
  });
}

async function requireWebhookSubscription(
  context: GraphQLContext,
  id: string,
): Promise<WebhookSubscription> {
  let subscription: WebhookSubscription | null = null;
  try {
    subscription = await context.prisma.webhookSubscription.findUnique({ where: { id } });
  } catch {
    subscription = null;
  }
  if (!subscription) throw createNotFoundError(WEBHOOK_NOT_FOUND_MESSAGE);
  await resolveWebhookTeamId(context, subscription.teamId);
  return subscription;
}

function normalizeWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw createValidationError(WEBHOOK_URL_INVALID_MESSAGE);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createValidationError(WEBHOOK_URL_INVALID_MESSAGE);
  }
  return parsed.toString();
}

function normalizeWebhookFilterQuery(filterQuery: string | null): string | null {
  const trimmed = filterQuery?.trim() || null;
  if (trimmed) {
    // Fail creation/update fast on malformed filters instead of silently
    // dropping every delivery later.
    parseIqlOrThrow(trimmed);
  }
  return trimmed;
}

function normalizeWebhookEventTypes(eventTypes: string[] | null): string[] {
  if (!eventTypes || eventTypes.length === 0) {
    return [];
  }
  const normalized = [...new Set(eventTypes.map((type) => type.trim()).filter(Boolean))];
  const unknown = normalized.filter((type) => !(WORK_EVENT_TYPES as readonly string[]).includes(type));
  if (unknown.length > 0) {
    throw createValidationError(WEBHOOK_EVENT_TYPE_INVALID_MESSAGE);
  }
  return normalized;
}

function buildTeamWhere(filter: TeamFilterInput | null | undefined) {
  const key = filter?.key?.eq;

  if (key === undefined || key === null) {
    return undefined;
  }

  return {
    key,
  };
}

function buildIssueLabelWhere(filter: IssueLabelFilterInput | null | undefined) {
  const name = filter?.name?.eq;

  if (name === undefined || name === null) {
    return undefined;
  }

  return {
    name,
  };
}

function combineTeamWhere(
  left: Prisma.TeamWhereInput | undefined,
  right: Prisma.TeamWhereInput | undefined,
): Prisma.TeamWhereInput | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    AND: [left, right],
  };
}

function serializeDateTime(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return parseDateTime(value).toISOString();
  }

  throw new TypeError('DateTime values must be Date instances or ISO 8601 strings.');
}

function clampConnectionFirst(requestedFirst: number, maxFirst: number): number {
  if (!Number.isFinite(requestedFirst) || requestedFirst < 1) {
    return 1;
  }

  return Math.min(Math.trunc(requestedFirst), maxFirst);
}

function parseDateTime(value: string): Date {
  const parsedValue = new Date(value);

  if (Number.isNaN(parsedValue.getTime())) {
    throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
  }

  return parsedValue;
}

function buildCommentOrderBy(
  orderBy: CommentOrderByInput | null | undefined,
): Prisma.CommentOrderByWithRelationInput[] {
  if (orderBy === undefined || orderBy === null || orderBy === 'createdAt') {
    return COMMENT_ORDER_BY.slice();
  }

  return COMMENT_ORDER_BY.slice();
}

function isDefaultCommentOrder(orderBy: CommentOrderByInput | null | undefined): boolean {
  return orderBy === undefined || orderBy === null || orderBy === 'createdAt';
}

function encodeCursor(entity: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: entity.createdAt.toISOString(),
      id: entity.id,
    } satisfies CursorPayload),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(after: string): CursorPayload {
  const parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as Partial<CursorPayload>;

  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new TypeError('Invalid cursor payload.');
  }

  return {
    createdAt: parsed.createdAt,
    id: parsed.id,
  };
}

function buildPageInfo(
  nodes: Array<{ createdAt: Date; id: string }>,
  hasNextPage: boolean,
): { endCursor: string | null; hasNextPage: boolean } {
  const lastNode = nodes[nodes.length - 1];

  return {
    hasNextPage,
    endCursor: lastNode ? encodeCursor(lastNode) : null,
  };
}

function combineIssueWhere(
  left: Prisma.IssueWhereInput | undefined,
  right: Prisma.IssueWhereInput | undefined,
): Prisma.IssueWhereInput | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    AND: [left, right],
  };
}

function buildIssueCursorWhere(after: string | null | undefined): Prisma.IssueWhereInput | undefined {
  if (!after) {
    return undefined;
  }

  const cursor = decodeCursor(after);
  const createdAt = parseDateTime(cursor.createdAt);

  return {
    OR: [
      {
        createdAt: {
          lt: createdAt,
        },
      },
      {
        createdAt,
        id: {
          lt: cursor.id,
        },
      },
    ],
  };
}

function buildCommentWhere(
  issueId: string,
  after: string | null | undefined,
  rootsOnly: boolean | null | undefined = false,
): Prisma.CommentWhereInput {
  // A work item carries several threads (INV-561); `rootsOnly` lists the
  // threads rather than every comment across all of them.
  const threadFilter: Prisma.CommentWhereInput = rootsOnly ? { parentCommentId: null } : {};

  if (!after) {
    return {
      issueId,
      ...threadFilter,
    };
  }

  const cursor = decodeCursor(after);
  const createdAt = parseDateTime(cursor.createdAt);

  return {
    issueId,
    ...threadFilter,
    OR: [
      {
        createdAt: {
          gt: createdAt,
        },
      },
      {
        createdAt,
        id: {
          gt: cursor.id,
        },
      },
    ],
  };
}

/**
 * Every refusal carries its exposed reason in `message` (INV-795): a client
 * that gets a bare `success: false` cannot tell a person what to fix.
 */
async function runMutation<TResult extends { success: true }, TFallback extends { success: false }>(
  operation: () => Promise<TResult>,
  fallback: TFallback,
): Promise<TResult | (TFallback & { message: string | null })> {
  return runMutationWithReason(operation, fallback);
}

/**
 * `runMutation`, but a refusal carries the exposed reason in `message` so a
 * caller editing the work graph can say why (cycle, unknown work, hierarchy
 * rule) instead of a bare `success: false` (INV-679).
 */
/** The work item an amendment belongs to, for the write check before deciding it. */
async function amendmentWorkId(prisma: DatabaseClient, amendmentId: string): Promise<string> {
  const amendment = await prisma.contractAmendment.findUnique({ where: { id: amendmentId }, select: { workId: true } });
  if (!amendment) throw createNotFoundError(CONTRACT_AMENDMENT_NOT_FOUND_MESSAGE);
  return amendment.workId;
}

async function runMutationWithReason<TResult extends { success: true }, TFallback extends { success: false }>(
  operation: () => Promise<TResult>,
  fallback: TFallback,
): Promise<TResult | (TFallback & { message: string | null })> {
  try {
    return await operation();
  } catch (error) {
    const exposedError = getExposedError(error);
    if (exposedError?.extensions.code === 'FORBIDDEN') {
      throw exposedError;
    }
    if (exposedError || isPrismaInvalidInputError(error)) {
      return { ...fallback, message: exposedError?.message ?? null };
    }
    throw error;
  }
}

async function workflowStateTeamId(prisma: DatabaseClient, stateId: string): Promise<string> {
  const state = await prisma.workflowState.findUnique({ where: { id: stateId }, select: { teamId: true } });
  if (!state) throw createNotFoundError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
  return state.teamId;
}

async function upsertTeamMemberUser(
  prisma: DatabaseClient,
  email: string,
  name: string | null,
): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase();

  return prisma.user.upsert({
    where: {
      email: normalizedEmail,
    },
    create: {
      email: normalizedEmail,
      name: name?.trim() || fallbackUserName(normalizedEmail),
    },
    update: {},
  });
}

async function canManageTeamMemberships(
  prisma: DatabaseClient,
  context: GraphQLContext,
  teamId: string,
): Promise<boolean> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return true;
  }

  if (!context.viewer) {
    return false;
  }

  const membership = await prisma.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId,
        userId: context.viewer.id,
      },
    },
    select: {
      role: true,
    },
  });

  return membership?.role === 'OWNER';
}

async function assertTeamRetainsOwner(
  prisma: DatabaseClient,
  teamId: string,
  options: { excludedUserId?: string; nextRole?: TeamMembershipRole | null },
): Promise<void> {
  const ownerCount = await prisma.teamMembership.count({
    where: {
      teamId,
      role: 'OWNER',
      ...(options.excludedUserId ? { userId: { not: options.excludedUserId } } : {}),
    },
  });

  if (ownerCount > 0 || options.nextRole === 'OWNER') {
    return;
  }

  throw createValidationError(TEAM_OWNER_REQUIRED_MESSAGE);
}

function fallbackUserName(email: string): string {
  const localPart = email.split('@')[0]?.trim();

  return localPart || email;
}

function getRequestedIssueConnectionFields(info: GraphQLResolveInfo): Set<string> {
  const fieldNames = new Set<string>();

  for (const fieldNode of info.fieldNodes) {
    collectIssueConnectionFieldNames(fieldNode.selectionSet, info.fragments, fieldNames, false);
  }

  return fieldNames;
}

function collectIssueConnectionFieldNames(
  selectionSet: SelectionSetNode | undefined,
  fragments: Record<string, FragmentDefinitionNode>,
  fieldNames: Set<string>,
  insideNodes: boolean,
): void {
  if (!selectionSet) {
    return;
  }

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      collectIssueConnectionFieldName(selection, fragments, fieldNames, insideNodes);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectIssueConnectionFieldNames(selection.selectionSet, fragments, fieldNames, insideNodes);
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      collectIssueConnectionFieldNames(
        fragments[selection.name.value]?.selectionSet,
        fragments,
        fieldNames,
        insideNodes,
      );
    }
  }
}

function collectIssueConnectionFieldName(
  field: FieldNode,
  fragments: Record<string, FragmentDefinitionNode>,
  fieldNames: Set<string>,
  insideNodes: boolean,
): void {
  if (insideNodes) {
    fieldNames.add(field.name.value);
    return;
  }

  if (field.name.value === 'nodes') {
    collectIssueConnectionFieldNames(field.selectionSet, fragments, fieldNames, true);
    return;
  }

  collectIssueConnectionFieldNames(field.selectionSet, fragments, fieldNames, false);
}
