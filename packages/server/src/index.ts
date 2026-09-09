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
import { handleDocsRoutes } from './docs-routes.js';
import { getExposedError } from './errors.js';
import type { GoogleOAuthConfiguration } from './google-oauth.js';
import { collectOutboundWebhookTargets, flushEventOutbox } from './event-outbox.js';
import {
  createNotificationEmailSender,
  isNotificationEmailReady,
  processNotificationEmails,
  sweepStaleNotifications,
} from './notification-email.js';
import { handleMcpRequest } from './mcp.js';
import {
  getRateLimitOptions,
  requestIdentityKey,
  TokenBucketRateLimiter,
  type RateLimitOptions,
} from './rate-limit.js';
import { createGraphQLSchema } from './schema.js';
import { getServerEnvironment, loadServerEnvironment, type ServerEnvironment } from './environment.js';
import { getUploadsDirectory } from './uploads.js';
import { handleWebStatic } from './web-static.js';
import { handleGitHubWebhook } from './github-webhook-handler.js';

loadServerEnvironment();

export type { ServerEnvironment };

// 10MB upload cap (decoded) + base64/JSON overhead headroom.
export const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

export interface StartServerOptions {
  appOrigin?: string;
  /** Serve the built web app from the API process (single-container deploys). */
  webDistDir?: string | null;
  /** Per-identity token-bucket limits on /graphql, /mcp*, and /auth/*. */
  rateLimit?: RateLimitOptions | null;
  allowAdminFallback?: boolean;
  authToken?: string;
  googleOAuth?: Partial<GoogleOAuthConfiguration>;
  port?: number;
  prisma?: PrismaClient;
  sessionTtlSeconds?: number;
  uploadsDir?: string;
  viewerAssertionSecret?: string | null;
  webhookSecret?: string | null;
  webhookUrls?: string | null;
  /** HMAC secret for verifying incoming GitHub webhook signatures */
  githubWebhookSecret?: string | null;
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

  const uploadsDir = options.uploadsDir ?? getUploadsDirectory();
  const rateLimitOptions =
    'rateLimit' in options ? options.rateLimit : getRateLimitOptions();
  const rateLimiter = rateLimitOptions?.enabled
    ? new TokenBucketRateLimiter(rateLimitOptions)
    : null;

