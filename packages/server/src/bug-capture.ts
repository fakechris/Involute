import { createValidationError, exposeErrorMessages } from './errors.js';

/**
 * The browser environment a bug report may carry (INV-1146). A UI bug is hard
 * to reproduce without the page, viewport, browser, console errors and failed
 * requests it happened with; the capture extension (INV-1147) collects them.
 *
 * Everything is optional. Over-long lists and text are cut to size rather than
 * refused (a noisy page should not lose the report); a value of the wrong type
 * or a URL that is not http(s) is refused, with the field named in `message`.
 * Request and response bodies are never accepted: unknown keys are dropped.
 */
export const CAPTURE_LIST_LIMIT = 20;
export const CAPTURE_MESSAGE_LIMIT = 500;
export const CAPTURE_ELEMENT_TEXT_LIMIT = 200;
const URL_LIMIT = 2000;
const TEXT_LIMIT = 300;
const USER_AGENT_LIMIT = 500;
const SELECTOR_LIMIT = 500;
const STYLE_VALUE_LIMIT = 200;

export const CAPTURE_STYLE_KEYS = [
  'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color',
  'padding', 'margin', 'width', 'height', 'display', 'position', 'z-index', 'overflow',
] as const;

export const CAPTURE_MESSAGES = {
  shape: 'capture must be an object (url, title, viewport, userAgent, colorScheme, appVersion, consoleErrors, failedRequests, element, screenshotAttachmentId).',
  url: 'capture.url must be an http(s) URL.',
  title: 'capture.title must be text.',
  viewport: 'capture.viewport must be { width, height, dpr } with non-negative numbers.',
  userAgent: 'capture.userAgent must be text.',
  colorScheme: "capture.colorScheme must be 'light' or 'dark'.",
  appVersion: 'capture.appVersion must be text.',
  consoleErrors: 'capture.consoleErrors must be a list of { level, message, time } with text message.',
  failedRequests: 'capture.failedRequests must be a list of { method, url, status, durationMs } with an http(s) url.',
  element: 'capture.element must be { selector, text, box { x, y, width, height }, styles } with text selector and numeric box.',
  styles: 'capture.element.styles must map style names to text values.',
  screenshot: 'capture.screenshotAttachmentId must be the id of a file you uploaded that is not attached to other work.',
} as const;
exposeErrorMessages(Object.values(CAPTURE_MESSAGES));

export interface BugCapture {
  url?: string;
  title?: string;
  viewport?: { width: number; height: number; dpr: number };
  userAgent?: string;
  colorScheme?: 'light' | 'dark';
  appVersion?: string;
  consoleErrors?: Array<{ level: string; message: string; time: string | null }>;
  failedRequests?: Array<{ method: string; url: string; status: number | null; durationMs: number | null }>;
  element?: {
    selector: string;
    text: string | null;
    box: { x: number; y: number; width: number; height: number } | null;
    styles: Partial<Record<(typeof CAPTURE_STYLE_KEYS)[number], string>>;
  };
  screenshotAttachmentId?: string;
  /** Set by the server from the attachment, so the issue page can link it. */
  screenshotUrl?: string;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const cut = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);
const absent = (value: unknown) => value === undefined || value === null;

function refuse(message: string): never {
  throw createValidationError(message);
}

function text(value: unknown, limit: number, message: string): string | undefined {
  if (absent(value)) return undefined;
  if (typeof value !== 'string') refuse(message);
  return cut(value.trim(), limit);
}

function httpUrl(value: unknown, message: string): string {
  if (typeof value !== 'string') refuse(message);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    refuse(message);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') refuse(message);
  return cut(parsed.href, URL_LIMIT);
}

function list(value: unknown, message: string): unknown[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value)) refuse(message);
  return value.slice(0, CAPTURE_LIST_LIMIT);
}

