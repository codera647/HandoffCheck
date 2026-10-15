import { test, expect } from '@playwright/test';
import { asActor, ids } from '../tests/fixtures';

test('mocked hosted Workspace settings separate respondent and editor links', async ({ page }) => {
  const formUrl = 'https://docs.google.com/forms/d/e/published_1234567890/viewform';
  // Isolated synthetic session and mocked backend; no Google account or live API is used.
  await page.route('https://dpwzjmqvsqifbgspoylc.supabase.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path === '/functions/v1/handoff-api/membership/accept') data = null;
    else if (path === '/functions/v1/handoff-api/me') data = asActor(ids.admin);
    else if (path === '/functions/v1/handoff-api/notifications') data = [];
    else if (path === '/functions/v1/handoff-api/workspace')
      data = {
        enabled: true,
        formId: 'editor_1234567890',
        formUrl,
        sheetId: 'sheet_1234567890',
        folderId: 'folder_1234567890',
        lastSyncAt: null,
      };
    else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: data });
  });
  await page.addInitScript(
    ({ admin }) => {
      localStorage.removeItem('handoffcheck-demo-user');
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const payload = btoa(JSON.stringify({ sub: admin, exp: expires })).replaceAll('=', '');
      localStorage.setItem(
        'sb-dpwzjmqvsqifbgspoylc-auth-token',
        JSON.stringify({
          access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic`,
          refresh_token: 'synthetic',
          token_type: 'bearer',
          expires_at: expires,
          user: {
            id: admin,
            aud: 'authenticated',
            role: 'authenticated',
            app_metadata: { provider: 'google' },
            user_metadata: {},
            created_at: '2026-10-15T00:00:00Z',
          },
        }),
      );
    },
    { admin: ids.admin },
  );
  await page.goto('/settings/workspace');
  await expect(
    page.getByRole('link', { name: 'Fill out intake form', exact: true }),
  ).toHaveAttribute('href', formUrl);
  await expect(page.getByRole('link', { name: 'Edit intake form', exact: true })).toHaveAttribute(
    'href',
    'https://docs.google.com/forms/d/editor_1234567890/edit',
  );
  await expect(
    page.getByRole('link', { name: 'Fill out intake form', exact: true }),
  ).toHaveAttribute('target', '_blank');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-intake-links.png', fullPage: true });
});