  const httpServer = createServer(async (request, response) => {
    if (request.method === 'GET' && getPathname(request.url) === '/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('OK');
      return;
    }

    // Readiness: unlike /health (process liveness, always 200), /ready pings
    // the database so orchestrators and prod-smoke can distinguish "up" from
    // "up and able to serve work".
    if (request.method === 'GET' && getPathname(request.url) === '/ready') {
      try {
        await prisma.$queryRaw`SELECT 1`;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ database: 'ok', status: 'ready' }));
      } catch (error: unknown) {
        console.error('Readiness check failed.');
        console.error(error);
        response.statusCode = 503;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ database: 'unavailable', status: 'not-ready' }));
      }
      return;
    }

    // Per-identity rate limit on state-changing/API surfaces. GETs (docs,
    // health, uploads) stay unlimited; the bucket keys on bearer/session
    // identity, falling back to the remote address for anonymous probes.
    if (
      rateLimiter &&
      (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH')
    ) {
      const limitedPath = getPathname(request.url);
      if (
        limitedPath === '/graphql' ||
        limitedPath.startsWith('/mcp') ||
        limitedPath.startsWith('/auth/')
      ) {
        const decision = rateLimiter.take(requestIdentityKey(request));
        if (!decision.allowed) {
          response.statusCode = 429;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.setHeader('retry-after', String(decision.retryAfterSeconds));
          response.end(JSON.stringify({ error: 'Rate limit exceeded. Retry later.' }));
          return;
        }
      }
    }

    // HTTP-level body cap before Yoga/MCP parse anything: uploads top out at
    // 10MB decoded (~13.4MB base64 + JSON envelope), so 20MB leaves headroom
    // while bounding unauthenticated allocation. Chunked bodies without a
    // declared length bypass this check and rely on the resolver-level cap.
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
      const declaredLength = Number(request.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
        response.statusCode = 413;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Request body too large.' }));
        return;
      }
    }

    const pathname = getPathname(request.url);

    // GitHub webhook endpoint — must be before docs/MCP routes to avoid
    // body consumption conflicts. Only active when a secret is configured.
    const ghWebhookSecret = options.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
    if (ghWebhookSecret && pathname.startsWith('/api/webhooks/github')) {
      handleGitHubWebhook({ prisma, webhookSecret: ghWebhookSecret }, request, response)
        .catch((error: unknown) => {
          console.error('[github-webhook] Unhandled error in webhook handler:', error);
          if (!response.headersSent) {
            response.statusCode = 200;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ ok: true }));
          }
        });
      return;
    }

    if (
      request.method === 'GET' &&
      (pathname === '/llms.txt' || pathname === '/llms-full.txt' || pathname.startsWith('/docs/'))
    ) {
      handleDocsRoutes({ request, response }).catch((error: unknown) => {
        console.error('Failed to handle docs route request.');
        console.error(error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        response.end('Internal server error');
      });
      return;
    }

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

        const webDistDir = options.webDistDir ?? process.env.INVOLUTE_WEB_DIST;
        if (
          webDistDir &&
          request.method === 'GET' &&
          pathname !== '/graphql'
        ) {
          handleWebStatic(webDistDir, pathname, response);
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

  // Subscriptions are resolved on every tick so CRUD changes apply without a
  // restart; with zero subscriptions the legacy env pair is the fallback.
  const outboxTimer = setInterval(() => {
    void (async () => {
      try {
        const webhookTargets = await collectOutboundWebhookTargets(
          prisma,
          options.webhookUrls ?? environment.webhookUrls,
          options.webhookSecret ?? environment.webhookSecret,
        );
        if (webhookTargets.length > 0) {
          await flushEventOutbox(prisma, webhookTargets);
        }
      } catch (error: unknown) {
        console.error('Failed to flush event outbox.');
        console.error(error);
      }
    })();
  }, 10_000);
  outboxTimer?.unref();

  // Email digests only run when SMTP is explicitly configured; the in-app
  // notification surface works without any mail infrastructure.
  let emailTimer: NodeJS.Timeout | undefined;
  const notificationEmailRuntime = {
    appOrigin: options.appOrigin ?? environment.appOrigin,
    email: environment.notificationEmail,
  };
  if (isNotificationEmailReady(notificationEmailRuntime)) {
    const sender = createNotificationEmailSender(notificationEmailRuntime.email);
    emailTimer = setInterval(() => {
      void processNotificationEmails(prisma, notificationEmailRuntime, sender).catch(
        (error: unknown) => {
          console.error('Failed to process notification emails.');
          console.error(error);
        },
      );
    }, 30_000);
    emailTimer?.unref();
  }

  // Daily retention sweep: read notifications older than 90 days and unread
  // notifications older than 180 days are removed.
  let retentionTimer: NodeJS.Timeout | undefined;
  retentionTimer = setInterval(() => {
    void sweepStaleNotifications(prisma).catch((error: unknown) => {
      console.error('Failed to sweep stale notifications.');
      console.error(error);
    });
  }, 24 * 60 * 60_000);
  retentionTimer?.unref();

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
      if (emailTimer) {
        clearInterval(emailTimer);
      }
      if (retentionTimer) {
        clearInterval(retentionTimer);
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

  // Uploads are unguessable (random UUID filenames) but must still be
  // authorization-checked: files without a database row are never served,
  // trusted token bearers (CLI/server-to-server, full API access already) may
  // fetch any recorded upload, while session/agent viewers must be the
  // uploader, an admin, or a reader of the linked issue/comment team.
  const attachment = await options.auth.prisma.attachment.findFirst({
    where: { url: `/uploads/${filename}` },
    include: { comment: { select: { issueId: true } },
      issue: { select: { teamId: true } } },
  });
  if (!attachment) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }
  const viewer = context.viewer;
  const isOwner = viewer && attachment.uploaderId === viewer.id;
  const isAdmin = viewer?.globalRole === 'ADMIN';
  if (context.authMode !== 'token' && !isOwner && !isAdmin) {
    const issueId = attachment.issueId ?? attachment.comment?.issueId ?? null;
    if (!issueId) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }
    const issue = await options.auth.prisma.issue.findUnique({
      where: { id: issueId },
      select: { teamId: true },
    });
    if (!issue) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }
    try {
      const { assertCanReadTeam } = await import('./access-control.js');
      await assertCanReadTeam(options.auth.prisma, context, issue.teamId);
    } catch {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }
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
    '.gif': 'image/gif', '.webp': 'image/webp',
  };
  const ext = extname(filename).toLowerCase();
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('content-security-policy', "sandbox; default-src 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-type', mimeTypes[ext] ?? 'application/octet-stream');
  if (!(ext in mimeTypes)) {
    response.setHeader('content-disposition', 'attachment');
  }
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
