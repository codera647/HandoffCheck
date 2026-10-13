import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { DomainError } from '../../shared/domain';

export type GoogleSessionAuth = Pick<
  SupabaseClient['auth'],
  'exchangeCodeForSession' | 'getSession'
>;

// The callback is exchanged once in supabase.ts; React StrictMode must not reuse its code.
export async function resumeGoogleSession(
  auth: GoogleSessionAuth,
  address: URL,
  clearCallback: () => void,
): Promise<Session | null> {
  if (address.pathname !== '/auth/callback') {
    const { data, error } = await auth.getSession();
    if (error)
      throw new DomainError(
        'SESSION_FAILED',
        'Your saved session could not be restored. Sign in again.',
        401,
      );
    return data.session;
  }
  try {
    const fragment = new URLSearchParams(address.hash.slice(1));
    const callbackError = address.searchParams.get('error') || fragment.get('error');
    if (callbackError)
      throw new DomainError(
        'OAUTH_FAILED',
        callbackError === 'access_denied'
          ? 'Google sign-in was cancelled. You can try again.'
          : 'Google sign-in could not be completed. Start again from the sign-in page.',
        401,
      );
    const code = address.searchParams.get('code');
    if (!code || code.length > 1024)
      throw new DomainError(
        'CALLBACK_MISSING',
        'This sign-in link is incomplete. Start Google sign-in again from this browser.',
        401,
      );
    const { data, error } = await auth.exchangeCodeForSession(code);
    if (error || !data.session)
      throw new DomainError(
        'CALLBACK_EXPIRED',
        'This sign-in link expired or could not be verified. Start Google sign-in again from this browser.',
        401,
      );
    return data.session;
  } finally {
    // Remove codes and provider error details from history without dropping router state.
    clearCallback();
  }
}
