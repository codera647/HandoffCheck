import { test, expect } from '@playwright/test';

test.describe('public branding pages without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('policies and overview are readable with no session or backend and work on narrow screens', async ({
    page,
  }) => {
    const backendRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('supabase.co')) backendRequests.push(request.url());
    });
    await page.route('**/*.supabase.co/**', (route) => route.abort());
    for (const [path, heading] of [
      ['/about', 'Feature requests ready for engineering review'],
      ['/privacy', 'Privacy policy'],
      ['/terms', 'Terms of service'],
    ]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(await response!.text()).toContain(`<h1>${heading}</h1>`);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      const footer = page.getByRole('contentinfo');
      await expect(footer.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute(
        'href',
        '/privacy',
      );
      await expect(footer.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute(
        'href',
        '/terms',
      );
      await page.setViewportSize({ width: 320, height: 740 });
      // Locator measurements work while page-authored JavaScript remains disabled.
      const main = await page.getByRole('main').boundingBox();
      expect(main!.width).toBeLessThanOrEqual(320);
      await expect(page.getByRole('link', { name: 'Open app', exact: true })).toBeVisible();
      await page.screenshot({ path: `test-results/public-${path.slice(1)}-mobile.png` });
    }
    await page.goto('/privacy');
    await page.getByRole('link', { name: 'Retention and deletion', exact: true }).click();
    await expect(page).toHaveURL(/\/privacy#retention$/);
    await expect(page.getByRole('heading', { name: '7. Retention and deletion' })).toBeInViewport();
    await page.getByRole('link', { name: 'Terms', exact: true }).click();
    await expect(page).toHaveTitle('Terms of service | HandoffCheck');
    expect(backendRequests).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/privacy');
    await page.screenshot({ path: 'test-results/public-privacy-desktop.png' });
  });
});

test('sign-in links load public documents and return to the app without a login redirect', async ({
  page,
}) => {
  await page.goto('/login');
  const links = page.getByRole('navigation', { name: 'Information' });
  await links.getByRole('link', { name: 'Privacy', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page).toHaveTitle('Privacy policy | HandoffCheck');
  await expect(page.getByText('unpaid Gemini quota', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'moiz44386@gmail.com' }).first()).toHaveAttribute(
    'href',
    'mailto:moiz44386@gmail.com',
  );
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveTitle('About HandoffCheck');
  await page.getByRole('link', { name: 'Open app', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});
