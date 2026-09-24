import type {
  AgentCredential,
  AgentRequest,
  Attachment,
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
} from '@prisma/client';

import { makeExecutableSchema } from '@graphql-tools/schema';
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
} from './access-control.js';
import type {
  CreateCommentInput,
  CreateIssueInput,
  UpdateIssueInput,
} from './issue-service.js';
import { buildIssueWhere, type IssueFilterInput } from './issue-filter.js';
import { compileIqlToIssueWhere, parseIqlOrThrow } from './iql-compile.js';

import { requireAuthentication, type GraphQLContext } from './auth.js';
import { isPlausibleEmail, issueAgentCredential, parseAgentScopeList } from './agent-credentials.js';
import type { AgentScope } from './agent-credentials.js';
import { WORK_EVENT_TYPES, enqueueWorkEvent } from './event-outbox.js';
import { toWireState } from './agent-request-state.js';
import { PRESENCE_COPY, agentRequestPresence } from './agent-request-presence.js';
import { ACTOR_PRESENCE_COPY, actorPresence } from './actor-presence.js';
import { deactivateActor, transferActorOwner, reactivateActor, recordActorAudit } from './actor-lifecycle.js';
import { isValidHandle, normalizeHandle } from './mention-parser.js';
import { EVIDENCE_NOT_FOUND_MESSAGE, retractEvidence } from './evidence-retract.js';
import { answerAgentRequestAsHuman } from './agent-request-service.js';
import { provisionServiceActor } from './service-actors.js';
import {
  findWorkProvenance,
  getAgentProfile,
  listAgentActors,
  type AgentProfile as AgentProfileResult,
  type WorkProvenance as WorkProvenanceResult,
} from './agent-directory.js';
import { createComment, createIssue, createIssueInTransaction, deleteComment, deleteIssue, updateIssue } from './issue-service.js';
import { projectWorkNotifications } from './notification-service.js';
import { auditMergedPrTraceability } from './traceability-audit.js';
import { suggestedBranchName } from './branch-name.js';
import { createWorkLink, deleteWorkLink, listIncidentLinks } from './link-service.js';
import { writeActorFromViewer } from './work-service.js';
import { getUploadsDirectory } from './uploads.js';
import { loadProjectWorkGraph, type ProjectWorkGraph } from './work-graph-view.js';
import {
  findWorkByIdOrIdentifier,
  getWorkContext,
  listReadyWork,
  type ListReadyWorkInput,
  type WorkContextBundle,
} from './context-service.js';
import {
  claimWork,
  commitWork,
  proposeWork,
  rejectWork,
  type ClaimWorkInput,
  type CommitWorkInput,
  type ProposeWorkInput,
  type RejectWorkInput,
} from './claim-service.js';
import { attachEvidence, reportRun, reviewWork } from './run-service.js';
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
};
type WorkLinkParent = WorkLink & { from?: Issue | null; to?: Issue | null };
type WorkClaimParent = WorkClaim & { actor?: User | null };
type AgentCredentialParent = AgentCredential & { user?: User | null };

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

