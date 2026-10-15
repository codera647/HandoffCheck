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
  await expect(page.getByText('Automation settings saved.', { exact: true })).toBeVisible();
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
  // Clipboard boundary is mocked so this test never changes the user's clipboard.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.copiedResponse = value;
        },
      },
    }),
  );
  await enableAssistance(page);
  await page.getByRole('link', { name: 'Open assistant', exact: true }).click();
  await expect(page.locator('.assistant-header')).toBeInViewport();
  await page.getByRole('button', { name: 'Suggest requirement edits' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested edits', exact: true })).toBeVisible();
  const activity = page.getByRole('log', { name: 'Assistant activity' });
  const edits = activity
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Suggested edits', exact: true }) });
  await edits.getByText('Compare source and suggested edit', { exact: true }).click();
  await expect(edits.getByText('Saved requirement', { exact: true })).toBeVisible();
  await edits.getByText('Source: Expected behavior', { exact: true }).click();
  await edits.getByRole('button', { name: 'View full source', exact: true }).click();
  await expect(page.getByLabel('Inspect source')).toHaveValue('behavior');
  await expect(page.locator('.assistant-source-text')).toBeFocused();
  await edits.getByRole('button', { name: 'Copy response', exact: true }).click();
  await expect(page.getByText('Response copied.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.copiedResponse)).toContain(
    'Source (Expected behavior):',
  );
  await page
    .locator('.assistance-section')
    .screenshot({ path: 'test-results/assistant-suggestions-desktop.png' });
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
  await page.getByRole('button', { name: 'Revision 2', exact: true }).click();
  await expect(activity.getByText('Edit accepted', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All revisions', exact: true }).click();
  await expect(activity.getByText('Edit accepted', { exact: true })).toBeVisible();
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
  await expect(
    page.getByText('Product approval recorded for revision 1.', { exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByText('Engineering approval recorded for revision 1.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open brief', exact: true }).click();
  await page.getByRole('button', { name: 'Draft QA checklist' }).click();
  await expect(
    page.getByRole('heading', { name: 'QA checklist draft', exact: true }),
  ).toBeVisible();
  const assistant = page.getByRole('region', { name: 'QA assistance', exact: true });
  const scenarios = assistant.locator('.assistant-test');
  await expect(scenarios.first()).toHaveAttribute('open', '');
  await expect(
    assistant.getByRole('heading', { name: 'Expected result', exact: true }),
  ).toBeVisible();
  await expect(scenarios.first().locator('.assistant-test-steps')).toHaveCSS(
    'list-style-type',
    'decimal',
  );
  const scenarioCount = await scenarios.count();
  expect(scenarioCount).toBeGreaterThan(1);
  await assistant.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(assistant.locator('.assistant-test[open]')).toHaveCount(scenarioCount);
  await assistant.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(assistant.locator('.assistant-test[open]')).toHaveCount(0);
  // Native disclosure controls also work with the keyboard.
  await scenarios.first().locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(scenarios.first()).toHaveAttribute('open', '');
  await scenarios.first().getByText('Source: Acceptance criterion 1', { exact: true }).click();
  await scenarios.first().getByRole('button', { name: 'View full source', exact: true }).click();
  await expect(assistant.getByLabel('Inspect source')).toHaveValue('criteria');
  await expect(assistant.locator('.assistant-source-text')).toBeFocused();
  await assistant.getByRole('button', { name: 'Draft QA checklist', exact: true }).focus();
  await assistant.locator('.assistant-thread').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await assistant.evaluate((element) =>
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 12),
  );
  await page.screenshot({ path: 'test-results/assistant-qa-formatted-desktop.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assistant.evaluate((element) =>
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 12),
  );
  await page.screenshot({ path: 'test-results/assistant-qa-formatted-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
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

test('personal clear chat persists, preserves other accounts and can reveal saved responses or restore history', async ({
  page,
}) => {
  await enableAssistance(page);
  const url = page.url();
  const assistant = page.getByRole('region', { name: 'Requirement assistance', exact: true });
  const log = page.getByRole('log', { name: 'Assistant activity' });
  await assistant.getByRole('button', { name: 'Prepare reviewer summary', exact: true }).click();
  await expect(log.getByRole('heading', { name: 'Reviewer summary', exact: true })).toBeVisible();
  await assistant.getByRole('button', { name: 'Clear chat', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear chat', exact: true }).click();
  await expect(log.getByRole('article')).toHaveCount(0);
  await expect(page.locator('.request-context')).toContainText('Ready for approval');
  await page.reload();
  await expect(log.getByRole('article')).toHaveCount(0);
  await expect(
    assistant.getByRole('button', { name: 'Restore messages', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000002');
  await page.goto(url);
  await expect(log.getByRole('heading', { name: 'Reviewer summary', exact: true })).toBeVisible();
  await page.getByLabel('Demo identity').selectOption('10000000-0000-4000-8000-000000000001');
  await page.goto(url);
  await expect(log.getByRole('article')).toHaveCount(0);
  await assistant.getByRole('button', { name: 'Prepare reviewer summary', exact: true }).click();
  await expect(log.getByRole('heading', { name: 'Reviewer summary', exact: true })).toBeVisible();
  await expect(
    assistant.getByText('Showing the saved response for this revision.', { exact: true }),
  ).toBeVisible();
  await assistant.getByRole('button', { name: 'Restore messages', exact: true }).click();
  await expect(log.getByRole('heading', { name: 'Checklist review', exact: true })).toBeVisible();
  await expect(assistant.getByText('Messages restored.', { exact: true })).toBeVisible();
});
