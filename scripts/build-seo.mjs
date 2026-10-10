// Build-time step for the public marketing pages: splices the shared footer
// into each page's <!-- MINALLO_FOOTER --> marker and generates sitemap.xml
// from scripts/seo-pages-manifest.mjs. Run after the frontend -> dist copy
// (see build-production.mjs), same pattern as the MINALLO_LANDING_CONTENT
// splice: one source of truth, substituted into the static HTML at build
// time so the server's raw response needs no client-side JS to be complete.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEO_PAGES, SITEMAP_PAGES } from './seo-pages-manifest.mjs';

const OUT = 'dist';
const SITE = 'https://minallo.de';
const FOOTER_MARKER = '<!-- MINALLO_FOOTER -->';

const FOOTER_LINKS = {
  en: [
    ['/', 'Home'],
    ['/#pricing', 'Pricing'],
    ['/#features', 'About'],
    ['/impressum.html', 'Impressum'],
    ['/privacy.html', 'Privacy'],
    ['/terms.html', 'Terms'],
    ['/withdrawal.html', 'Withdrawal']
  ],
  de: [
    ['/', 'Startseite'],
    ['/#pricing', 'Preise'],
    ['/#features', 'Über Minallo'],
    ['/impressum.html', 'Impressum'],
    ['/privacy.html', 'Datenschutz'],
    ['/terms.html', 'AGB'],
    ['/withdrawal.html', 'Widerruf']
  ]
};

function renderFooter(lang) {
  const links = FOOTER_LINKS[lang] || FOOTER_LINKS.en;
  const [home, ...rest] = links;
  const restLinks = rest
    .map(([href, label]) => `<a href="${href}" style="color:#94a3b8;">${label}</a>`)
    .join('\n        ');
  return [
    '<footer style="margin-top:56px; padding-top:24px; border-top:1px solid rgba(255,255,255,0.1); display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:space-between; font-size:0.875rem; color:#94a3b8;">',
    '      <span>&copy; 2026 Minallo</span>',
    '      <nav style="display:flex; flex-wrap:wrap; gap:14px;">',
    `        <a href="${home[0]}" style="color:#94a3b8;">${home[1]}</a>`,
    `        ${restLinks}`,
    '      </nav>',
    '    </footer>'
  ].join('\n');
}

let footersApplied = 0;
for (const page of SEO_PAGES) {
  const filePath = join(OUT, page.path);
  const html = readFileSync(filePath, 'utf8');
  if (!html.includes(FOOTER_MARKER)) {
    throw new Error(`${page.path} is missing ${FOOTER_MARKER} — cannot splice the shared footer.`);
  }
  writeFileSync(filePath, html.replace(FOOTER_MARKER, renderFooter(page.lang)));
  footersApplied++;
}

// --- sitemap.xml -----------------------------------------------------------

function hreflangBlock(page, groupMembers) {
  if (!groupMembers || groupMembers.length < 2) return '';
  const enPage = groupMembers.find((p) => p.lang === 'en') || groupMembers[0];
  const lines = groupMembers.map(
    (p) => `    <xhtml:link rel="alternate" hreflang="${p.lang}" href="${SITE}${p.path}" />`
  );
  lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${enPage.path}" />`);
  return '\n' + lines.join('\n');
}

const groups = new Map();
for (const page of SITEMAP_PAGES) {
  if (!page.hreflangGroup) continue;
  if (!groups.has(page.hreflangGroup)) groups.set(page.hreflangGroup, []);
  groups.get(page.hreflangGroup).push(page);
}

const urlEntries = SITEMAP_PAGES.map((page) => {
  const groupMembers = page.hreflangGroup ? groups.get(page.hreflangGroup) : null;
  // The home page carries its own historical hreflang (en/x-default only,
  // no "de" sibling exists for it) — preserve that rather than inventing one.
  const hreflang =
    page === SITEMAP_PAGES[0] && page.path === '/'
      ? `\n    <xhtml:link rel="alternate" hreflang="en" href="${SITE}/" />\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/" />`
      : hreflangBlock(page, groupMembers);
  return [
    '  <url>',
    `    <loc>${SITE}${page.path}</loc>${hreflang}`,
    `    <lastmod>${page.lastmod}</lastmod>`,
    `    <changefreq>${page.changefreq}</changefreq>`,
    `    <priority>${page.priority.toFixed(1)}</priority>`,
    '  </url>'
  ].join('\n');
}).join('\n');

const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
  '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
  urlEntries +
  '\n</urlset>\n';

writeFileSync(join(OUT, 'sitemap.xml'), sitemap);

console.log(
  `Build SEO: spliced shared footer into ${footersApplied} page(s), generated sitemap.xml with ${SITEMAP_PAGES.length} URL(s).`
);
