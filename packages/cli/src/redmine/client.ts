/**
 * Talking to an old Redmine.
 *
 * Three things about this deployment shape the client:
 *
 * 1. **The REST API is off.** `/api/*` answers 404, so everything here uses
 *    the web controllers with a JSON suffix: `/projects.json`,
 *    `/issues.json`, `/issues/<id>.json`.
 * 2. **A single API key opens a session.** The site sits behind a CAS
 *    gateway; the key is passed as `?key=`, which the gateway turns into an
 *    authenticated session. A `X-Redmine-API-Key` header is not enough here —
 *    the key as a query parameter is what works.
 * 3. **Lists are capped at 100.** `limit` above 100 is silently clamped, so
 *    every list is walked with `offset`.
 */

import type {
  RedmineIssue,
  RedmineIssueDetail,
  RedmineIssueStatus,
  RedmineListResponse,
  RedmineProject,
  RedmineTracker,
  RedmineUser,
} from './types.js';

const REDMINE_PAGE_LIMIT = 100;
const REDMINE_FETCH_TIMEOUT_MS = 60_000;

export interface RedmineClientOptions {
  /** Base URL of the Redmine, e.g. `https://redmine.91jinrong.com`. */
  baseUrl: string;
  /** The API key, sent as `?key=` on every request. */
  apiKey: string;
  /** How many requests may be in flight at once. */
  concurrency?: number;
  /** Requests per second ceiling, across all workers. */
  requestsPerSecond?: number;
}

export class RedmineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'RedmineError';
  }
}

export class RedmineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: RedmineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    const perSecond = options.requestsPerSecond ?? 8;
    this.minIntervalMs = perSecond > 0 ? Math.round(1000 / perSecond) : 0;
  }

  /** One JSON request. The key travels as a query parameter (see the header). */
  async fetchJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    url.searchParams.set('key', this.apiKey);

    const response = await this.request(url);
    const text = await response.text();

    if (!response.ok) {
      throw new RedmineError(
        `Redmine request failed: ${response.status} ${response.statusText}`,
        response.status,
        path,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RedmineError(
        `Redmine returned a non-JSON body for ${path} (${text.slice(0, 120)}).`,
        response.status,
        path,
      );
    }
  }

  /** One binary request — used for attachments. */
  async fetchBinary(path: string): Promise<Buffer> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.apiKey);

    const response = await this.request(url);

    if (!response.ok) {
      throw new RedmineError(
        `Redmine request failed: ${response.status} ${response.statusText}`,
        response.status,
        path,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async request(url: URL): Promise<Response> {
    await this.acquire();

    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(REDMINE_FETCH_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          'user-agent': 'involute-redmine-import/1.0',
        },
      });
    } finally {
      this.release();
    }
  }

  /** A simple concurrency gate with a minimum gap between requests. */
  private async acquire(): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active += 1;

    if (this.minIntervalMs > 0) {
      const waitFor = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (waitFor > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitFor));
      }
      this.lastRequestAt = Date.now();
    }
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  // --- Lists -------------------------------------------------------------

  async listProjects(): Promise<RedmineProject[]> {
    const projects: RedmineProject[] = [];
    let offset = 0;

    for (;;) {
      const payload = await this.fetchJson<RedmineListResponse<RedmineProject>>('/projects.json', {
        limit: REDMINE_PAGE_LIMIT,
        offset,
        status: '*',
      });
      const page = payload.projects ?? [];

      projects.push(...page);
      offset += page.length;

      if (page.length === 0 || offset >= (payload.total_count ?? projects.length)) {
        return projects;
      }
    }
  }

  /**
   * One user by id.
   *
   * The list endpoint does not show everybody: a user who only appears as
   * somebody's assignee can be missing from it while still being visible on
   * their own page. This closes that gap.
   *
   * The response carries the person's own API key — it is read here and
   * dropped; only the fields the import needs are ever kept.
   */
  async getUser(id: number): Promise<RedmineUser | null> {
    try {
      const payload = await this.fetchJson<{ user?: RedmineUser }>(`/users/${id}.json`);
      return payload.user ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Every user, whatever their account status.
   *
   * This Redmine answers `status=*` with an empty list — the wildcard is
   * broken there — so each status is asked for by number and the results are
   * merged. A user who only ever appears as an assignee would otherwise be
   * dropped, and their issues would lose their owner.
   */
  async listUsers(): Promise<RedmineUser[]> {
    const users = new Map<number, RedmineUser>();

    const statuses: Array<number | undefined> = [undefined, 1, 2, 3, 4, 5];

    for (const status of statuses) {
      const payload = await this.fetchJson<RedmineListResponse<RedmineUser>>('/users.json', {
        limit: REDMINE_PAGE_LIMIT,
        ...(status === undefined ? {} : { status }),
      });

      for (const user of payload.users ?? []) {
        users.set(user.id, user);
      }
    }

    return [...users.values()];
  }

  async listTrackers(): Promise<RedmineTracker[]> {
    const payload = await this.fetchJson<RedmineListResponse<RedmineTracker>>('/trackers.json');
    return payload.trackers ?? [];
  }

  async listIssueStatuses(): Promise<RedmineIssueStatus[]> {
    const payload = await this.fetchJson<RedmineListResponse<RedmineIssueStatus>>('/issue_statuses.json');
    return payload.issue_statuses ?? [];
  }

  async listIssues(): Promise<RedmineIssue[]> {
    const issues: RedmineIssue[] = [];
    let offset = 0;

    for (;;) {
      const payload = await this.fetchJson<RedmineListResponse<RedmineIssue>>('/issues.json', {
        limit: REDMINE_PAGE_LIMIT,
        offset,
        status: '*',
      });
      const page = payload.issues ?? [];

      issues.push(...page);
      offset += page.length;

      if (page.length === 0 || offset >= (payload.total_count ?? issues.length)) {
        return issues;
      }
    }
  }

  /**
   * One issue with its notes, attachments and links.
   *
   * The `include` parameter is what makes the web controller render the
   * journals and attachments; without it the response only carries the
   * summary fields.
   */
  async getIssueDetail(id: number): Promise<RedmineIssueDetail> {
    const payload = await this.fetchJson<{ issue?: RedmineIssueDetail }>(
      `/issues/${id}.json`,
      { include: 'journals,attachments,relations' },
    );

    return payload.issue ?? (payload as unknown as RedmineIssueDetail);
  }

  async downloadAttachment(id: number): Promise<Buffer> {
    return this.fetchBinary(`/attachments/${id}`);
  }
}
