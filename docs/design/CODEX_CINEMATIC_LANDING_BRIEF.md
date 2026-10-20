# Codex implementation brief — Minallo cinematic landing + crawlable SEO

**Status:** approved visual direction; implementation pending. Do not merge or deploy automatically.

## Source of truth
- Approved, working standalone design reference: docs/design/minallo-two-journeys-approved-reference.html (this branch). This is a visual/behavior reference, NOT a file to publish as the production landing page.
- Current Minallo brand: frontend/css/new-landing.css, frontend/css/typography.css, frontend/pages/new_landing.html.
- Current production HTML composition: frontend/index.html + scripts/build-production.mjs. In the current build, the new_landing.html fragment is inserted into dist/index.html at build time. **Do not regress this!**
- Public SEO infrastructure: frontend/robots.txt, frontend/llms.txt, scripts/build-seo.mjs, scripts/seo-pages-manifest.mjs, Cloudflare Pages deploy.
- Current billing: 7-day trial when eligible, then EUR 11.99/month, subject to actual eligibility and the existing checkout flow. Do not hardcode fictitious social proof or AI capabilities.

## Goals
1. Match the approved cinematic prototype closely in tone, story, color, layout, and interactions. Midnight navy + sky blue/cyan + Manrope, smooth cinematic sections, premium 3D-like detail. Keep page polished and usable.
2. Two distinct selectable journeys: (a) university student / course-based exam preparation; (b) German learner. A visitor sees a shared cinematic intro and deliberately chooses a journey. Allow changing routes easily, preserve keyboard and mobile usability.
3. Limit pinned scrollytelling. One signature feature reveal per journey uses an octopus-like central Minallo hub whose **individual feature arms appear one-by-one as the visitor scrolls**, while the screen pins. Do NOT turn the whole website into one continuous pinned slideshow.
4. Other meaningful content is separated into short story chapters and distinct interactive experiences. University path: overloaded files -> organized course workspace -> real-world application / physics demo -> structured tutoring -> summaries -> flashcards/quiz -> exam preparation -> adaptive pace. German path: comprehensible examples -> grammar -> vocabulary in context -> writing feedback -> German exam practice and tailored level. Use accurate feature claims only, differentiate real demo from illustrative examples.
5. AFTER visitors explore, invite them to take the personalized study-plan quiz; show a useful result before asking for signup and optional email-saving permission. Both paths then lead to the real onboarding/auth and subscription mechanics.

## HARD REQUIREMENT: All meaningful public product content must be crawlable without JavaScript
This is a RELEASE BLOCKER, as important as visual acceptance. A bot fetching a page without JS must learn what Minallo is, the two user journeys, how each feature works, what documents users can use, pricing/trial terms, differentiators, and links to deeper information. Preserve essential copy in the initial HTTP response as semantic HTML.

### Architectural approach
- Public marketing pages should be statically rendered at build time, NOT client-rendered empty shells. Keep using the project's Cloudflare Pages + TypeScript + build-production build-time injection approach. No React/Next migration just for SEO.
- Home page at /: meaningful hero and clear descriptions of BOTH journeys; two visible, crawlable text links using ordinary <a href> to dedicated URLs. The visual selector can animate but must work with JS disabled. Avoid using only div onClick, fragment-only navigation, or query strings as the *sole* URLs for discovery.
- Dedicated indexable URLs for each complete public journey, for example /student-journey.html and /german-learning.html. Each page has complete meaningful HTML in its **own raw response**, unique title/description/canonical, clear heading hierarchy, descriptive alt text, relevant links, factual sections and FAQs. A client-side transition may enhance navigation but is not required.
- Include an accessible text equivalent to every octopus arm, interactive learning scene, or canvas/3D-only visual: semantic heading, a genuine short paragraph, and relevant deep-link. These descriptions must be actual visible text, not hidden SEO-only copy. All feature details must NOT be injected only after scroll, click, IntersectionObserver, dynamic import, fetch, or animation completion. Reveal animations should affect appearance of existing HTML nodes, not whether the content exists.
- Client-side JS can control scene pinning, octopus arm transitions, simulation sliders, quizzes, and motion. Graceful no-JS and prefers-reduced-motion fallbacks must show the information and allow following links.
- Avoid hiding all alternative-journey content behind CSS and hoping it indexes; give each journey its own canonical URL and visible route-specific content.
- Public links to relevant existing static feature pages must use actual <a href> so crawlers can follow. Do not put useful feature detail exclusively in modals, tooltips, SVG/canvas/3D, CSS ::before content, or JS template strings.
- Server response status should be 200 for valid pages, 404 for missing URLs; no blanket redirect to an authenticated app for public marketing pages. Preserve authenticated app behavior in /app/.

