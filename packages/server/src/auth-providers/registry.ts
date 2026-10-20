/**
 * Which sign-in lines a deployment offers.
 *
 * `AUTH_PROVIDERS` decides, and nothing else does: the public deployment
 * keeps `google`, a private one sets `dingtalk`, and both run the same code.
 * With `AUTH_PROVIDERS` unset the server behaves exactly as it did before
 * INV-1288 — Google only.
 */

import type { GoogleOAuthConfiguration } from '../google-oauth.js';
import { createDingTalkAuthProvider, isDingTalkConfigured, type DingTalkConfiguration } from './dingtalk.js';
import { createGoogleAuthProvider } from './google.js';
import { isAuthProviderId, type AuthProvider, type AuthProviderDescriptor } from './types.js';

export const DEFAULT_AUTH_PROVIDER_IDS = ['google'] as const;

export interface AuthProviderRegistryOptions {
  appOrigin: string;
  dingTalk: DingTalkConfiguration;
  googleOAuth: GoogleOAuthConfiguration;
  /** Provider ids to offer, in the order the buttons should appear. */
  enabledProviderIds: readonly string[];
}

export function parseAuthProviderIds(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value.trim() === '') {
    return [...DEFAULT_AUTH_PROVIDER_IDS];
  }

  const ids = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const unknown = ids.filter((id) => !isAuthProviderId(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown auth provider(s): ${unknown.join(', ')}. Supported: google, dingtalk.`,
    );
  }

  return [...new Set(ids)];
}

export function resolveAuthProviders(options: AuthProviderRegistryOptions): AuthProvider[] {
  const providers: AuthProvider[] = [];

  for (const id of options.enabledProviderIds) {
    if (id === 'google') {
      providers.push(createGoogleAuthProvider(options.googleOAuth));
      continue;
    }

    if (id === 'dingtalk') {
      providers.push(createDingTalkAuthProvider(options.dingTalk));
      continue;
    }

    throw new Error(`Unknown auth provider: ${id}.`);
  }

  return providers;
}

/** The sign-in buttons the web app shows, in order. */
export function describeAuthProviders(
  providers: readonly AuthProvider[],
): AuthProviderDescriptor[] {
  return providers
    .filter((provider) => provider.isConfigured())
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      startUrl: `/auth/${provider.id}/start`,
    }));
}

export function isDingTalkAvailable(configuration: DingTalkConfiguration): boolean {
  return isDingTalkConfigured(configuration);
}
