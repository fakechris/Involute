import type { PrismaClient } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { createServer, type Server as HttpServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, createReadStream, statSync } from 'node:fs';

import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';

import { createAuthenticationPlugin, createGraphQLContext } from './auth.js';
import { getAllowedBrowserOrigins, handleAuthRoutes } from './auth-routes.js';
import { getExposedError } from './errors.js';
import type { GoogleOAuthConfiguration } from './google-oauth.js';
import { flushEventOutbox, parseWebhookTargets } from './event-outbox.js';
import { handleMcpRequest } from './mcp.js';
import { createGraphQLSchema } from './schema.js';
import { getServerEnvironment, loadServerEnvironment, type ServerEnvironment } from './environment.js';
import { getUploadsDirectory } from './uploads.js';

loadServerEnvironment();

export type { ServerEnvironment };

export interface StartServerOptions {
  appOrigin?: string;
  allowAdminFallback?: boolean;
  authToken?: string;
  googleOAuth?: Partial<GoogleOAuthConfiguration>;
  port?: number;
  prisma?: PrismaClient;
  sessionTtlSeconds?: number;
  viewerAssertionSecret?: string | null;
  webhookSecret?: string | null;
  webhookUrls?: string | null;
}

export interface StartedServer {
  httpServer: HttpServer;
  port: number;
  prisma: PrismaClient;
  stop: () => Promise<void>;
  url: string;
}

