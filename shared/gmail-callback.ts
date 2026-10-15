import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  digest,
  GmailFailure,
  gmailConfigured,
  gmailReturnUrl,
  googleGrant,
  openGmail,
  sealGmail,
  verifiedGoogleIdentity,
} from './gmail.ts';

import type { GmailConfig } from './gmail.ts';
export const gmailPurpose = (workspace: string, actor: string) => `gmail:${workspace}:${actor}`;
const stateSchema = z.object({
  user_id: z.uuid(),
  workspace_id: z.uuid(),
  generation: z.number().int(),
  expected_email: z.email(),
  expected_sub: z.string(),
  encrypted_verifier: z.string(),
  return_url: z.url(),
});

export async function handleGmailCallback(
  request: Request,
  admin: SupabaseClient,
  origins: ReadonlySet<string>,
  config: GmailConfig,
  transport: typeof fetch = fetch,
): Promise<Response> {
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'text/plain; charset=UTF-8',
  };
  let destination: URL | undefined;
  try {
    if (!gmailConfigured(config)) throw new GmailFailure('Gmail connection is not configured.');
    const params = new URL(request.url).searchParams;
    const state = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(params.get('state'));
    const consumed = await admin.rpc('gmail_oauth_consume', { p_hash: await digest(state) });
    if (consumed.error)
      throw new GmailFailure('This Gmail connection attempt could not be verified.');
    const saved = stateSchema.parse(consumed.data);
    const returnUrl = new URL(saved.return_url);
    destination = new URL(gmailReturnUrl(returnUrl.origin, returnUrl.pathname, origins));
    if (params.has('error')) throw new GmailFailure('Gmail permission was not granted.');
    const code = z.string().min(1).max(4096).parse(params.get('code'));
    const verifier = await openGmail(
      saved.encrypted_verifier,
      config.encryptionKey!,
      `gmail-state:${state}`,
    );
    const grant = await googleGrant(
      config,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.callbackUrl,
        code_verifier: verifier,
      },
      transport,
    );
    const current = await admin.auth.admin.getUserById(saved.user_id);
    if (current.error || !current.data.user) throw new GmailFailure('This account is unavailable.');
    const identity = verifiedGoogleIdentity(current.data.user);
    if (
      grant.email !== saved.expected_email ||
      grant.sub !== saved.expected_sub ||
      grant.email !== identity.email ||
      grant.sub !== identity.sub ||
      !grant.refreshToken
    )
      throw new GmailFailure(
        'Connect the same Google account you use to sign in, with offline sending permission.',
      );
    const encrypted = await sealGmail(
      grant.refreshToken,
      config.encryptionKey!,
      gmailPurpose(saved.workspace_id, saved.user_id),
    );
    const stored = await admin.rpc('gmail_oauth_complete', {
      p_actor: saved.user_id,
      p_generation: saved.generation,
      p_email: grant.email,
      p_sub: grant.sub,
      p_token: encrypted,
    });
    if (stored.error || stored.data !== true)
      throw new GmailFailure('This connection attempt expired.');
    destination.searchParams.set('gmail', 'connected');
  } catch {
    if (!destination)
      return new Response(
        'This Gmail connection link expired or is unavailable. Return to your request and choose Connect Gmail again.',
        { status: 400, headers },
      );
    destination.searchParams.set('gmail', 'failed');
  }
  return new Response(null, { status: 303, headers: { ...headers, Location: destination.href } });
}
