import { test, expect } from '@playwright/test';
import { asActor, context, draft, ids } from '../tests/fixtures';
import { applyDemoCommand, createDemoRecord, currentReview } from '../shared/domain';
import { defaultPolicy, type AutomationTask } from '../shared/automation';

test('mocked hosted assistant shows retry progress, exhausts visibly and keeps approval blocked', async ({
  page,
}) => {
  // Synthetic session and task states; no Google account, provider or worker is contacted.
  const record = await applyDemoCommand(
    await createDemoRecord(draft(), context, 1),
    { action: 'review', expectedRevision: 1 },
    context,
  );
  record.status = 'reviewing';
  currentReview(record)!.state = 'running';
  currentReview(record)!.mode = 'ai';
  currentReview(record)!.expiresAt = new Date(Date.now() + 300000).toISOString();
  const task: AutomationTask = {
    id: crypto.randomUUID(),
    requestId: record.id,
    actorId: ids.product,
    kind: 'review',
    revision: 1,
    inputHash: record.revisions[0].inputHash,
    briefId: null,
    state: 'queued',
    output: null,
    error: 'Gemini is temporarily unavailable (HTTP 503). Try again later.',
    attempts: 1,
    createdAt: new Date().toISOString(),
    accepted: [],
    reviewedBy: null,
    demo: false,
    model: 'mock-model',
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://dpwzjmqvsqifbgspoylc.supabase.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path.endsWith('/membership/accept')) data = null;
    else if (path.endsWith('/me')) data = asActor(ids.product);
    else if (path.endsWith('/notifications')) data = [];
    else if (path.endsWith('/automation/policy'))
      data = {
        ...defaultPolicy,
        aiEnabled: true,
        providerConfigured: true,
        schedulerConfigured: true,
      };
    else if (path.endsWith('/assistance')) data = [task];
    else if (path.endsWith(`/requests/${record.id}`)) data = record;
    else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: data });
  });
  await page.addInitScript(
    ({ actorId }) => {
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const payload = btoa(JSON.stringify({ sub: actorId, exp: expires })).replaceAll('=', '');
      localStorage.setItem(
        'sb-dpwzjmqvsqifbgspoylc-auth-token',
        JSON.stringify({
          access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic`,
          refresh_token: 'synthetic',
          token_type: 'bearer',
          expires_at: expires,
          user: {
            id: actorId,
            aud: 'authenticated',
            role: 'authenticated',
            app_metadata: { provider: 'google' },
            user_metadata: {},
            created_at: '2026-10-15T00:00:00Z',
          },
        }),
      );
    },
    { actorId: ids.product },
  );
  await page.goto(`/requests/${record.id}?tab=approvals`);
  const assistant = page.getByRole('region', { name: 'Requirement assistance', exact: true });
  await expect(assistant.getByText('Waiting to retry', { exact: true }).first()).toBeVisible();
  await expect(
    assistant.getByText('The last attempt could not finish.', { exact: false }),
  ).toBeVisible();
  await expect(
    assistant.getByRole('button', { name: 'Run requirement review', exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole('tabpanel', { name: 'Approvals' })
      .getByRole('button', { name: 'Approve revision 1', exact: true }),
  ).toBeDisabled();
  task.state = 'working';
  task.attempts = 2;
  task.error = null;
  await expect(
    assistant.getByText('Gemini is processing the saved requirement text…', { exact: true }),
  ).toBeVisible();
  task.state = 'failed';
  task.attempts = 3;
  task.error = 'Gemini is temporarily unavailable (HTTP 503). Try again later.';
  record.status = 'review_error';
  currentReview(record)!.state = 'error';
  currentReview(record)!.error = task.error;
  await expect(
    assistant.getByRole('button', { name: 'Retry requirement review', exact: true }),
  ).toBeEnabled();
  await expect(assistant.getByText('Failed · approval blocked', { exact: true })).toBeVisible();
  await assistant.screenshot({ path: 'test-results/assistant-provider-failure-desktop.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assistant.screenshot({ path: 'test-results/assistant-provider-failure-mobile.png' });
  expect(errors).toEqual([]);
});
