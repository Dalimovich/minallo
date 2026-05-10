// Summary pre-processing pipeline.
// Classifies chunks, removes noise, cleans text, and groups into topic sections.
// No OpenAI calls — pure data transformation used by notes-generate.js.
'use strict';

// ── Category sets ─────────────────────────────────────────────────────────────

// These categories are excluded from the main summary by default
const LOW_VALUE_CATEGORIES = new Set([
  'title', 'noise', 'literature', 'advertisement'
]);

// These are included only when the caller opts in (e.g. "include research pages")
const OPTIONAL_CATEGORIES = new Set([
  'research_project'
]);

// ── Noise / header / footer patterns ─────────────────────────────────────────

// Text that should never appear as study content
const NOISE_TEXT_PATTERNS = [
  /Platzhalter\s+für\s+Bild/i,
  /Bild\s+(?:auf\s+)?[Tt]itelfolie/i,
  /hinter\s+das\s+Logo\s+einsetzen/i,
  /Klicken\s+Sie,\s+um\s+das\s+Format/i,
];

// Repeated header/footer lines to strip from chunk text before sending to AI
const HEADER_FOOTER_PATTERNS = [
  // "Prof. Dr.-Ing. K. Dilger | Fertigungstechnik | Kapitel 2 – Urformen | Seite 5"
  /Prof\.\s*Dr\.\s*-?Ing\.\s*[^\n|]{1,40}\|[^\n]*/gi,
  // "Institut für Füge- und Schweißtechnik"
  /Institut\s+für\s+Füge-?\s*und\s+Schweißtechnik[^\n]*/gi,
  // "Vorlesung Fertigungstechnik | Kapitel X – …"
  /Vorlesung\s+Fertigungstechnik[^\n]*/gi,
  // Standalone "Seite 12" footers
  /^\s*Seite\s+\d+\s*$/gim,
  // Bildquellen / Quelle: lines that are pure citation noise (not study content)
  /^Bildquellen?:[^\n]*/gim,
];

// ── Category keyword maps ─────────────────────────────────────────────────────

const CATEGORY_KEYWORD_SETS = [
  // Order matters: first match wins
  { category: 'literature',        tests: [/\bliteratur\b/i, /bibliographi/i, /quellenverzeichnis/i, /internet.?quellen/i, /\bbildquellen?\b/i] },
  { category: 'advertisement',     tests: [/nächste\s+vorlesung/i, /\bwerbung\b/i, /empfehlen\s+wir/i] },
  { category: 'research_project',  tests: [/forschungsprojekt/i, /forschungsvorhaben/i, /\bDFG\b/, /\bIGF\b/, /gefördert\s+von/i] },
  { category: 'learning_goals',    tests: [/lernziel/i, /lerninhalt/i, /nach\s+(?:dieser|der)\s+vorlesung/i, /sie\s+(?:können|kennen|verstehen)\s+nach/i] },
  { category: 'classification',    tests: [/\beinteilung\b/i, /\bDIN\s+8580\b/, /hauptgruppen\s+der\s+fertigung/i, /einordnung\s+in\s+die\s+fertigung/i] },
  { category: 'process',           tests: [/\bgießverfahren\b/i, /\bdruckguss\b/i, /\bsandguss\b/i, /\bfeinguss\b/i, /\bkokillenguss\b/i, /\bniederdruckguss\b/i, /\berstarren\b/i, /warmkammer/i, /kaltkammer/i] },
  { category: 'material',          tests: [/\bwerkstoff(?:e|gruppe)?\b/i, /\blegierung(?:en)?\b/i, /eisenguss/i, /\bGJL\b/, /\bGJS\b/, /\bGJV\b/, /temperguss/i, /\baluminium(?:gewinnung)?\b/i] },
  { category: 'design_rules',      tests: [/gießgerechte?\s+konstruktion/i, /\bwanddicke\b/i, /heuversch/i, /\bverrippung\b/i, /entformungsschräge/i, /gestaltungsregel/i] },
  { category: 'quality_simulation',tests: [/\bsimulation\b/i, /qualitätssicherung/i, /\bgussfehler\b/i, /\blunker\b/i, /röntgenprüfung/i, /\bporosität\b/i] },
];

