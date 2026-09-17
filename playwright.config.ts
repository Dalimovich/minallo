import { defineConfig, devices } from '@playwright/test';

// 22-german-exam-engine-live.spec.ts and 23-lesen-reading-live.spec.ts make
// real OpenAI (+ TTS, for Hören) calls against the same 30/hour
// ai_german_exam_generate rate limit a real learner would hit, so neither
// must run on every push/PR the way the rest of this project's Desktop
// Chrome tests do (that already exhausted the shared E2E account's limit
// once during manual verification). Both are excluded from the default
// project below unless this env var opts them back in — set only by the
// dedicated e2e-german-exam-live.yml workflow (manual/nightly), which also
// filters the run to just those files via its CLI invocation.
const INCLUDE_LIVE_GERMAN_EXAM_E2E = process.env.E2E_INCLUDE_GERMAN_EXAM_LIVE === '1';
const LIVE_GERMAN_EXAM_SPECS = ['**/22-german-exam-engine-live.spec.ts', '**/23-lesen-reading-live.spec.ts'];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { outputFolder: 'tests/e2e/report', open: 'never' }], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8788',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // Only spin up local dev server when not pointing at a remote URL (i.e. local runs only)
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:8788',
    reuseExistingServer: true,
    timeout: 60000,
  },
  projects: [
    { name: 'setup', testMatch: '**/auth.setup.ts' },
    {
      name: 'Desktop Chrome',
      testIgnore: INCLUDE_LIVE_GERMAN_EXAM_E2E ? undefined : LIVE_GERMAN_EXAM_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'Mobile Chrome',
      testMatch: [
        '**/12-navigation-map.spec.ts',
        '**/13-chatbot.spec.ts',
        '**/16-responsive.spec.ts',
        '**/18-german-learner.spec.ts',
        '**/20-writing-coach-workspace.spec.ts',
      ],
      use: {
        ...devices['Pixel 5'],
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'Tablet',
      testMatch: [
        '**/12-navigation-map.spec.ts',
        '**/13-chatbot.spec.ts',
        '**/16-responsive.spec.ts',
        '**/18-german-learner.spec.ts',
        '**/20-writing-coach-workspace.spec.ts',
      ],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 820, height: 1180 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
});
