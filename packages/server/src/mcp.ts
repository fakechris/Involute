import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { createGraphQLContext, type GraphQLContextOptions } from './auth.js';
import { getExposedError, NOT_AUTHENTICATED_MESSAGE } from './errors.js';
import { callMcpTool, listMcpTools } from './mcp-tools.js';

const PROTOCOL_VERSION = '2025-03-26';

export interface McpHandlerOptions extends Omit<GraphQLContextOptions, 'request'> {
  request: IncomingMessage;
  response: ServerResponse;
}

export async function handleMcpRequest(options: McpHandlerOptions): Promise<boolean> {
  const pathname = getPathname(options.request.url);
  const readonly = pathname === '/mcp/readonly';

  if (pathname !== '/mcp' && !readonly) {
    return false;
  }

  if (options.request.method === 'OPTIONS') {
    options.response.statusCode = 204;
    options.response.setHeader('access-control-allow-origin', '*');
    options.response.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id');
    options.response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    options.response.end();
    return true;
  }

  if (options.request.method !== 'POST') {
    options.response.statusCode = 405;
    options.response.setHeader('allow', 'POST, OPTIONS');
    options.response.setHeader('content-type', 'application/json; charset=utf-8');
    options.response.end(JSON.stringify({ error: 'MCP endpoints accept POST JSON-RPC only.' }));
    return true;
  }

  const rawBody = await readRequestBody(options.request);
  const fetchRequest = toFetchRequest(options.request, rawBody);
  const contextOptions: GraphQLContextOptions = {
    authToken: options.authToken,
    prisma: options.prisma,
    request: fetchRequest,
  };
  if (options.allowAdminFallback !== undefined) {
    contextOptions.allowAdminFallback = options.allowAdminFallback;
  }
  if (options.viewerAssertionSecret !== undefined) {
    contextOptions.viewerAssertionSecret = options.viewerAssertionSecret;
  }
  const context = await createGraphQLContext(contextOptions);

  if (context.authMode === 'none') {
    writeJson(options.response, 401, jsonRpcError(null, -32001, NOT_AUTHENTICATED_MESSAGE));
    return true;
  }

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    writeJson(options.response, 400, jsonRpcError(null, -32700, 'Parse error'));
    return true;
  }

  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    writeJson(options.response, 400, jsonRpcError(message?.id ?? null, -32600, 'Invalid request'));
    return true;
  }

  if (message.id === undefined || message.id === null) {
    options.response.statusCode = 202;
    options.response.end();
    return true;
  }

  try {
    const result = await dispatchMcpMethod(context.prisma, context, message, readonly);
    writeJson(options.response, 200, { jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    const exposed = getExposedError(error);
    const rpcError = jsonRpcError(
      message.id,
      -32000,
      exposed?.message ?? (error instanceof Error ? error.message : 'Internal error'),
    );
    const status = exposed?.extensions.code === 'UNAUTHENTICATED' ? 401 : 200;
    writeJson(options.response, status, rpcError);
  }

  return true;
}

async function dispatchMcpMethod(
  _prisma: PrismaClient,
  context: Awaited<ReturnType<typeof createGraphQLContext>>,
  message: JsonRpcRequest,
  readonly: boolean,
): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'involute',
          version: '0.0.0',
        },
        instructions:
          'Involute is a project-state kernel. Search before creating work. Propose candidates instead of committed issues. Do not file local TODOs. Run complete is not work accepted.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: listMcpTools(readonly).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case 'tools/call': {
      const params = (message.params ?? {}) as { arguments?: Record<string, unknown>; name?: string };
      if (!params.name) {
        throw new Error('tools/call requires params.name');
      }
      const result = await callMcpTool(context, params.name, params.arguments ?? {}, readonly);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, jsonReplacer, 2),
          },
        ],
      };
    }
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}

interface JsonRpcRequest {
  id?: number | string | null;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('access-control-allow-origin', '*');
  response.end(JSON.stringify(body));
}

function getPathname(url: string | undefined): string {
  if (!url) {
    return '/';
  }

  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return url.split('?')[0] ?? '/';
  }
}

function toFetchRequest(request: IncomingMessage, body: string): Request {
  const host = request.headers.host ?? '127.0.0.1';
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    }
  }

  const init: RequestInit = {
    method: request.method ?? 'POST',
    headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = body;
  }
  return new Request(`http://${host}${request.url ?? '/'}`, init);
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}
