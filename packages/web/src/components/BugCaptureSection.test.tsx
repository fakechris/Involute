import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BugCaptureSection } from './BugCaptureSection';

afterEach(() => {
  cleanup();
});

describe('BugCaptureSection (INV-1146)', () => {
  it('lays out the captured environment with the screenshot link', () => {
    render(
      <BugCaptureSection
        capture={{
          url: 'https://app.example.com/board',
          title: 'Board',
          viewport: { width: 1280, height: 720, dpr: 2 },
          userAgent: 'Chrome/130',
          colorScheme: 'dark',
          appVersion: '0123456789ab',
          consoleErrors: [{ level: 'error', message: 'TypeError: x', time: null }],
          failedRequests: [{ method: 'POST', url: 'https://app.example.com/graphql', status: 500, durationMs: 120 }],
          element: { selector: 'span.title', text: 'Fix', box: null, styles: { 'font-size': '14px' } },
          screenshotUrl: '/uploads/shot.png',
        }}
      />,
    );
    const section = screen.getByRole('region', { name: 'Environment' });
    expect(within(section).getByRole('link', { name: 'Board' })).toHaveAttribute('href', 'https://app.example.com/board');
    expect(section).toHaveTextContent('1280×720 @2x');
    expect(section).toHaveTextContent('Chrome/130');
    expect(section).toHaveTextContent('dark');
    expect(section).toHaveTextContent('0123456789ab');
    expect(section).toHaveTextContent('span.title');
    expect(section).toHaveTextContent('font-size: 14px');
    expect(section).toHaveTextContent('TypeError: x');
    expect(section).toHaveTextContent('POST 500 https://app.example.com/graphql (120 ms)');
    expect(within(section).getByRole('link', { name: 'Open screenshot' })).toHaveAttribute('href', '/uploads/shot.png');
  });
});