// ── Chunk classifier ──────────────────────────────────────────────────────────

/**
 * Assigns a category string to a single chunk based on its text and page position.
 */
function classifyChunk(chunk) {
  const text      = chunk.chunk_text || '';
  const trimmed   = text.trim();
  const pageStart = chunk.page_start || 0;

  // Hard noise: template/placeholder text
  if (NOISE_TEXT_PATTERNS.some(function (p) { return p.test(text); })) return 'noise';

  // Very short chunks on cover pages are title/noise
  if (pageStart <= 2 && trimmed.length < 300) return 'title';

  // Keyword-based category detection
  const lower = trimmed.toLowerCase();
  for (var i = 0; i < CATEGORY_KEYWORD_SETS.length; i++) {
    var entry = CATEGORY_KEYWORD_SETS[i];
    if (entry.tests.some(function (p) { return p.test(lower); })) {
      return entry.category;
    }
  }

  return 'core_content';
}

// ── Text cleaner ──────────────────────────────────────────────────────────────

/**
 * Strips repeated headers/footers and fixes common PDF extraction artefacts.
 */
function cleanChunkText(text) {
  if (!text) return '';
  var out = text;

  for (var i = 0; i < HEADER_FOOTER_PATTERNS.length; i++) {
    out = out.replace(HEADER_FOOTER_PATTERNS[i], '');
  }

  // Fix glued words from PDF extraction: "MetallwirdDurch" → "Metall wird Durch"
  // Only when a lowercase letter is directly followed by an uppercase letter (no space)
  out = out.replace(/([a-zäöü])([A-ZÄÖÜ])/g, '$1 $2');

  // Collapse 3+ blank lines into 2
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

// ── Strategy selector ─────────────────────────────────────────────────────────

/**
 * Picks a generation strategy based on content page count and detail level.
 * @returns {'single'|'sectioned'|'multi_section'|'map_reduce'}
 */
function chooseSummaryStrategy(pageCount, detailLevel) {
  if (pageCount <= 2)  return 'single';
  if (pageCount <= 6)  return 'sectioned';
  if (pageCount <= 15) return 'multi_section';
  return 'map_reduce';
}

// ── Topic group builder ───────────────────────────────────────────────────────

/**
 * Groups classified+cleaned chunks into logical topic sections.
 * Uses section_title from chunk metadata when available.
 * Falls back to page-proximity grouping with a max group size.
 */
function buildTopicGroups(chunks, maxPagesPerGroup) {
  var gs = maxPagesPerGroup || 5;
  if (!chunks.length) return [];

  var groups  = [];
  var current = null;

  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var title = chunk.section_title || null;
    var ps    = chunk.page_start    || 0;
    var pe    = chunk.page_end      || ps;

    if (!current) {
      current = { title: title || null, chunks: [chunk], pageStart: ps, pageEnd: pe };
      continue;
    }

    var sameSection = title && title === current.title;
    var adjacent    = ps <= current.pageEnd + 2;
    var groupFull   = (current.pageEnd - current.pageStart + 1) >= gs;

    if (sameSection || (adjacent && !groupFull)) {
      current.chunks.push(chunk);
      if (pe > current.pageEnd) current.pageEnd = pe;
      if (title && !current.title) current.title = title;
    } else {
      groups.push(current);
      current = { title: title || null, chunks: [chunk], pageStart: ps, pageEnd: pe };
    }
  }

  if (current) groups.push(current);

  // Fall back to page range as title for groups without a section_title
  for (var j = 0; j < groups.length; j++) {
    if (!groups[j].title) {
      groups[j].title = 'S. ' + groups[j].pageStart +
        (groups[j].pageEnd !== groups[j].pageStart ? '–' + groups[j].pageEnd : '');
    }
  }

  return groups;
}

