/**
 * Type definitions for Linear export data.
 * These represent the shape of data as exported from Linear's GraphQL API.
 */

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  team: { id: string };
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface LinearUser {
  id: string;
  name: string;
  email: string;
  displayName: string;
  active: boolean;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  state: { id: string; name: string };
  team: { id: string; key: string };
  assignee: { id: string; name: string; email: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  parent: { id: string } | null;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string } | null;
}

export interface ParentChildMapping {
  parentId: string;
  childId: string;
  parentIdentifier?: string | undefined;
  childIdentifier?: string | undefined;
}

export interface ExportValidationReport {
  exportedAt: string;
  counts: {
    teams: number;
    workflowStates: number;
    labels: number;
    users: number;
    issues: number;
    comments: number;
    parentChildRelationships: number;
  };
}
