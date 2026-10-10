import { redactText, redactUrl } from './redact';
import { truncate } from './ring-buffer';
import type { BugCapture, PageInfo, PickedElement, RecorderSnapshot } from './types';

/** The server keeps 20 of each list and cuts text to these lengths (bug-capture.ts, INV-1146). */
export const CAPTURE_LIST_LIMIT = 20;
export const CAPTURE_MESSAGE_LIMIT = 500;
export const CAPTURE_ELEMENT_TEXT_LIMIT = 200;
const TITLE_LIMIT = 300;

const isHttp = (url: string) => /^https?:\/\//i.test(url);

/**
 * Assemble the capture sent with bugReport (INV-1147). Everything from the
 * page passes through redaction here, so this is the one place the payload's
 * page-derived text is built; newest list entries win when there are too many.
 */
export function assembleCapture(input: {
  page: PageInfo | null;
  recorder: RecorderSnapshot | null;
  element: PickedElement | null;
  screenshotAttachmentId: string | null;
}): BugCapture {
  const capture: BugCapture = {};
  const { page, recorder, element } = input;
  if (page) {
    if (isHttp(page.url)) capture.url = redactUrl(page.url);
    if (page.title) capture.title = truncate(redactText(page.title), TITLE_LIMIT);
    capture.viewport = {
      width: Math.max(0, Math.round(page.viewport.width)),
      height: Math.max(0, Math.round(page.viewport.height)),
      dpr: page.viewport.dpr > 0 ? page.viewport.dpr : 1,
    };
    if (page.userAgent) capture.userAgent = page.userAgent;
    capture.colorScheme = page.colorScheme;
    if (page.appVersion) capture.appVersion = truncate(redactText(page.appVersion), 100);
  }
  if (recorder) {
    const consoleErrors = recorder.consoleErrors.slice(-CAPTURE_LIST_LIMIT).map((entry) => ({
      level: entry.level,
      message: truncate(redactText(entry.message), CAPTURE_MESSAGE_LIMIT),
      time: Number.isFinite(entry.time) ? new Date(entry.time).toISOString() : null,
    }));
    if (consoleErrors.length > 0) capture.consoleErrors = consoleErrors;
    const failedRequests = recorder.failedRequests
      .filter((entry) => isHttp(entry.url))
      .slice(-CAPTURE_LIST_LIMIT)
      .map((entry) => ({
        method: (entry.method || 'GET').toUpperCase().slice(0, 10),
        url: redactUrl(entry.url),
        status: typeof entry.status === 'number' && entry.status >= 0 ? Math.round(entry.status) : null,
        durationMs: typeof entry.durationMs === 'number' && entry.durationMs >= 0 ? Math.round(entry.durationMs) : null,
      }));
    if (failedRequests.length > 0) capture.failedRequests = failedRequests;
  }
  if (element) {
    capture.element = {
      selector: truncate(redactText(element.selector), 500),
      text: element.text ? truncate(redactText(element.text), CAPTURE_ELEMENT_TEXT_LIMIT) : null,
      box: element.box,
      styles: element.styles,
    };
  }
  if (input.screenshotAttachmentId) capture.screenshotAttachmentId = input.screenshotAttachmentId;
  return capture;
}
