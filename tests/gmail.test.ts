import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  digest,
  gmailAuthorizationUrl,
  gmailReturnUrl,
  gmailScope,
  openGmail,
  randomOAuthValue,
  sealGmail,
  verifiedGoogleIdentity,
} from '../shared/gmail';
import { gmailPurpose, handleGmailCallback } from '../shared/gmail-callback';
import { ids } from './fixtures';

const config = {
  clientId: 'synthetic.apps.googleusercontent.com',
  clientSecret: 'synthetic-client-secret',
  encryptionKey: btoa('a'.repeat(32)),
  callbackUrl: 'https://backend.example/functions/v1/handoff-api/gmail/callback',
};
const origins = new Set(['https://handoffcheck.vercel.app']);
const returnUrl = `https://handoffcheck.vercel.app/requests/${ids.workspace}`;
it('encrypts credentials with author/workspace binding and rejects tampering', async () => {
  const purpose = gmailPurpose(ids.workspace, ids.author);
  const encrypted = await sealGmail('synthetic-refresh', config.encryptionKey, purpose);
  expect(encrypted).not.toContain('synthetic-refresh');
  expect(await openGmail(encrypted, config.encryptionKey, purpose)).toBe('synthetic-refresh');
  await expect(
    openGmail(encrypted, config.encryptionKey, gmailPurpose(ids.workspace, ids.product)),
  ).rejects.toThrow();
  await expect(openGmail(encrypted + 'bad', config.encryptionKey, purpose)).rejects.toThrow();
});
it('builds an offline send-only OAuth request and permits only saved request return paths', async () => {
  const user = {
    email: 'author@example.com',
    email_confirmed_at: 'now',
    user_metadata: { sub: 'untrusted' },
    identities: [{ id: ids.author, provider: 'google', identity_data: { sub: 'google-author' } }],
  };
  expect(verifiedGoogleIdentity(user).sub).toBe('google-author');
  const state = randomOAuthValue(),
    verifier = randomOAuthValue();
  const url = new URL(
    gmailAuthorizationUrl(config, state, await digest(verifier), 'author@example.com'),
  );
  expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', gmailScope]);
  expect(url.searchParams.get('state')).toBe(state);
  expect(url.searchParams.get('code_challenge')).not.toBe(verifier);
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(
    gmailReturnUrl(
      'https://handoffcheck.vercel.app',
      `/requests/${ids.workspace}?secret=bad`,
      origins,
    ),
  ).toBe(returnUrl + '?tab=approvals');
  expect(() =>
    gmailReturnUrl('https://evil.example', `/requests/${ids.workspace}`, origins),
  ).toThrow();
  expect(() =>
    gmailReturnUrl('https://handoffcheck.vercel.app', '//evil.example', origins),
  ).toThrow();
  expect(() =>
    verifiedGoogleIdentity({
      email: 'author@example.com',
      email_confirmed_at: 'now',
      identities: [{ provider: 'email', identity_data: { sub: 'other' } }],
    }),
  ).toThrow();
});

// Explicit service/Auth stubs; the HTTP transport below never calls Google.
async function callbackFixture(
  options: {
    wrongAccount?: boolean;
    denied?: boolean;
    expired?: boolean;
    stale?: boolean;
    missingRefresh?: boolean;
    providerFailure?: boolean;
  } = {},
) {
  const state = randomOAuthValue();
  const verifier = randomOAuthValue();
  const stored = {
    user_id: ids.author,
    workspace_id: ids.workspace,
    generation: 4,
    expected_email: 'author@example.com',
    expected_sub: 'google-author',
    encrypted_verifier: await sealGmail(verifier, config.encryptionKey, `gmail-state:${state}`),
    return_url: returnUrl,
  };
  const rpc = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'gmail_oauth_consume') {
      expect(input.p_hash).toBe(await digest(state));
      return { data: options.expired ? null : stored, error: null };
    }
    expect(name).toBe('gmail_oauth_complete');
    expect(input.p_actor).toBe(ids.author);
    expect(input.p_generation).toBe(4);
    expect(
      await openGmail(
        String(input.p_token),
        config.encryptionKey,
        gmailPurpose(ids.workspace, ids.author),
      ),
    ).toBe('synthetic-refresh');
    return { data: !options.stale, error: null };
  });
  const admin = {
    rpc,
    auth: {
      admin: {
        getUserById: async () => ({
          error: null,
          data: {
            user: {
              email: 'author@example.com',
              email_confirmed_at: 'now',
              identities: [
                { id: ids.author, provider: 'google', identity_data: { sub: 'google-author' } },
              ],
            },
          },
        }),
      },
    },
  } as unknown as SupabaseClient;
  const transport = vi.fn<typeof fetch>(async (address, init) => {
    if (String(address).endsWith('/token')) {
      expect(new URLSearchParams(String(init?.body)).get('code_verifier')).toBe(verifier);
      return options.providerFailure
        ? new Response('private provider failure', { status: 503 })
        : new Response(
            JSON.stringify({
              access_token: 'synthetic-access',
              refresh_token: options.missingRefresh ? undefined : 'synthetic-refresh',
              scope: `openid email ${gmailScope}`,
            }),
          );
    }
    expect(address).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    return new Response(
      JSON.stringify({
        sub: options.wrongAccount ? 'google-other' : 'google-author',
        email: options.wrongAccount ? 'other@example.com' : 'author@example.com',
        email_verified: true,
      }),
    );
  });
  const request = new Request(
    `${config.callbackUrl}?state=${state}&${options.denied ? 'error=access_denied' : 'code=synthetic-code'}`,
  );
  const response = await handleGmailCallback(request, admin, origins, config, transport);
  return { response, rpc, transport };
}
it('completes the bound OAuth connection and returns no credentials to the browser', async () => {
  const { response, rpc } = await callbackFixture();
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe(returnUrl + '?tab=approvals&gmail=connected');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(rpc).toHaveBeenCalledTimes(2);
});
it.each([
  { wrongAccount: true },
  { missingRefresh: true },
  { providerFailure: true },
  { stale: true },
  { denied: true },
])('rejects incomplete or mismatched OAuth consent: %j', async (options) => {
  const { response, rpc, transport } = await callbackFixture(options);
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe(returnUrl + '?tab=approvals&gmail=failed');
  if (!('stale' in options)) expect(rpc).toHaveBeenCalledTimes(1);
  if ('denied' in options) expect(transport).not.toHaveBeenCalled();
});
it('rejects expired state without using Google or redirecting to an untrusted destination', async () => {
  const { response, transport } = await callbackFixture({ expired: true });
  expect(response.status).toBe(400);
  expect(response.headers.get('Location')).toBeNull();
  expect(transport).not.toHaveBeenCalled();
});
