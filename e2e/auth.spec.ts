import { test, expect } from '@playwright/test';

test('cancelled Google login clears the callback and remains usable after a demo session', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.goto('/auth/callback?error=access_denied&error_description=private-provider-details');
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByText('Google sign-in was cancelled. You can try again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('private-provider-details')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/google-login-cancelled.png', fullPage: true });
  await page.getByRole('button', { name: 'Open demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
});