interface BugReportInput {
  teamId: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  repository?: string | null;
  labelIds?: string[] | null;
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

const BUG_LABEL_NAME = 'bug';
const BUG_REPORT_SOURCE = 'bug-report';
const BUG_TREND_WEEKS = 8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function buildIssueListInclude(
  options: { includeChildren?: boolean; includeComments?: boolean } = {},
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

  type Query {
    viewer: User
    issue(id: String!): Issue
    issues(first: Int!, after: String, filter: IssueFilter, query: String): IssueConnection!
    teams(filter: TeamFilter): TeamConnection!
    issueLabels(filter: IssueLabelFilter): IssueLabelConnection!
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
    candidateSummary(teamFilter: TeamFilter): CandidateSummary!
    projectSummary(teamFilter: TeamFilter): ProjectSummaryResult!
    bugSummary(teamFilter: TeamFilter): BugSummaryResult!
    traceabilityAudit(days: Int): TraceabilityAuditResult!
    """Non-human actors (AGENT and SERVICE), most recently active first. Backs the directory and @ completion."""
    agents(teamKey: String, includeDeactivated: Boolean): [User!]!
    """One agent's profile, by handle or id."""
    agentProfile(handle: String!): AgentProfile
    agentCredentials(teamId: String!): [AgentCredentialRecord!]!
    webhooks(teamId: String!): [WebhookSubscriptionRecord!]!
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
    workCommit(id: String!, input: WorkCommitInput!): WorkCommitPayload!
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
    """A person completes a request addressed to them (INV-596): comment, answeredCommentId, COMPLETED, audit and event in one transaction. An ADMIN may answer for someone else with an overrideReason."""
    agentRequestAnswer(input: AgentRequestAnswerInput!): AgentRequestAnswerPayload!
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
  }

  type Team {
    id: ID!
    key: String!
    name: String!
    visibility: TeamVisibility!
    states: WorkflowStateConnection!
    memberships: TeamMembershipConnection!
    issueCount: Int!
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
  }

  type IssueLabel {
    id: ID!
    name: String!
  }

  type User {
    id: ID!
    name: String
    email: String
    isMe: Boolean
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
    """When the row was made; null for actors older than INV-604 with no earlier trace."""
    createdAt: DateTime
  }

  type AgentCredentialCounts {
    active: Int!
    revoked: Int!
  }

  enum GlobalRole {
    ADMIN
    USER
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

  type EvidenceRetractPayload {
    success: Boolean!
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
  }

  type AgentRequestAnswerPayload {
    success: Boolean!
    request: AgentRequest
    comment: Comment
  }

  type ActorLifecyclePayload {
    success: Boolean!
    actor: User
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
  }

  type AgentCredentialRevokePayload {
    success: Boolean!
    credential: AgentCredentialRecord
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
  }

  type NotificationMarkAllPayload {
    success: Boolean!
    count: Int!
  }

  type NotificationPreferencesPayload {
    success: Boolean!
    emailNotifications: Boolean!
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
    stateId: String
    priority: Int
    projectId: String
    cycleId: String
    kind: WorkKind
    assigneeId: String
    labelIds: [String!]
    repository: String
  }

  input BugReportInput {
    teamId: String!
    title: String!
    description: String
    priority: Int
    repository: String
    labelIds: [String!]
  }

  type BugReportPayload {
    success: Boolean!
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
    issue: Issue
  }

  type IssueUpdatePayload {
    success: Boolean!
    issue: Issue
  }

  type IssueDeletePayload {
    success: Boolean!
    issueId: ID
  }

  type CommentCreatePayload {
    success: Boolean!
    comment: Comment
  }

  type CommentDeletePayload {
    success: Boolean!
    commentId: ID
  }

  type TeamUpdateAccessPayload {
    success: Boolean!
    team: Team
  }

  type TeamMembershipUpsertPayload {
    success: Boolean!
    membership: TeamMembership
  }

  type TeamMembershipRemovePayload {
    success: Boolean!
    membershipId: ID
  }

  type ProjectCreatePayload {
    success: Boolean!
    project: Project
  }

  type ProjectUpdatePayload {
    success: Boolean!
    project: Project
  }

  type ProjectDeletePayload {
    success: Boolean!
    projectId: ID
  }

  type CycleCreatePayload {
    success: Boolean!
    cycle: Cycle
  }

  type CycleUpdatePayload {
    success: Boolean!
    cycle: Cycle
  }

  type CycleDeletePayload {
    success: Boolean!
    cycleId: ID
  }

  type UserUpdatePayload {
    success: Boolean!
    user: User
  }

  type FileUploadPayload {
    success: Boolean!
    attachment: Attachment
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
    relatedWorkId: String
    relatedWorkType: WorkLinkType
    idempotencyKey: String
    source: String
    initialState: String
  }

  input WorkCommitInput {
    expectedRevision: Int!
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
  }

  type WorkLinkMutationPayload {
    success: Boolean!
    link: WorkLink
  }

  type WorkLinkDeletePayload {
    success: Boolean!
    id: String
  }

  type WorkCommitPayload {
    success: Boolean!
    issue: Issue
  }

  type WorkRejectPayload {
    success: Boolean!
    issue: Issue
  }

  type WorkClaimPayload {
    success: Boolean!
    issue: Issue
    claim: WorkClaimRecord
    suggestedBranch: String
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
    runId: String!
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
  }

  type EvidenceAttachPayload {
    success: Boolean!
    issue: Issue
    evidence: WorkEvidenceRecord
  }

  type WorkReviewPayload {
    success: Boolean!
    issue: Issue
    decision: WorkReviewDecisionRecord
  }
`;

const resolvers = {
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
    viewer: (_parent: unknown, _args: Record<string, never>, context: GraphQLContext): User | null =>
      context.viewer,
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
          await assertCanReadTeam(context.prisma, context, issue.teamId);
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
        await assertCanReadTeam(context.prisma, context, issue.teamId);
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
      args: { filter?: TeamFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ nodes: Team[] }> => {
      const where = combineTeamWhere(buildTeamWhere(args.filter), buildReadableTeamWhere(context));

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
      };
    },
    traceabilityAudit: async (
      _parent: unknown,
      args: { days?: number | null },
      context: GraphQLContext,
    ) => {
      requireAuthentication(context);
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

      await assertCanReadTeam(context.prisma, context, work.teamId);
      return getWorkContext(context.prisma, work.id);
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
      return listAgentActors(context.prisma, {
        includeDeactivated: args.includeDeactivated ?? false,
        teamKey: args.teamKey ?? null,
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
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        const issue = await createIssue(
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
    bugReport: async (
      _parent: unknown,
      args: { input: BugReportInput },
      context: GraphQLContext,
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
        requireAuthentication(context);
        await assertCanWriteTeam(context.prisma, context, args.input.teamId);
        // Resolved outside the issue transaction: a concurrent first-ever
        // report may win the label create, and a failed INSERT would poison
        // a Postgres transaction.
        const bugLabel = await findOrCreateBugLabel(context.prisma);
        const labelIds = [...new Set([bugLabel.id, ...(args.input.labelIds ?? [])])];
        const created = await context.prisma.$transaction(async (transaction) => {
          const issue = await createIssueInTransaction(
            transaction,
            {
              description: args.input.description ?? null,
              kind: 'ISSUE',
              labelIds,
              priority: args.input.priority ?? null,
              repository: args.input.repository ?? null,
              source: BUG_REPORT_SOURCE,
              teamId: args.input.teamId,
              title: args.input.title,
            },
            writeActorFromViewer(context.viewer),
          );
          const payload = {
            identifier: issue.identifier,
            priority: issue.priority,
            repository: issue.repository,
            title: issue.title,
          };
          const event = await enqueueWorkEvent(transaction, {
            payload,
            type: 'bug.reported',
            workId: issue.id,
            workIdentifier: issue.identifier,
          });
          await projectWorkNotifications(transaction, {
            eventId: event.id,
            payload,
            type: 'bug.reported',
            work: issue,
          });
          return issue;
        });

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
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
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
    ): Promise<{ link: WorkLink | null; success: boolean }> =>
      runMutation(async () => {
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
    workLinkDelete: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<{ id: string | null; success: boolean }> =>
      runMutation(async () => {
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
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
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
    ): Promise<{ issue: IssueParent | null; success: boolean }> =>
      runMutation(async () => {
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
    ) => runMutation(async () => {
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
    ): Promise<{ evidence: WorkEvidence | null; success: boolean }> =>
      runMutation(async () => {
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
    agentRequestAnswer: async (
      _parent: unknown,
      args: { input: { body: string; overrideReason?: string | null; requestId: string } },
      context: GraphQLContext,
    ): Promise<{ comment: Comment | null; request: AgentRequestParent | null; success: boolean }> =>
      runMutation(async () => {
        const viewer = requireAuthentication(context);
        await assertCanActOnRequest(context.prisma, context, args.input.requestId);
        const answered = await answerAgentRequestAsHuman(context.prisma, {
          body: args.input.body,
          by: { actorId: viewer.id, actorKind: viewer.actorKind, globalRole: viewer.globalRole },
          id: args.input.requestId,
          overrideReason: args.input.overrideReason ?? null,
        });
        const comment = await context.prisma.comment.findUniqueOrThrow({ where: { id: answered.commentId } });
        return { comment, request: answered.request, success: true as const };
      }, { comment: null, request: null, success: false as const }),
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
      runMutation(async () => {
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
    teamMembershipUpsert: async (
      _parent: unknown,
      args: { input: { email: string; name?: string | null; role: TeamMembershipRole; teamId: string } },
      context: GraphQLContext,
    ): Promise<{ membership: TeamMembershipParent | null; success: boolean }> =>
      runMutation(async () => {
        await assertCanManageTeam(context.prisma, context, args.input.teamId);
        const membership = await context.prisma.$transaction(async (transaction) => {
          const user = await upsertTeamMemberUser(transaction, args.input.email, args.input.name ?? null);
          if (user.actorKind !== 'HUMAN') {
            throw createValidationError(TEAM_ROSTER_HUMANS_ONLY_MESSAGE);
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
      runMutation(async () => {
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
  Team: {
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
      const canManage = await canManageTeamMemberships(context.prisma, context, parent.id);

      if (!canManage) {
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
  User: {
    isMe: (parent: UserParent, _args: Record<string, never>, context: GraphQLContext): boolean =>
      context.viewer?.id === parent.id,
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

async function findOrCreateBugLabel(prisma: DatabaseClient): Promise<IssueLabel> {
  const existing = await prisma.issueLabel.findFirst({
    where: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } },
  });
  if (existing) {
    return existing;
  }
  try {
    return await prisma.issueLabel.create({ data: { name: BUG_LABEL_NAME } });
  } catch {
    // A concurrent first-ever report created the label between our read and
    // create; re-read the winner.
    const winner = await prisma.issueLabel.findFirst({
      where: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } },
    });
    if (winner) {
      return winner;
    }
    throw new Error('Failed to resolve the bug label.');
  }
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

async function runMutation<TResult extends { success: true }, TFallback extends { success: false }>(
  operation: () => Promise<TResult>,
  fallback: TFallback,
): Promise<TResult | TFallback> {
  try {
    return await operation();
  } catch (error) {
    const exposedError = getExposedError(error);

    if (exposedError?.extensions.code === 'FORBIDDEN') {
      throw exposedError;
    }

    if (exposedError || isPrismaInvalidInputError(error)) {
      return fallback;
    }

    throw error;
  }
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
