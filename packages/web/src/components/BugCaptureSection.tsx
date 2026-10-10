import type { ReactNode } from 'react';

import type { BugCapture } from '../board/types';

/**
 * The browser environment a bug was reported with (INV-1146): page, viewport,
 * browser, theme and version, the element pointed at, console errors and
 * failed requests, and the screenshot. The same facts are in the description's
 * Environment section; this shows them laid out instead of as Markdown source.
 */
export function BugCaptureSection({ capture }: { capture: BugCapture }) {
  const rows: Array<[string, ReactNode]> = [];
  if (capture.url) {
    rows.push(['Page', <a href={capture.url} target="_blank" rel="noopener noreferrer">{capture.title || capture.url}</a>]);
  } else if (capture.title) {
    rows.push(['Page', capture.title]);
  }
  if (capture.viewport) rows.push(['Viewport', `${capture.viewport.width}×${capture.viewport.height} @${capture.viewport.dpr}x`]);
  if (capture.userAgent) rows.push(['Browser', capture.userAgent]);
  if (capture.colorScheme) rows.push(['Theme', capture.colorScheme]);
  if (capture.appVersion) rows.push(['Version', <span className="mono">{capture.appVersion}</span>]);
  if (capture.screenshotUrl) {
    rows.push(['Screenshot', <a href={capture.screenshotUrl} target="_blank" rel="noopener noreferrer">Open screenshot</a>]);
  }
  const styles = Object.entries(capture.element?.styles ?? {});

  return (
    <section aria-label="Environment" style={{ marginTop: 16, fontSize: 14 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 500, color: 'var(--fg-muted)' }}>Environment</h3>
      {rows.length > 0 ? (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
          {rows.map(([name, value]) => (
            <div key={name} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--fg-dim)' }}>{name}</dt>
              <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {capture.element ? (
        <div style={{ marginTop: 8 }}>
          <span style={{ color: 'var(--fg-dim)' }}>Element </span>
          <code>{capture.element.selector}</code>
          {capture.element.text ? <span> — “{capture.element.text}”</span> : null}
          {styles.length > 0 ? (
            <div className="mono" style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>
              {styles.map(([key, value]) => `${key}: ${value}`).join('; ')}
            </div>
          ) : null}
        </div>
      ) : null}
      {capture.consoleErrors?.length ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: 'var(--fg-dim)' }}>Console errors</div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
            {capture.consoleErrors.map((entry, index) => (
              <li key={index}><span style={{ color: 'var(--danger)' }}>{entry.level}</span> <code>{entry.message}</code></li>
            ))}
          </ul>
        </div>
      ) : null}
      {capture.failedRequests?.length ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: 'var(--fg-dim)' }}>Failed requests</div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
            {capture.failedRequests.map((entry, index) => (
              <li key={index}>
                {entry.method} {entry.status ?? 'failed'} <code>{entry.url}</code>
                {entry.durationMs === null ? null : ` (${Math.round(entry.durationMs)} ms)`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
