import { PageBody } from '../components/layout';
import { EmptyState } from '../components/status';
import { getProviderLoginUrl, rememberSignInReturn, type SessionState } from '../lib/session';

export function SignInPage({ session, authError }: { session: SessionState | null | undefined; authError: string | null }) {
  const providers = session?.authProviders.length
    ? session.authProviders
    : session?.googleOAuthConfigured
      ? [{ id: 'google', label: 'Sign in with Google', startUrl: '/auth/google/start' }]
      : [];
  const suspended = authError === 'suspended';
  const inviteOnly = authError === 'not_invited';
  const title = suspended
    ? 'This account is suspended'
    : inviteOnly
      ? 'This workspace is invite-only'
      : authError
        ? 'Could not sign in'
        : 'Sign in to continue';
  const body = suspended
    ? 'Ask a workspace admin to reactivate your account.'
    : inviteOnly
      ? 'Sign in with the account that was invited, or ask a workspace admin for an invitation.'
      : session === undefined
        ? 'Checking sign-in options…'
        : providers.length === 0
          ? 'Sign-in isn’t available right now. Contact your workspace admin for help.'
          : authError
            ? 'Sign in again to return to the page you were trying to open.'
            : 'This workspace is private. Sign in to return to this page.';

  return (
    <main>
      <PageBody>
        <EmptyState
          title={title}
          body={<span role="alert">{body}</span>}
          action={!suspended && providers.map((provider) => (
            <a
              key={provider.id}
              className="ui-action ui-action--accent ui-action--md"
              href={getProviderLoginUrl(provider.startUrl)}
              onClick={rememberSignInReturn}
            >
              {provider.label}
            </a>
          ))}
        />
      </PageBody>
    </main>
  );
}
