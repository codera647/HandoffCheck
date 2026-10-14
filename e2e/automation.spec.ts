import { test, expect } from '@playwright/test';

async function enableAssistance(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000004');
  await page.goto('/settings/automation');
  await page.getByLabel('Enable simulated assistance').check();
  await page.getByLabel('Suggested requirement edits').check();
  await page.getByLabel('Reviewer summaries').check();
  await page.getByLabel('QA drafts').check();
  await page.getByLabel('Generate brief after both approvals').check();
  await page.getByRole('button', { name: 'Save automation settings' }).click();
  await expect(page.getByLabel('Enable simulated assistance')).toBeChecked();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000001');
  await page.goto('/requests');
  await page.getByRole('link', { name: 'Export reports by date range', exact: true }).click();
}
test('simulated suggestions require author confirmation and create a new revision', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enableAssistance(page);
  await page.getByRole('button', { name: 'Suggest requirement edits' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested edits', exact: true })).toBeVisible();
  const url = page.url();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000002');
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Review and accept edit' })).toHaveCount(0);
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000001');
  await page.goto(url);
  await page.getByRole('button', { name: 'Review and accept edit' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Accept edit and save revision' }).click();
  await expect(page.getByText('Revision 2', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Edit accepted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare reviewer summary' }).click();
  await expect(page.getByRole('heading', { name: 'Reviewer summary', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/assistance-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('automatic brief waits for both leads; QA drafts remain separate and Linear demo is inert', async ({
  page,
}) => {
  await enableAssistance(page);
  const url = page.url();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000002');
  await page.goto(url);
  await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
  await page
    .getByRole('tabpanel', { name: 'Approvals' })
    .getByRole('button', { name: 'Approve revision 1', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve revision 1', exact: true })
    .click();
  await expect(page.getByRole('link', { name: 'Open brief', exact: true })).toHaveCount(0);
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000003');
  await page.goto(url);
  await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
  await page
    .getByRole('tabpanel', { name: 'Approvals' })
    .getByRole('button', { name: 'Approve revision 1', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve revision 1', exact: true })
    .click();
  await page.getByRole('link', { name: 'Open brief', exact: true }).click();
  await page.getByRole('button', { name: 'Draft QA checklist' }).click();
  await expect(
    page.getByRole('heading', { name: 'QA checklist draft', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mark QA draft reviewed' }).click();
  await expect(page.getByText('Reviewed by Sam Rivera.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('These tests have not been executed.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('The local demo does not send tickets to Linear.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/automation-brief-desktop.png', fullPage: true });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.brief-document')).toBeVisible();
  await expect(page.locator('.assistance-section').first()).not.toBeVisible();
  await expect(page.locator('.notifications')).not.toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000004');
  await page.goto('/settings/linear');
  await expect(page.getByRole('button', { name: 'Load accessible teams' })).toBeDisabled();
});
