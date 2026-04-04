export interface TeamSummary {
  id: string;
  key: string;
  name: string;
  states: {
    nodes: WorkflowStateSummary[];
  };
}

export interface WorkflowStateSummary {
  id: string;
  name: string;
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

export interface BoardPageQueryVariables {
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
