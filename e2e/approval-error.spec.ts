import { test, expect } from '@playwright/test';
import { asActor, context, draft, ids } from '../tests/fixtures';
import { applyDemoCommand, createDemoRecord, currentReview } from '../shared/domain';
import { defaultPolicy } from '../shared/automation';
import { commandSchema } from '../shared/contracts';

for (const actorId of [ids.product, ids.engineering]) {
  test(`mocked hosted ${actorId === ids.product ? 'product' : 'engineering'} lead sees why approval is blocked and can retry review`, async ({
    page,
  }) => {
    // Synthetic session and API responses. No live accounts or Gemini calls.
    const actorContext = asActor(actorId);
    let record = await createDemoRecord(draft(), context, 1);
    record = await applyDemoCommand(record, { action: 'review', expectedRevision: 1 }, context);
    record.status = 'review_error';
    currentReview(record)!.state = 'error';
    currentReview(record)!.mode = 'ai';
    currentReview(record)!.error = 'Gemini rejected the request format (HTTP 400).';
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://dpwzjmqvsqifbgspoylc.supabase.co/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown;
      if (path.endsWith('/membership/accept')) data = null;
      else if (path.endsWith('/me')) data = actorContext;
      else if (path.endsWith('/notifications') || path.endsWith('/assistance')) data = [];
      else if (path.endsWith('/automation/policy'))
        data = { ...defaultPolicy, aiEnabled: true, providerConfigured: true };
      else if (path.endsWith(`/requests/${record.id}/commands`)) {
        const command = commandSchema.parse(route.request().postDataJSON());
        record = await applyDemoCommand(record, command, actorContext);
        data = record;
      } else if (path.endsWith(`/requests/${record.id}`)) data = record;
      else if (path.endsWith('/requests'))
        data = { items: [record], total: 1, page: 1, pageSize: 25 };
      else {
        await route.abort();
        return;
      }
      await route.fulfill({ json: data });
    });
    await page.addInitScript(
      ({ actorId }) => {
        localStorage.removeItem('handoffcheck-demo-user');
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
      { actorId },
    );
    await page.goto('/reviews');
    await page.getByRole('link', { name: record.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/requests/${record.id}\\?tab=approvals$`));
    const panel = page.getByRole('tabpanel', { name: 'Approvals' });
    await expect(
      panel.getByRole('button', { name: 'Approve revision 1', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByText('Approval is blocked because the requirement review failed.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Request changes', exact: true })).toBeVisible();
    await expect(
      page.getByText('These results are private to the author and assigned reviewers.', {
        exact: false,
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/approval-blocked-${actorId === ids.product ? 'product' : 'engineering'}.png`,
      fullPage: true,
    });
    await panel.getByRole('button', { name: 'Open review', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Review' })).toContainText('HTTP 400');
    await page.getByRole('button', { name: 'Retry review', exact: true }).click();
    await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Approve revision 1', exact: true }),
    ).toBeEnabled();
    await panel.getByRole('button', { name: 'Approve revision 1', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Approve revision 1', exact: true })
      .click();
    await expect(
      panel.getByRole('button', { name: 'Approve revision 1', exact: true }),
    ).toHaveCount(0);
    expect(record.status).toBe('partially_approved');
    expect(record.approvals).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}
