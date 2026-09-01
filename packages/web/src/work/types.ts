import type { TeamSummary, UserSummary, WorkflowStateSummary } from '../board/types';

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
  status: WorkRunStatus;
  phase?: string | null;
  summary?: string | null;
  externalUrl?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export interface WorkEvidenceSummary {
  id: string;
  kind: WorkEvidenceKind;
  url: string;
  summary?: string | null;
  createdAt: string;
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
}

export interface CandidatesPageQueryData {
  teams: {
    nodes: TeamSummary[];
  };
  users: {
    nodes: WorkUserSummary[];
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
  };
}

export interface WorkGraphPageQueryVariables {
  first: number;
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
