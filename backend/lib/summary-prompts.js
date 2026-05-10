// Summary generation prompts, validation, and token budgets.
// Imported by notes-generate.js — no Netlify handler logic here.
'use strict';

// ── Shared noise constants (also imported by notes-generate for validateNotes) ─

const FILLER_PHRASES = [
  'overview of', 'general introduction', 'this section covers', 'various methods',
  'überblick über', 'einführung in', 'verschiedene methoden', 'allgemeine einführung'
];

const TEMPLATE_NOISE_TERMS = [
  'platzhalter', 'titelfolie', 'bild einsetzen', 'hinter das logo',
  'masterfolie', 'vorlage für', 'textfeld', 'klicken sie', 'klicken sie,'
];

// ── Language helpers ──────────────────────────────────────────────────────────

/**
 * Tells the model which language to write content in.
 */
function langInstr(lang) {
  if (lang === 'en')        return 'Write all content in English regardless of the source language.';
  if (lang === 'de')        return 'Schreibe alle Inhalte auf Deutsch, unabhängig von der Quellsprache.';
  if (lang === 'bilingual') return 'Write bilingually: use German for headings and main content; add English translations in parentheses for key technical terms.';
  return 'Write in exactly the same language as the source text. If the source is German, write in German. If English, write in English. Do NOT translate.';
}

/**
 * Returns the heading-language rule for summary prompts.
 * For German/auto: enforce German-only headings explicitly.
 */
function langHeadingRule(lang) {
  if (lang === 'en') {
    return 'Use English headings throughout (e.g. "Overview", "Main Concepts", "Formulas", "Exam Focus").';
  }
  return 'Verwende AUSSCHLIESSLICH deutsche Überschriften. KEINE englischen Überschriften wie "Big Picture", "Key Concepts", "What to Remember" oder "Balanced". Nur Deutsch.';
}

/**
 * Returns a language-appropriate set of heading labels for the 10-section structure.
 */
function sectionHeadings(lang) {
  if (lang === 'en') {
    return {
      title:       'Summary',
      overview:    'Overview',
      concepts:    'Main Concepts',
      definitions: 'Important Definitions',
      terms:       'Technical Terms',
      methods:     'Methods and Processes',
      formulas:    'Formulas',
      lists:       'Important Lists and Classifications',
      comparisons: 'Comparisons',
      exam:        'Exam Focus',
      sources:     'Source Pages',
      noFormulas:  'No formulas found in the selected pages.'
    };
  }
  return {
    title:       'Zusammenfassung',
    overview:    'Überblick',
    concepts:    'Hauptkonzepte',
    definitions: 'Wichtige Definitionen',
    terms:       'Technische Begriffe',
    methods:     'Methoden und Prozesse',
    formulas:    'Formeln',
    lists:       'Wichtige Listen und Klassifikationen',
    comparisons: 'Vergleiche',
    exam:        'Prüfungsrelevanz',
    sources:     'Quellen',
    noFormulas:  'Keine Formeln in den ausgewählten Seiten gefunden.'
  };
}

// ── Word-count targets per effective content page ─────────────────────────────

const WORDS_PER_EFFECTIVE_PAGE = {
  brief:    [15, 30],
  balanced: [40, 70],
  detailed: [80, 130],
  exam:     [90, 150]
};

/**
 * Calculates the target word count for a summary given the detail level
 * and effective content pages (weighted, not raw page count).
 * effectivePages is the float from computeEffectivePages().
 */
function targetWordCount(detailLevel, effectivePages) {
  var range = WORDS_PER_EFFECTIVE_PAGE[detailLevel] || WORDS_PER_EFFECTIVE_PAGE.balanced;
  var mid   = Math.round((range[0] + range[1]) / 2);
  return Math.max(300, Math.round((effectivePages || 10) * mid));
}

// ── Token budget ──────────────────────────────────────────────────────────────

/**
 * Returns max_tokens for an OpenAI call.
 * effectivePages is optional — when provided, budget scales with content.
 * German text is token-dense: assume ~1.6 tokens per word.
 */
