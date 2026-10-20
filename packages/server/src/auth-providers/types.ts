/**
 * Auth providers — the seam that lets one build serve several sign-in lines.
 *
 * The public deployment runs on Google; a private deployment can run on
 * DingTalk (INV-1288). Both lines share this contract, so neither one forks
 * the other: a deployment picks its providers with `AUTH_PROVIDERS`.
 *
 * A provider owns two things only: how to send a person to the identity
 * provider, and how to turn the code that comes back into a profile. What
 * happens to that profile — the invite-only rule, the approved domains, the
 * team membership — is workspace policy and lives in `workspace-access.ts`.
 */

export interface AuthProviderProfile {
  /** Verified, lowercase. The workspace keys people by email (docs/permissions.md §1). */
  email: string;
  name: string;
  picture: string | null;
  /** The provider's stable id for this person: Google `sub`, DingTalk `unionId`. */
  subject: string;
}

/**
 * Which sign-in line vouched for a person, and by which subject.
 *
 * This is the provider layer's business. The workspace policy — who may sign
 * in, what role they get, which teams they join — is one policy for every
 * line and lives in `workspace-access.ts`.
 */
export interface SignInProvider {
  id: string;
  subject: string;
}

export interface AuthProvider {
  /** Stable id, used in URLs (`/auth/<id>/start`) and in the identity table. */
  readonly id: string;
  /** The label the sign-in button shows. */
  readonly label: string;
  /** Whether this provider has everything it needs to sign someone in. */
  isConfigured(): boolean;
  /** Where to send the browser to start the flow. */
  buildAuthorizationUrl(state: string): string;
  /** Exchange the returned code for who the person is. */
  completeSignIn(code: string): Promise<AuthProviderProfile>;
}

/** What the web app needs to render a sign-in button. */
export interface AuthProviderDescriptor {
  id: string;
  label: string;
  startUrl: string;
}

export const AUTH_PROVIDER_IDS = ['google', 'dingtalk'] as const;

export type AuthProviderId = (typeof AUTH_PROVIDER_IDS)[number];

export function isAuthProviderId(value: string): value is AuthProviderId {
  return (AUTH_PROVIDER_IDS as readonly string[]).includes(value);
}
