import type { WorkResolution } from '../components/CloseReasonDialog';
import type { ContractAmendmentSummary, UserSummary, WorkflowStateSummary, WorkflowStateType } from '../board/types';

export type CommitmentStatus = 'CANDIDATE' | 'COMMITTED' | 'REJECTED';
export type WorkKind = 'ISSUE' | 'PROJECT' | 'MILESTONE' | 'DECISION' | 'EPIC';
export type WorkLinkType =
  | 'CONTAINS'
  | 'BLOCKS'
  | 'DERIVED_FROM'
  | 'DISCOVERED_DURING'
  | 'RELATED_TO'
  | 'DUPLICATE_OF'
  | 'REGRESSED_BY';
export type WorkRunStatus = 'QUEUED' | 'RUNNING' | 'BLOCKED' | 'COMPLETED' | 'FAILED';
export type WorkEvidenceKind = 'PR' | 'TEST' | 'LOG' | 'SCREENSHOT' | 'ARTIFACT' | 'DECISION';
export type ActorKind = 'HUMAN' | 'AGENT' | 'SERVICE';

export interface WorkUserSummary extends UserSummary {
  actorKind?: ActorKind;
}

export interface WorkRef {
  id: string;
  identifier: string;
  title: string;
  commitmentStatus?: CommitmentStatus;
}

export interface CandidateWork {
  deliveryRootId?: string | null;
  hasPendingDeliveryChange?: boolean;
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  commitmentStatus: CommitmentStatus;
  kind: WorkKind;
  revision: number;
  outcome?: string | null;
  scope?: string | null;
  constraints?: string | null;
  acceptance?: string | null;
  verification?: string | null;
  repository?: string | null;
  snoozedUntil?: string | null;
  source?: string | null;
  priority?: number;
  labels?: { nodes: Array<{ id: string; name: string }> };
  createdAt: string;
  /** The CONTAINS parent; committing requires one for every kind but PROJECT (INV-719). */
  parent?: { id: string; identifier: string; title: string; kind: WorkKind } | null;
  /** Identifiers its text names like dependencies without a BLOCKS link (INV-720). */
  dependencyHints?: string[];
  team: {
    id: string;
    key: string;
  };
  assignee: WorkUserSummary | null;
  state: WorkflowStateSummary;
}

export interface WorkLinkNode {
  id: string;
  type: WorkLinkType;
  from: WorkRef;
  to: WorkRef;
}

export interface WorkRunSummary {
  executionId?: string | null;
  executionRevokedAt?: string | null;
  id: string;
  publicId: string;
  actorId?: string | null;
  claimId?: string | null;
  baseRevision?: number | null;
  status: WorkRunStatus;
  phase?: string | null;
  summary?: string | null;
  externalUrl?: string | null;
  lastActivityAt?: string | null;
  staleNotifiedAt?: string | null;
  /** live / stale / settled (INV-996). */
  presence?: string | null;
  startedAt: string;
  endedAt?: string | null;
  /** Who ran it (INV-794). */
  actor?: { id: string; name: string | null; handle: string | null; actorKind: string } | null;
  /** What the run was bound to (INV-474/790). */
  repository?: string | null;
  commitSha?: string | null;
  pullRequestNumber?: number | null;
  contractRevision?: string | null;
}

export interface EvidenceVerificationSummary {
  id: string;
  status: string;
  failureCode?: string | null;
  observedAt: string;
}

export interface WorkEvidenceSummary {
  id: string;
  actorId?: string | null;
  runId?: string | null;
  kind: WorkEvidenceKind;
  url: string;
  summary?: string | null;
  createdAt: string;
  retractedAt?: string | null;
  retractReason?: string | null;
  retractedBy?: { id: string; name: string | null; handle: string | null } | null;
  supersededByWork?: { id: string; identifier: string } | null;
  /** Server observations of this evidence, newest first (INV-474); shown before acceptance (INV-790). */
  verifications?: EvidenceVerificationSummary[];
}

export interface WorkReviewDecisionSummary {
  id: string;
  decision: 'ACCEPTED' | 'REJECTED';
  reason?: string | null;
  fromRevision: number;
  toRevision: number;
  createdAt: string;
  reviewer: WorkUserSummary;
  run?: WorkRunSummary | null;
}

