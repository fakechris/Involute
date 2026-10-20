/**
 * The DingTalk sign-in line (INV-1288), as an auth provider.
 *
 * DingTalk's enterprise app QR login: the browser goes to `login.dingtalk.com`,
 * the person scans, DingTalk calls back with a `code`, and the server trades
 * that code for the person's own profile.
 *
 *   ① POST /v1.0/oauth2/userAccessToken  — app credentials + code → access token
 *   ② GET  /v1.0/contact/users/me        — access token → the person
 *
 * `unionId` is the identity: it is stable across every app in the same corp,
 * so one DingTalk person is one Involute person. `openId` is per-app and is
 * deliberately not used as the subject.
 *
 * The workspace keys people by email (docs/permissions.md §1), so a person
 * without a verified email cannot be admitted; the refusal says so plainly.
 */

import type { AuthProvider, AuthProviderProfile } from './types.js';

export interface DingTalkConfiguration {
  appKey: string | null;
  appSecret: string | null;
  redirectUri: string | null;
  /** OAuth scopes; DingTalk's QR login asks for `corpid`. */
  scopes: string[];
}

const DINGTALK_AUTHORIZATION_URL = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DINGTALK_USER_INFO_URL = 'https://api.dingtalk.com/v1.0/contact/users/me';
const DINGTALK_FETCH_TIMEOUT_MS = 10_000;

export const DINGTALK_EMAIL_REQUIRED_MESSAGE =
  'This DingTalk account has no email address. Add one in DingTalk, or ask an admin to invite you by email.';

interface DingTalkTokenResponse {
  accessToken?: string;
  code?: string;
  expireIn?: number;
  message?: string;
}

interface DingTalkUserResponse {
  avatarUrl?: string;
  code?: string;
  email?: string;
  message?: string;
  nick?: string;
  openId?: string;
  unionId?: string;
}

export function isDingTalkConfigured(configuration: DingTalkConfiguration): boolean {
  return Boolean(
    configuration.appKey && configuration.appSecret && configuration.redirectUri,
  );
}

export function createDingTalkAuthProvider(configuration: DingTalkConfiguration): AuthProvider {
  return {
    id: 'dingtalk',
    label: '钉钉登录',
    isConfigured: () => isDingTalkConfigured(configuration),
    buildAuthorizationUrl: (state) => {
      if (!isDingTalkConfigured(configuration)) {
        throw new Error('DingTalk sign-in is not configured.');
      }

      const url = new URL(DINGTALK_AUTHORIZATION_URL);
      url.searchParams.set('redirect_uri', configuration.redirectUri!);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', configuration.appKey!);
      url.searchParams.set('scope', configuration.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('prompt', 'consent');

      return url.toString();
    },
    completeSignIn: (code) => exchangeDingTalkCodeForUserProfile(code, configuration),
  };
}

export async function exchangeDingTalkCodeForUserProfile(
  code: string,
  configuration: DingTalkConfiguration,
): Promise<AuthProviderProfile> {
  if (!isDingTalkConfigured(configuration)) {
    throw new Error('DingTalk sign-in is not configured.');
  }

  const tokenResponse = await fetch(DINGTALK_TOKEN_URL, {
    signal: AbortSignal.timeout(DINGTALK_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      clientId: configuration.appKey,
      clientSecret: configuration.appSecret,
      code,
      grantType: 'authorization_code',
    }),
  });

  const tokenPayload = (await readJson(tokenResponse)) as DingTalkTokenResponse;

  if (!tokenResponse.ok || !tokenPayload.accessToken) {
    throw new Error(
      `DingTalk token exchange failed${
        tokenPayload.message ? `: ${tokenPayload.message}` : ` (status ${tokenResponse.status})`
      }.`,
    );
  }

  const userResponse = await fetch(DINGTALK_USER_INFO_URL, {
    signal: AbortSignal.timeout(DINGTALK_FETCH_TIMEOUT_MS),
    headers: {
      'x-acs-dingtalk-access-token': tokenPayload.accessToken,
    },
  });

  const userPayload = (await readJson(userResponse)) as DingTalkUserResponse;

  if (!userResponse.ok || (userPayload.code && userPayload.code !== '0')) {
    throw new Error(
      `DingTalk user info request failed${
        userPayload.message ? `: ${userPayload.message}` : ` (status ${userResponse.status})`
      }.`,
    );
  }

  if (!userPayload.unionId) {
    throw new Error('DingTalk user info response is missing unionId.');
  }

  const email = userPayload.email?.trim().toLowerCase() ?? '';

  if (!email) {
    throw new Error(DINGTALK_EMAIL_REQUIRED_MESSAGE);
  }

  return {
    email,
    name: userPayload.nick?.trim() || email,
    picture: userPayload.avatarUrl ?? null,
    subject: userPayload.unionId,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return {};
  }
}
