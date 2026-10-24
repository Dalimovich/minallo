import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/marketing',
  fullyParallel: true,
  workers: 2,
  reporter: [['list'], ['html', { outputFolder: 'tests/e2e/report/marketing', open: 'never' }]],
  use: {
    baseURL: process.env.MARKETING_BASE_URL || 'http://127.0.0.1:4178',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: process.env.MARKETING_BASE_URL
    ? undefined
    : {
        command: 'node scripts/serve-marketing.mjs',
        url: 'http://127.0.0.1:4178',
        reuseExistingServer: !process.env.CI
      },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    }
  ]
});
