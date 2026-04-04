export interface WorkspaceMetadata {
  name: string;
  version: string;
}

export const workspaceMetadata: WorkspaceMetadata = {
  name: 'Involute',
  version: '0.0.0',
};

export const VIEWER_ASSERTION_HEADER = 'x-involute-viewer-assertion';

export type ViewerAssertionSubjectType = 'email' | 'id';

export interface ViewerAssertionClaims {
  exp: number;
  sub: string;
  subType: ViewerAssertionSubjectType;
}
