const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const CALLBACK_PORT = 17584;

/** The PKCE verifier stays in the main process; Google runs in the system browser. */
function startGoogleSignIn({
  supabaseUrl,
  publishableKey,
  openExternal,
  timeoutMs = 300000,
  port = CALLBACK_PORT,
  createAuthClient = createClient,
}) {
  const callbackPath = '/auth/callback/' + randomBytes(32).toString('hex');
  const memory = new Map();
  const auth = createAuthClient(supabaseUrl, publishableKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => memory.set(key, value),
        removeItem: (key) => memory.delete(key),
      },
    },
  }).auth;
  let server,
    timer,
    settled = false,
    exchanging = false;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const finish = (error, tokens) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      // This store is RAM only. A server-side signOut would revoke the renderer's new session.
      memory.clear();
      if (error) reject(error);
      else resolve(tokens);
    };
    cancel = () => finish(new Error('Google sign-in was cancelled. You can try again.'));
    server = createServer(async (request, response) => {
      const callback = new URL(request.url, 'http://127.0.0.1');
      if (
        request.method !== 'GET' ||
        request.headers.host !== '127.0.0.1:' + server.address().port ||
        callback.pathname !== callbackPath ||
        request.headers.origin ||
        exchanging ||
        settled
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      const code = callback.searchParams.get('code');
      const failure = callback.searchParams.get('error');
      if (!failure && (!code || code.length > 1024)) {
        response.writeHead(400);
        response.end('Start sign-in from HandoffCheck.');
        return;
      }
      exchanging = true;
      let tokens, error;
      if (failure) {
        error = new Error('Google sign-in was cancelled or denied. You can try again.');
      } else {
        try {
          const result = await auth.exchangeCodeForSession(code);
          if (result.error || !result.data.session) throw new Error('Session exchange failed.');
          tokens = {
            access_token: result.data.session.access_token,
            refresh_token: result.data.session.refresh_token,
          };
        } catch {
          error = new Error(
            'Google sign-in could not be verified. Start sign-in again in HandoffCheck.',
          );
        }
      }
      response.writeHead(error ? 400 : 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(
        '<!doctype html><html><head><title>HandoffCheck sign-in</title></head><body style="font-family:Arial;padding:40px"><h1>' +
          (error ? 'Sign-in could not finish' : 'Signed in to HandoffCheck') +
          '</h1><p>Return to the HandoffCheck desktop app. You can close this tab.</p></body></html>',
      );
      finish(error, tokens);
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.on('error', () =>
      finish(
        new Error(
          'The sign-in return port is unavailable. Close another HandoffCheck window and try again.',
        ),
      ),
    );
    server.listen(port, '127.0.0.1', async () => {
      if (settled) {
        server.close();
        return;
      }
      timer = setTimeout(
        () => finish(new Error('Google sign-in timed out. You can try again.')),
        timeoutMs,
      );
      timer.unref();
      try {
        const redirectTo = 'http://127.0.0.1:' + server.address().port + callbackPath;
        const { data, error } = await auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo, skipBrowserRedirect: true },
        });
        if (settled) {
          memory.clear();
          return;
        }
        if (error || !data.url) throw new Error('No authorization URL.');
        const destination = new URL(data.url);
        if (
          destination.origin !== new URL(supabaseUrl).origin ||
          destination.pathname !== '/auth/v1/authorize'
        )
          throw new Error('Unexpected authorization URL.');
        await openExternal(destination.href);
      } catch {
        finish(new Error('Google sign-in could not start. Check your connection and try again.'));
      }
    });
  });
  return { promise, cancel: () => cancel() };
}

module.exports = { CALLBACK_PORT, startGoogleSignIn };
