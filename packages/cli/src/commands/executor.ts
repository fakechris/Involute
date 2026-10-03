import type { Command } from 'commander';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { executeAuthorizedEffect } from '../executor-runtime.js';
const exec = promisify(execFile);
export interface ExecutorTransport { call(name: string, args: object): Promise<unknown> }
export function createExecutorMcpClient(serverUrl: string, token: string): ExecutorTransport {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw message('Executor credentials require HTTPS outside loopback.');
  url.pathname = '/mcp'; url.search = ''; url.hash = '';
  return { async call(name, args) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'executor', method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw message('Executor MCP request failed; no automatic mutation retry.');
    const body = await response.text();
    const payload = body.trim().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (!payload) throw message('Invalid executor MCP response.');
    const rpc = JSON.parse(payload) as { error?: unknown; result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } };
    if (rpc.error || rpc.result?.isError) throw message('Executor MCP operation was refused; refresh context and inspect the dispatch.');
    const text = rpc.result?.content?.find((item) => item.type === 'text')?.text;
    if (!text) throw message('Executor MCP result is missing.');
    return JSON.parse(text) as unknown;
  } };
}
interface Row { repository: string; id: string; workId: string; generation: number; revision: number; visibleState: string; runId: string | null; run?: { commitSha: string | null; pullRequestNumber: number | null } | null }
interface Recipe {
  version: 1; repository: string; cwd: string; baseSha: string; action: 'merge' | 'deploy'; environment?: string;
  command: string; args: string[];
}
interface Options { work: string; executionFile: string; recipe: string; sha: string; key: string; journal: string }
function message(value: string): Error { return new Error(value); }
async function getRow(client: ExecutorTransport, work: string): Promise<Row> {
  const context = await client.call('work_executor_context', { id: work }) as { protocolVersion: number; dispatches: Row[]; work: { repository: string } };
  if (context.protocolVersion !== 1) throw message('Unsupported executor protocol.');
  const row = context.dispatches.find((item) => item.workId === work);
  if (!row) throw message('Dispatch the approved implementation before executing it.');
  return { ...row, repository: context.work.repository };
}
async function update(client: ExecutorTransport, workId: string, operation: string, details: object): Promise<Record<string, unknown>> {
  return await client.call('work_executor_update', { work_id: workId, operation, details }) as Record<string, unknown>;
}
/** Recipes are installed locally by the runtime operator, never supplied by the Involute server. */
export async function performExecutorEffect(client: ExecutorTransport, options: Options): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(options.sha)) throw message('Use a full lowercase commit SHA.');
  const secretStat = await stat(options.executionFile);
  if (secretStat.mode & 0o077) throw message('The execution file must be private (chmod 600).');
  const execution = JSON.parse(await readFile(options.executionFile, 'utf8')) as { work_id: string; run_id: string; claim_token: string };
  if (execution.work_id !== options.work || !execution.run_id || !execution.claim_token) throw message('The execution file must match work_id and contain run_id and claim_token.');
  const recipe = JSON.parse(await readFile(options.recipe, 'utf8')) as Recipe;
  if (recipe.version !== 1 || !['merge', 'deploy'].includes(recipe.action) || !isAbsolute(recipe.cwd) || !isAbsolute(recipe.command) || !/^[a-f0-9]{40}$/.test(recipe.baseSha) || !Array.isArray(recipe.args) || !recipe.args.every((arg) => typeof arg === 'string') || !recipe.args.some((arg) => arg.includes('{sha}'))) throw message('Invalid local executor recipe; pin cwd, command, baseSha, action and a {sha} argument.');
  const git = async (...args: string[]) => (await exec('git', ['-C', recipe.cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  const remote = (await git('remote', 'get-url', 'origin')).trim().replace(/^git@github.com:/, '').replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '');
  if (remote !== recipe.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote)) throw message('The local Git origin does not match the recipe repository.');
  if ((await git('status', '--porcelain')).trim() || (await git('rev-parse', 'HEAD')).trim() !== options.sha) throw message('The executor needs a clean checkout at the exact effect SHA.');
  await git('merge-base', '--is-ancestor', recipe.baseSha, options.sha);
  const paths = (await git('diff', '--no-renames', '--name-only', '-z', recipe.baseSha, options.sha)).split('\0').filter(Boolean);
  await mkdir(dirname(options.journal), { recursive: true, mode: 0o700 });
  // Exclusive creation stops local accidental replay even when a response was lost.
  await writeFile(options.journal, JSON.stringify({ version: 1, workId: options.work, key: options.key, sha: options.sha, state: 'PREPARING' }), { flag: 'wx', mode: 0o600 });
  let row = await getRow(client, options.work);
  if (row.repository !== recipe.repository) throw message('The recipe repository does not match the authorized work.');
  const details = () => ({ expectedRevision: row.revision, generation: row.generation, claimToken: execution.claim_token });
  if (row.visibleState === 'QUEUED') { await update(client, options.work, 'ack', { ...details(), runId: execution.run_id }); row = await getRow(client, options.work); }
  if (row.runId !== execution.run_id || row.visibleState !== 'RUNNING') throw message('This execution is not the acknowledged running dispatch.');
  if (recipe.action === 'merge' && (!row.run?.pullRequestNumber || row.run.commitSha !== options.sha || !recipe.args.some((arg) => arg.includes('{pr}')))) throw message('Merge recipes require a {pr} argument and the bound PR head.');
  const effect = await update(client, options.work, 'prepare_effect', { ...details(), effect: { key: options.key, action: recipe.action, environment: recipe.environment, commitSha: options.sha, paths } });
  const args = recipe.args.map((arg) => arg.replaceAll('{sha}', options.sha).replaceAll('{pr}', String(row.run?.pullRequestNumber ?? '')));
  let stopped = false;
  await executeAuthorizedEffect({
    prepare: async () => {
      await writeFile(options.journal, JSON.stringify({ version: 1, workId: options.work, effectId: effect.id, sha: options.sha, state: 'AUTHORIZATION_PENDING' }), { mode: 0o600 });
      // Check the local checkout again after network awaits; no user-controlled shell interpolation.
      if ((await git('status', '--porcelain')).trim() || (await git('rev-parse', 'HEAD')).trim() !== options.sha) throw message('Checkout changed during executor preparation.');
      row = await getRow(client, options.work);
    },
    authorize: async () => { await update(client, options.work, 'start_effect', { ...details(), effectId: effect.id }); },
    execute: () => new Promise<void>((resolve, reject) => {
      const child = spawn(recipe.command, args, { cwd: recipe.cwd, shell: false, detached: true, stdio: 'ignore' });
      let polling = false;
      let closed = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (closed || stopped) return;
        stopped = true;
        if (child.pid && !closed) { try { process.kill(-child.pid, 'SIGTERM'); forceKill = setTimeout(() => { if (!closed) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ } } }, 5000); forceKill.unref(); } catch { /* already exited */ } }
      };
      const timer = setInterval(() => {
        if (polling || closed) return;
        polling = true;
        void getRow(client, options.work).then((current) => { if (current.generation !== row.generation || current.runId !== row.runId || current.visibleState !== 'RUNNING') stop(); }).catch(stop).finally(() => { polling = false; });
      }, 1000);
      child.once('error', () => { closed = true; clearInterval(timer); clearTimeout(forceKill);  reject(message('Executor could not start; reconcile the external effect before retrying.')); });
      child.once('close', (code) => { closed = true; clearInterval(timer); clearTimeout(forceKill);  if (code === 0 && !stopped) resolve(); else reject(message('Executor ended without a confirmed success; reconcile the external effect before retrying.')); });
    }),
  }).catch(async (error: unknown) => {
    if (stopped) {
      try { row = await getRow(client, options.work); await update(client, options.work, 'stop_ack', details()); } catch { /* Stop remains unknown when server authority cannot be checked. */ }
    }
    await writeFile(options.journal, JSON.stringify({ version: 1, workId: options.work, effectId: effect.id, sha: options.sha, state: 'UNKNOWN' }), { mode: 0o600 });
    throw error;
  });
  await writeFile(options.journal, JSON.stringify({ version: 1, workId: options.work, effectId: effect.id, sha: options.sha, state: 'COMMAND_EXITED_ZERO', receiptRequired: true }), { mode: 0o600 });
  process.stdout.write('Effect command exited successfully. Observe the deployed version and health, then submit a version 1 receipt; this is not production acceptance.\n');
}
export function registerExecutorCommand(program: Command, client: () => Promise<ExecutorTransport>) {
  program.command('executor-effect').description('Run a locally installed effect recipe with final Involute authorization and stop observation')
    .requiredOption('--work <uuid>', 'Implementation work UUID')
    .requiredOption('--execution-file <path>', 'Private work_id/run_id/claim_token file')
    .requiredOption('--recipe <path>', 'Locally installed JSON recipe')
    .requiredOption('--sha <sha>', 'Exact release or PR head SHA')
    .requiredOption('--key <key>', 'Stable effect idempotency key')
    .requiredOption('--journal <path>', 'New private durable journal file; must not already exist')
    .action(async (options: Options) => { try { await performExecutorEffect(await client(), options); } catch { throw message('Executor did not finish safely. Inspect its private journal and server dispatch; do not automatically repeat an unknown effect.'); } });
}
