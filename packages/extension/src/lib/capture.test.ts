import { describe, expect, it } from 'vitest';

import { CAPTURE_LIST_LIMIT, assembleCapture } from './capture';
import { buildBugReportInput, type BugForm } from './form';
import type { PageInfo, PickedElement, RecorderSnapshot } from './types';

const SECRETS = {
  token: 'tok_9f8e7d6c5b4a',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
  email: 'jane.doe@example.com',
  stripe: 'sk_live_51HxYzAbCdEfGh',
  customer: 'cus_NffrFeUfNV2Hib',
  password: 'hunter2hunter2',
  hex: 'deadbeefdeadbeefdeadbeefdeadbeef',
};

const page: PageInfo = {
  url: `https://app.example.com/billing?session=${SECRETS.token}&tab=invoices#id_token=${SECRETS.jwt}`,
  title: `Billing — ${SECRETS.email}`,
  viewport: { width: 1280.4, height: 720, dpr: 2 },
  userAgent: 'Mozilla/5.0 Chrome/140',
  colorScheme: 'dark',
  appVersion: 'abc1234',
};

const recorder: RecorderSnapshot = {
  consoleErrors: [
    { level: 'error', message: `charge failed for ${SECRETS.customer} with key ${SECRETS.stripe}`, time: Date.UTC(2026, 9, 10) },
    { level: 'warn', message: `login password=${SECRETS.password} user ${SECRETS.email}`, time: Date.UTC(2026, 9, 10) },
  ],
  failedRequests: [
    { method: 'post', url: `https://api.example.com/v1/charges?api_key=${SECRETS.hex}`, status: 402, durationMs: 120.6 },
    { method: 'GET', url: 'chrome-extension://abc/x.js', status: null, durationMs: null },
  ],
};

const element: PickedElement = {
  selector: '#pay > button.primary',
  text: `Pay as ${SECRETS.email} (Authorization: Bearer ${SECRETS.token})`,
  box: { x: 20, y: 40, width: 200, height: 60 },
  styles: { color: 'rgb(0, 0, 0)', 'font-size': '14px' },
};

describe('assembleCapture', () => {
  it('builds the server capture shape', () => {
    const capture = assembleCapture({ page, recorder, element, screenshotAttachmentId: 'att-1' });
    expect(capture.viewport).toEqual({ width: 1280, height: 720, dpr: 2 });
    expect(capture.colorScheme).toBe('dark');
    expect(capture.appVersion).toBe('abc1234');
    expect(capture.userAgent).toBe('Mozilla/5.0 Chrome/140');
    expect(capture.screenshotAttachmentId).toBe('att-1');
    expect(capture.consoleErrors).toHaveLength(2);
    expect(capture.consoleErrors![0]!.time).toBe('2026-10-10T00:00:00.000Z');
    // Non-http(s) requests are dropped (the server refuses them).
    expect(capture.failedRequests).toEqual([{ method: 'POST', url: expect.stringContaining('https://api.example.com/v1/charges'), status: 402, durationMs: 121 }]);
    expect(capture.element).toMatchObject({ selector: '#pay > button.primary', box: element.box, styles: element.styles });
    expect(new URL(capture.url!).searchParams.get('tab')).toBe('invoices');
  });

  it('keeps the newest entries when the recorder has more than the server keeps', () => {
    const many: RecorderSnapshot = {
      consoleErrors: Array.from({ length: 30 }, (_, n) => ({ level: 'error' as const, message: `e${n}`, time: n })),
      failedRequests: [],
    };
    const capture = assembleCapture({ page: null, recorder: many, element: null, screenshotAttachmentId: null });
    expect(capture.consoleErrors).toHaveLength(CAPTURE_LIST_LIMIT);
    expect(capture.consoleErrors![0]!.message).toBe('e10');
    expect(capture.failedRequests).toBeUndefined();
    expect(capture.url).toBeUndefined();
  });

  it('never carries a raw secret, in the capture or the whole submitted payload', () => {
    const capture = assembleCapture({ page, recorder, element, screenshotAttachmentId: 'att-1' });
    const form: BugForm = {
      teamId: 'team-1', title: 'Pay button does nothing', stepsToReproduce: '1. Open the billing page', description: '',
      priority: 2, severity: null, location: { kind: 'triage' },
    };
    const payload = JSON.stringify(buildBugReportInput(form, capture));
    for (const [name, raw] of Object.entries(SECRETS)) expect(payload, name).not.toContain(raw);
    expect(payload).not.toContain(encodeURIComponent(SECRETS.email));
  });
});
