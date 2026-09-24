# Minallo E2E QA Plan

This Playwright suite is organized as human-like QA, not only smoke tests. It uses the existing `tests/e2e` setup and shared helpers in `tests/e2e/pages` and `tests/e2e/utils`.

## What The Tests Cover

- `11-button-audit.spec.ts`: finds visible buttons, links, sidebar items, toolbar controls, quick action cards, and other click targets. It skips intentionally disabled and destructive actions, then verifies every clicked control causes a meaningful UI change.
- `12-navigation-map.spec.ts`: clicks the real sidebar/menu controls for dashboard, courses, chatbot, notes/summaries, editor, chat, notifications, games, settings, profile, and subscription.
- `13-chatbot.spec.ts`: verifies focus, typing, empty-send behavior, mocked AI send/response, file chooser, course import modal, controlled AI errors, and quick cards.
- `14-notes-summary-panels.spec.ts`: verifies the lecture notes page, PDF notes panel, summary tab, saved tab, expected delete-button placement, and panel sizing.
- `15-pdf-editor-toolbar.spec.ts`: verifies the PDF editor entry point, upload file chooser, text/highlight/draw tools, color/font controls, cursor visibility on a white document canvas, and non-dead toolbar buttons.
- `16-responsive.spec.ts`: runs in mobile/tablet projects and checks hamburger navigation, chatbot input usability, quick-card containment, and reachable navigation.

## How To Run

```bash
npm run test:e2e
```

Headed mode:

```bash
npm run test:e2e:headed
```

Open the HTML report:

```bash
npm run test:e2e:report
```

Run against production:

```bash
E2E_BASE_URL=https://minallo.de npm run test:e2e
```

On Windows PowerShell:

```powershell
$env:E2E_BASE_URL='https://minallo.de'; npm run test:e2e
```

## Credentials And Mocking

Authenticated tests use `E2E_EMAIL` and `E2E_PASSWORD` through `tests/e2e/auth.setup.ts`. The app session is saved to `tests/e2e/.auth/user.json`.

AI flows are mocked by `tests/e2e/utils/mocks.ts`, so normal E2E runs do not call OpenAI or burn tokens. The mocks cover success, loading, error, and timeout-style failures.

## Debugging Artifacts

`playwright.config.ts` keeps:

- screenshots on failure
- video on failure
- traces on failure
- an HTML report in `tests/e2e/report`

## Adding Button Tests

Prefer adding stable `data-testid` selectors to important UI controls, then include those selectors in `tests/e2e/utils/selectors.ts`. For new feature areas, add a focused spec and reuse:

- `AppPage.navigateTo(section)`
- `clickAndAssertChanged(locator)`
- `safeClick(locator)`
- `assertNoCriticalConsoleErrors(errors)`
- `assertNoCriticalNetworkFailures(failures)`
- `mockAiEndpoints(page)`

Do not click destructive controls unless the action is guarded, mocked, and reversible.

## Selector Contract

Use stable selectors for important controls. Current examples:

- `data-testid="sidebar-chatbot"`
- `data-testid="chatbot-input"`
- `data-testid="chatbot-send"`
- `data-testid="upload-files"`
- `data-testid="import-course"`
- `data-testid="quick-summarize"`
- `data-testid="quick-solve"`
- `data-testid="quick-exam-answer"`
- `data-testid="quick-flashcards"`
- `data-testid="notes-panel"`
- `data-testid="summary-panel"`
- `data-testid="pdf-editor-toolbar"`

Avoid relying only on CSS classes or exact visible text for high-value flows.