function getMaxTokens(tool, detailLevel, effectivePages) {
  if (tool === 'notes') return 4000;

  if (effectivePages != null && effectivePages > 0) {
    var words = targetWordCount(detailLevel, effectivePages);
    var base  = Math.round(words * 1.65) + 600; // +600 for headings/structure
    switch (detailLevel) {
      case 'brief':    return Math.max(1500, Math.min(base, 3000));
      case 'detailed': return Math.max(3500, Math.min(base, 8000));
      case 'exam':     return Math.max(3000, Math.min(base, 7000));
      default:         return Math.max(2000, Math.min(base, 5000));
    }
  }

  // Fallback fixed budgets when no effective-page info
  switch (detailLevel) {
    case 'brief':    return 1500;
    case 'detailed': return 5000;
    case 'exam':     return 3500;
    default:         return 3000;
  }
}

// ── Detail-level instruction ──────────────────────────────────────────────────

/**
 * Returns the detail-level instruction block, optionally with a concrete word target.
 * targetWords comes from targetWordCount() and is based on actual content density.
 */
function summaryDetailInstr(detailLevel, targetWords) {
  var wordLine = targetWords
    ? 'TARGET LENGTH: approximately ' + targetWords + ' words. This is a hard minimum — do NOT produce a shorter summary regardless of template constraints.'
    : '';

  switch (detailLevel) {
    case 'brief':
      return `DETAIL LEVEL: Brief
Write a SHORT but information-dense summary.
${wordLine || 'Target length: ~250–450 words for 1–3 pages; scale proportionally for more.'}
Cover: main idea, 3–5 key concepts, critical formulas, 2–3 exam takeaways.
Skip sections that have no content (e.g. omit Formeln if there are none).`;

    case 'detailed':
      return `DETAIL LEVEL: Detailed
Write a COMPREHENSIVE, topic-by-topic summary thorough enough to study from without reopening the PDF.
${wordLine || 'For a 30–50 page chapter, the summary must be several pages long (8–14 major sections minimum).'}
Rules:
- Cover EVERY named method, process, material, classification, advantage, disadvantage, formula, and comparison in the source.
- Do NOT shorten lists — reproduce them completely with ALL items.
- Each named method/process/material gets its own subsection with: what it is, how it works, advantages, disadvantages, materials, applications.
- Definitions must be preserved verbatim or near-verbatim.
- The structure must follow the lecture's own topic order, not a generic template.`;

    case 'exam':
      return `DETAIL LEVEL: Exam-focused
Structure around what a student needs to pass an exam on this material.
${wordLine || 'For a large chapter, cover all exam-relevant processes, definitions, and formulas in full.'}
Cover: exact definitions, must-know processes step by step, all formulas with variable explanations, comparison tables.
Add a "Prüfungsfragen" section with 4–8 exam-style questions and precise model answers drawn from the source.
Be selective but complete — every exam-relevant item must be included.`;

    default: // balanced
      return `DETAIL LEVEL: Balanced
Write a STRUCTURED summary covering all important material without excessive detail.
${wordLine || 'Target length: ~500–900 words for 3–6 pages; scale proportionally for more.'}
Cover: main idea, all important definitions, key processes (complete but condensed), formulas, lists, comparisons, exam relevance.
Prefer completeness over brevity when content is dense.
Do NOT produce the same short output for 2 pages and 20 pages.`;
  }
}

// ── Main summary prompt (single-call / small scope ≤ 6 pages) ─────────────────

