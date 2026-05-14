export interface TeamSummary {
  id: string;
  key: string;
  name: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  memberships?: {
    nodes: TeamMembershipSummary[];
  };
  states: {
    nodes: WorkflowStateSummary[];
  };
}

export interface TeamMembershipSummary {
  id: string;
  role: 'VIEWER' | 'EDITOR' | 'OWNER';
  user: AccessUserSummary;
}

export type WorkflowStateType = 'BACKLOG' | 'UNSTARTED' | 'STARTED' | 'COMPLETED' | 'CANCELED';

export interface WorkflowStateSummary {
  id: string;
  name: string;
  type: WorkflowStateType;
  position: number;
}

export interface BoardColumn {
  name: string;
  stateId: string;
}

export interface LabelSummary {
  id: string;
  name: string;
}

export interface UserSummary {
  id: string;
  name: string | null;
  email: string | null;
}

export interface AccessUserSummary extends UserSummary {
  globalRole: 'ADMIN' | 'USER';
}

export interface CommentSummary {
  id: string;
  body: string;
  createdAt: string;
  user: UserSummary | null;
}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  state: WorkflowStateSummary;
  team: {
    id: string;
    key: string;
    name?: string;
    states?: {
      nodes: WorkflowStateSummary[];
    };
  };
  labels: {
    nodes: LabelSummary[];
  };
  assignee: UserSummary | null;
  children: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
    }>;
  };
  parent?: {
    id: string;
    identifier: string;
    title: string;
  } | null;
  comments: {
    nodes: CommentSummary[];
  };
}

export interface BoardPageQueryData {
  teams: {
    nodes: TeamSummary[];
  };
  users: {
    nodes: UserSummary[];
  };
  issueLabels: {
    nodes: LabelSummary[];
  };
  issues: {
    nodes: IssueSummary[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
}

export interface AccessPageQueryData {
  viewer: AccessUserSummary | null;
  teams: {
    nodes: TeamSummary[];
  };
}

export interface TeamUpdateAccessMutationData {
  teamUpdateAccess: {
    success: boolean;
    team: TeamSummary | null;
  };
}

export interface TeamUpdateAccessMutationVariables {
  input: {
    teamId: string;
    visibility: 'PRIVATE' | 'PUBLIC';
  };
}

export interface TeamMembershipUpsertMutationData {
  teamMembershipUpsert: {
    success: boolean;
    membership: TeamMembershipSummary | null;
  };
}

export interface TeamMembershipUpsertMutationVariables {
  input: {
    teamId: string;
    email: string;
    name?: string | null;
    role: 'VIEWER' | 'EDITOR' | 'OWNER';
  };
}

export interface TeamMembershipRemoveMutationData {
  teamMembershipRemove: {
    success: boolean;
    membershipId: string | null;
  };
}

export interface TeamMembershipRemoveMutationVariables {
  input: {
    teamId: string;
    userId: string;
  };
}

export interface BoardPageQueryVariables {
  first: number;
  after?: string;
  filter?: {
    team?: {
      key?: {
        eq: string;
      };
    };
    assignee?: {
      isMe?: {
        eq: boolean;
      };
    };
  };
}

export interface IssuePageQueryData {
  issue: IssueSummary | null;
  users: {
    nodes: UserSummary[];
  };
  issueLabels: {
    nodes: LabelSummary[];
  };
}

export interface IssuePageQueryVariables {
  id: string;
}

export interface IssueCreateMutationData {
  issueCreate: {
    success: boolean;
    issue: IssueSummary | null;
  };
}

export interface IssueCreateMutationVariables {
  input: {
    teamId: string;
    title: string;
    description?: string | null;
    priority?: number;
  };
}

export interface IssueUpdateMutationData {
  issueUpdate: {
    success: boolean;
    issue: IssueSummary | null;
  };
}

export interface IssueUpdateMutationVariables {
  id: string;
  input: {
    assigneeId?: string | null;
    description?: string | null;
    labelIds?: string[];
    priority?: number;
    stateId?: string;
    title?: string;
  };
}

export interface Html5BoardDragPayload {
  issueId: string;
  stateId: string;
}

export interface CommentCreateMutationData {
  commentCreate: {
    success: boolean;
    comment: CommentSummary | null;
  };
}

export interface CommentCreateMutationVariables {
  input: {
    issueId: string;
    body: string;
  };
}

export interface IssueDeleteMutationData {
  issueDelete: {
    success: boolean;
    issueId: string | null;
  };
}

export interface IssueDeleteMutationVariables {
  id: string;
}

export interface CommentDeleteMutationData {
  commentDelete: {
    success: boolean;
    commentId: string | null;
  };
}

export interface CommentDeleteMutationVariables {
  id: string;
}
