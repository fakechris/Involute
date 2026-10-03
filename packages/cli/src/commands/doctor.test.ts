import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';
const origin = 'https://involute.example';
const protocol = { schemaVersion: 1, protocolVersion: 1, mcpProtocolVersion: '2025-03-26', serverVersion: '0.0.0', buildSha: 'a'.repeat(40), endpointOrigin: origin,
  projectBinding: { rootId: 'a12d2b58-f472-46fc-b9ff-84423e937ba6', identifier: 'INV-79', repository: 'owner/repo', alias: 'INV' },
  authScopeSummary: { mode: 'agent-token', actorKind: 'AGENT', scopes: ['read'], readonly: false }, supportedCapabilities: ['cursor-pagination'] };
const config = { 'server-url': origin, token: 'inv_agent_private_do_not_print' };
function server(value: unknown = protocol) {
  return vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ result: { protocolVersion: '2025-03-26' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ protocol: value }) }] } }))));
}
afterEach(() => vi.unstubAllGlobals());
describe('doctor diagnostics', () => {
  it('passes only a known version, build, origin, credential and matching binding', async () => {
    server(); const report = await runDoctor(config, { project: 'INV-79', repository: 'owner/repo' });
    expect(report.exitCode).toBe(0); expect(report.schemaVersion).toBe(1); expect(JSON.stringify(report)).not.toContain(config.token);
  });
  it('does not treat older or unknown protocols as compatible', async () => {
    server({ ...protocol, protocolVersion: 27 }); const report = await runDoctor(config);
    expect(report.exitCode).toBe(2); expect(report.checks.at(-1)?.status).toBe('unknown');
  });
  it('does not pass an unknown server version with otherwise valid metadata', async () => {
    server({ ...protocol, serverVersion: 'unrecognized' });
    const report = await runDoctor(config, { project: 'INV-79' });
    expect(report.exitCode).toBe(2);
    expect(report.checks.find(c => c.id === 'serverVersion')?.status).toBe('unknown');
  });
  it('does not pass a wrong root even when the repository matches', async () => {
    server(); const report = await runDoctor(config, { project: 'INV-2', repository: 'owner/repo' });
    expect(report.exitCode).toBe(2); expect(report.checks.find(c => c.id === 'project')?.status).toBe('fail');
  });
  it('reports unknown build without inventing a deployed version', async () => {
    server({ ...protocol, buildSha: null }); const report = await runDoctor(config, { project: 'INV-79' });
    expect(report.exitCode).toBe(2); expect(report.checks.find(c => c.id === 'build')?.status).toBe('unknown');
  });
  it('distinguishes expired credentials from unreachable endpoints without echoing error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(config.token, { status: 401 })));
    const expired = await runDoctor(config); expect(expired.exitCode).toBe(2); expect(JSON.stringify(expired)).not.toContain(config.token);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(config.token)));
    const offline = await runDoctor(config); expect(offline.exitCode).toBe(3); expect(JSON.stringify(offline)).not.toContain(config.token);
  });
  it('preserves read-only endpoint and never retries or writes', async () => {
    server({ ...protocol, authScopeSummary: { ...protocol.authScopeSummary, readonly: true } });
    const report = await runDoctor({ ...config, 'server-url': origin + '/mcp/readonly' }, { project: 'INV-79' });
    expect(report.exitCode).toBe(0);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2); expect(calls.every(([url]) => String(url).endsWith('/mcp/readonly'))).toBe(true);
    expect(calls.map(([, options]) => JSON.parse(options?.body as string).method)).toEqual(['initialize', 'tools/call']);
  });
  it('rejects unsafe or credential-bearing endpoint config before networking', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const url of ['http://remote.example', 'https://user:secret@host', origin + '?token=secret']) {
      expect((await runDoctor({ ...config, 'server-url': url })).exitCode).toBe(2);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
