import type { UserSummary, WorkflowStateSummary, WorkflowStateType } from '../board/types';

export type CommitmentStatus = 'CANDIDATE' | 'COMMITTED' | 'REJECTED';
export type WorkKind = 'ISSUE' | 'PROJECT' | 'MILESTONE' | 'DECISION' | 'EPIC';
export type WorkLinkType =
  | 'CONTAINS'
  | 'BLOCKS'
  | 'DERIVED_FROM'
  | 'DISCOVERED_DURING'
  | 'RELATED_TO'
  | 'DUPLICATE_OF';
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
  id: string;
  publicId: string;
  actorId?: string | null;
  claimId?: string | null;
  baseRevision?: number | null;
  status: WorkRunStatus;
  phase?: string | null;
  summary?: string | null;
  externalUrl?: string | null;
  startedAt: string;
  endedAt?: string | null;
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
}

export interface WorkContextWork {
  id: string;
  identifier: string;
  title: string;
  /** Requests to agents on this work, with their hand-off chain (INV-597). */
  agentRequests?: WorkContextRequest[];
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
export type InReviewWork = CandidateWork;

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
    issue: { id: string; identifier: string; commitmentStatus: CommitmentStatus } | null;
  };
}

export interface WorkCommitMutationVariables {
  id: string;
  input: {
    expectedRevision: number;
    acceptance?: string;
    assigneeId?: string;
    parentId?: string;
  };
}

export interface WorkRejectMutationData {
  workReject: {
    success: boolean;
    issue: { id: string; identifier: string; commitmentStatus: CommitmentStatus } | null;
  };
}

export interface WorkRejectMutationVariables {
  id: string;
  input: {
    expectedRevision: number;
    reason?: string;
  };
}

export interface WorkReviewMutationData {
  workReview: {
    success: boolean;
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
  };
}
