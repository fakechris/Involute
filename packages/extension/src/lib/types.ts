/** Shapes shared by the background, the panel and the page scripts (INV-1147). */

export interface ConsoleEntry {
  level: 'error' | 'warn' | 'uncaught' | 'unhandledrejection';
  message: string;
  /** Epoch milliseconds. */
  time: number;
}

export interface FailedRequest {
  method: string;
  url: string;
  /** null when the request never got a response (network error, CORS, abort). */
  status: number | null;
  durationMs: number | null;
}

export interface RecorderSnapshot {
  consoleErrors: ConsoleEntry[];
  failedRequests: FailedRequest[];
}

export interface PageInfo {
  url: string;
  title: string;
  viewport: { width: number; height: number; dpr: number };
  userAgent: string;
  colorScheme: 'light' | 'dark';
  appVersion: string | null;
}

export interface PickedElement {
  selector: string;
  text: string | null;
  /** In screenshot pixels: CSS pixels of the viewport times devicePixelRatio. */
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

/** The capture as the server's BugReportInput.capture expects it (INV-1146). */
export interface BugCapture {
  url?: string;
  title?: string;
  viewport?: { width: number; height: number; dpr: number };
  userAgent?: string;
  colorScheme?: 'light' | 'dark';
  appVersion?: string;
  consoleErrors?: Array<{ level: string; message: string; time: string | null }>;
  failedRequests?: Array<{ method: string; url: string; status: number | null; durationMs: number | null }>;
  element?: { selector: string; text: string | null; box: { x: number; y: number; width: number; height: number } | null; styles: Record<string, string> };
  screenshotAttachmentId?: string;
}

export interface Connection {
  token: string;
  server: string;
  person: { id: string; name: string | null; email: string | null };
  expiresAt: string;
}
