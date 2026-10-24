# Cinematic landing review — 2026-10-24

Implemented on `preview/cinematic-landing` from the approved handoff. Homepage and dedicated student/German journeys preserve the navy/cyan palette, Manrope, cinematic chapters, and one sequential pinned feature map per journey on suitable desktop screens. Mobile, reduced-motion, failed-script, and no-JavaScript visitors receive readable normal-flow content. Both journeys include explicitly labeled local samples and a personalized local quiz, followed by the existing authentication entry.

The production build retains marketing HTML injection. Product descriptions, features, pricing (eligible 7-day trial, then €11.99/month), limitations, and public links are present in initial HTML. Journey canonicals, metadata, sitemap, llms.txt, and semantic feature links are included. GPTBot policy is unchanged.

## Final reliability fixes

### Laptop reveal correction

The original 800px minimum viewport height disabled both sticky pinning and the connected diagram on common laptops. Reproduced on the deployed preview at 1366×650 and 1366×768. The reveal now fits desktop content areas down to 600px high, with compact spacing and fully visible cards. Fast wheel gestures crossing into the section stop at its entrance instead of jumping over it. Mobile and reduced-motion fallback behavior is preserved. CSS/module URLs were versioned to avoid stale cached behavior.

Regression coverage exercises both journeys at 600, 650 and 768px heights, real wheel entry, sequential arms, sticky screen position and all five cards inside the viewport. Screenshots: [600px student](../../audit/cinematic/laptop-600-student.png), [768px German](../../audit/cinematic/laptop-768-german.png).

- Prevent the application startup watchdog from reloading an already-rendered marketing page and clearing quiz answers.
- Await deferred authentication initialization and retry failed script loads when sign-in is selected.
- Preserve browser zoom and native controls during paced feature-map scrolling; cancel queued scrolling when users skip or use the keyboard.
- Refresh asset versions on all three public entry pages.

New regression tests failed against the previous build and pass with these fixes.

## Validation

| Check | Result |
| --- | --- |
| `npm run test:marketing` | Production build, 5 HTML/plan checks, 24 desktop/mobile Playwright tests passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Zero errors; one existing unused eslint-disable warning in generated chatbot experience-mode.js |
| Focused cinematic/auth lint | Passed |
| `npm test` | 1017 passed; 1 unrelated learner-persistent-panel test failed: “stays closed in ncb-view-practice” |
| `npm run verify:marketing:http -- http://127.0.0.1:4182` | Normal, Googlebot and OAI-SearchBot raw responses, canonicals, discovery files and missing-route 404 passed |
| `git diff --check` | Passed |

Browser coverage includes JavaScript disabled, 320px layout, keyboard navigation, reduced motion, sequential reveals and skip, local demonstrations, quiz input safety, auth handoff/recovery, idle-page stability, unavailable WebGL, and automated WCAG A/AA checks. Authentication was verified through handoff to the existing app; real account creation, Google consent, billing and purchases were not exercised.

The unrelated full-suite failure reads unchanged chatbot CSS and is outside this landing change. The complete repository suite is therefore not green.

## Performance observations

Local Chromium measurements with 4x CPU slowdown, 1.6 Mbps download and 150ms latency. These are lab observations, not field Core Web Vitals or INP.

| Page | Desktop LCP | Mobile LCP | Largest sampled desktop/mobile interaction |
| --- | --- | --- | --- |
| Home | 2352ms | 2056ms | 128ms / 48ms |
| Student | 2652ms | 2372ms | 96ms / 32ms |
| German | 2456ms | 2168ms | 96ms / 40ms |

CLS was zero except desktop home (0.000405). Desktop student LCP exceeds the 2.5s target in this run. No page exceptions or failed requests were recorded. Existing Google One Tap emitted vendor warnings about deprecated status methods/empty accounts and a FedCM token error in an anonymous session. Full measurements: [performance.json](../../audit/cinematic/performance.json).

## Screenshots

- [Desktop home](../../audit/cinematic/home-desktop.png) and [mobile home](../../audit/cinematic/home-mobile.png)
- [Journey chooser](../../audit/cinematic/chooser-desktop.png)
- [Desktop feature map](../../audit/cinematic/feature-map-desktop.png)
- [Mobile student with JavaScript disabled](../../audit/cinematic/student-no-js-mobile.png)
- [Mobile personalized plan](../../audit/cinematic/student-plan-mobile.png)
- [Mobile German pace section](../../audit/cinematic/german-pace-mobile.png)

## Staging verification

The existing GitHub integration automatically built previews after the push. No manual deployment was performed. At commit `e2419984`, the [Cloudflare branch preview](https://preview-cinematic-landing.minallo.pages.dev) passed all raw HTTP/content checks for normal, Googlebot and OAI-SearchBot requests, discovery files and missing-route 404. Cloudflare redirects `.html` journey paths to extensionless paths; their canonical metadata remains the production `.html` URL.

Preview hosting adds `X-Robots-Tag: noindex`. The strict production check correctly rejected this; the explicit `--preview` mode permits that hosting header while still checking semantic HTML, canonicals, document robots metadata, user-agent parity and discovery. It does not establish production indexability. The Netlify integration also reported a ready preview, but its homepage returned 404; use the working Cloudflare preview for review.

Checks do not establish WAF access from trusted crawler IPs, search indexing, or production performance. Repeat preview checks with:

```sh
npm run verify:marketing:http -- https://preview-cinematic-landing.minallo.pages.dev --preview
```

For the production release, retain the strict check without that flag:

```sh
npm run verify:marketing:http -- https://APPROVED-PREVIEW-HOST
```

Also check deployed redirect/canonical behavior, authentication with a real test account, Google structured-data validation, and crawler access at the hosting layer. Review this draft before merging. The design references remain handoff documents, not production artifacts.