### Discovery, metadata, structured data
- Preserve existing public page canonical and robots-meta conventions. Add unique page-level titles, meaningful meta descriptions, canonical links, Open Graph/social metadata for public routes; avoid duplicate content/canonicals.
- Register new public pages in scripts/seo-pages-manifest.mjs, regenerate dist/sitemap.xml, and keep navigation/footer/internal links and frontend/llms.txt consistent with published facts. llms.txt is supplementary; not a substitute for indexable pages or discoverability.
- Inspect frontend/robots.txt and Cloudflare WAF/CDN access, ensure public marketing pages are crawlable by Googlebot and **OAI-SearchBot** for ChatGPT Search; do NOT indiscriminately change the separate GPTBot training policy without an explicit product decision. Bot impersonation or user-agent-specific content (cloaking) is not allowed.
- Maintain accurate SoftwareApplication/Organization/WebSite structured data where justified; add FAQPage only if relevant FAQs are actually on the page and content matches visible text; do not promise rich-result eligibility. Include correct price/trial details where shown and a clear privacy/consent explanation.
- Maintain accessible EN/DE language labeling and hreflang ONLY for URLs that truly contain the corresponding language, not just because a journey is for German learners.
- Minallo can have poor ChatGPT recognition for many reasons, including crawl discovery and freshness; fixing code increases accessibility but cannot guarantee indexing or a specific assistant answer.

## Visual/interaction implementation
- Respect the approved HTML prototype, but split implementation into maintainable modules (hero, route selector, single octopus reveal, demos, quiz, shared UI). No giant monolithic new-landing.js rewrite.
- Maintain Minallo visual branding from the current site: #020617/#031323 dark navy, #38bdf8/#7dd3fc blue accents, Manrope, rounded glass surfaces; preserve responsive premium feel.
- One pinned octopus diagram sequence for Student and one for German path (as needed) with connected nodes revealing individually; keep the diagram accessible as a list of visible feature summaries. Pinned timelines should never trap wheel/touch/keyboard navigation. Add skip/continue controls.
- Provide desktop + mobile + touch + keyboard behavior; respect prefers-reduced-motion, avoid motion sickness. Progressive enhancement: layout works if canvas/WebGL fails, animation library fails, or JS is disabled.
- Real demo requests must be safely sandboxed using public sample material ONLY. No unguarded anonymous access to authenticated AI endpoints, no real user documents, no leaked keys, strict input size and rate limits. If backend demo isn't feasible in this PR, use a clearly labeled interactive sample and leave a scoped follow-up; do not call it “live AI”.
- Do not introduce unnecessary big 3D packages if CSS/optimized video/Three.js-on-demand can achieve result. Lazy-load heavy interactive code and media below the fold.
- Keep existing app, Supabase auth, account flow, checkout integration, legal pages, accessibility, analytics, subscription accuracy and Cloudflare deployment intact.
- No changes to the production pricing, free-trial entitlement, or subscription logic for a marketing redesign.

## Testing / Definition of done (Codex must automate)
- npm run build, npm run typecheck, npm test, relevant npm run test:e2e, plus relevant lint checks.
- Add a no-JS/source HTML test parsing **dist/index.html, dist/student-journey.html, dist/german-learning.html**. Assert each raw HTML file (without executing any JS) contains all meaningful product text, clear H1/H2s, journey-relevant features, priced offer where shown, crawlable links, and no empty root shell. Validate actual build output, not just source templates.
- Assert the text for each octopus arm and interactive chapter is present in the corresponding raw HTML and that there is a human-visible text explanation, not merely animation/canvas/JS.
- Test with JS disabled in Playwright: homepage choose links work, path pages show content, footer/legal links available. Test JS-enabled journeys and interactive demos: route choice, octopus arms, scrolling, keyboard controls, quiz and plan; test mobile widths 390px and desktop ~1440px.
- Test reduced-motion and unsupported-WebGL fallback, correct 404s, canonical/meta/robots tags, sitemap entries, href links, and language handling.
- Capture baseline and new mobile/Desktop screenshots. Audit overflow/CLS/contrast and keep motion from delaying usable content. LCP, INP, CLS should meet Core Web Vitals targets where practical.
- After staging deploy, fetch URLs as plain HTTP clients (curl with JS off) and check full content, canonical, robots.txt, sitemap.xml and llms.txt; verify Cloudflare challenge/rate limits do not block legitimate crawler traffic. We have not yet verified the production HTTP responses, so do not report them as confirmed.
- Manually validate with Google Search Console URL Inspection and Rich Results Test as available. For ChatGPT discovery, check OAI-SearchBot access from trusted crawler IP ranges and confirm search visibility over time. Neither Google nor ChatGPT appearance can be guaranteed.
- Produce a detailed draft PR with screenshots, no-JS crawl verification excerpts, tests, performance results, gaps/follow-ups, and any implementation deviations from the approved prototype. Do not auto-merge.

## Avoid these regressions
- Turning production home page into an empty JS shell.
- Replacing statically present marketing copy with animated-only content.
- Keeping only one indexable canonical page and hiding the entire other journey in client state.
- Publishing prototype examples as proven live AI responses.
- Writing misleading “unlimited” or guaranteed grades claims, invented conversion statistics/testimonials, or hiding subscription renewal details.
- Changing /app auth, Stripe/PayPal/subscriptions or user course data in the redesign.

## Suggested execution order
A. Baseline: inspect current production build and crawler checks; document existing accessible copy.
B. Static HTML foundation: create public route(s), semantic copy, metadata, FAQ, links, SEO manifest, robust no-JS tests.
C. Cinematic layout and route-selection with responsive styling.
D. Single octopus pinned reveal per journey, real separate feature experiences, reduced-motion handling.
E. Study-plan quiz / onboarding handoff (no pricing changes).
F. QA, screenshots, crawler HTTP verification, draft PR for review.

**Finish with implementation PR (not a plan-only response).**