import { describe, expect, it } from 'vitest';

import { DingTalkClient, DingTalkError } from './client.ts';

interface FakeCall {
  url: string;
  body: URLSearchParams;
}

/** A fetch that answers from a fixed script, and records what it was asked. */
function fakeFetch(handlers: {
  token?: { accessToken?: string; expireIn?: number; message?: string; ok?: boolean };
  api?: (path: string, body: URLSearchParams) => { ok?: boolean; payload: unknown };
}) {
  const calls: FakeCall[] = [];
  let tokenRequests = 0;

  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = new URLSearchParams((init?.body as string | undefined) ?? '');

    if (url.includes('oauth2/accessToken')) {
      tokenRequests += 1;
      const token = handlers.token ?? {};

      return Response.json(
        {
          accessToken: token.accessToken,
          expireIn: token.expireIn,
          message: token.message,
        },
        { status: token.ok === false ? 400 : 200 },
      );
    }

    calls.push({ url, body });

    const path = url.replace('https://oapi.dingtalk.com/topapi/v2', '').split('?')[0] ?? '';
    const answer = handlers.api?.(path, body) ?? { payload: { errcode: 0, result: {} } };

    return Response.json(answer.payload, { status: answer.ok === false ? 500 : 200 });
  };

  return { impl, calls, tokenRequests: () => tokenRequests };
}

describe('the DingTalk client (INV-1288)', () => {
  it('asks for an access token once and reuses it', async () => {
    const fetcher = fakeFetch({
      token: { accessToken: 'token-1', expireIn: 7200 },
      api: () => ({ payload: { errcode: 0, result: { dept_id: 1, name: 'Core' } } }),
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    await client.getDepartment(1);
    await client.getDepartment(1);
    await client.getDepartment(1);

    expect(fetcher.tokenRequests()).toBe(1);
    expect(fetcher.calls[0]?.url).toContain('access_token=token-1');
  });

  it('says what went wrong when the token cannot be had', async () => {
    const fetcher = fakeFetch({ token: { message: 'invalid appKey', ok: false } });
    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    await expect(client.getAccessToken()).rejects.toThrow(/invalid appKey/);
  });

  it('reads one department', async () => {
    const fetcher = fakeFetch({
      token: { accessToken: 'token-1' },
      api: () => ({ payload: { errcode: 0, result: { dept_id: 7, name: 'Platform', parent_id: 1 } } }),
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    expect(await client.getDepartment(7)).toEqual({ deptId: 7, name: 'Platform', parentId: 1 });
    expect(fetcher.calls[0]?.body.get('dept_id')).toBe('7');
  });

  it('reports a department that is not there as missing, not as an error', async () => {
    const fetcher = fakeFetch({
      token: { accessToken: 'token-1' },
      api: () => ({ payload: { errcode: 0, result: {} } }),
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    expect(await client.getDepartment(7)).toBeNull();
  });

  it('follows the pages of a department list', async () => {
    let page = 0;
    const fetcher = fakeFetch({
      token: { accessToken: 'token-1' },
      api: () => {
        page += 1;

        if (page === 1) {
          return {
            payload: {
              errcode: 0,
              result: { dept_list: [{ dept_id: 2, name: 'A' }], has_more: true, next_cursor: 42 },
            },
          };
        }

        return {
          payload: {
            errcode: 0,
            result: { dept_list: [{ dept_id: 3, name: 'B' }], has_more: false },
          },
        };
      },
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    const departments = await client.listSubDepartments(1);

    expect(departments.map((entry) => entry.deptId)).toEqual([2, 3]);
    expect(fetcher.calls[1]?.body.get('cursor')).toBe('42');
  });

  it('maps the people of a department and leaves out the ones with no id', async () => {
    const fetcher = fakeFetch({
      token: { accessToken: 'token-1' },
      api: () => ({
        payload: {
          errcode: 0,
          result: {
            list: [
              {
                active: true,
                avatar: 'https://img/u1',
                dept_id_list: [1],
                email: ' ann@example.com ',
                name: ' Ann Li ',
                title: 'Engineer ',
                unionid: 'union-u1',
                userid: 'u1',
              },
              { name: 'No Id' },
            ],
          },
        },
      }),
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    const users = await client.listDepartmentUsers(1);

    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({
      active: true,
      avatarUrl: 'https://img/u1',
      departmentIds: [1],
      email: 'ann@example.com',
      name: 'Ann Li',
      title: 'Engineer',
      unionId: 'union-u1',
      userId: 'u1',
    });
  });

  it('walks a department and everything under it', async () => {
    const tree: Record<string, Array<{ dept_id: number; name: string; parent_id: number }>> = {
      '1': [{ dept_id: 2, name: 'Platform', parent_id: 1 }],
      '2': [{ dept_id: 3, name: 'Data', parent_id: 2 }],
      '3': [],
    };

    const fetcher = fakeFetch({
      token: { accessToken: 'token-1' },
      api: (path, body) => {
        if (path === '/department/get') {
          return { payload: { errcode: 0, result: { dept_id: 1, name: 'Core', parent_id: 0 } } };
        }

        return {
          payload: {
            errcode: 0,
            result: {
              dept_list: tree[body.get('dept_id') ?? ''] ?? [],
              has_more: false,
            },
          },
        };
      },
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    const collected = await client.collectDepartmentTree(1);

    expect(collected.map((entry) => entry.deptId)).toEqual([1, 2, 3]);
  });

  it('raises the error DingTalk reported', async () => {
    const fetcher = fakeFetch({
      token: { accessToken: 'token-1' },
      api: () => ({ payload: { errcode: 88, errmsg: 'no permission' } }),
    });

    const client = new DingTalkClient({
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: fetcher.impl,
    });

    await expect(client.getDepartment(1)).rejects.toThrow(DingTalkError);
    await expect(client.getDepartment(1)).rejects.toThrow(/no permission/);
  });
});
