import type { Command } from 'commander';

interface Config { 'server-url'?: string; token?: string }
interface Check { id: string; status: 'pass' | 'fail' | 'unknown'; code: string; remediation: string }
interface Protocol {
  schemaVersion: number; protocolVersion: number; mcpProtocolVersion: string;
  serverVersion: string; buildSha: string | null; endpointOrigin: string | null;
  projectBinding: { rootId: string | null; identifier: string | null; repository: string | null; alias: string | null } | null;
  authScopeSummary: { mode: string; actorKind: string | null; scopes: string[] | null; readonly: boolean };
  supportedCapabilities: string[];
}
export interface DoctorReport { schemaVersion: 1; checks: Check[]; exitCode: number; protocol?: Protocol }
export async function runDoctor(config: Config, binding: { project?: string; repository?: string } = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: Check['status'], code: string, remediation = '') => checks.push({ id, status, code, remediation });
  const result = (exitCode: number, protocol?: Protocol): DoctorReport => ({ schemaVersion: 1, checks, exitCode, ...(protocol ? { protocol } : {}) });
  let url: URL;
  try {
    url = new URL(config['server-url'] ?? '');
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error();
    if (!config.token) throw new Error();
    url.pathname = url.pathname === '/mcp/readonly' ? '/mcp/readonly' : '/mcp';
  } catch {
    add('configuration', 'fail', 'INVALID_CONFIG', 'Configure an HTTPS server-url (HTTP only on loopback) and a token in the private CLI config.');
    return result(2);
  }
  add('configuration', 'pass', 'CONFIGURED');
  async function rpc(method: string, params: object) {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'doctor', method, params }) });
    if (response.status === 401 || response.status === 403) throw new DoctorFailure('AUTH_REFUSED', 2);
    if (!response.ok) throw new DoctorFailure('SERVICE_UNAVAILABLE', 3);
    const body = await response.text();
    const text = body.trim().startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data:'))?.slice(5);
    if (!text) throw new DoctorFailure('INVALID_RESPONSE', 2);
    const value = JSON.parse(text);
    if (value.error || value.result?.isError) throw new DoctorFailure('OPERATION_REFUSED', 2);
    return value.result;
  }
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'involute-doctor', version: '1' } });
    if (init?.protocolVersion !== '2025-03-26') {
      add('transport', 'unknown', 'UNKNOWN_MCP_VERSION', 'Upgrade the client or verify server compatibility.'); return result(2);
    }
    add('transport', 'pass', 'MCP_COMPATIBLE');
    const guide = await rpc('tools/call', { name: 'protocol_get_guide', arguments: { project_id: binding.project, repository: binding.repository } });
    const content = guide?.content?.find((item: { type: string }) => item.type === 'text')?.text;
    const raw = content ? JSON.parse(content).protocol : null;
    if (!raw || raw.schemaVersion !== 1 || raw.protocolVersion !== 1 || raw.mcpProtocolVersion !== '2025-03-26') {
      add('protocol', 'unknown', 'UNKNOWN_PROTOCOL_VERSION', 'Use a client compatible with this server; absence is not success.'); return result(2);
    }
    // Only project known fields. Never serialize arbitrary server content, errors or credentials.
    if (typeof raw.serverVersion !== 'string' || !Array.isArray(raw.supportedCapabilities) || !raw.authScopeSummary || typeof raw.authScopeSummary.readonly !== 'boolean') throw new DoctorFailure('INVALID_RESPONSE', 2);
    const protocol: Protocol = {
      schemaVersion: 1, protocolVersion: 1, mcpProtocolVersion: '2025-03-26',
      serverVersion: safeVersion(raw.serverVersion), buildSha: /^[a-f0-9]{40}$/.test(raw.buildSha ?? '') ? raw.buildSha : null,
      endpointOrigin: safeOrigin(raw.endpointOrigin),
      projectBinding: raw.projectBinding ? { rootId: safeId(raw.projectBinding.rootId), identifier: safeIdentifier(raw.projectBinding.identifier), repository: safeRepository(raw.projectBinding.repository), alias: safeIdentifier(raw.projectBinding.alias) } : null,
      authScopeSummary: { mode: ['agent-token', 'session', 'token', 'none'].includes(raw.authScopeSummary.mode) ? raw.authScopeSummary.mode : 'unknown', actorKind: ['AGENT', 'HUMAN', 'SERVICE'].includes(raw.authScopeSummary.actorKind) ? raw.authScopeSummary.actorKind : null, scopes: Array.isArray(raw.authScopeSummary.scopes) ? raw.authScopeSummary.scopes.filter((scope: unknown) => typeof scope === 'string' && ['read', 'propose', 'claim', 'report', 'link', 'update', 'answer'].includes(scope)) : null, readonly: raw.authScopeSummary.readonly },
      supportedCapabilities: raw.supportedCapabilities.filter((value: unknown) => typeof value === 'string' && ['cursor-pagination', 'execution-claims-v1', 'action-catalog-v1', 'external-executor-v1', 'revision-conflict-v1'].includes(value)),
    };
    add('protocol', 'pass', 'PROTOCOL_COMPATIBLE');
    add('serverVersion', protocol.serverVersion === 'unknown' ? 'unknown' : 'pass', protocol.serverVersion === 'unknown' ? 'SERVER_VERSION_UNKNOWN' : 'SERVER_VERSION_IDENTIFIED', protocol.serverVersion === 'unknown' ? 'Use a server reporting a valid release version.' : '');
    add('build', protocol.buildSha ? 'pass' : 'unknown', protocol.buildSha ? 'BUILD_IDENTIFIED' : 'BUILD_UNKNOWN', protocol.buildSha ? '' : 'Build the server with INVOLUTE_BUILD_SHA set to its full source SHA.');
    const originMatches = protocol.endpointOrigin === url.origin;
    add('origin', originMatches ? 'pass' : protocol.endpointOrigin ? 'fail' : 'unknown', originMatches ? 'ORIGIN_MATCH' : 'ORIGIN_UNCONFIRMED', originMatches ? '' : 'Check APP_ORIGIN and the selected public endpoint; direct endpoints may intentionally differ.');
    const bound = !!protocol.projectBinding?.rootId && (!binding.repository || binding.repository === protocol.projectBinding.repository) && (!binding.project || [protocol.projectBinding.rootId, protocol.projectBinding.identifier].includes(binding.project));
    add('project', bound ? 'pass' : 'fail', bound ? 'PROJECT_BOUND' : 'PROJECT_UNCONFIRMED', bound ? '' : 'Supply --project or --repository matching a visible canonical PROJECT.');
    add('credential', protocol.authScopeSummary.mode === 'agent-token' && protocol.authScopeSummary.scopes?.includes('read') ? 'pass' : 'unknown', protocol.authScopeSummary.mode === 'agent-token' ? 'AGENT_SCOPE_REPORTED' : 'NON_AGENT_CREDENTIAL', 'Check required actions with work_catalog(kind: capabilities); this diagnostic does not grant execution rights.');
    return result(checks.every(check => check.status === 'pass') ? 0 : 2, protocol);
  } catch (error) {
    const failure = error instanceof DoctorFailure ? error : new DoctorFailure(error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'SERVICE_UNREACHABLE', error instanceof SyntaxError ? 2 : 3);
    add('connection', 'fail', failure.code, failure.exitCode === 3 ? 'Check endpoint connectivity and service readiness, then rerun doctor.' : 'Check credentials, project selectors and server compatibility; no writes were attempted.');
    return result(failure.exitCode);
  }
}
class DoctorFailure extends Error { constructor(readonly code: string, readonly exitCode: number) { super(code); } }
function safeVersion(value: unknown) { return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) ? value : 'unknown'; }
function safeId(value: unknown) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value : null; }
function safeIdentifier(value: unknown) { return typeof value === 'string' && /^[A-Z]+(?:-\d+)?$/.test(value) ? value : null; }
function safeRepository(value: unknown) { return typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) ? value : null; }
function safeOrigin(value: unknown) { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null; } catch { return null; } }
export function registerDoctorCommand(program: Command, readConfig: () => Promise<Config>) {
  program.command('doctor').description('Read-only protocol, credential and project binding diagnostics.')
    .option('--json', 'Machine-readable versioned report').option('--project <id>', 'PROJECT UUID or identifier').option('--repository <repo>', 'Canonical repository')
    .action(async (options: { json?: boolean; project?: string; repository?: string }) => {
      let report: DoctorReport;
      try { report = await runDoctor(await readConfig(), options); }
      catch { report = { schemaVersion: 1, exitCode: 2, checks: [{ id: 'configuration', status: 'fail', code: 'INVALID_CONFIG', remediation: 'Repair the private CLI configuration.' }] }; }
      process.stdout.write(options.json || program.opts().json ? `${JSON.stringify(report, null, 2)}\n` : report.checks.map(check => `${check.status} ${check.id}: ${check.code}${check.remediation ? ` — ${check.remediation}` : ''}`).join('\n') + '\n');
      process.exitCode = report.exitCode;
    });
}
