import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App keyboard shortcuts and help dialog', () => {
  it('displays clear, unambiguous G-chord shortcuts on primary sidebar navigation', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    const boardLink = screen.getByRole('link', { name: /^Board/i });
    expect(boardLink).toBeInTheDocument();
    expect(within(boardLink).getByText('G B')).toBeInTheDocument();

    const candidatesLink = screen.getByRole('link', { name: /^Candidates/i });
    expect(candidatesLink).toBeInTheDocument();
    expect(within(candidatesLink).getByText('G C')).toBeInTheDocument();

    const inReviewLink = screen.getByRole('link', { name: /^In Review/i });
    expect(inReviewLink).toBeInTheDocument();
    expect(within(inReviewLink).getByText('G N')).toBeInTheDocument();

    const bugsLink = screen.getByRole('link', { name: /^Bugs/i });
    expect(bugsLink).toBeInTheDocument();
    expect(within(bugsLink).getByText('G U')).toBeInTheDocument();

    const graphLink = screen.getByRole('link', { name: /^Graph/i });
    expect(graphLink).toBeInTheDocument();
    expect(within(graphLink).getByText('G R')).toBeInTheDocument();

    const inboxLink = screen.getByRole('link', { name: /^Inbox/i });
    expect(inboxLink).toBeInTheDocument();
    expect(within(inboxLink).getByText('G I')).toBeInTheDocument();

    const myIssuesLink = screen.getByRole('link', { name: /^My Issues/i });
    expect(myIssuesLink).toBeInTheDocument();
    expect(within(myIssuesLink).getByText('G M')).toBeInTheDocument();

    const viewsLink = screen.getByRole('link', { name: /^Views/i });
    expect(viewsLink).toBeInTheDocument();
    expect(within(viewsLink).getByText('G W')).toBeInTheDocument();

    const projectsLink = screen.getByRole('link', { name: /^Projects/i });
    expect(projectsLink).toBeInTheDocument();
    expect(within(projectsLink).getByText('G P')).toBeInTheDocument();

    const membersLink = screen.getByRole('link', { name: /^Members/i });
    expect(membersLink).toBeInTheDocument();
    expect(within(membersLink).getByText('G E')).toBeInTheDocument();
  });

  it('navigates to Candidates via G then C chord, showing chord indicator', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    expect(await screen.findByRole('status')).toHaveTextContent(/Go to/i);

    fireEvent.keyDown(window, { key: 'c' });
    expect(await screen.findByRole('heading', { name: 'Candidates' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('triggers Create Issue when pressing single C key, without navigating to Candidates', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    // Press single key 'c'
    fireEvent.keyDown(window, { key: 'c' });

    // Should open the Create Issue dialog
    expect(await screen.findByRole('dialog', { name: /Create issue/i })).toBeInTheDocument();
    // Should stay on the board and not navigate to candidates
    expect(screen.queryByRole('heading', { name: 'Candidates' })).not.toBeInTheDocument();
  });

  it('opens keyboard shortcuts dialog via ? key and closes with Escape', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    // Press '?'
    fireEvent.keyDown(window, { key: '?' });

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('Navigation (G Chords)')).toBeInTheDocument();
    expect(within(dialog).getByText('Global Actions')).toBeInTheDocument();
    expect(within(dialog).getByText('Board & Backlog Navigation')).toBeInTheDocument();

    // Close via Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
    });
  });

  it('opens keyboard shortcuts dialog via Cmd+/ shortcut', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '/', metaKey: true });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('opens keyboard shortcuts dialog via sidebar footer button', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    const button = screen.getAllByRole('button', { name: 'Keyboard shortcuts' })[0]!;
    fireEvent.click(button);

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('filters shortcuts within the help dialog search box', async () => {
    renderTestApp();

    fireEvent.keyDown(window, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    const searchInput = screen.getByRole('textbox', { name: 'Search keyboard shortcuts' });
    fireEvent.change(searchInput, { target: { value: 'candidates' } });

    expect(within(dialog).getByText('Go to Candidates')).toBeInTheDocument();
    expect(within(dialog).queryByText('Go to Board')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'nonexistent123' } });
    expect(within(dialog).getByText(/No shortcuts matching/i)).toBeInTheDocument();
  });

  it('allows opening shortcuts from command palette', async () => {
    renderTestApp();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });

    const shortcutItem = within(palette).getByRole('button', { name: /Keyboard shortcuts/i });
    fireEvent.click(shortcutItem);

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('cancels G chord when Escape is pressed', async () => {
    renderTestApp();

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    expect(await screen.findByRole('status')).toHaveTextContent(/Go to/i);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    // Subsequent 'c' press should open Create Issue, NOT navigate to candidates
    fireEvent.keyDown(window, { key: 'c' });
    expect(await screen.findByRole('dialog', { name: /Create issue/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Candidates' })).not.toBeInTheDocument();
  });
});