export interface ReceiptReferenceSummary {
  kind: string;
  ref: string;
  version: string | null;
  digest: string | null;
  excerpt: string | null;
  /** False when the reference is a bare pointer — what was seen cannot be reconstructed from it. */
  preserved: boolean;
}

/** The actor's own statement of what it knew when it wrote. Always a claim (INV-588). */
export interface DecisionReceiptSummary {
  id: string;
  reasoning: string;
  runtime: string | null;
  sessionId: string | null;
  contractRevision: number;
  createdAt: string;
  actor: { id: string; name: string | null; handle: string | null };
  evidence: ReceiptReferenceSummary[];
  inputs: ReceiptReferenceSummary[];
}

export interface WorkAuditSummary {
  sessionId?: string | null;
  claimGeneration?: number | null;
  receipt?: DecisionReceiptSummary | null;
  id: string;
  revision: number;
  actorKind: ActorKind;
  actor: WorkUserSummary | null;
  surface?: string | null;
  reason?: string | null;
  createdAt: string;
}

export interface WorkClaimSummary {
  actor: WorkUserSummary;
  leaseUntil: string;
  executionId?: string | null;
  createdAt: string;
}

export interface WorkContextRequest {
  id: string;
  state: string;
  presence: string;
  deadlineAt: string;
  hopCount: number;
  rootRequestId: string | null;
  handedOffFromId: string | null;
  failureReason: string | null;
  answeredCommentId: string | null;
  targetActor: { id: string; name: string | null; handle: string | null; actorKind: string };
  /** The question, and who asked it (INV-794). */
  body?: string;
  requestedByActor?: { id: string; name: string | null; handle: string | null; actorKind: string } | null;
}

export interface WorkContextWork {
  id: string;
  /** An agent's open proposal to change this committed contract (INV-869). */
  pendingContractAmendment?: ContractAmendmentSummary | null;
  identifier: string;
  title: string;
  /** Current contract hash; compare with a run's contractRevision (INV-790). */
  contractDigest?: string | null;
  deliveryRootId?: string | null;
  /** Requests to agents on this work, with their hand-off chain (INV-597). */
  agentRequests?: WorkContextRequest[];
  /** A bug candidate is triaged from the bug filter (INV-794). */
  labels?: { nodes: Array<{ id: string; name: string }> };
  description?: string | null;
  kind: WorkKind;
  commitmentStatus: CommitmentStatus;
  revision: number;
  outcome?: string | null;
  scope?: string | null;
  constraints?: string | null;
  acceptance?: string | null;
  verification?: string | null;
  repository?: string | null;
  state: WorkflowStateSummary;
  team: {
    id: string;
    key: string;
    name?: string;
  };
  assignee: WorkUserSummary | null;
}

export interface WorkContextBundle {
  work: WorkContextWork;
  ancestors: WorkRef[];
  blockedBy: WorkRef[];
  blocks: WorkRef[];
  claim: WorkClaimSummary | null;
  audits: WorkAuditSummary[];
  runs: WorkRunSummary[];
  evidence: WorkEvidenceSummary[];
  reviewDecisions: WorkReviewDecisionSummary[];
}

export interface CandidateProjectSummary {
  repository: string;
  totalCount: number;
}

export interface CandidateSummary {
  totalCount: number;
  noRepositoryCount: number;
  projects: CandidateProjectSummary[];
}

