#!/usr/bin/env node
/**
 * Claude Code `UserPromptSubmit` hook for Involute (INV-1247).
 *
 * At the start of a user turn, queries the read-only MCP endpoint
 * (`/mcp/readonly`) for `agent_inbox` unread decisions without marking any
 * notification read.
 *
 * - When unread decisions exist: prints a single-line `additionalContext`
 *   JSON payload for Claude Code (`hookSpecificOutput.hookEventName =
 *   "UserPromptSubmit"`) and exits 0.
 * - When no unread decisions exist, credentials are absent, or the server is
 *   unreachable / times out (<= 2s): outputs 0 bytes and exits 0.
 * - Never writes or logs credentials.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TIMEOUT_MS = 2000;
const DEFAULT_TIMEOUT_MS = 1800;

/**
 * Normalize an Involute MCP URL so the hook always queries `/mcp/readonly`.
 */
export function toReadonlyMcpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return null;
  }
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/mcp/readonly')) {
    return trimmed;
  }
  if (trimmed.endsWith('/mcp')) {
    return `${trimmed}/readonly`;
  }
  return trimmed;
}

function extractAuthHeader(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const headers = entry.headers ?? entry.http_headers;
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const auth = headers.Authorization ?? headers.authorization;
  return typeof auth === 'string' && auth.trim() ? auth.trim() : null;
}

function pickServerEntry(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object') {
    return null;
  }
  const candidate = mcpServers['involute-readonly'] ?? mcpServers.involute;
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const url = toReadonlyMcpUrl(candidate.url ?? candidate.serverUrl);
  const authHeader = extractAuthHeader(candidate);
  if (!url || !authHeader) {
    return null;
  }
  return { url, authHeader };
}

/**
 * Resolve Involute MCP URL and Authorization header from environment overrides
 * or the user-level `~/.claude.json` configuration.
 */
export function resolveInvoluteHookConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const envUrl = toReadonlyMcpUrl(env.INVOLUTE_MCP_URL);
  const envAuth =
    typeof env.INVOLUTE_AUTH_HEADER === 'string' && env.INVOLUTE_AUTH_HEADER.trim()
      ? env.INVOLUTE_AUTH_HEADER.trim()
      : typeof env.INVOLUTE_AGENT_TOKEN === 'string' && env.INVOLUTE_AGENT_TOKEN.trim()
        ? `Bearer ${env.INVOLUTE_AGENT_TOKEN.trim().replace(/^Bearer\s+/i, '')}`
        : null;

  if (envUrl && envAuth) {
    return { url: envUrl, authHeader: envAuth };
  }

  const configPath =
    options.configPath ??
    (typeof env.INVOLUTE_CLAUDE_CONFIG === 'string' && env.INVOLUTE_CLAUDE_CONFIG.trim()
      ? env.INVOLUTE_CLAUDE_CONFIG.trim()
      : join(homedir(), '.claude.json'));

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const projectEntry =
        parsed.projects && typeof parsed.projects === 'object' && parsed.projects[cwd]
          ? pickServerEntry(parsed.projects[cwd].mcpServers)
          : null;
      if (projectEntry) {
        return projectEntry;
      }
      const globalEntry = pickServerEntry(parsed.mcpServers);
      if (globalEntry) {
        return globalEntry;
      }
    }
  } catch {
    // Missing or unreadable config: fail silently.
  }

  return null;
}

/**
 * Format a 1-line summary for unread decisions.
 */
export function formatUnreadDecisionsLine(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return null;
  }
  const count = notifications.length;
  const latest = notifications[0] ?? {};
  const identifier = latest.work_identifier || latest.identifier || latest.work_id || 'work';
  const type = latest.type || 'decision';
  const rawTime = latest.created_at || latest.at || '';
  const hhmm = typeof rawTime === 'string' && rawTime.includes('T') ? rawTime.slice(11, 16) : '';
  const latestDesc = `${identifier} ${type}${hhmm ? ` ${hhmm}` : ''}`;
  return `Involute: ${count} unread ${count === 1 ? 'decision' : 'decisions'} (latest ${latestDesc}) — read agent_inbox before stating any status.`;
}

/**
 * Query Involute `/mcp/readonly` `agent_inbox` and return the Claude Code hook
 * stdout string (or `""` when there are no unread decisions or any error occurs).
 */
export async function runInvoluteInboxHook(options = {}) {
  const env = options.env ?? process.env;
  const config = resolveInvoluteHookConfig(options);
  if (!config) {
    return '';
  }

  const rawTimeout = Number(options.timeoutMs ?? env.INVOLUTE_HOOK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: config.authHeader,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'involute-inbox-hook',
        method: 'tools/call',
        params: {
          name: 'agent_inbox',
          arguments: { first: 50 },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return '';
    }

    const rpc = await response.json();
    const text = rpc?.result?.content?.[0]?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return '';
    }

    const inbox = JSON.parse(text);
    const line = formatUnreadDecisionsLine(inbox?.notifications);
    if (!line) {
      return '';
    }

    if (options.format === 'text' || env.INVOLUTE_HOOK_FORMAT === 'text') {
      return `${line}\n`;
    }

    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: line,
      },
    })}\n`;
  } catch {
    return '';
  }
}

async function main() {
  // Drain stdin non-blockingly if piped by Claude Code, but never wait on it.
  if (!process.stdin.isTTY) {
    process.stdin.on('error', () => {});
    process.stdin.resume();
  }
  const output = await runInvoluteInboxHook();
  if (output) {
    process.stdout.write(output);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
