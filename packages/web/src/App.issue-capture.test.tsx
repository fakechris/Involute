import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1146: a bug reported with the capture extension shows its environment on
// the issue page, with the screenshot one click away.
describe('Issue page environment', () => {
  it('shows the captured environment of a bug report', async () => {
    const capture = {
      url: 'https://app.example.com/board',
      title: 'Board',
      viewport: { width: 1280, height: 720, dpr: 2 },
      userAgent: 'Chrome/130',
      colorScheme: 'dark' as const,
      appVersion: '0123456789ab',
      consoleErrors: [{ level: 'error', message: 'TypeError: x', time: null }],
      screenshotUrl: '/uploads/shot.png',
    };
    const data = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: boardQueryResult.issues.nodes.map((issue) => (issue.id === 'issue-1' ? { ...issue, capture } : issue)),
      },
    };
    renderApp(App, { data, loading: false }, ['/issue/issue-1']);

    const section = await screen.findByRole('region', { name: 'Environment' });
    expect(within(section).getByRole('link', { name: 'Board' })).toHaveAttribute('href', 'https://app.example.com/board');
    expect(section).toHaveTextContent('1280×720 @2x');
    expect(section).toHaveTextContent('TypeError: x');
    expect(within(section).getByRole('link', { name: 'Open screenshot' })).toHaveAttribute('href', '/uploads/shot.png');
  });

  it('has no Environment section without a capture', async () => {
    renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    await screen.findAllByText(boardQueryResult.issues.nodes.find((issue) => issue.id === 'issue-1')!.title);
    expect(screen.queryByRole('region', { name: 'Environment' })).toBeNull();
  });
});
