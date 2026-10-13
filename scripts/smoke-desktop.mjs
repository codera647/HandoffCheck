import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'handoffcheck-smoke-'));
let app;
try {
  const executablePath = process.argv[2];
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + profile],
    env: { ...process.env, HANDOFFCHECK_SMOKE_TEST: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor({ timeout: 60000 });
  assert.equal(new URL(page.url()).origin, 'https://handoffcheck.vercel.app');
  const boundary = await page.evaluate(() => ({
    signIn: typeof window.handoffDesktop?.signInWithGoogle,
    node: typeof window.require,
    demoVisible: document.body.textContent.includes('Open demo workspace'),
  }));
  assert.equal(boundary.signIn, 'function');
  assert.equal(boundary.node, 'undefined');
  assert.equal(boundary.demoVisible, false);
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.webSecurity, true);
  console.log('Native production login screen, isolated bridge and renderer settings verified.');
} finally {
  await app?.close();
  // mkdtemp returned this absolute task-owned directory beneath the OS temp directory.
  assert.equal(path.dirname(profile), tmpdir());
  assert.match(path.basename(profile), /^handoffcheck-smoke-/);
  await rm(profile, { recursive: true, force: true });
}
