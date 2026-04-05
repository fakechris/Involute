import type { PrismaClient } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { createServer, type Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';

import { createAuthenticationPlugin, createGraphQLContext } from './auth.js';
import { getAllowedBrowserOrigins, handleAuthRoutes } from './auth-routes.js';
import { getExposedError } from './errors.js';
import type { GoogleOAuthConfiguration } from './google-oauth.js';
import { createGraphQLSchema } from './schema.js';
import { getServerEnvironment, loadServerEnvironment, type ServerEnvironment } from './environment.js';

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

  const httpServer = createServer((request, response) => {
    if (request.method === 'GET' && getPathname(request.url) === '/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('OK');
      return;
    }

    handleAuthRoutes({
      allowAdminFallback: options.allowAdminFallback ?? environment.allowAdminFallback,
      appOrigin: options.appOrigin ?? environment.appOrigin,
      authToken: options.authToken ?? environment.authToken,
      googleOAuth,
      prisma,
      request,
      response,
      sessionTtlSeconds: options.sessionTtlSeconds ?? environment.sessionTtlSeconds,
      viewerAssertionSecret: options.viewerAssertionSecret ?? environment.viewerAssertionSecret,
    }).then((handled) => {
      if (handled) {
        return;
      }

      yoga(request, response);
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

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine the listening server address.');
  }

  return {
    httpServer,
    port: address.port,
    prisma,
    stop: async () => {
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
