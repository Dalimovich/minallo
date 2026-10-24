import { test, expect } from '@playwright/test';

for (const height of [600, 650, 768]) {
  test(`laptop ${height}px keeps the complete diagram pinned through its reveal`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1366, height });
    for (const path of ['/student-journey.html', '/german-learning.html']) {
      await page.goto(path);
      const section = page.locator('.octopus-scroll');
      await expect(section).toHaveClass(/map-enhanced/);
      await section.evaluate((el) =>
        window.scrollTo({ top: (el as HTMLElement).offsetTop - 150, behavior: 'instant' })
      );
      await page.mouse.move(680, 100);
      await page.mouse.wheel(0, 5000);
      await expect
        .poll(() => section.evaluate((el) => Math.abs(el.getBoundingClientRect().top)))
        .toBeLessThan(5);
      await section.evaluate((el) =>
        window.scrollTo({ top: (el as HTMLElement).offsetTop + 100, behavior: 'instant' })
      );
      await expect(page.locator('.oct-pin')).toHaveCSS('position', 'sticky');
      await page.mouse.move(680, 320);
      await page.mouse.wheel(0, 600);
      await expect.poll(() => page.locator('.oct-line.revealed').count()).toBeGreaterThan(0);
      expect(
        await page.locator('.oct-pin').evaluate((el) => Math.abs(el.getBoundingClientRect().top))
      ).toBeLessThan(2);
      // All five readable cards must fit once the reveal is complete.
      await section.evaluate((el) =>
        window.scrollTo({
          top: (el as HTMLElement).offsetTop + el.clientHeight - innerHeight - 20,
          behavior: 'instant'
        })
      );
      await expect(page.locator('.oct-node.pending')).toHaveCount(0);
      for (const node of await page.locator('.oct-node').all()) {
        const box = await node.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      }
      await page.screenshot({
        path: `audit/cinematic/laptop-${height}-${path.includes('student') ? 'student' : 'german'}.png`
      });
    }
  });
}
