// Single source of truth for the public marketing pages: drives both the
// shared footer (build-seo.mjs splices it into every page's
// <!-- MINALLO_FOOTER --> marker) and the auto-generated sitemap.xml.
// Previously the footer was hand-copied into 14 files and sitemap.xml was a
// hand-maintained list — both drifted. Add a page here once; it reaches both.
//
// hreflangGroup: pages sharing the same group key get <xhtml:link rel="alternate">
// entries pointing at each other plus an x-default pointing at the English page.

export const HOME_PAGE = {
  path: '/',
  lang: 'en',
  hreflangGroup: null,
  lastmod: '2026-05-21',
  changefreq: 'weekly',
  priority: 1.0,
};

export const LEGAL_PAGES = [
  { path: '/privacy.html', lastmod: '2026-06-10', changefreq: 'yearly', priority: 0.3 },
  { path: '/impressum.html', lastmod: '2026-06-10', changefreq: 'yearly', priority: 0.3 },
  { path: '/terms.html', lastmod: '2026-06-10', changefreq: 'yearly', priority: 0.3 },
  { path: '/withdrawal.html', lastmod: '2026-06-10', changefreq: 'yearly', priority: 0.3 },
];

// "Group A" — already on the seo-landing.css / seo-nav / seo-footer system.
const NO_VARIANT_PAGES = [
  '/flashcards-from-pdf.html',
  '/lecture-summary-generator.html',
  '/ai-quiz-generator-from-notes.html',
  '/ai-tutor-for-engineering-students.html',
  '/course-based-ai-learning-tool.html',
  '/exam-study-guide-generator.html',
].map((path) => ({
  path,
  lang: 'en',
  hreflangGroup: null,
  lastmod: '2026-05-21',
  changefreq: 'monthly',
  priority: 0.9,
}));

// "Group B" — bespoke inline-styled pages with an EN + DE pair each.
const BILINGUAL_SLUGS = [
  { slug: 'ai-tutor', priority: 0.8 },
  { slug: 'pdf-editor', priority: 0.8 },
  { slug: 'notes', priority: 0.7 },
  { slug: 'pomodoro', priority: 0.7 },
];

const BILINGUAL_PAGES = BILINGUAL_SLUGS.flatMap(({ slug, priority }) => [
  {
    path: `/${slug}.html`,
    lang: 'en',
    hreflangGroup: slug,
    lastmod: '2026-05-20',
    changefreq: 'monthly',
    priority,
  },
  {
    path: `/de/${slug}.html`,
    lang: 'de',
    hreflangGroup: slug,
    lastmod: '2026-05-20',
    changefreq: 'monthly',
    priority,
  },
]);

// Pages whose footer marker gets spliced (everything except legal pages,
// which use their own legal-footer template and are left untouched).
export const SEO_PAGES = [...NO_VARIANT_PAGES, ...BILINGUAL_PAGES];

// Every public page that belongs in sitemap.xml.
export const SITEMAP_PAGES = [HOME_PAGE, ...SEO_PAGES, ...LEGAL_PAGES];
