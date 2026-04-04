import { describe, expect, it } from 'vitest';

import {
  createViewerAssertion,
  verifyViewerAssertion,
  VIEWER_ASSERTION_HEADER,
  workspaceMetadata,
} from './index.js';

describe('shared package exports', () => {
  it('exposes stable workspace metadata', () => {
    expect(workspaceMetadata).toEqual({
      name: 'Involute',
      version: '0.0.0',
    });
  });

  it('uses the expected viewer assertion header name', () => {
    expect(VIEWER_ASSERTION_HEADER).toBe('x-involute-viewer-assertion');
  });

  it('creates and verifies signed assertions', () => {
    const assertion = createViewerAssertion(
      {
        exp: Math.floor(new Date('2026-04-04T03:00:00.000Z').getTime() / 1000),
        sub: 'user-123',
        subType: 'id',
      },
      'shared-secret',
    );

    expect(verifyViewerAssertion(assertion, 'shared-secret', new Date('2026-04-04T02:00:00.000Z'))).toEqual({
      exp: Math.floor(new Date('2026-04-04T03:00:00.000Z').getTime() / 1000),
      sub: 'user-123',
      subType: 'id',
    });
  });

  it('rejects tampered assertions', () => {
    const assertion = createViewerAssertion(
      {
        exp: Math.floor(new Date('2026-04-04T03:00:00.000Z').getTime() / 1000),
        sub: 'person@example.com',
        subType: 'email',
      },
      'shared-secret',
    );
    const tampered = `${assertion.slice(0, -1)}${assertion.endsWith('a') ? 'b' : 'a'}`;

    expect(verifyViewerAssertion(tampered, 'shared-secret', new Date('2026-04-04T02:00:00.000Z'))).toBeNull();
  });

  it('rejects expired assertions', () => {
    const assertion = createViewerAssertion(
      {
        exp: Math.floor(new Date('2026-04-04T01:00:00.000Z').getTime() / 1000),
        sub: 'user-123',
        subType: 'id',
      },
      'shared-secret',
    );

    expect(verifyViewerAssertion(assertion, 'shared-secret', new Date('2026-04-04T02:00:00.000Z'))).toBeNull();
  });
});
