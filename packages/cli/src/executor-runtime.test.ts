import { createExecutorMcpClient } from './commands/executor.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAuthorizedEffect } from './executor-runtime.js';
describe('external effect authority boundary', () => {
  it('checks authority again after asynchronous preparation revokes it', async () => {
    let allowed = true;
    const execute = vi.fn();
    await expect(executeAuthorizedEffect({ prepare: async () => { await Promise.resolve(); allowed = false; }, authorize: async () => { if (!allowed) throw new Error('revoked'); }, execute })).rejects.toThrow('revoked');
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not retry an ambiguous authorization response or an external effect', async () => {
    const execute = vi.fn(async () => { throw new Error('unknown external result'); });
    await expect(executeAuthorizedEffect({ prepare: async () => {}, authorize: async () => {}, execute })).rejects.toThrow('unknown external result');
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockClear();
    await expect(executeAuthorizedEffect({ prepare: async () => {}, authorize: async () => { throw new Error('lost response'); }, execute })).rejects.toThrow('lost response');
    expect(execute).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllGlobals());
it('uses the agent MCP endpoint and never retries an ambiguous mutation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'executor', result: { content: [{ type: 'text', text: '{"ok":true}' }] } })));
  vi.stubGlobal('fetch', fetch);
  const client = createExecutorMcpClient('https://example.test/graphql', 'inv_agent_fixture');
  await expect(client.call('work_executor_context', { id: 'work' })).resolves.toEqual({ ok: true });
  expect(String(fetch.mock.calls[0]?.[0])).toBe('https://example.test/mcp');
  fetch.mockReset().mockRejectedValue(new Error('Lost response'));
  await expect(client.call('work_executor_update', { operation: 'start_effect' })).rejects.toThrow('Lost response');
  expect(fetch).toHaveBeenCalledTimes(1);
});
