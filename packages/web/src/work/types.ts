import type { UserSummary, WorkflowStateSummary } from '../board/types';

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
  createdAt: string;
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

export interface GraphWorkNode {
  id: string;
  identifier: string;
  title: string;
  commitmentStatus: CommitmentStatus;
  state: {
    name: string;
  };
  links: {
    nodes: WorkLinkNode[];
  };
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

export interface WorkAuditSummary {
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

export interface WorkContextWork {
  id: string;
  identifier: string;
  title: string;
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

export interface CandidatesPageQueryData {
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
    team?: {
      key?: {
        eq: string;
      };
    };
  };
}

export interface WorkGraphPageQueryData {
  issues: {
    nodes: GraphWorkNode[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
}

export interface WorkGraphPageQueryVariables {
  first: number;
  after?: string;
  filter?: {
    team?: {
      key?: {
        eq: string;
      };
    };
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
    issue: { id: string; identifier: string; commitmentStatus: CommitmentStatus } | null;
  };
}

export interface WorkCommitMutationVariables {
  id: string;
  input: {
    expectedRevision: number;
    acceptance?: string;
    assigneeId?: string;
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
