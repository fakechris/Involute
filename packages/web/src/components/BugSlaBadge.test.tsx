import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BugSlaBadge, describeSla, formatSlaDuration } from './BugSlaBadge';

const HOUR = 3_600_000;

describe('bug SLA badge (INV-750)', () => {
  it('formats time left coarsely', () => {
    expect(formatSlaDuration(20 * 60_000)).toBe('20m');
    expect(formatSlaDuration(5 * HOUR)).toBe('5h');
    expect(formatSlaDuration(50 * HOUR)).toBe('2d 2h');
    expect(formatSlaDuration(-3 * HOUR)).toBe('3h');
  });

  it('says what state the clock is in', () => {
    const base = { remainingMs: 5 * HOUR, dueAt: null, budgetHours: 24 };
    expect(describeSla({ ...base, status: 'ON_TRACK' })).toBe('SLA 5h left');
    expect(describeSla({ ...base, status: 'PAUSED' })).toBe('SLA paused · 5h left');
    expect(describeSla({ ...base, status: 'BREACHED', remainingMs: -2 * HOUR })).toBe('SLA breached 2h ago');
  });

  it('hides a met SLA on cards but keeps it in detail views', () => {
    const met = { status: 'MET' as const, remainingMs: HOUR, dueAt: null, budgetHours: 24 };
    const { container, rerender } = render(<BugSlaBadge sla={met} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<BugSlaBadge sla={met} showMet />);
    expect(screen.getByText('SLA met')).toBeInTheDocument();
    rerender(<BugSlaBadge sla={{ status: 'AT_RISK', remainingMs: 3 * HOUR, dueAt: null, budgetHours: 24 }} />);
    expect(screen.getByLabelText('SLA 3h left')).toHaveClass('bug-sla--at-risk');
  });
});
