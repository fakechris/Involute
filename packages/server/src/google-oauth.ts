import type { PrismaClient } from '@prisma/client';

export interface GoogleOAuthConfiguration {
  adminEmails: string[];
  appOrigin: string;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
  scopes: string[];
}

export interface GoogleOAuthUserProfile {
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
  subject: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}

interface GoogleUserInfoResponse {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub?: string;
}

const GOOGLE_AUTH_BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USER_INFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function isGoogleOAuthConfigured(configuration: GoogleOAuthConfiguration): boolean {
  return Boolean(
    configuration.clientId &&
      configuration.clientSecret &&
      configuration.redirectUri,
  );
}

export function buildGoogleAuthorizationUrl(
  configuration: GoogleOAuthConfiguration,
  state: string,
): string {
  if (!isGoogleOAuthConfigured(configuration)) {
    throw new Error('Google OAuth is not configured.');
  }

  const url = new URL(GOOGLE_AUTH_BASE_URL);
  url.searchParams.set('client_id', configuration.clientId!);
  url.searchParams.set('redirect_uri', configuration.redirectUri!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', configuration.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account');

  return url.toString();
}

export async function exchangeGoogleCodeForUserProfile(
  code: string,
  configuration: GoogleOAuthConfiguration,
): Promise<GoogleOAuthUserProfile> {
  if (!isGoogleOAuthConfigured(configuration)) {
    throw new Error('Google OAuth is not configured.');
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: configuration.clientId!,
      client_secret: configuration.clientSecret!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: configuration.redirectUri!,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenPayload = (await tokenResponse.json()) as GoogleTokenResponse;

  if (!tokenPayload.access_token) {
    throw new Error('Google token exchange did not return an access token.');
  }

  const userInfoResponse = await fetch(GOOGLE_USER_INFO_URL, {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
    },
  });

  if (!userInfoResponse.ok) {
    throw new Error(`Google user info request failed with status ${userInfoResponse.status}.`);
  }

  const userInfo = (await userInfoResponse.json()) as GoogleUserInfoResponse;

  if (!userInfo.email || !userInfo.sub || !userInfo.name) {
    throw new Error('Google user info response is missing required fields.');
  }

  return {
    email: userInfo.email.toLowerCase(),
    emailVerified: Boolean(userInfo.email_verified),
    name: userInfo.name,
    picture: userInfo.picture ?? null,
    subject: userInfo.sub,
  };
}

export async function upsertGoogleOAuthUser(
  prisma: PrismaClient,
  profile: GoogleOAuthUserProfile,
  configuration: GoogleOAuthConfiguration,
): Promise<{ email: string; id: string; name: string }> {
  if (!profile.emailVerified) {
    throw new Error('Google account email must be verified.');
  }

  const isAdminEmail = configuration.adminEmails.includes(profile.email);
  const existingBySubject = await prisma.user.findFirst({
    where: {
      googleSubject: profile.subject,
    },
  });

  if (existingBySubject) {
    return prisma.user.update({
      where: {
        id: existingBySubject.id,
      },
      data: {
        avatarUrl: profile.picture,
        email: profile.email,
        globalRole: isAdminEmail ? 'ADMIN' : existingBySubject.globalRole,
        name: profile.name,
      },
      select: {
        email: true,
        id: true,
        name: true,
      },
    });
  }

  const existingByEmail = await prisma.user.findUnique({
    where: {
      email: profile.email,
    },
  });

  if (existingByEmail) {
    return prisma.user.update({
      where: {
        id: existingByEmail.id,
      },
      data: {
        avatarUrl: profile.picture,
        globalRole: isAdminEmail ? 'ADMIN' : existingByEmail.globalRole,
        googleSubject: profile.subject,
        name: profile.name,
      },
      select: {
        email: true,
        id: true,
        name: true,
      },
    });
  }

  return prisma.user.create({
    data: {
      avatarUrl: profile.picture,
      email: profile.email,
      globalRole: isAdminEmail ? 'ADMIN' : 'USER',
      googleSubject: profile.subject,
      name: profile.name,
    },
    select: {
      email: true,
      id: true,
      name: true,
    },
  });
}
