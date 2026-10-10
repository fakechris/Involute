/**
 * Every GraphQL document the extension sends (INV-1147). An extension token
 * may only run what extensionOperationAllowed lets through (INV-1145): the
 * server test extension-operations.test.ts imports this file and checks each
 * document against that gate and the schema, so the two cannot drift.
 *
 * No fragments (the gate refuses them) and only fields from its SAFE_FIELDS.
 */
export const OPERATIONS = {
  Viewer: /* GraphQL */ `
    query Viewer {
      viewer { id name email }
    }
  `,
  Teams: /* GraphQL */ `
    query Teams {
      teams { nodes { id key name } }
    }
  `,
  ProjectForOrigin: /* GraphQL */ `
    query ProjectForOrigin($origin: String!) {
      projectForOrigin(origin: $origin) {
        id
        identifier
        title
        repository
        team { id key name }
      }
    }
  `,
  TeamProjects: /* GraphQL */ `
    query TeamProjects($teamKey: String!) {
      issues(first: 100, filter: { kind: PROJECT, commitmentStatus: COMMITTED, team: { key: { eq: $teamKey } } }) {
        nodes { id identifier title repository team { id key name } }
      }
    }
  `,
  PlacementOptions: /* GraphQL */ `
    query PlacementOptions($repository: String!) {
      milestones: issues(first: 200, filter: { repository: { eq: $repository }, kind: MILESTONE, commitmentStatus: COMMITTED }) {
        nodes { id identifier title kind state { type } }
      }
      epics: issues(first: 200, filter: { repository: { eq: $repository }, kind: EPIC, commitmentStatus: COMMITTED }) {
        nodes { id identifier title kind state { type } }
      }
    }
  `,
  SimilarBugs: /* GraphQL */ `
    query SimilarBugs($teamId: String!, $title: String!) {
      similarBugs(teamId: $teamId, title: $title, first: 5) {
        id
        identifier
        title
        state { name type }
      }
    }
  `,
  UploadScreenshot: /* GraphQL */ `
    mutation UploadScreenshot($input: FileUploadInput!) {
      fileUpload(input: $input) {
        success
        message
        attachment { id filename mimeType size url }
      }
    }
  `,
  ReportBug: /* GraphQL */ `
    mutation ReportBug($input: BugReportInput!) {
      bugReport(input: $input) {
        success
        message
        issue { id identifier title }
      }
    }
  `,
} as const;

export type OperationName = keyof typeof OPERATIONS;

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OPERATIONS, value);
}

export interface Team { id: string; key: string; name: string }
export interface ProjectNode { id: string; identifier: string; title: string; repository: string | null; team: Team }
export interface PlacementNode { id: string; identifier: string; title: string; kind: 'MILESTONE' | 'EPIC'; state: { type: string } | null }
export interface SimilarBug { id: string; identifier: string; title: string; state: { name: string; type: string } | null }

export interface OperationData {
  Viewer: { viewer: { id: string; name: string | null; email: string | null } | null };
  Teams: { teams: { nodes: Team[] } };
  ProjectForOrigin: { projectForOrigin: ProjectNode | null };
  TeamProjects: { issues: { nodes: ProjectNode[] } };
  PlacementOptions: { milestones: { nodes: PlacementNode[] }; epics: { nodes: PlacementNode[] } };
  SimilarBugs: { similarBugs: SimilarBug[] };
  UploadScreenshot: { fileUpload: { success: boolean; message: string | null; attachment: { id: string; filename: string; mimeType: string; size: number; url: string } | null } };
  ReportBug: { bugReport: { success: boolean; message: string | null; issue: { id: string; identifier: string; title: string } | null } };
}