function summaryPrompt(lang, detailLevel, targetWords) {
  var h = sectionHeadings(lang);
  return `You are a study assistant generating a student-focused summary of a university lecture PDF.

${langInstr(lang)}
${langHeadingRule(lang)}

${summaryDetailInstr(detailLevel || 'balanced', targetWords)}

STRICT RULES:
- Use ONLY the provided PDF text. Do NOT invent, hallucinate, or add external knowledge.
- IGNORE: author names, university/institute names, logos, copyright lines, semester labels, slide numbers, lecture footers.
- Preserve definitions verbatim or near-verbatim from the source.
- Include page references *(S. X)* or *(S. X–Y)* whenever citing a specific fact or concept.
- Use Markdown. Use KaTeX for formulas: inline $...$, display $$...$$
- Do NOT write generic filler like "dieser Abschnitt gibt einen Überblick" or "verschiedene Methoden werden vorgestellt".
- Summary length MUST scale with content — more pages means a longer summary.
- Include a section only when the source contains relevant content for it.
- If something is unclear or not present in the source, simply omit it — do NOT write "(Nicht klar aus dem PDF.)".
- Do not include slide-template text, placeholder text, or repeated header/footer lines.

OUTPUT STRUCTURE (use all sections that apply):

# ${h.title}: [Hauptthema aus Vorlesungstitel oder erster Überschrift]

## 1. ${h.overview}
2–4 Sätze: Was behandelt dieser Abschnitt, warum ist er relevant?

## 2. ${h.concepts}
For each major concept in the source:
- **[Begriff]** *(S. X)*: genaue Erklärung — nicht nur der Term, sondern was er bedeutet.

## 3. ${h.definitions}
- **[Term]** *(S. X)*: [exakte oder nahezu wörtliche Definition aus der Quelle]
Diesen Abschnitt nur weglassen, wenn die Quelle wirklich keine Definitionen enthält.

## 4. ${h.terms}
- **[Term]**: kurze Erklärung seiner Bedeutung in diesem Kontext.
Nur fachspezifische Begriffe, die in der Quelle vorkommen.

## 5. ${h.methods}
For each method, process, or procedure in the source:
- **[Verfahren/Methode]** *(S. X)*: Prinzip, Ablauf, Anwendung, Besonderheiten.
Schritt-für-Schritt wenn die Quelle das vorgibt. Diesen Abschnitt weglassen, wenn keine Verfahren vorhanden.

## 6. ${h.formulas}
$$[Formel]$$
Wobei: [Variable] = [Bedeutung], Einheit: [Einheit]
*(S. X)*
Wenn keine Formeln im ausgewählten Inhalt vorkommen: "${h.noFormulas}"

## 7. ${h.lists}
Wichtige Listen aus der Quelle VOLLSTÄNDIG reproduzieren — alle Punkte, nicht nur eine Auswahl.
Beispiele: Klassifikationen, Bauteilgruppen, Vor-/Nachteile, Werkstoffgruppen, Verfahrenskategorien.
Weglassen, wenn keine bedeutsamen Listen vorhanden.

## 8. ${h.comparisons}
Vergleichstabellen oder Gegenüberstellungen, wenn die Quelle Verfahren, Werkstoffe o.ä. vergleicht.
Markdown-Tabelle verwenden bei ≥ 2 Vergleichspartnern und ≥ 2 Eigenschaften.
Weglassen, wenn keine Vergleiche vorhanden.

## 9. ${h.exam}
Die wichtigsten Punkte, die ein Student für die Prüfung kennen muss.
Konkret — echte Konzepte nennen, keine vagen Kategorien.
Bei exam-Modus: 4–8 Prüfungsfragen mit Modellantworten ergänzen.

## 10. ${h.sources}
Verwendete Seitenbereiche: *(S. X–Y)*`;
}

// ── Section summary prompt (used per topic group in multi-section pipeline) ────

