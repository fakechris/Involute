import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PageBody, PageHeader, PageToolbar } from './Page';

afterEach(cleanup);

describe('Page skeleton (INV-1314)', () => {
  it('renders the title as the h1 with count, hint and actions in their slots', () => {
    render(<PageHeader title="Bugs" count={12} hint="Open and closed" actions={<button type="button">Report bug</button>} />);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1, name: 'Bugs' })).toBeInTheDocument();
    expect(header.querySelector('.page-header__count')).toHaveTextContent('12');
    expect(header.querySelector('.page-header__hint')).toHaveTextContent('Open and closed');
    expect(within(header.querySelector('.page-header__actions') as HTMLElement).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
  });

  it('omits the count when none is given but keeps a zero', () => {
    const { rerender } = render(<PageHeader title="Inbox" />);
    expect(document.querySelector('.page-header__count')).toBeNull();
    rerender(<PageHeader title="Inbox" count={0} />);
    expect(document.querySelector('.page-header__count')).toHaveTextContent('0');
  });

  it('renders toolbar slots in the fixed order projects → filters → view, whatever the prop order', () => {
    render(<PageToolbar aria-label="Filters" view={<span>view</span>} filters={<span>filters</span>} projects={<span>projects</span>} />);
    const toolbar = screen.getByRole('region', { name: 'Filters' });
    expect([...toolbar.children].map((slot) => slot.textContent)).toEqual(['projects', 'filters', 'view']);
  });

  it('renders nothing for an empty toolbar', () => {
    const { container } = render(<PageToolbar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the width on the content column and drops padding for flush bodies', () => {
    const { container, rerender } = render(<PageBody width="narrow">content</PageBody>);
    expect(container.querySelector('.page-body__inner')).toHaveClass('page-body__inner--narrow');
    rerender(<PageBody width="full" padding="none" className="ops">content</PageBody>);
    expect(container.querySelector('.page-body')).toHaveClass('page-body--flush');
    expect(container.querySelector('.page-body__inner')).toHaveClass('page-body__inner--full', 'ops');
  });
});