function time(value: unknown): string | null {
  if (absent(value)) return null;
  if (isNumber(value)) return new Date(value).toISOString();
  if (typeof value === 'string') return cut(value.trim(), 40);
  return refuse(CAPTURE_MESSAGES.consoleErrors);
}

function optionalNumber(value: unknown, message: string): number | null {
  if (absent(value)) return null;
  if (!isNumber(value) || value < 0) refuse(message);
  return value;
}

/** Validate and size-cap a raw capture; null when none was sent. */
export function parseBugCapture(raw: unknown): BugCapture | null {
  if (absent(raw)) return null;
  if (!isObject(raw)) refuse(CAPTURE_MESSAGES.shape);
  const capture: BugCapture = {};

  if (!absent(raw.url)) capture.url = httpUrl(raw.url, CAPTURE_MESSAGES.url);
  const title = text(raw.title, TEXT_LIMIT, CAPTURE_MESSAGES.title);
  if (title) capture.title = title;

  if (!absent(raw.viewport)) {
    const viewport = raw.viewport;
    if (!isObject(viewport) || ![viewport.width, viewport.height].every((n) => isNumber(n) && n >= 0)) refuse(CAPTURE_MESSAGES.viewport);
    const dpr = absent(viewport.dpr) ? 1 : viewport.dpr;
    if (!isNumber(dpr) || dpr <= 0) refuse(CAPTURE_MESSAGES.viewport);
    capture.viewport = { width: Math.round(viewport.width as number), height: Math.round(viewport.height as number), dpr };
  }

  const userAgent = text(raw.userAgent, USER_AGENT_LIMIT, CAPTURE_MESSAGES.userAgent);
  if (userAgent) capture.userAgent = userAgent;
  if (!absent(raw.colorScheme)) {
    if (raw.colorScheme !== 'light' && raw.colorScheme !== 'dark') refuse(CAPTURE_MESSAGES.colorScheme);
    capture.colorScheme = raw.colorScheme;
  }
  const appVersion = text(raw.appVersion, 100, CAPTURE_MESSAGES.appVersion);
  if (appVersion) capture.appVersion = appVersion;

  const consoleErrors = list(raw.consoleErrors, CAPTURE_MESSAGES.consoleErrors);
  if (consoleErrors) {
    capture.consoleErrors = consoleErrors.map((entry) => {
      if (!isObject(entry) || typeof entry.message !== 'string') refuse(CAPTURE_MESSAGES.consoleErrors);
      return {
        level: text(entry.level, 20, CAPTURE_MESSAGES.consoleErrors) || 'error',
        message: cut(entry.message.trim(), CAPTURE_MESSAGE_LIMIT),
        time: time(entry.time),
      };
    });
  }

  const failedRequests = list(raw.failedRequests, CAPTURE_MESSAGES.failedRequests);
  if (failedRequests) {
    capture.failedRequests = failedRequests.map((entry) => {
      if (!isObject(entry)) refuse(CAPTURE_MESSAGES.failedRequests);
      const status = optionalNumber(entry.status, CAPTURE_MESSAGES.failedRequests);
      return {
        method: (text(entry.method, 10, CAPTURE_MESSAGES.failedRequests) || 'GET').toUpperCase(),
        url: httpUrl(entry.url, CAPTURE_MESSAGES.failedRequests),
        status: status === null ? null : Math.round(status),
        durationMs: optionalNumber(entry.durationMs, CAPTURE_MESSAGES.failedRequests),
      };
    });
  }

  if (!absent(raw.element)) {
    const element = raw.element;
    if (!isObject(element) || typeof element.selector !== 'string' || !element.selector.trim()) refuse(CAPTURE_MESSAGES.element);
    let box: NonNullable<BugCapture['element']>['box'] = null;
    if (!absent(element.box)) {
      const rawBox = element.box;
      if (!isObject(rawBox) || ![rawBox.x, rawBox.y, rawBox.width, rawBox.height].every(isNumber)) refuse(CAPTURE_MESSAGES.element);
      box = { x: rawBox.x as number, y: rawBox.y as number, width: rawBox.width as number, height: rawBox.height as number };
    }
    const styles: NonNullable<BugCapture['element']>['styles'] = {};
    if (!absent(element.styles)) {
      if (!isObject(element.styles)) refuse(CAPTURE_MESSAGES.styles);
      for (const key of CAPTURE_STYLE_KEYS) {
        const value = element.styles[key];
        if (absent(value)) continue;
        if (typeof value !== 'string' && !isNumber(value)) refuse(CAPTURE_MESSAGES.styles);
        styles[key] = cut(String(value).trim(), STYLE_VALUE_LIMIT);
      }
    }
    capture.element = {
      selector: cut(element.selector.trim(), SELECTOR_LIMIT),
      text: text(element.text, CAPTURE_ELEMENT_TEXT_LIMIT, CAPTURE_MESSAGES.element) ?? null,
      box,
      styles,
    };
  }

  if (!absent(raw.screenshotAttachmentId)) {
    if (typeof raw.screenshotAttachmentId !== 'string' || !raw.screenshotAttachmentId.trim()) refuse(CAPTURE_MESSAGES.screenshot);
    capture.screenshotAttachmentId = raw.screenshotAttachmentId.trim();
  }
  return capture;
}

