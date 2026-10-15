import { test, expect } from '@playwright/test';
import { asActor, context, draft, ids } from '../tests/fixtures';
import { applyDemoCommand, createDemoRecord } from '../shared/domain';
import { disabledReminders, reminderInputSchema, type ReminderSettings } from '../shared/reminders';
import { defaultPolicy } from '../shared/automation';

for (const actorId of [ids.author, ids.product]) {
  test(`synthetic hosted reminder schedule is ${actorId === ids.author ? 'editable by its author' : 'read-only for the reviewer'}`, async ({
    page,
  }) => {
    // Synthetic session/API transport. No real mail or production records are created.
    const actorContext = asActor(actorId);
    const record = await applyDemoCommand(
      await createDemoRecord(draft(), context, 1),
      { action: 'review', expectedRevision: 1 },
      context,
    );
    let settings: ReminderSettings = { ...disabledReminders, schedulerConfigured: true };
    if (actorId === ids.product)
      settings = {
        ...settings,
        enabled: true,
        custom: true,
        version: 1,
        state: 'scheduled',
        emailConfigured: true,
        emailStatus: 'sent',
        nextDueAt: new Date(Date.now() + 3600000).toISOString(),
      };
    let saves = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://dpwzjmqvsqifbgspoylc.supabase.co/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown;
      if (path.endsWith('/membership/accept')) data = null;
      else if (path.endsWith('/me')) data = actorContext;
      else if (path.endsWith('/notifications') || path.endsWith('/assistance')) data = [];
      else if (path.endsWith('/automation/policy'))
        data = { ...defaultPolicy, schedulerConfigured: true };
      else if (path.endsWith('/reminders')) {
        if (route.request().method() === 'POST') {
          saves++;
          const input = reminderInputSchema.parse(route.request().postDataJSON());
          expect(actorId).toBe(ids.author);
          expect(input.expectedVersion).toBe(settings.version);
          expect(input.expectedRevision).toBe(1);
          if (saves === 1) {
            await route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'SERVER_ERROR',
                  message: 'The schedule could not be saved in this synthetic failure.',
                },
              },
            });
            return;
          }
          settings = {
            ...settings,
            enabled: input.enabled,
            emailEnabled: input.emailEnabled,
            intervalMinutes: input.intervalMinutes,
            version: settings.version + 1,
            custom: true,
            state: input.enabled ? 'scheduled' : 'off',
            nextDueAt: input.enabled
              ? new Date(Date.now() + input.intervalMinutes * 60000).toISOString()
              : null,
          };
        }
        data = settings;
      } else if (path.endsWith(`/requests/${record.id}`)) data = record;
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
    await page.goto(`/requests/${record.id}?tab=approvals`);
    const summary = page.locator('.request-reminders > summary');
    await summary.focus();
    await summary.press('Enter');
    await expect(page.locator('.request-reminders')).toHaveAttribute('open', '');
    const form = page.getByRole('form', { name: 'Approval reminder settings' });
    await expect(form).toBeVisible();
    if (actorId === ids.author) {
      await expect(form).toContainText('Email setup is pending');
      await form.getByRole('checkbox', { name: 'Repeat reminders', exact: true }).check();
      await form.getByLabel('Repeat every', { exact: true }).fill('1');
      await form.getByLabel('Reminder time unit').selectOption('1');
      const save = form.getByRole('button', { name: 'Save reminder schedule' });
      await expect(save).toBeDisabled();
      await form.getByLabel('Repeat every', { exact: true }).fill('2');
      await form.getByLabel('Reminder time unit').selectOption('60');
      await save.click();
      await expect(form.getByRole('alert')).toContainText('synthetic failure');
      const refreshed = page.waitForResponse(
        (response) =>
          response.url().endsWith('/reminders') && response.request().method() === 'GET',
      );
      await form.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
      await refreshed;
      expect(saves).toBe(1);
      await expect(
        form.getByRole('checkbox', { name: 'Repeat reminders', exact: true }),
      ).toBeChecked();
      await save.click();
      await expect(page.getByText('Reminder schedule saved.', { exact: true })).toBeVisible();
      await expect(form).toContainText('Next reminder:');
      expect(settings).toMatchObject({
        enabled: true,
        emailEnabled: true,
        intervalMinutes: 120,
        version: 1,
      });
      await page.setViewportSize({ width: 320, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page
        .locator('.request-reminders')
        .screenshot({ path: 'test-results/reminder-schedule-mobile.png' });
      await form.getByRole('checkbox', { name: 'Repeat reminders', exact: true }).uncheck();
      await save.click();
      await expect(form).toContainText('Repeat reminders are paused.');
      await expect(form).not.toContainText('Next reminder:');
      expect(settings.enabled).toBe(false);
    } else {
      await expect(form).toContainText('Only the request author can change this schedule.');
      await expect(
        form.getByRole('checkbox', { name: 'Repeat reminders', exact: true }),
      ).toBeDisabled();
      await expect(form.getByRole('button', { name: 'Save reminder schedule' })).toHaveCount(0);
      await expect(form).toContainText('accepted by Resend; inbox delivery is not confirmed');
      await page
        .locator('.request-reminders')
        .screenshot({ path: 'test-results/reminder-schedule-reviewer.png' });
      expect(saves).toBe(0);
    }
    expect(errors).toEqual([]);
  });
}