export { getServerEnvironment };

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const environment = getServerEnvironment();
  const prisma = options.prisma ?? new PrismaClientConstructor();
  const ownsPrismaClient = !options.prisma;

  if (ownsPrismaClient) {
    await prisma.$connect();
  }

  const yoga = createYoga({
    cors: {
      credentials: true,
      origin: getAllowedBrowserOrigins(options.appOrigin ?? environment.appOrigin),
    },
    context: async ({ request }) =>
      createGraphQLContext({
        allowAdminFallback: options.allowAdminFallback ?? environment.allowAdminFallback,
        request,
        prisma,
        authToken: options.authToken ?? environment.authToken,
        viewerAssertionSecret: options.viewerAssertionSecret ?? environment.viewerAssertionSecret,
      }),
    graphqlEndpoint: '/graphql',
    logging: false,
    maskedErrors: {
      maskError: (error, message) => {
        const exposedError = getExposedError(error);

        if (exposedError) {
          return exposedError;
        }

        return new GraphQLError(message);
      },
    },
    plugins: [createAuthenticationPlugin({
      allowAdminFallback: options.allowAdminFallback ?? environment.allowAdminFallback,
      authToken: options.authToken ?? environment.authToken,
      prisma,
      viewerAssertionSecret: options.viewerAssertionSecret ?? environment.viewerAssertionSecret,
    })],
    schema: createGraphQLSchema(prisma),
  });

  const googleOAuth = {
    adminEmails: options.googleOAuth?.adminEmails ?? environment.adminEmailAllowlist,
    appOrigin: options.googleOAuth?.appOrigin ?? options.appOrigin ?? environment.appOrigin,
    clientId: options.googleOAuth?.clientId ?? environment.googleOAuthClientId,
    clientSecret: options.googleOAuth?.clientSecret ?? environment.googleOAuthClientSecret,
    redirectUri: options.googleOAuth?.redirectUri ?? environment.googleOAuthRedirectUri,
    scopes: options.googleOAuth?.scopes ?? ['openid', 'email', 'profile'],
  } satisfies GoogleOAuthConfiguration;

  const uploadsDir = getUploadsDirectory();

  const httpServer = createServer((request, response) => {
    if (request.method === 'GET' && getPathname(request.url) === '/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('OK');
      return;
    }

    const pathname = getPathname(request.url);
    const mcpAuth = {
      allowAdminFallback: options.allowAdminFallback ?? environment.allowAdminFallback,
      authToken: options.authToken ?? environment.authToken,
      prisma,
      viewerAssertionSecret: options.viewerAssertionSecret ?? environment.viewerAssertionSecret,
    };

    if (request.method === 'GET' && pathname.startsWith('/uploads/')) {
      const filename = pathname.slice('/uploads/'.length);
      handleUploadDownload({
        auth: mcpAuth,
        filename,
        request,
        response,
        uploadsDir,
      }).catch((error: unknown) => {
        console.error('Failed to handle upload download request.');
        console.error(error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json; charset=utf-8');
        }
        response.end(JSON.stringify({ error: 'Internal server error' }));
      });
      return;
    }

    handleMcpRequest({
      ...mcpAuth,
      request,
      response,
    }).then((handledMcp) => {
      if (handledMcp) {
        return;
      }

      return handleAuthRoutes({
        ...mcpAuth,
        appOrigin: options.appOrigin ?? environment.appOrigin,
        googleOAuth,
        request,
        response,
        sessionTtlSeconds: options.sessionTtlSeconds ?? environment.sessionTtlSeconds,
      }).then((handled) => {
        if (handled) {
          return;
        }

        yoga(request, response);
      });
    }).catch((error: unknown) => {
      const exposedError = getExposedError(error);

      console.error('Failed to handle auth route request.');
      console.error(error);

      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        error: exposedError?.message ?? 'Internal server error',
      }));
    });

  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };

    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(options.port ?? environment.port);
  });

  const webhookTargets = parseWebhookTargets(
    options.webhookUrls ?? environment.webhookUrls,
    options.webhookSecret ?? environment.webhookSecret,
  );
  const outboxTimer =
    webhookTargets.length > 0
      ? setInterval(() => {
          void flushEventOutbox(prisma, webhookTargets).catch((error: unknown) => {
            console.error('Failed to flush event outbox.');
            console.error(error);
          });
        }, 2000)
      : null;
  outboxTimer?.unref();

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine the listening server address.');
  }

  return {
    httpServer,
    port: address.port,
    prisma,
    stop: async () => {
      if (outboxTimer) {
        clearInterval(outboxTimer);
      }

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      if (ownsPrismaClient) {
        await prisma.$disconnect();
      }
    },
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function handleUploadDownload(options: {
  auth: {
    allowAdminFallback: boolean;
    authToken: string;
    prisma: PrismaClient;
    viewerAssertionSecret: string | null;
  };
  filename: string;
  request: import('node:http').IncomingMessage;
  response: import('node:http').ServerResponse;
  uploadsDir: string;
}): Promise<void> {
  const { filename, request, response, uploadsDir } = options;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    response.statusCode = 400;
    response.end('Bad request');
    return;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  const context = await createGraphQLContext({
    ...options.auth,
    request: new Request(`http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`, {
      headers,
      method: 'GET',
    }),
  });
  if (context.authMode === 'none') {
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'Authentication required.' }));
    return;
  }

  const filePath = join(uploadsDir, filename);
  if (!existsSync(filePath)) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }
  const stat = statSync(filePath);
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
  };
  const ext = extname(filename).toLowerCase();
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('content-type', mimeTypes[ext] ?? 'application/octet-stream');
  response.setHeader('content-length', stat.size);
  createReadStream(filePath).pipe(response);
}

async function main(): Promise<void> {
  const environment = getServerEnvironment();
  const startedServer = await startServer({
    appOrigin: environment.appOrigin,
    allowAdminFallback: environment.allowAdminFallback,
    authToken: environment.authToken,
    port: environment.port,
  });

  console.log(`Involute GraphQL API listening on ${startedServer.url}/graphql`);
}

function getPathname(url: string | undefined): string {
  if (!url) {
    return '/';
  }

  const questionMarkIndex = url.indexOf('?');
  return questionMarkIndex === -1 ? url : url.slice(0, questionMarkIndex);
}

function isExecutedDirectly(): boolean {
  const entryFilePath = process.argv[1];

  if (!entryFilePath) {
    return false;
  }

  return fileURLToPath(import.meta.url) === resolve(entryFilePath);
}

if (isExecutedDirectly()) {
  main().catch((error: unknown) => {
    console.error('Failed to start the Involute GraphQL API server.');
    console.error(error);
    process.exitCode = 1;
  });
}