export interface CandidatesPageQueryData {
  candidateSummary?: CandidateSummary | null;
  teams: {
    nodes: Array<{
      id: string;
      key: string;
      name: string;
      /** Workflow states, for choosing where committed work starts (INV-792). */
      states?: { nodes: Array<{ id: string; name: string; type: string }> };
      memberships: {
        nodes: Array<{
          id: string;
          user: WorkUserSummary;
        }>;
      };
    }>;
  };
  issues: {
    nodes: CandidateWork[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
}

export interface CandidatesPageQueryVariables {
  first: number;
  after?: string;
  /** IQL from the shared filter bar (INV-1077). */
  query?: string | null;
  teamFilter?: {
    key?: {
      eq: string;
    };
  } | null;
  filter?: {
    commitmentStatus?: CommitmentStatus;
    repository?: {
      eq?: string;
      in?: string[];
      nin?: string[];
      isNull?: boolean;
    };
    team?: {
      key?: {
        eq: string;
      };
    };
  };
}


/** Committed work currently waiting in an In Review workflow state. */
export type InReviewWork = CandidateWork & {
  /** An agent proposed a change to this contract that is waiting for a person (INV-869). */
  pendingContractAmendment?: { id: string } | null;
  /** How long it has waited in Review; overdue for a bug past the review clock (INV-1002). */
  reviewWait?: { since: string; waitMs: number; overdue: boolean } | null;
  /** Why the Auto-Accept Gate left a bug for a person, or that it accepted it (INV-1075). */
  autoAccept?: AutoAcceptInfo | null;
};

export interface InReviewPageQueryData {
  issues: {
    nodes: InReviewWork[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
}

export interface InReviewPageQueryVariables {
  first: number;
  after?: string;
  query?: string | null;
  filter: {
    commitmentStatus?: CommitmentStatus;
    state?: {
      name?: {
        eq: string;
      };
      /** Match by lifecycle type; names can be renamed (INV-797). */
      type?: {
        eq: 'BACKLOG' | 'UNSTARTED' | 'STARTED' | 'REVIEW' | 'COMPLETED' | 'CANCELED';
      };
    };
    team?: {
      key?: {
        eq: string;
      };
    };
  } | null;
}

export interface WorkGraphNodeRecord {
  id: string;
  identifier: string;
  title: string;
  kind: WorkKind;
  commitmentStatus: CommitmentStatus;
  state: { id: string; name: string; type: WorkflowStateType };
  assignee: { id: string; name: string | null } | null;
}

export interface ProjectWorkGraphQueryData {
  workGraph: {
    repository: string | null;
    truncated: boolean;
    root: { id: string; identifier: string; title: string } | null;
    nodes: WorkGraphNodeRecord[];
    externalNodes: WorkGraphNodeRecord[];
    edges: Array<{ id: string; type: WorkLinkType; fromId: string; toId: string }>;
  };
}

export interface ProjectWorkGraphQueryVariables {
  project: string;
  includeCandidates?: boolean;
}

export interface GraphProjectsQueryData {
  projectSummary: {
    totalCount: number;
    projects: Array<{ repository: string; name: string; identifier: string | null; totalCount: number }>;
  };
}

export interface WorkContextPageQueryData {
  workContext: WorkContextBundle | null;
}

export interface WorkContextPageQueryVariables {
  id: string;
}

export interface WorkCommitMutationData {
  workCommit: {
    success: boolean;
    /** Why the commit was refused; null on success. */
    message?: string | null;
    issue: { id: string; identifier: string; revision?: number; commitmentStatus: CommitmentStatus } | null;
  };
}

export interface WorkCommitMutationVariables {
  id: string;
  input: {
    expectedRevision: number;
    acceptance?: string;
    assigneeId?: string;
    parentId?: string;
    /** Required for bugs: 1 (Urgent) to 4 (Low), sets the SLA (INV-750). */
    priority?: number;
    /** The rest of the contract and where it starts, settled at commit (INV-792). */
    outcome?: string;
    scope?: string;
    constraints?: string;
    verification?: string;
    stateId?: string;
  };
}

export interface WorkRejectMutationData {
  workReject: {
    success: boolean;
    message?: string | null;
    issue: { id: string; identifier: string; commitmentStatus: CommitmentStatus } | null;
  };
}

export interface WorkRejectMutationVariables {
  id: string;
  input: {
    expectedRevision: number;
    /** Required (INV-1118). */
    resolution: WorkResolution;
    reason?: string;
  };
}

export interface WorkReviewMutationData {
  workReview: {
    success: boolean;
    message?: string | null;
    issue: { id: string; identifier: string; revision: number } | null;
    decision: { id: string; decision: 'ACCEPTED' | 'REJECTED' } | null;
  };
}

export interface WorkReviewMutationVariables {
  id: string;
  input: {
    expectedRevision: number;
    decision: 'ACCEPTED' | 'REJECTED';
    reason?: string;
    runId?: string;
  };
}

export interface ProjectWorkTimelineQueryData {
  workGraph: {
    timeline: Array<{
      workId: string;
      committedAt: string | null;
      startedAt: string | null;
      reviewAt: string | null;
      completedAt: string | null;
      canceledAt: string | null;
      history: 'FULL' | 'PARTIAL' | 'NONE';
      transitions: Array<{ at: string; stateName: string; stateType: WorkflowStateType }>;
    }>;
    cycles: Array<{ id: string; name: string; number: number; startsAt: string; endsAt: string }>;
  };
}

export interface PlacementOption {
  id: string;
  identifier: string;
  title: string;
  kind: WorkKind;
  /** Containers only; finished ones are not offered for new work (INV-744). */
  state?: { type: string } | null;
}

export interface PlacementOptionsQueryData {
  projects: { nodes: PlacementOption[] };
  milestones: { nodes: PlacementOption[] };
  epics: { nodes: PlacementOption[] };
}

export interface HygieneRef {
  id: string;
  identifier: string;
  title: string;
}

export interface WorkHygieneQueryData {
  workHygiene: {
    unplacedCount: number;
    unplaced: Array<HygieneRef & { kind: WorkKind; repository: string | null }>;
    unlinkedMentionCount: number;
    unlinkedMentions: Array<{ from: HygieneRef; to: HygieneRef }>;
    dependencyWithoutBlocksCount: number;
    dependencyWithoutBlocks: Array<{ from: HygieneRef; to: HygieneRef }>;
    researchWithoutDownstreamCount: number;
    researchWithoutDownstream: Array<HygieneRef & { repository: string | null }>;
    researchClosableCount: number;
    researchClosable: Array<HygieneRef & { repository: string | null }>;
    incidentsWithoutDownstreamCount: number;
    incidentsWithoutDownstream: Array<HygieneRef & { severity: string | null }>;
    incidentsWithoutPostmortemCount: number;
    incidentsWithoutPostmortem: Array<HygieneRef & { severity: string | null }>;
    overdueFollowUpCount: number;
    overdueFollowUps: Array<HygieneRef & { repository: string | null }>;
  };
}

export interface WorkSearchHit {
  /** `semantic`: close in meaning, no words matched (INV-927). */
  matchedField: 'identifier' | 'title' | 'contract' | 'description' | 'comment' | 'attachment' | 'run' | 'semantic';
  snippet: string | null;
  commentId: string | null;
  /** The attached file the snippet came from (INV-1117). */
  attachmentFilename?: string | null;
  issue: {
    id: string;
    identifier: string;
    title: string;
    state: { id: string; name: string; type: string };
    team: { id: string; key: string };
  };
}

export interface WorkSearchQueryData {
  search: WorkSearchHit[];
}

export interface SearchLabelsQueryData {
  issueLabels: { nodes: Array<{ id: string; name: string }> };
}

export interface AutoAcceptInfo {
  outcome: string;
  reasons: string[];
  accepted: boolean;
  createdAt: string;
}

export type AttentionKind =
  | 'CONTRACT_AMENDMENT'
  | 'WORK_REVIEW'
  | 'CANDIDATE_COMMIT'
  | 'DELIVERY_CHANGE'
  | 'AGENT_REQUEST'
  | 'DECISION_REQUESTED'
  | 'OPS';

export type AttentionAction = 'ACCEPT' | 'ANSWER' | 'APPROVE' | 'COMMIT' | 'DECLINE' | 'OPEN' | 'REJECT' | 'REPLY' | 'RESPOND' | 'RETURN';

/** A decision the viewer is waiting to make (INV-1091). */
export interface AttentionItemNode {
  id: string;
  kind: AttentionKind;
  subjectId: string;
  actions: AttentionAction[];
  reason: string;
  since: string;
  groupKey: string | null;
  group: { id: string; identifier: string; title: string; kind: WorkKind } | null;
  work: CandidateWork | null;
  /** Waited past its kind's limit (INV-1094). */
  overdue?: boolean;
  /** Everything that BLOCKS it is finished: ready now. */
  unblocked?: boolean;
  /** Unfinished work that BLOCKS it. */
  waitingOn?: Array<{ id: string; identifier: string; title: string }>;
}

export interface AttentionPageQueryData {
  attentionSummary: { total: number; byKind: Array<{ kind: AttentionKind; count: number; oldestSince: string | null }> };
  attention: { nodes: AttentionItemNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  teams: { nodes: Array<Omit<CandidatesPageQueryData['teams']['nodes'][number], 'name'>> };
}

export interface AttentionSummaryQueryData {
  attentionSummary: { total: number };
}
