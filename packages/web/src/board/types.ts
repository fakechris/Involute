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

export interface LabelSummary {
  id: string;
  name: string;
}

export interface UserSummary {
  id: string;
  name: string | null;
  email: string | null;
}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: WorkflowStateSummary;
  team: {
    id: string;
    key: string;
  };
  labels: {
    nodes: LabelSummary[];
  };
  assignee: UserSummary | null;
}

export interface BoardPageQueryData {
  teams: {
    nodes: TeamSummary[];
  };
  users: {
    nodes: UserSummary[];
  };
  issues: {
    nodes: IssueSummary[];
  };
}

export interface BoardPageQueryVariables {
  first: number;
}