function sectionSummaryPrompt(lang, detailLevel, pageStart, pageEnd, topicTitle, targetWords) {
  var pageRef = pageStart != null
    ? (pageStart === pageEnd ? 'Seite ' + pageStart : 'Seiten ' + pageStart + '–' + pageEnd)
    : 'diesem Abschnitt';
  var topicLine = topicTitle
    ? 'Thema dieses Abschnitts: **' + topicTitle + '** (' + pageRef + ')'
    : 'Seitenbereich: ' + pageRef;

  return `You are summarising one topic section from a university lecture PDF for a student.

${langInstr(lang)}
${langHeadingRule(lang)}

${summaryDetailInstr(detailLevel || 'balanced', targetWords)}

SCOPE:
${topicLine}

STRICT RULES:
- Use ONLY the content from ${pageRef}. Do NOT reference other pages or invent facts.
- IGNORE: author names, university logos, copyright notices, semester labels, slide numbers, repeated footers.
- Do NOT include slide-template text, placeholder text, or PDF metadata noise.
- Include page references *(S. X)* for important facts.
- Use Markdown. KaTeX for formulas: $...$ inline, $$...$$ display.
- This is ONE SECTION of a larger summary — do not re-introduce the full lecture context.
- If the source for these pages is sparse, keep this section short. Do not pad.
- If a fact is not clearly on these pages, omit it entirely.

OUTPUT FORMAT:
## [Abschnittsüberschrift — verwende die tatsächliche Kapitelüberschrift aus dem PDF, falls sichtbar]

Decke ab, was auf diesen Seiten vorhanden ist:
Hauptkonzepte | Definitionen | Technische Begriffe | Verfahren/Prozesse | Formeln | Listen | Vergleiche | Prüfungsrelevanz

Seitenreferenzen für jeden wichtigen Punkt angeben. Länge proportional zur Inhaltsdichte.`;
}

// ── Merge summary prompt ──────────────────────────────────────────────────────

/**
 * Merge prompt for combining section summaries into one final document.
 * topicGroupTitles: string[] — titles of each topic section that was summarised.
 * targetWords: number — minimum word count for the merged output.
 */
