import { test, expect } from '@playwright/test';
import { fieldLabels, type RequestRecord } from '../shared/contracts';
import { createDemoRecord } from '../shared/domain';
import { context, ids } from '../tests/fixtures';
import { defaultPolicy } from '../shared/automation';

test('hosted drafting retains failed messages, recovers a lost response and never creates a request from chat', async ({
  page,
}) => {
  // Synthetic authentication and API transport only; no employee session or Gemini call is used.
  let calls = 0,
    created = 0;
  let record: RequestRecord | undefined;
  const keys: string[] = [];
  await page.route('https://dpwzjmqvsqifbgspoylc.supabase.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path.endsWith('/me')) data = context;
    else if (path.endsWith('/membership/accept')) data = null;
    else if (path.endsWith('/notifications')) data = [];
    else if (path.endsWith('/automation/policy'))
      data = { ...defaultPolicy, aiEnabled: true, providerConfigured: true };
    else if (path.endsWith('/intake/turn')) {
      calls++;
      keys.push(route.request().headers()['idempotency-key']);
      const input = route.request().postDataJSON();
      expect(input.messages.at(-1).role).toBe('user');
      if (calls === 2) {
        await route.abort();
        return;
      }
      const first = input.messages[0].text;
      data = {
        response: {
          summary: 'Check the proposed problem statement.',
          proposals: [
            { field: 'problem', text: first, evidence: [{ messageIndex: 0, quote: first }] },
          ],
          question: {
            field: 'audience',
            text: 'Who needs this export?',
            options: [
              {
                label: 'Analysts',
                value: 'Only analysts with report_export permission.',
                recommended: true,
                reason: 'Keeps access explicit; confirm that this matches your policy.',
              },
            ],
          },
        },
        model: 'mock-model',
        demo: false,
      };
    } else if (path.endsWith('/requests') && route.request().method() === 'POST') {
      created++;
      record = await createDemoRecord(route.request().postDataJSON().draft, context, 2);
      data = record;
    } else if (record && path.endsWith(`/requests/${record.id}/commands`)) {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'AI_PROVIDER',
            message: 'Gemini is unavailable in this synthetic submission check.',
          },
        },
      });
      return;
    } else if (record && path.endsWith(`/requests/${record.id}`)) data = record;
    else if (path.endsWith('/assistance')) data = [];
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
    { actorId: ids.author },
  );
  await page.goto('/requests/new');
  await page.getByRole('button', { name: 'Describe with assistant', exact: true }).click();
  const builder = page.getByRole('region', { name: 'Request drafting assistant' });
  const preview = page.getByRole('complementary', { name: 'Proposed request preview' });
  await page
    .getByLabel('Describe your idea')
    .fill('Analysts need CSV export instead of copying rows by hand.');
  await builder.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(preview).toContainText('1 of 12 fields proposed');
  expect(created).toBe(0);
  await builder.getByRole('button', { name: /^Analysts/ }).click();
  await expect(
    builder.getByText('Your message and previous preview are retained.', { exact: true }),
  ).toBeVisible();
  await expect(
    builder.getByRole('button', { name: 'Use draft in form', exact: true }),
  ).toBeDisabled();
  await builder.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect(builder.getByRole('button', { name: 'Retry message', exact: true })).toHaveCount(0);
  expect(keys[1]).toBe(keys[2]);
  expect(calls).toBe(3);
  expect(created).toBe(0);
  await preview.getByRole('checkbox').check();
  await page.getByLabel('Your answer or correction').fill('An unsent correction');
  await expect(
    builder.getByRole('button', { name: 'Use draft in form', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Your answer or correction').fill('');
  await preview.getByRole('checkbox').check();
  await builder.getByRole('button', { name: 'Use draft in form', exact: true }).click();
  await expect(page.getByLabel('Problem and evidence', { exact: false })).toHaveValue(
    'Analysts need CSV export instead of copying rows by hand.',
  );
  await expect(page.getByLabel('Product lead', { exact: true })).toHaveValue('');
  expect(created).toBe(0);
  await page.getByLabel('Feature title', { exact: false }).fill('Recover a saved draft');
  await page.getByLabel('Product lead', { exact: true }).selectOption(ids.product);
  await page.getByLabel('Engineering lead', { exact: true }).selectOption(ids.engineering);
  await page.getByRole('button', { name: 'Create and submit for review', exact: true }).click();
  expect(created).toBe(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm and submit', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Recover a saved draft', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'Your draft was saved, but submission could not be confirmed.',
  );
  await expect(page.locator('.request-context')).toContainText('Draft');
  expect(created).toBe(1);
});

test('author drafts through questions, confirms the form and submits privately to the assigned reviews', async ({
  page,
}) => {
  test.setTimeout(90000); // Full twelve-field conversation plus submission and two role changes.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000004');
  await page.goto('/settings/automation');
  await page.getByLabel('Enable simulated assistance').check();
  await page.getByRole('button', { name: 'Save automation settings' }).click();
  await expect(page.getByText('Automation settings saved.', { exact: true })).toBeVisible();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000001');
  await page.goto('/requests/new');
  await page.getByRole('button', { name: 'Describe with assistant', exact: true }).click();
  const builder = page.getByRole('region', { name: 'Request drafting assistant' });
  const conversation = page.getByRole('log', { name: 'Drafting conversation' });
  const preview = page.getByRole('complementary', { name: 'Proposed request preview' });
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeHidden();
  await expect(builder.getByText('It does not call Gemini.', { exact: false })).toBeVisible();
  const answer = async (value: string) => {
    await page
      .getByRole('textbox', { name: /Describe your idea|Your answer or correction/ })
      .fill(value);
    await builder.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await answer('Analysts copy report rows by hand. They need a CSV export for selected dates.');
  await expect(preview).toContainText('1 of 12 fields proposed');
  await expect(
    builder.getByRole('button', { name: 'Use draft in form', exact: true }),
  ).toBeDisabled();
  await expect(
    conversation.getByRole('heading', { name: 'Describe feature title.', exact: true }),
  ).toBeVisible();
  const title = 'CSV exports from a conversation';
  for (const [field, value] of [
    ['title', title],
    ['audience', 'Analysts with report_export permission.'],
    ['behavior', 'Select start and end dates and download a CSV of matching rows.'],
    ['scope', 'Date selection and CSV download from existing reports.'],
  ] as const) {
    await answer(value);
    await expect(
      preview.locator('summary').filter({ hasText: fieldLabels[field] }).first(),
    ).toBeVisible();
  }
  await expect(
    conversation.getByRole('heading', { name: 'Describe out of scope.', exact: true }),
  ).toBeVisible();
  await expect(preview).not.toContainText('Exclude scheduled automation');
  await conversation.getByRole('button', { name: /Keep the first release focused/ }).click();
  await expect(preview).toContainText('6 of 12 fields proposed');
  await preview.locator('summary').filter({ hasText: 'Out of scope' }).first().click();
  await expect(
    preview.locator('p').filter({
      hasText: 'Exclude scheduled automation and additional export formats from the first release.',
    }),
  ).toBeVisible();
  for (const value of [
    'Given an authorized analyst, when a valid date range is selected, then download matching rows as CSV.',
    'Reject reversed dates. Export headers when there are no rows. Show a retry action after failure.',
    'Existing reports API and permission checks.',
    'Only export rows the analyst can already read. No new permissions.',
    'Analysts can export a matching CSV without copying rows manually.',
    'Normal priority because it removes a repeated manual step.',
  ])
    await answer(value);
  await expect(preview).toContainText('12 of 12 fields proposed');
  await page.screenshot({ path: 'test-results/request-builder-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  const overflow = await page.locator('body *').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.right > innerWidth + 1 &&
          getComputedStyle(element).position !== 'fixed'
        );
      })
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        width: element.getBoundingClientRect().width,
        right: element.getBoundingClientRect().right,
      }))
      .slice(0, 12),
  );
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/request-builder-mobile.png', fullPage: true });
  await preview.getByRole('checkbox').check();
  await builder.getByRole('button', { name: 'Use draft in form', exact: true }).click();
  await expect(page.getByLabel('Feature title', { exact: false })).toHaveValue(title);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByLabel('Product lead', { exact: true })
    .selectOption('10000000-0000-4000-8000-000000000002');
  await page
    .getByLabel('Engineering lead', { exact: true })
    .selectOption('10000000-0000-4000-8000-000000000003');
  await page.getByRole('button', { name: 'Create and submit for review', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/requests\/new$/);
  await page.getByRole('button', { name: 'Create and submit for review', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm and submit', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('.request-context')).toContainText('Ready for approval');
  const requestUrl = page.url();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000002');
  await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  await page.goto('/reviews');
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Approvals' })).toBeVisible();
  await expect(
    page
      .getByRole('tabpanel', { name: 'Approvals' })
      .getByRole('button', { name: 'Approve revision 1', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Edit request', exact: true })).toHaveCount(0);
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000004');
  await page.goto(requestUrl);
  await expect(page.getByRole('alert')).toContainText('This request could not be found.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
