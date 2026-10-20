import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from './constants.js';
import { parseAuthProviderIds } from './auth-providers/registry.js';
import { normalizeDatabaseUrl } from './database-url.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export interface ServerEnvironment {
  adminEmailAllowlist: string[];
  appOrigin: string;
  allowAdminFallback: boolean;
  /** Which sign-in lines this deployment offers (INV-1288). */
  authProviderIds: string[];
  databaseUrl: string;
  authToken: string;
  dingTalkAppKey: string | null;
  dingTalkAppSecret: string | null;
  dingTalkRedirectUri: string | null;
  dingTalkScopes: string[];
  googleOAuthClientId: string | null;
  googleOAuthClientSecret: string | null;
  googleOAuthRedirectUri: string | null;
  notificationEmail: NotificationEmailEnvironment;
  port: number;
  requireGoogleOAuth: boolean;
  sessionTtlSeconds: number;
  viewerAssertionSecret: string | null;
  webhookSecret: string | null;
  webhookUrls: string | null;
}

export interface NotificationEmailEnvironment {
  enabled: boolean;
  host: string | null;
  password: string | null;
  port: number;
  from: string | null;
  user: string | null;
}

export function getProjectEnvPath(): string {
  return resolve(currentDirectory, '../../../.env');
}

export function loadServerEnvironment(): void {
  loadDotenv({
    path: getProjectEnvPath(),
  });

  if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
  }
}

export function getServerEnvironment(env: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  const allowAdminFallback = env.ALLOW_ADMIN_FALLBACK === 'true';
  const nodeEnvironment = env.NODE_ENV ?? 'development';
  const requireGoogleOAuth = env.REQUIRE_GOOGLE_OAUTH === 'true';
  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30);
  const adminEmailAllowlist = (env.ADMIN_EMAIL_ALLOWLIST ?? env.GOOGLE_OAUTH_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const googleOAuthClientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() || null;
  const googleOAuthClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || null;
  const googleOAuthRedirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || null;
  const dingTalkAppKey = env.DINGTALK_APP_KEY?.trim() || null;
  const dingTalkAppSecret = env.DINGTALK_APP_SECRET?.trim() || null;
  const dingTalkRedirectUri = env.DINGTALK_REDIRECT_URI?.trim() || null;
  const dingTalkScopes = (env.DINGTALK_SCOPES ?? 'corpid')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const webhookSecret = env.INVOLUTE_WEBHOOK_SECRET?.trim() || null;
  const webhookUrls = env.INVOLUTE_WEBHOOK_URL?.trim() || null;
  const notificationEmail: NotificationEmailEnvironment = {
    enabled: env.NOTIFICATION_EMAIL_ENABLED === 'true',
    from: env.NOTIFICATION_EMAIL_FROM?.trim() || null,
    host: env.NOTIFICATION_EMAIL_SMTP_HOST?.trim() || null,
    password: env.NOTIFICATION_EMAIL_SMTP_PASSWORD?.trim() || null,
    port: Number(env.NOTIFICATION_EMAIL_SMTP_PORT ?? 587),
    user: env.NOTIFICATION_EMAIL_SMTP_USER?.trim() || null,
  };
  if (notificationEmail.enabled && (!notificationEmail.host || !notificationEmail.from)) {
    throw new Error(
      'NOTIFICATION_EMAIL_ENABLED=true requires NOTIFICATION_EMAIL_SMTP_HOST and NOTIFICATION_EMAIL_FROM.',
    );
  }

  if (allowAdminFallback && nodeEnvironment !== 'development' && nodeEnvironment !== 'test') {
    throw new Error('ALLOW_ADMIN_FALLBACK=true is only supported in development or test environments.');
  }

  if (requireGoogleOAuth && (!googleOAuthClientId || !googleOAuthClientSecret || !googleOAuthRedirectUri)) {
    throw new Error(
      'REQUIRE_GOOGLE_OAUTH=true requires GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
    );
  }

  const authProviderIds = parseAuthProviderIds(env.AUTH_PROVIDERS);

  // A provider that is asked for but not configured is a misconfiguration, not a
  // silent no-op: the person would see no button and think the workspace is broken.
  // Only an explicit AUTH_PROVIDERS is a request; the default stays forgiving so
  // a server without Google keeps working exactly as it did before INV-1288.
  if (env.AUTH_PROVIDERS?.trim()) {
    if (authProviderIds.includes('dingtalk') && (!dingTalkAppKey || !dingTalkAppSecret || !dingTalkRedirectUri)) {
      throw new Error(
        'AUTH_PROVIDERS includes dingtalk, which requires DINGTALK_APP_KEY, DINGTALK_APP_SECRET, and DINGTALK_REDIRECT_URI.',
      );
    }

    if (authProviderIds.includes('google') && (!googleOAuthClientId || !googleOAuthClientSecret || !googleOAuthRedirectUri)) {
      throw new Error(
        'AUTH_PROVIDERS includes google, which requires GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
      );
    }
  }

  if (authProviderIds.length === 0) {
    throw new Error('AUTH_PROVIDERS must name at least one sign-in line (google, dingtalk).');
  }

  if (Boolean(webhookSecret) !== Boolean(webhookUrls)) {
    throw new Error('INVOLUTE_WEBHOOK_URL and INVOLUTE_WEBHOOK_SECRET must be configured together.');
  }

  return {
    adminEmailAllowlist,
    appOrigin: env.APP_ORIGIN?.trim() || 'http://localhost:4201',
    allowAdminFallback,
    authProviderIds,
    databaseUrl: env.DATABASE_URL ?? '',
    authToken: env.AUTH_TOKEN ?? '',
    dingTalkAppKey,
    dingTalkAppSecret,
    dingTalkRedirectUri,
    dingTalkScopes,
    googleOAuthClientId,
    googleOAuthClientSecret,
    googleOAuthRedirectUri,
    notificationEmail,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    requireGoogleOAuth,
    sessionTtlSeconds: Number.isFinite(sessionTtlSeconds) && sessionTtlSeconds > 0
      ? Math.trunc(sessionTtlSeconds)
      : 60 * 60 * 24 * 30,
    viewerAssertionSecret: env.VIEWER_ASSERTION_SECRET?.trim() || null,
    webhookSecret,
    webhookUrls,
  };
}