function mergeSummaryPrompt(lang, detailLevel, targetWords, topicGroupTitles) {
  var h = sectionHeadings(lang);
  var wordLine = targetWords
    ? 'MINIMUM LENGTH: ' + targetWords + ' words. A short merged output will be rejected. The merged summary must be longer than any individual section.'
    : 'The merged summary must be longer than any individual section.';

  var topicBlock = '';
  if (topicGroupTitles && topicGroupTitles.length) {
    topicBlock = `
REQUIRED SECTIONS — generate one ## section per topic below. Do NOT merge, skip, or compress them:
${topicGroupTitles.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n')}

Each topic section must include ALL content from the corresponding section summary.
Do not collapse two separate topics into one bullet — they each need their own ## heading.
`;
  }

  return `You are merging multiple topic-section summaries from a university lecture PDF into one final structured study summary.

${langInstr(lang)}
${langHeadingRule(lang)}

${summaryDetailInstr(detailLevel || 'balanced', targetWords)}

${wordLine}
${topicBlock}
MERGE RULES:
- Preserve ALL important content from ALL sections. Do NOT aggressively shorten.
- Remove exact duplicates (identical facts stated twice), but keep near-duplicates in different contexts.
- Keep ALL page references *(S. X)*.
- Facts must stay attached to the correct topic — do NOT mix details from different processes or materials.
- Do NOT invent new content — use only what is in the provided section summaries.
- For each named process/method: include what it is, how it works, advantages, disadvantages, materials used, and applications.
- Reproduce all lists completely — do not shorten them.
- The final Prüfungsrelevanz section must cover the most important exam points across all sections.

OUTPUT: Complete Markdown document.

# ${h.title}: [Kapitel-/Thementitel aus dem ersten Abschnitt]

${topicGroupTitles && topicGroupTitles.length
  ? '## [section per required topic above, in order]'
  : `## 1. ${h.overview}
## 2. ${h.concepts}
## 3. ${h.definitions}
## 4. ${h.terms}
## 5. ${h.methods}
## 6. ${h.formulas}
## 7. ${h.lists}
## 8. ${h.comparisons}
## 9. ${h.exam}
## 10. ${h.sources}`}

## ${h.exam}
## ${h.sources}

A long chapter summary should be several pages long — do not produce a short overview.`;
}

// ── Strict fallback prompt (regeneration after validation failure) ─────────────

function strictSummaryPrompt(lang, detailLevel, missingTerms) {
  return summaryPrompt(lang, detailLevel) + `

ADDITIONAL REQUIREMENT — FINAL CHECK:
The following key terms from the source text are absent from your summary.
Include all that are genuinely important to the lecture content:
${missingTerms.map(function (t) { return '- ' + t; }).join('\n')}

ALSO: Do not include slide-template noise (Platzhalter, Titelfolie, Bild einsetzen, etc.) anywhere in the output.`;
}

// ── Validation ────────────────────────────────────────────────────────────────

function extractKeyTerms(contextText) {
  var words = contextText.match(/[A-Za-zÄÖÜäöüß]{5,}/g) || [];
  var freq = {};
  for (var i = 0; i < words.length; i++) {
    var lw = words[i].toLowerCase();
    freq[lw] = (freq[lw] || 0) + 1;
  }
  return Object.keys(freq)
    .filter(function (w) { return freq[w] >= 2; })
    .sort(function (a, b) { return freq[b] - freq[a]; })
    .slice(0, 30);
}

/**
 * Validates a generated summary.
 * pageCount — raw source page count (used for section-count rules).
 * targetWords — word count target from targetWordCount() (used for word-count check).
 * Returns { valid, issues, missingTerms }.
 */
function validateSummary(markdown, contextText, detailLevel, pageCount, targetWords) {
  var issues = [];
  var pc = pageCount || 0;
  var mdLower = markdown.toLowerCase();

  // ── Word count check (primary length gate) ──────────────────────────────
  if (targetWords) {
    var wordCount = (markdown.match(/\S+/g) || []).length;
    var minWords  = Math.round(targetWords * 0.55); // allow 45% slack before flagging
    if (wordCount < minWords) issues.push('too_short');
  } else {
    // Fallback char-based check
    var minLen = detailLevel === 'brief' ? 250 : detailLevel === 'detailed' ? 700 : 400;
    if (markdown.length < minLen) issues.push('too_short');
  }

  // ── Large-doc detailed check ────────────────────────────────────────────
  if (detailLevel === 'detailed' && pc >= 20) {
    // Must have at least 5 ## sections
    var sectionCount = (markdown.match(/^## /gm) || []).length;
    if (sectionCount < 5) issues.push('too_few_sections');
    // Char floor for a 20+ page detailed summary
    if (markdown.length < 2500) issues.push('too_short_for_large_doc');
  }

  // ── Key term coverage ───────────────────────────────────────────────────
  var keyTerms = extractKeyTerms(contextText);
  var missingTerms = keyTerms.filter(function (t) { return !mdLower.includes(t); });
  // Summary may omit more terms than notes — threshold 0.60
  if (keyTerms.length > 0 && missingTerms.length / keyTerms.length > 0.60) {
    issues.push('missing_terms');
  }

  // ── Filler phrase check ─────────────────────────────────────────────────
  for (var i = 0; i < FILLER_PHRASES.length; i++) {
    if (mdLower.includes(FILLER_PHRASES[i])) { issues.push('generic_filler'); break; }
  }

  // ── Template noise check ────────────────────────────────────────────────
  for (var j = 0; j < TEMPLATE_NOISE_TERMS.length; j++) {
    if (mdLower.includes(TEMPLATE_NOISE_TERMS[j])) { issues.push('template_noise'); break; }
  }

  // ── English-heading check for German source ─────────────────────────────
  // If the markdown contains "## Big Picture" or "## Key Concepts" those are wrong
  if (/^## (?:Big Picture|Key Concepts|What to Remember|Overview)\b/m.test(markdown)) {
    issues.push('wrong_heading_language');
  }

  return { valid: issues.length === 0, issues: issues, missingTerms: missingTerms.slice(0, 15) };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  langInstr,
  langHeadingRule,
  sectionHeadings,
  getMaxTokens,
  targetWordCount,
  summaryDetailInstr,
  summaryPrompt,
  sectionSummaryPrompt,
  mergeSummaryPrompt,
  strictSummaryPrompt,
  validateSummary,
  FILLER_PHRASES,
  TEMPLATE_NOISE_TERMS
};
