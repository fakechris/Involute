import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// The issue page names its controls for what they do (INV-2124, INV-2125).
describe('Issue page control labels', () => {
  it('calls the history arrows Back / Forward and offers Copy link without a shortcut it does not have', async () => {
    renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);

    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument();
    expect(screen.queryByTitle('Previous issue')).toBeNull();
    expect(screen.queryByTitle('Next issue')).toBeNull();

    expect(screen.queryByText('Copy issue URL')).toBeNull();
    expect(screen.getAllByText('Copy link').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('⌘L');
  });
});
