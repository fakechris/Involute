/**
 * The Google sign-in line, as an auth provider.
 *
 * The OAuth mechanics stay in `google-oauth.ts`; this file only puts the
 * existing behaviour behind the provider contract, so the public deployment
 * keeps signing people in exactly as it did before INV-1288.
 *
 * What is Google-specific lives here and nowhere else: that a Google account
 * must have a verified email, and that Google's subject still lands in the
 * legacy `googleSubject` column (`legacy.ts`). The workspace policy that runs
 * after this is the same policy every sign-in line gets.
 */

import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCodeForUserProfile,
  isGoogleOAuthConfigured,
  type GoogleOAuthConfiguration,
} from '../google-oauth.js';
import type { AuthProvider } from './types.js';

export function createGoogleAuthProvider(configuration: GoogleOAuthConfiguration): AuthProvider {
  return {
    id: 'google',
    label: 'Sign in with Google',
    isConfigured: () => isGoogleOAuthConfigured(configuration),
    buildAuthorizationUrl: (state) => buildGoogleAuthorizationUrl(configuration, state),
    completeSignIn: async (code) => {
      const profile = await exchangeGoogleCodeForUserProfile(code, configuration);

      if (!profile.emailVerified) {
        throw new Error('Google account email must be verified.');
      }

      return {
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        subject: profile.subject,
      };
    },
  };
}
