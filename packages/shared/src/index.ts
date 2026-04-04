export interface WorkspaceMetadata {
  name: string;
  version: string;
}

export const VIEWER_ASSERTION_HEADER = 'x-involute-viewer-assertion';

export const workspaceMetadata: WorkspaceMetadata = {
  name: 'Involute',
  version: '0.0.0',
};

export {
  createViewerAssertion,
  verifyViewerAssertion,
  type ViewerAssertionClaims,
} from './viewer-assertion.js';
