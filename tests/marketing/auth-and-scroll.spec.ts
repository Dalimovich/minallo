import { test, expect } from '@playwright/test';

test('reading a journey for 26 seconds does not reload it or erase quiz answers', async ({
  page
}) => {
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ body: '' }));
  await page.clock.install();
  await page.goto('/student-journey.html#plan');
  await expect(page.locator('#plan-form button[type=submit]')).toBeEnabled();
  await page.locator('#subject').fill('My preserved course');
  await page.clock.fastForward(26000);
  await expect(page).toHaveURL(/student-journey\.html#plan$/);
  await expect(page.locator('#subject')).toHaveValue('My preserved course');
});

test('sign-in recovers when the initial auth script fails to load', async ({ page }) => {
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ body: '' }));
  let requests = 0;
  await page.route('**/js/auth-bootstrap.js*', (route) =>
    ++requests === 1 ? route.abort() : route.continue()
  );
  await page.route('**/app/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Existing auth flow</h1>' })
  );
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app\//);
  expect(requests).toBe(2);
});

test('feature-map wheel pacing preserves browser zoom and the skip control', async ({
  page
}, info) => {
  await page.goto('/student-journey.html');
  if (info.project.name !== 'desktop') {
    await expect(page.locator('.oct-pin')).toHaveCSS('position', 'relative');
    await page.getByRole('link', { name: 'Skip feature reveal' }).click();
    await expect(page).toHaveURL(/#student-lab$/);
    return;
  }
  await page
    .locator('.octopus-scroll')
    .evaluate((el) =>
      window.scrollTo({ top: (el as HTMLElement).offsetTop + 700, behavior: 'instant' })
    );
  const zoomPrevented = await page.locator('.octopus-scroll').evaluate((el) => {
    const event = new WheelEvent('wheel', {
      deltaY: 100,
      ctrlKey: true,
      cancelable: true,
      bubbles: true
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(zoomPrevented).toBe(false);
  await page
    .locator('.octopus-scroll')
    .dispatchEvent('wheel', { deltaY: -12000, bubbles: true, cancelable: true });
  await page.getByRole('link', { name: 'Skip feature reveal' }).click();
  await expect(page).toHaveURL(/#student-lab$/);
  await expect
    .poll(() =>
      page.locator('#student-lab').evaluate((el) => Math.abs(el.getBoundingClientRect().top))
    )
    .toBeLessThan(50);
});

test('failed cinematic JavaScript leaves the public page readable and stable', async ({ page }) => {
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ body: '' }));
  await page.route('**/js/pages/cinematic/**', (route) => route.abort());
  await page.clock.install();
  await page.goto('/german-learning.html#german-grammar');
  await page.clock.fastForward(26000);
  await expect(page).toHaveURL(/german-learning\.html#german-grammar$/);
  await expect(page.locator('.oct-pin')).toHaveCSS('position', 'relative');
  await expect(page.locator('#german-grammar')).toContainText('weil');
  await page.locator('footer a[href="/privacy.html"]').click();
  await expect(page).toHaveURL(/privacy/);
});
