const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { startGoogleSignIn } = require('../auth.cjs');
const { isAppUrl, isExternalUrl, isTrustedSender } = require('../security.cjs');

const origin = 'https://handoffcheck.example';
test('only the pinned app main frame can request native sign-in', () => {
  const mainFrame = { url: origin + '/login' },
    contents = { mainFrame };
  assert.equal(
    isTrustedSender({ sender: contents, senderFrame: mainFrame }, contents, origin),
    true,
  );
  assert.equal(
    isTrustedSender({ sender: contents, senderFrame: { url: mainFrame.url } }, contents, origin),
    false,
  );
  assert.equal(isTrustedSender({ sender: {}, senderFrame: mainFrame }, contents, origin), false);
  mainFrame.url = 'https://handoffcheck.example.evil.test/login';
  assert.equal(
    isTrustedSender({ sender: contents, senderFrame: mainFrame }, contents, origin),
    false,
  );
  assert.equal(isAppUrl('https://user:pass@handoffcheck.example', origin), false);
  for (const value of [
    'file:///C:/Windows',
    'javascript:alert(1)',
    'http://example.com',
    'https://u:p@example.com',
    'not a url',
  ])
    assert.equal(isExternalUrl(value), false);
  assert.equal(isExternalUrl('https://docs.google.com/document/d/example/edit'), true);
});

function fixture(options = {}) {
  const opened = new EventEmitter();
  let storage,
    exchanged = [];
  const signIn = startGoogleSignIn({
    supabaseUrl: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    port: 0,
    openExternal: (url) => {
      opened.emit('open', url);
    },
    createAuthClient: (_url, _key, config) => {
      assert.equal(config.auth.flowType, 'pkce');
      assert.equal(config.auth.autoRefreshToken, false);
      storage = config.auth.storage;
      return {
        auth: {
          signInWithOAuth: async ({ provider, options }) => {
            assert.equal(provider, 'google');
            assert.equal(options.skipBrowserRedirect, true);
            storage.setItem('verifier', 'ephemeral-verifier');
            return {
              data: {
                url:
                  'https://project.supabase.co/auth/v1/authorize?redirect_to=' +
                  encodeURIComponent(options.redirectTo),
              },
              error: null,
            };
          },
          exchangeCodeForSession: async (code) => {
            exchanged.push(code);
            assert.equal(storage.getItem('verifier'), 'ephemeral-verifier');
            return options.exchangeError
              ? { data: { session: null }, error: new Error('private provider failure') }
              : {
                  data: { session: { access_token: 'test-access', refresh_token: 'test-refresh' } },
                  error: null,
                };
          },
        },
      };
    },
    ...options,
  });
  // Register the rejection handler before cancellation/timeout to avoid an unhandled rejection.
  const outcome = signIn.promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return {
    signIn,
    outcome,
    opened,
    get storage() {
      return storage;
    },
    exchanged,
  };
}

test('browser callback uses a random route, rejects unrelated requests, and returns one session', async () => {
  const f = fixture(),
    [authorize] = await once(f.opened, 'open');
  const callback = new URL(new URL(authorize).searchParams.get('redirect_to'));
  assert.match(callback.pathname, /^\/auth\/callback\/[a-f0-9]{64}$/);
  assert.equal(
    (await fetch(callback.origin + '/auth/callback/not-this-attempt?code=fake')).status,
    404,
  );
  assert.equal(
    (await fetch(callback + '?code=valid', { headers: { Origin: 'https://evil.test' } })).status,
    404,
  );
  assert.equal((await fetch(callback)).status, 400);
  const response = await fetch(callback + '?code=valid');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /Return to the HandoffCheck desktop app/);
  assert.deepEqual((await f.outcome).value, {
    access_token: 'test-access',
    refresh_token: 'test-refresh',
  });
  assert.deepEqual(f.exchanged, ['valid']);
  assert.equal(f.storage.getItem('verifier'), null);
});

test('provider cancellation clears memory and never exchanges a code or reflects error details', async () => {
  const f = fixture(),
    [authorize] = await once(f.opened, 'open');
  const callback = new URL(authorize).searchParams.get('redirect_to');
  const response = await fetch(callback + '?error=access_denied&error_description=private-data');
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /private-data/);
  assert.match((await f.outcome).error.message, /cancelled or denied/);
  assert.deepEqual(f.exchanged, []);
  assert.equal(f.storage.getItem('verifier'), null);
});

test('failed exchange returns a useful error without exposing provider details', async () => {
  const f = fixture({ exchangeError: true }),
    [authorize] = await once(f.opened, 'open');
  const response = await fetch(
    new URL(authorize).searchParams.get('redirect_to') + '?code=expired',
  );
  assert.equal(response.status, 400);
  assert.match((await f.outcome).error.message, /could not be verified/);
  assert.equal(f.storage.getItem('verifier'), null);
});

test('abandoned browser authorization times out and closes the callback server', async () => {
  const f = fixture({ timeoutMs: 50 }),
    [authorize] = await once(f.opened, 'open');
  assert.match((await f.outcome).error.message, /timed out/);
  await assert.rejects(fetch(new URL(authorize).searchParams.get('redirect_to')));
  assert.equal(f.storage.getItem('verifier'), null);
});

test('closing the desktop app cancels its pending authorization', async () => {
  const f = fixture();
  await once(f.opened, 'open');
  f.signIn.cancel();
  assert.match((await f.outcome).error.message, /cancelled/);
  assert.equal(f.storage.getItem('verifier'), null);
});

test('cancellation before the listener opens never starts browser authorization', async () => {
  let opened = false;
  const f = fixture({
    openExternal: () => {
      opened = true;
    },
  });
  f.signIn.cancel();
  assert.match((await f.outcome).error.message, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(opened, false);
});
