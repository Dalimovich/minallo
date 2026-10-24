import { test, expect } from '@playwright/test';

const journeys = [
  { path: '/student-journey.html', story: '#student-story', features: '#student-features' },
  { path: '/german-learning.html', story: '#german-story', features: '#german-features' }
];

for (const { path, story, features } of journeys) {
  test(`${path}: opening chapters pin, reveal sequentially and release into the feature map`, async ({
    page
  }, info) => {
    await page.goto(path);
    const runway = page.locator(`${story} .story-runway`);
    if (info.project.name !== 'desktop') {
      // No-JS/mobile/reduced-motion fallback: every chapter is simultaneously
      // visible in normal flow, nothing pinned, nothing hidden from a crawler.
      for (const chapter of await page.locator(`${story} .journey-chapter`).all()) {
        await expect(chapter).toBeVisible();
      }
      return;
    }
    await expect(runway).toHaveClass(/story-enhanced/);
    await expect(page.locator(`${story} .story-stage`)).toHaveCSS('position', 'sticky');

    // A realistic fast flick must still show every chapter, not skip straight
    // from the first to the last (the bug this test guards against): watch
    // every animation frame while a real wheel flick crosses the whole runway.
    await runway.evaluate((el) => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.evaluate(() => {
      (window as any).__seen = new Set();
      const sample = () => {
        const el = document.querySelector('.journey-chapter.story-active');
        if (el) (window as any).__seen.add((el as HTMLElement).dataset.scene);
        (window as any).__raf = requestAnimationFrame(sample);
      };
      sample();
    });
    await page.mouse.move(700, 400);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 500);
    await page.waitForTimeout(3500);
    const everActive = await page.evaluate(() => {
      cancelAnimationFrame((window as any).__raf);
      return [...(window as any).__seen].sort();
    });
    expect(everActive).toEqual(['0', '1', '2']);

    // Counter and prev/next controls reflect the final step.
    await expect(page.locator(`${story} .story-counter`)).toContainText('03 / 03');
    await expect(page.locator(`${story} .story-controls [data-direction="1"]`)).toBeVisible();

    // Ctrl+wheel must stay browser zoom, never hijacked.
    const zoomPrevented = await runway.evaluate((el) => {
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

    // Continuing to scroll releases into the feature map; pinned sections do
    // not trap the user.
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(40);
    }
    await expect(page.locator(features)).toHaveClass(/map-enhanced/);
  });
}

test('story chapters: skip link is reachable without scrolling', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'pin/skip controls only render on desktop');
  await page.goto('/student-journey.html');
  await page.getByRole('link', { name: 'Skip introduction' }).click();
  await expect(page).toHaveURL(/#student-features$/);
});
