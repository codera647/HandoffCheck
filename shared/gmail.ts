import { z } from 'zod';

export const gmailScope = 'https://www.googleapis.com/auth/gmail.send';
export interface GmailConfig {
  clientId?: string;
  clientSecret?: string;
  encryptionKey?: string;
  callbackUrl: string;
}
export const gmailConfigured = (config: GmailConfig) =>
  !!config.clientId?.endsWith('.apps.googleusercontent.com') &&
  !!config.clientSecret &&
  /^[A-Za-z0-9+/]{43}=$/.test(config.encryptionKey ?? '');
export class GmailFailure extends Error {
  constructor(
    message: string,
    public retryable = false,
    public uncertain = false,
    public reconnect = false,
  ) {
    super(message);
  }
}
export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
export const randomOAuthValue = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value: string) {
  return base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}
async function encryptionKey(value: string) {
  const raw = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('Invalid encryption key.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealGmail(value: string, key: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    await encryptionKey(key),
    new TextEncoder().encode(value),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function openGmail(value: string, key: string, purpose: string): Promise<string> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid encrypted value.');
  const decode = (v: string) =>
    Uint8Array.from(atob(v.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(parts[1]), additionalData: new TextEncoder().encode(purpose) },
    await encryptionKey(key),
    decode(parts[2]),
  );
  return new TextDecoder().decode(plaintext);
}
export function gmailAuthorizationUrl(
  config: GmailConfig,
  state: string,
  challenge: string,
  email: string,
) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId!,
    redirect_uri: config.callbackUrl,
    response_type: 'code',
    scope: `openid email ${gmailScope}`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: email,
  }).toString();
  return url.href;
}

export async function googleJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  let size = 0;
  let raw = '';
  const decoder = new TextDecoder();
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16000) {
        await reader.cancel();
        throw new GmailFailure('Google returned an unsupported response.');
      }
      raw += decoder.decode(part.value, { stream: true });
    }
  return JSON.parse(raw + decoder.decode());
}
export async function googleGrant(
  config: GmailConfig,
  values: Record<string, string>,
  transport: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await transport('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId!,
        client_secret: config.clientSecret!,
        ...values,
      }),
    });
  } catch {
    throw new GmailFailure('Google authorization is temporarily unavailable.', true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GmailFailure(
      'Google authorization expired or was denied. Connect Gmail again.',
      response.status >= 500 || response.status === 429,
      false,
      response.status === 400 || response.status === 401,
    );
  }
  let token: { access_token: string; refresh_token?: string; scope: string };
  try {
    token = z
      .object({
        access_token: z.string().min(1).max(4096),
        refresh_token: z.string().min(1).max(4096).optional(),
        scope: z.string(),
      })
      .parse(await googleJson(response));
  } catch {
    throw new GmailFailure('Google returned an unsupported authorization response.');
  }
  if (!token.scope.split(' ').includes(gmailScope))
    throw new GmailFailure(
      'Google did not grant email sending permission. Connect Gmail again.',
      false,
      false,
      true,
    );
  let identity: { sub: string; email: string; email_verified: boolean };
  try {
    const info = await transport('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!info.ok) {
      await info.body?.cancel();
      throw new Error('Identity unavailable.');
    }
    identity = z
      .object({ sub: z.string().min(1).max(100), email: z.email(), email_verified: z.boolean() })
      .parse(await googleJson(info));
  } catch {
    throw new GmailFailure('The connected Google account could not be verified.', true);
  }
  if (!identity.email_verified)
    throw new GmailFailure('The Google account email is not verified.', false, false, true);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    email: identity.email.toLowerCase(),
    sub: identity.sub,
  };
}

export function gmailReturnUrl(origin: string, path: string, allowed: ReadonlySet<string>): string {
  if (!allowed.has(origin)) throw new GmailFailure('This application origin is not allowed.');
  const url = new URL(path, origin);
  if (
    url.origin !== origin ||
    !url.pathname.startsWith('/requests/') ||
    !z.uuid().safeParse(url.pathname.slice(10)).success
  )
    throw new GmailFailure('Return to a saved request before connecting Gmail.');
  url.search = '?tab=approvals';
  url.hash = '';
  return url.href;
}

// Use Google's immutable subject in the server-verified provider identity.
// The identity row UUID and user_metadata are not Google subject identifiers.
export function verifiedGoogleIdentity(user: {
  email?: string;
  email_confirmed_at?: string;
  identities?: { provider: string; identity_data?: { [key: string]: unknown } }[];
}) {
  const identity = user.identities?.find((item) => item.provider === 'google');
  const subject = z.string().min(1).max(100).safeParse(identity?.identity_data?.sub);
  if (!subject.success || !user.email_confirmed_at || !z.email().safeParse(user.email).success)
    throw new GmailFailure('Sign in with your verified Google account before connecting Gmail.');
  return { sub: subject.data, email: user.email!.toLowerCase() };
}
