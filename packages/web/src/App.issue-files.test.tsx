import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1003: private files attached to work are listed on the issue page.
describe('Issue page files', () => {
  it('lists attached files with a link to open them', async () => {
    const data = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: boardQueryResult.issues.nodes.map((issue) =>
          issue.id === 'issue-1'
            ? { ...issue, attachments: [{ id: 'att-1', filename: 'linear-study.md', mimeType: 'text/markdown', size: 20_480, url: '/uploads/abc.md', createdAt: '2026-10-07T00:00:00.000Z' }] }
            : issue),
      },
    };
    renderApp(App, { data, loading: false }, ['/issue/issue-1']);

    const files = await screen.findByRole('list', { name: 'Files' });
    expect(screen.getByRole('heading', { name: 'Files · 1' })).toBeInTheDocument();
    const link = within(files).getByRole('link', { name: 'linear-study.md' });
    expect(link).toHaveAttribute('href', '/uploads/abc.md');
    expect(within(files).getByText('text/markdown · 20 KB')).toBeInTheDocument();
  });

  it('previews markdown from the stored text and thumbnails a picture', async () => {
    const data = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: boardQueryResult.issues.nodes.map((issue) =>
          issue.id === 'issue-1'
            ? {
                ...issue,
                attachments: [
                  { id: 'att-1', filename: 'linear-study.md', mimeType: 'text/markdown', size: 20, url: '/uploads/abc.md', textContent: 'hello from the file', createdAt: '2026-10-07T00:00:00.000Z' },
                  { id: 'att-2', filename: 'shot.png', mimeType: 'image/png', size: 100, url: '/uploads/shot.png', createdAt: '2026-10-07T00:00:00.000Z' },
                ],
              }
            : issue),
      },
    };
    renderApp(App, { data, loading: false }, ['/issue/issue-1']);

    expect(await screen.findByText('hello from the file')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', '/uploads/shot.png');
  });

  it('shows the same files in the board drawer', async () => {
    const data = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: boardQueryResult.issues.nodes.map((issue) =>
          issue.id === 'issue-1'
            ? { ...issue, attachments: [{ id: 'att-1', filename: 'linear-study.md', mimeType: 'text/markdown', size: 20_480, url: '/uploads/abc.md', createdAt: '2026-10-07T00:00:00.000Z' }] }
            : issue),
      },
    };
    renderApp(App, { data, loading: false }, ['/?issue=INV-1']);

    const files = await screen.findByRole('list', { name: 'Files' });
    expect(within(files).getByRole('link', { name: 'linear-study.md' })).toHaveAttribute('href', '/uploads/abc.md');
  });
});