// ── Full pipeline ─────────────────────────────────────────────────────────────

/**
 * Runs the full pre-processing pipeline on raw chunks:
 *   1. Classify each chunk
 *   2. Filter out low-value categories
 *   3. Optionally include research/appendix pages
 *   4. Clean chunk text (strip headers/footers, fix glued words)
 *   5. Group into topic sections
 *
 * Returns { groups, keptChunks, filteredCount, totalCount }
 */
function buildSummaryPipeline(chunks, includeOptional) {
  var totalCount = chunks.length;

  // Classify
  var classified = chunks.map(function (c) {
    return Object.assign({}, c, { _category: classifyChunk(c) });
  });

  // Filter
  var kept = classified.filter(function (c) {
    if (LOW_VALUE_CATEGORIES.has(c._category)) return false;
    if (OPTIONAL_CATEGORIES.has(c._category) && !includeOptional) return false;
    return true;
  });

  // Clean text
  var cleaned = kept
    .map(function (c) {
      return Object.assign({}, c, { chunk_text: cleanChunkText(c.chunk_text) });
    })
    .filter(function (c) { return c.chunk_text.length > 30; });

  var groups = buildTopicGroups(cleaned, 5);

  return {
    groups:        groups,
    keptChunks:    cleaned,
    filteredCount: totalCount - kept.length,
    totalCount:    totalCount
  };
}

// ── Content weight estimator ──────────────────────────────────────────────────

/**
 * Estimates the "study value" of a single classified+cleaned chunk.
 * Returns 0 for noise/title/ads; up to 2.5 for dense study content.
 */
function estimateChunkWeight(chunk) {
  var cat  = chunk._category || 'core_content';
  var text = chunk.chunk_text || '';

  if (cat === 'title' || cat === 'advertisement' || cat === 'noise') return 0;

  var words = (text.match(/\S+/g) || []).length;
  var weight = 0;

  // Word count contribution
  if (words > 50)  weight += 0.5;
  if (words > 150) weight += 0.5;
  if (words > 300) weight += 0.5;

  // Content-signal bonuses
  if (/definition|bezeichnet\s+(?:man|wird)|versteht\s+man|ist\s+definiert/i.test(text)) weight += 0.75;
  if (/\$\$?[^$]{3,}\$\$?|formel|gleichung|berechnung/i.test(text))                       weight += 0.75;
  if (/vorteil|nachteil|einsatzm[öo]glichkeit|anwendung/i.test(text))                     weight += 0.75;
  if (/schritt\s+\d|ablauf|prozess|verfahren|methode/i.test(text))                        weight += 0.75;
  if (/vergleich|gegen[üu]ber|tabelle|\bvs\b/i.test(text))                                weight += 0.75;
  if (/beispiel|z\.b\.|etwa\s|etwa,/i.test(text))                                         weight += 0.4;

  // Cap low-value but not-zero categories
  if (cat === 'literature')     return Math.min(weight, 0.2);
  if (cat === 'learning_goals') return Math.min(weight, 0.5);

  return Math.min(weight, 2.5);
}

/**
 * Computes total effective pages from an array of classified+cleaned chunks.
 * Returns a float representing the study-content equivalent page count.
 */
function computeEffectivePages(keptChunks) {
  var total = 0;
  for (var i = 0; i < keptChunks.length; i++) {
    total += estimateChunkWeight(keptChunks[i]);
  }
  return Math.round(total * 10) / 10;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  classifyChunk,
  cleanChunkText,
  chooseSummaryStrategy,
  buildTopicGroups,
  buildSummaryPipeline,
  estimateChunkWeight,
  computeEffectivePages,
  LOW_VALUE_CATEGORIES,
  OPTIONAL_CATEGORIES
};
