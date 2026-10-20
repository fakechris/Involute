/**
 * Talking to a DingTalk organisation (INV-1288).
 *
 * This is the directory side of DingTalk: departments and the people in them.
 * It is a different thing from the sign-in flow in `auth-providers/dingtalk.ts`
 * — that one asks "who is this person?", this one asks "who is in the
 * organisation and where do they sit?".
 *
 * ## Which APIs
 *
 * The directory APIs come in two generations. The 1.0 set
 * (`api.dingtalk.com/v1.0/...`) is the one DingTalk recommends and where new
 * capabilities land; the `topapi/v2` set (`oapi.dingtalk.com/...`) still
 * carries the directory endpoints that return the fields an organisation sync
 * needs — the person's email and their union id — in one page. The access
 * token is the same for both.
 *
 * ## Permissions
 *
 * Reading departments needs the directory-department read permission; reading
 * people needs the directory-member read permission, plus the "personal
 * information" permissions for the fields to come back at all — without them
 * DingTalk omits `email` rather than failing.
 */

export interface DingTalkClientOptions {
  appKey: string;
  appSecret: string;
  /** Overridable for a test. */
  fetchImpl?: typeof fetch;
  /** How long a token is reused, in seconds. DingTalk's own limit is 7200. */
  tokenTtlSeconds?: number;
}

export interface DingTalkDepartment {
  /** DingTalk's own id for the department. */
  deptId: number;
  name: string;
  parentId: number | null;
}

export interface DingTalkDirectoryUser {
  /** DingTalk's id for the person inside this app. */
  userId: string;
  /** Stable across every app in the same corporation — the identity we key on. */
  unionId: string | null;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  title: string | null;
  active: boolean;
  departmentIds: number[];
}

const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const DINGTALK_API_BASE = 'https://oapi.dingtalk.com/topapi/v2';
const DINGTALK_FETCH_TIMEOUT_MS = 20_000;
const DINGTALK_PAGE_SIZE = 100;

interface DingTalkTokenResponse {
  accessToken?: string;
  expireIn?: number;
  message?: string;
}

interface DingTalkTopApiResponse<T> {
  errcode?: number;
  errmsg?: string;
  result?: T;
}

interface DingTalkDepartmentListResult {
  dept_list?: Array<{
    dept_id?: number;
    name?: string;
    parent_id?: number;
  }>;
  has_more?: boolean;
  next_cursor?: number;
}

interface DingTalkDepartmentResult {
  dept_id?: number;
  name?: string;
  parent_id?: number;
}

interface DingTalkUserListResult {
  has_more?: boolean;
  next_cursor?: number;
  list?: Array<{
    active?: boolean;
    avatar?: string;
    dept_id_list?: number[];
    email?: string;
    mobile?: string;
    name?: string;
    title?: string;
    unionid?: string;
    userid?: string;
  }>;
}

export class DingTalkError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'DingTalkError';
  }
}

export class DingTalkClient {
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenTtlSeconds: number;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: DingTalkClientOptions) {
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 600;
  }

  /** The app's access token, reused until it is close to expiring. */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const response = await this.fetchImpl(DINGTALK_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(DINGTALK_FETCH_TIMEOUT_MS),
      body: JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret }),
    });

    const payload = (await this.readJson(response)) as DingTalkTokenResponse;

    if (!response.ok || !payload.accessToken) {
      throw new DingTalkError(
        `DingTalk access token request failed${
          payload.message ? `: ${payload.message}` : ` (status ${response.status})`
        }.`,
      );
    }

    this.accessToken = payload.accessToken;
    this.tokenExpiresAt = Date.now() + this.tokenTtlSeconds * 1000;
    return this.accessToken;
  }

  /** One department, by id. */
  async getDepartment(departmentId: number): Promise<DingTalkDepartment | null> {
    const result = await this.call<DingTalkDepartmentResult>(
      '/department/get',
      { dept_id: departmentId },
    );

    if (!result || result.dept_id === undefined) {
      return null;
    }

    return {
      deptId: result.dept_id,
      name: result.name ?? `Department ${String(result.dept_id)}`,
      parentId: result.parent_id ?? null,
    };
  }

  /** The departments directly under one department. */
  async listSubDepartments(departmentId: number): Promise<DingTalkDepartment[]> {
    const departments: DingTalkDepartment[] = [];
    let cursor = 0;

    for (;;) {
      const result = await this.call<DingTalkDepartmentListResult>(
        '/department/listsub',
        { cursor, dept_id: departmentId, size: DINGTALK_PAGE_SIZE },
      );

      for (const department of result?.dept_list ?? []) {
        if (department.dept_id === undefined) {
          continue;
        }
        departments.push({
          deptId: department.dept_id,
          name: department.name ?? `Department ${String(department.dept_id)}`,
          parentId: department.parent_id ?? null,
        });
      }

      if (!result?.has_more) {
        return departments;
      }

      cursor = result.next_cursor ?? cursor + DINGTALK_PAGE_SIZE;
    }
  }

  /**
   * The people directly in one department.
   *
   * Sub-departments are not included — DingTalk reports each department's
   * own members only — so a caller that wants the whole subtree walks it.
   */
  async listDepartmentUsers(departmentId: number): Promise<DingTalkDirectoryUser[]> {
    const users: DingTalkDirectoryUser[] = [];
    let cursor = 0;

    for (;;) {
      const result = await this.call<DingTalkUserListResult>(
        '/user/list',
        {
          contain_access_limit: false,
          cursor,
          dept_id: departmentId,
          order_field: 'custom',
          size: DINGTALK_PAGE_SIZE,
        },
      );

      for (const user of result?.list ?? []) {
        if (!user.userid) {
          continue;
        }
        users.push({
          active: user.active !== false,
          avatarUrl: user.avatar ?? null,
          departmentIds: user.dept_id_list ?? [],
          email: user.email?.trim() || null,
          name: user.name?.trim() || user.userid,
          title: user.title?.trim() || null,
          unionId: user.unionid?.trim() || null,
          userId: user.userid,
        });
      }

      if (!result?.has_more) {
        return users;
      }

      cursor = result.next_cursor ?? cursor + DINGTALK_PAGE_SIZE;
    }
  }

  /** A department and everything under it, by id. */
  async collectDepartmentTree(departmentId: number): Promise<DingTalkDepartment[]> {
    const root = await this.getDepartment(departmentId);
    if (!root) {
      return [];
    }

    const collected: DingTalkDepartment[] = [root];
    const queue: number[] = [departmentId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.listSubDepartments(current);

      for (const child of children) {
        collected.push(child);
        queue.push(child.deptId);
      }
    }

    return collected;
  }

  /** The departments directly under the root (id 1). */
  async listTopLevelDepartments(): Promise<DingTalkDepartment[]> {
    return this.listSubDepartments(1);
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T | undefined> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${DINGTALK_API_BASE}${path}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
        signal: AbortSignal.timeout(DINGTALK_FETCH_TIMEOUT_MS),
        body: new URLSearchParams(
          Object.entries(body).map(([key, value]) => [key, String(value)]),
        ).toString(),
      },
    );

    const payload = (await this.readJson(response)) as DingTalkTopApiResponse<T>;
    const code = payload.errcode;

    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new DingTalkError(
        `DingTalk ${path} failed${payload.errmsg ? `: ${payload.errmsg}` : ''}${
          code !== undefined ? ` (code ${String(code)})` : ` (status ${response.status})`
        }.`,
        code,
      );
    }

    return payload.result;
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return {};
    }
  }
}
