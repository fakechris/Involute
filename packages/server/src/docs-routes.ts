import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildProtocolGuide } from './protocol-docs.js';

const DOC_FILE_ALLOWLIST = new Set([
  'api.md',
  'agent-setup.md',
  'ops.md',
  'milestones.md',
  'vision.md',
]);

const MAX_DOC_BYTES = 1024 * 1024;

export interface DocsRouteOptions {
  docsDir?: string;
  request: IncomingMessage;
  response: ServerResponse;
}

export async function handleDocsRoutes(options: DocsRouteOptions): Promise<boolean> {
  if (options.request.method !== 'GET') {
    return false;
  }

  const pathname = getPathname(options.request.url);

  if (pathname === '/llms.txt') {
    respondWithMarkdown(options.response, buildLlmsIndex());
    return true;
  }

  if (pathname === '/llms-full.txt') {
    respondWithMarkdown(options.response, await buildLlmsFullText(options.docsDir));
    return true;
  }

  if (pathname.startsWith('/docs/')) {
    const name = pathname.slice('/docs/'.length);

    if (!DOC_FILE_ALLOWLIST.has(name)) {
      respondNotFound(options.response);
      return true;
    }

    const content = await readDocFile(name, options.docsDir);

    if (content === null) {
      respondNotFound(options.response);
      return true;
    }

    respondWithMarkdown(options.response, content);
    return true;
  }

  return false;
}

function buildLlmsIndex(): string {
  return `# Involute

> Agent-native project-state and work-graph kernel. Involute stores long-lived
> work identity, contracts, typed links, status, decisions, and evidence.
> Codex, Claude Code, and other agents are the primary entrypoints; the kanban
> web app is an optional observation and governance surface.

Machine-readable documentation for agents and automation.

## Protocol

- [Work protocol guide](/llms-full.txt): kernel rules, state machines, scopes,
  MCP tools, webhook events, and the IQL query language.

## Reference docs

- [API reference](/docs/api.md): HTTP and GraphQL surface
- [Agent setup](/docs/agent-setup.md): per-client MCP configuration and tokens
- [Operations](/docs/ops.md): deploy, backup, restore, smoke checks
- [Milestones](/docs/milestones.md) and [vision](/docs/vision.md)

## Quick start

Connect an agent:

    codex mcp add involute --url <server-origin>/mcp

Then call the \`protocol_get_guide\` MCP tool before writing any work.
`;
}

async function buildLlmsFullText(docsDir?: string): Promise<string> {
  const sections: string[] = [buildProtocolGuide()];

  for (const name of DOC_FILE_ALLOWLIST) {
    const content = await readDocFile(name, docsDir);

    if (content !== null) {
      sections.push(`\n---\n\n# Source: /docs/${name}\n\n${content}`);
    }
  }

  return sections.join('\n');
}

function getDocsDirectory(explicitDir?: string): string {
  if (explicitDir) {
    return explicitDir;
  }

  if (process.env.INVOLUTE_DOCS_DIR) {
    return process.env.INVOLUTE_DOCS_DIR;
  }

  // dist layout: packages/server/dist -> repo-root docs/.
  // tsx layout: packages/server/src -> repo-root docs/.
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../docs');
}

async function readDocFile(name: string, docsDir?: string): Promise<string | null> {
  if (!DOC_FILE_ALLOWLIST.has(name)) {
    return null;
  }

  try {
    const content = await readFile(join(getDocsDirectory(docsDir), name), 'utf8');

    if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) {
      return null;
    }

    return content;
  } catch {
    return null;
  }
}

function respondWithMarkdown(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/markdown; charset=utf-8');
  response.setHeader('cache-control', 'public, max-age=300');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(body);
}

function respondNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end('Not found');
}

function getPathname(url: string | undefined): string {
  if (!url) {
    return '/';
  }

  const questionMarkIndex = url.indexOf('?');
  return questionMarkIndex === -1 ? url : url.slice(0, questionMarkIndex);
}