/** One table cell: no pipes or line breaks to break the row. */
const cell = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
/** Inline code that cannot be closed early by the value. */
const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;
const KEY_STYLES = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'display', 'position'] as const;

/** The "### Environment" Markdown section appended to the bug's description. */
export function environmentSection(capture: BugCapture): string {
  const rows: Array<[string, string]> = [];
  if (capture.url) rows.push(['Page', capture.title ? `[${cell(capture.title).replace(/[[\]]/g, '')}](${capture.url})` : capture.url]);
  else if (capture.title) rows.push(['Page', cell(capture.title)]);
  if (capture.viewport) rows.push(['Viewport', `${capture.viewport.width}×${capture.viewport.height} @${capture.viewport.dpr}x`]);
  if (capture.userAgent) rows.push(['Browser', cell(capture.userAgent)]);
  if (capture.colorScheme) rows.push(['Theme', capture.colorScheme]);
  if (capture.appVersion) rows.push(['Version', code(capture.appVersion)]);
  if (capture.screenshotUrl) rows.push(['Screenshot', `[screenshot](${capture.screenshotUrl})`]);

  const parts = ['### Environment'];
  if (rows.length > 0) parts.push(['| | |', '|---|---|', ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join('\n'));
  if (capture.element) {
    const { element } = capture;
    const lines = [`**Element** ${code(element.selector)}${element.text ? ` — “${element.text.replace(/\s+/g, ' ')}”` : ''}`];
    if (element.box) lines.push(`- box: ${element.box.x}, ${element.box.y}, ${element.box.width}×${element.box.height}`);
    const styles = KEY_STYLES.filter((key) => element.styles[key]).map((key) => `${key}: ${element.styles[key]}`);
    if (styles.length > 0) lines.push(`- styles: ${code(styles.join('; '))}`);
    parts.push(lines.join('\n'));
  }
  if (capture.consoleErrors?.length) {
    parts.push(['**Console errors**', ...capture.consoleErrors.map((entry) => `- ${entry.level}${entry.time ? ` ${entry.time}` : ''}: ${code(entry.message.replace(/\s+/g, ' '))}`)].join('\n'));
  }
  if (capture.failedRequests?.length) {
    parts.push(['**Failed requests**', ...capture.failedRequests.map((entry) => `- ${entry.method} ${entry.status ?? 'failed'} ${code(entry.url)}${entry.durationMs === null ? '' : ` (${Math.round(entry.durationMs)} ms)`}`)].join('\n'));
  }
  return parts.length === 1 ? '' : parts.join('\n\n');
}
