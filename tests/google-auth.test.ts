import { AuthError, type Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { resumeGoogleSession, type GoogleSessionAuth } from '../src/lib/google-auth';

const session: Session = {
  access_token: 'test-token',
  refresh_token: 'test-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  user: {
    id: 'test-user',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-13T00:00:00Z',
  },
};
function gateway() {
  return {
    getSession: vi
      .fn<GoogleSessionAuth['getSession']>()
      .mockResolvedValue({ data: { session }, error: null }),
    exchangeCodeForSession: vi.fn<GoogleSessionAuth['exchangeCodeForSession']>().mockResolvedValue({
      data: { session, user: session.user },
      error: null,
    }),
  };
}
describe('Google session return', () => {
  it('restores an existing session without exchanging a code or changing history', async () => {
    const auth = gateway(),
      clear = vi.fn();
    expect(await resumeGoogleSession(auth, new URL('https://app.example/requests'), clear)).toBe(
      session,
    );
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
  it('exchanges a valid callback and clears the code from history', async () => {
    const auth = gateway(),
      clear = vi.fn();
    expect(
      await resumeGoogleSession(
        auth,
        new URL('https://app.example/auth/callback?code=one-time-code'),
        clear,
      ),
    ).toBe(session);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith('one-time-code');
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it.each(['?error=access_denied&error_description=private-details', '#error=access_denied'])(
    'handles cancelled login %s without exposing provider details',
    async (suffix) => {
      const auth = gateway(),
        clear = vi.fn();
      await expect(
        resumeGoogleSession(auth, new URL(`https://app.example/auth/callback${suffix}`), clear),
      ).rejects.toThrow('Google sign-in was cancelled.');
      expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(clear).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects an incomplete callback and clears its URL', async () => {
    const auth = gateway(),
      clear = vi.fn();
    await expect(
      resumeGoogleSession(auth, new URL('https://app.example/auth/callback'), clear),
    ).rejects.toThrow('This sign-in link is incomplete.');
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it('reports an expired or unverifiable code without exposing the provider error', async () => {
    const auth = gateway(),
      clear = vi.fn();
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthError('private-provider-details'),
    });
    await expect(
      resumeGoogleSession(auth, new URL('https://app.example/auth/callback?code=expired'), clear),
    ).rejects.toThrow('This sign-in link expired or could not be verified.');
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
