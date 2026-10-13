import { test, expect } from '@playwright/test';

test('both leads approve, author exports, editing preserves the historical brief', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/requests-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Export reports by date range', exact: true }).click();
  await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve revision 1', exact: true })).toHaveCount(
    0,
  );
  const authorUrl = page.url();
  await page.getByLabel('Demo identity').selectOption({ label: 'Alex Morgan · Product lead' });
  await page.goto(authorUrl);
  await page.getByRole('button', { name: 'Approve revision 1', exact: true }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve revision 1', exact: true })
    .click();
  await expect(
    page.getByText('Product approval recorded for revision 1.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Demo identity').selectOption({ label: 'Sam Rivera · Engineering lead' });
  await page.goto(authorUrl);
  await page.getByRole('button', { name: 'Approve revision 1', exact: true }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve revision 1', exact: true })
    .click();
  await page.getByRole('button', { name: 'Generate brief', exact: true }).click();
  await page.getByRole('link', { name: 'Open brief' }).click();
  await expect(
    page.getByRole('heading', { name: 'Export reports by date range', exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
  await page.screenshot({ path: 'test-results/brief-desktop.png', fullPage: true });
  await page.getByLabel('Demo identity').selectOption({ label: 'Maya Chen · Member' });
  await page.goto(authorUrl);
  await page.getByRole('link', { name: 'Edit request' }).click();
  await page
    .getByLabel('In scope', { exact: false })
    .fill('Date selection and CSV export with a revised loading state.');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(page.getByText('Revision 2', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Brief for revision 1' })).toBeVisible();
  await page.getByRole('link', { name: 'Brief for revision 1' }).click();
  await expect(
    page
      .getByText('This brief is for revision 1. The current request is revision 2.', {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('new drafts save incomplete, private demo files attach and download', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await page.getByRole('link', { name: 'New feature request' }).click();
  await page.getByLabel('Feature title', { exact: false }).fill('Test access request');
  await page.getByLabel('Product lead', { exact: true }).selectOption({ label: 'Alex Morgan' });
  await page.getByLabel('Engineering lead', { exact: true }).selectOption({ label: 'Sam Rivera' });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('link', { name: 'Edit request' }).click();
  await page.getByLabel('Screenshots or PDFs').setInputFiles({
    name: 'context.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nDemo reference\n%%EOF'),
  });
  await expect(page.getByText('context.pdf', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('context.pdf');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Needs clarification', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: /Review \(/ }).click();
  await expect(
    page.getByText('Checklist-only review. Language ambiguity has not been reviewed by AI.'),
  ).toBeVisible();
});

test('narrow layout and keyboard navigation remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByLabel('Demo identity')).toBeVisible();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.screenshot({ path: 'test-results/requests-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Export reports by date range', exact: true }).click();
  await page.getByRole('tab', { name: 'Requirements', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Review', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
