// POST /api/notes/generate
// Body: { courseId, documentId, tool, pdfText?, fileName?,
//         scope: 'page'|'section'|'range'|'document',
//         currentPage?, pageRange?: {start,end},
//         language: 'same_as_source'|'en'|'de'|'bilingual',
//         detailLevel: 'detailed'|'summary' }
// Response: { note: { id, title, type, content_markdown, sources } }

'use strict';

const https = require('https');
const { requireEnv, optionalEnv } = require('../lib/env');
const { jsonResponse, fail, handleOptions } = require('../lib/responses');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');
const { supaRequest } = require('../lib/supabase-admin');

const OPENAI_MODEL = optionalEnv('OPENAI_GENERATE_MODEL_STRONG', 'gpt-4o');
const MAX_CONTEXT_CHARS = 28000;

// ── Language instruction ──────────────────────────────────────────────────────

function langInstr(lang) {
  if (lang === 'en')        return 'Write the notes in English regardless of the source language.';
  if (lang === 'de')        return 'Schreibe die Notizen auf Deutsch, unabhängig von der Quellsprache.';
  if (lang === 'bilingual') return 'Write bilingually: use the source language for content, add English translations in parentheses for key technical terms.';
  // same_as_source (default)
  return 'Write the notes in exactly the same language as the source text. If the source is German, write in German. If English, write in English. Do NOT translate.';
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function notesPrompt(lang) {
  return `You are generating detailed, exam-ready study notes from a PDF lecture slide or page.

${langInstr(lang)}

CRITICAL RULES — READ BEFORE GENERATING:
- Use ONLY the provided PDF text. Do NOT invent facts or use outside knowledge.
- Do NOT write a generic summary. This is DETAILED NOTES mode.
- Do NOT write vague bullets like "Overview of methods" or "Various casting techniques".
- If the PDF contains a list → reproduce the COMPLETE list with ALL items preserved.
- If the PDF contains a definition-like sentence → include it verbatim or near-verbatim.
- If the PDF contains a formula → capture it using KaTeX: inline $...$, display $$...$$, explain every variable.
- If the PDF describes a process → extract every step or characteristic in order.
- Every important technical term from the source must appear in the notes.
- Notes must be detailed enough for studying WITHOUT reopening the PDF.
- If something is unclear in the source, write: *(Nicht klar aus dem PDF.)* or *(Not clearly stated.)*

REQUIRED STRUCTURE — include every section that has content in the source:

# [Exact topic title from the slide/page]

## Was ist das? / What is this?
2–4 sentences of context and explanation.

## Wichtige Definitionen / Important Definitions
- **Term**: exact explanation from the source

## Technische Begriffe / Technical Terms
All important technical vocabulary with explanation.

## Formeln / Formulas
KaTeX formulas with variable explanations.

## Prozessschritte / Process Steps
Numbered steps or bulleted characteristics — exactly as described in source.

## Listen aus dem PDF / Lists from the PDF
All lists preserved in FULL with all items. Add a one-line explanation per item if useful.

## Vergleiche / Vergleiche / Comparisons
Tables or lists for comparisons, advantages/disadvantages if present.

## Prüfungsrelevanz / Exam Focus
What to memorize. What is likely to be tested.

## Quellenangabe / Source
Page reference for each section, e.g. *(S. 19)* or *(p. 19)*.

Formatting rules:
- Use # for title, ## for major sections, ### for subsections
- Use bullet points and numbered lists
- Use tables for comparisons
- Minimum 5–10 useful bullets per main topic
- Every sentence must add information — no filler`;
}

function summaryPrompt(lang) {
  return `You are generating a concise but exam-useful summary from a PDF lecture slide or page.

${langInstr(lang)}

Use ONLY the provided PDF text. Do not invent information.

Include:
1. **Was wird behandelt / What this covers** (1–2 sentences)
2. **Wichtigste Konzepte / Key concepts** — bullet points, concrete not vague
3. **Formeln / Formulas** — using KaTeX: inline $...$, display $$...$$
4. **Technische Begriffe / Key terms** — listed with short explanation
5. **Prüfungsrelevanz / Exam points** — the 3–5 most important things to remember
6. **Quelle / Source** — page reference e.g. *(S. 19)*

Keep it concise — quick review, not full explanation.
Use Markdown and KaTeX. Do NOT write generic overviews.`;
}

function strictNotesPrompt(lang, missingTerms) {
  return notesPrompt(lang) + `

ADDITIONAL REQUIREMENT — FINAL CHECK:
The following terms were found in the source text but are MISSING from your notes. You MUST include all of them:
${missingTerms.map(function (t) { return '- ' + t; }).join('\n')}

Do not submit notes that omit these terms.`;
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

function callOpenAI(systemPrompt, userMessage) {
  return new Promise(function (resolve, reject) {
    var apiKey = requireEnv('OPENAI_API_KEY');
    var body = JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage }
      ]
    });
    var req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      var d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        try {
          var p = JSON.parse(d);
          if (res.statusCode >= 300) return reject(new Error('OpenAI ' + res.statusCode + ': ' + d.slice(0, 200)));
          var text = p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content;
          if (!text) return reject(new Error('Empty OpenAI response'));
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(55000, function () { req.destroy(new Error('OpenAI timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Quality validation ────────────────────────────────────────────────────────

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

var FILLER_PHRASES = [
  'overview of', 'general introduction', 'this section covers', 'various methods',
  'überblick über', 'einführung in', 'verschiedene methoden', 'allgemeine einführung'
];

function validateNotes(markdown, contextText) {
  var issues = [];

  if (markdown.length < 700) issues.push('too_short');

  var keyTerms = extractKeyTerms(contextText);
  var mdLower = markdown.toLowerCase();
  var missingTerms = keyTerms.filter(function (t) { return !mdLower.includes(t); });
  if (keyTerms.length > 0 && missingTerms.length / keyTerms.length > 0.45) {
    issues.push('missing_terms');
  }

  for (var i = 0; i < FILLER_PHRASES.length; i++) {
    if (mdLower.includes(FILLER_PHRASES[i])) { issues.push('generic_filler'); break; }
  }

  return { valid: issues.length === 0, issues: issues, missingTerms: missingTerms.slice(0, 15) };
}

// ── Chunk retrieval ───────────────────────────────────────────────────────────

async function fetchChunks(serviceKey, userId, courseId, documentId, pageStart, pageEnd) {
  var path = 'document_chunks' +
    '?select=chunk_text,page_start,page_end,section_title,source_type' +
    '&user_id=eq.' + encodeURIComponent(userId) +
    '&course_id=eq.' + encodeURIComponent(courseId) +
    '&document_id=eq.' + encodeURIComponent(documentId) +
    '&order=page_start.asc,id.asc' +
    '&limit=80';
  // Overlap filter: include chunks that overlap with [pageStart, pageEnd]
  if (pageEnd   != null) path += '&page_start=lte.' + pageEnd;
  if (pageStart != null) path += '&page_end=gte.'   + pageStart;

  var result = await supaRequest('GET', path, null, serviceKey);
  return Array.isArray(result.body) ? result.body : [];
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildContext(chunks, fileName) {
  if (!chunks.length) return null;
  var ctx = 'QUELLE: ' + (fileName || 'PDF') + '\n\n';
  var chars = 0;
  var sources = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    var pageRef = c.page_start != null
      ? '[S. ' + c.page_start + (c.page_end && c.page_end !== c.page_start ? '–' + c.page_end : '') + ']'
      : '';
    var section = c.section_title ? '[' + c.section_title + '] ' : '';
    var line = section + pageRef + '\n' + c.chunk_text + '\n\n';
    if (chars + line.length > MAX_CONTEXT_CHARS) break;
    ctx += line;
    chars += line.length;
    sources.push({ page_start: c.page_start, page_end: c.page_end });
  }
  return { context: ctx, sources: sources };
}

// ── Save note ─────────────────────────────────────────────────────────────────

async function saveNote(serviceKey, opts) {
  var result = await supaRequest('POST', 'notes?select=id',
    {
      user_id: opts.userId,
      course_id: opts.courseId,
      document_id: opts.documentId || null,
      title: opts.title,
      type: opts.type,
      content_markdown: opts.markdown,
      source_page_start: opts.filterStart != null ? opts.filterStart : null,
      source_page_end:   opts.filterEnd   != null ? opts.filterEnd   : null
    },
    serviceKey,
    { 'Prefer': 'return=representation' }
  );
  var noteRows = result.body;
  var noteId = Array.isArray(noteRows) && noteRows[0] && noteRows[0].id;
  if (!noteId) return null;

  if (opts.sources && opts.sources.length && opts.documentId) {
    var sourceRows = opts.sources
      .filter(function (s) { return s.page_start != null; })
      .map(function (s) {
        return { note_id: noteId, document_id: opts.documentId, page_start: s.page_start, page_end: s.page_end };
      });
    if (sourceRows.length) {
      await supaRequest('POST', 'note_sources', sourceRows, serviceKey, { 'Prefer': 'return=minimal' })
        .catch(function () {});
    }
  }
  return noteId;
}

function extractTitle(markdown, fallback) {
  var m = markdown.match(/^#\s+(.+)/m);
  return m ? m[1].replace(/[*_`]/g, '').trim() : (fallback || 'Notizen');
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  var token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');

  var user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return fail(400, 'Invalid JSON'); }

  var courseId    = body.courseId;
  var documentId  = body.documentId;
  var tool        = body.tool;
  var pdfText     = body.pdfText;
  var fileName    = body.fileName;
  var language    = body.language    || 'same_as_source';
  var scope       = body.scope       || 'section';   // page | section | range | document
  var currentPage = body.currentPage != null ? Number(body.currentPage) : null;
  var pageRange   = body.pageRange   || null;         // { start, end }

  if (!courseId) return fail(400, 'courseId is required');
  if (!['notes', 'summary'].includes(tool)) return fail(400, 'tool must be notes or summary');

  // ── Debug log: incoming request ───────────────────────────────────────────
  console.log('[notes-generate request]', {
    courseId: courseId,
    documentId: documentId,
    currentPage: currentPage,
    pageRange: pageRange,
    scope: scope,
    language: language,
    tool: tool,
    pdfTextLength: pdfText ? pdfText.length : 0,
    pdfTextPreview: pdfText ? pdfText.slice(0, 300) : null
  });

  var serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // ── Resolve page filter from scope ────────────────────────────────────────
  var filterStart = null;
  var filterEnd   = null;

  if (scope !== 'document') {
    if (scope === 'page' && currentPage != null) {
      filterStart = currentPage;
      filterEnd   = currentPage;
    } else if (scope === 'section' && currentPage != null) {
      filterStart = Math.max(1, currentPage - 1);
      filterEnd   = currentPage + 1;
    } else if (scope === 'range' && pageRange) {
      filterStart = pageRange.start != null ? Number(pageRange.start) : null;
      filterEnd   = pageRange.end   != null ? Number(pageRange.end)   : null;
    }
    // Also apply pageRange if sent alongside scope
    if (filterStart == null && pageRange) {
      filterStart = pageRange.start != null ? Number(pageRange.start) : null;
      filterEnd   = pageRange.end   != null ? Number(pageRange.end)   : null;
    }
  }

  console.log('[notes-generate page filter]', { filterStart: filterStart, filterEnd: filterEnd, scope: scope, currentPage: currentPage });

  // ── Retrieve indexed chunks ───────────────────────────────────────────────
  var context        = null;
  var sources        = [];
  var rawContextText = '';

  if (documentId) {
    var chunks = await fetchChunks(serviceKey, user.id, courseId, documentId, filterStart, filterEnd);

    console.log('[notes-generate chunks]', {
      count: chunks.length,
      pages: chunks.slice(0, 10).map(function (c) {
        return { page_start: c.page_start, page_end: c.page_end, preview: (c.chunk_text || '').slice(0, 120) };
      })
    });

    // Guard: reject chunks that are entirely outside the requested range
    if (filterStart != null && filterEnd != null && chunks.length) {
      var badChunks = chunks.filter(function (c) {
        return c.page_end < filterStart || c.page_start > filterEnd;
      });
      if (badChunks.length) {
        console.warn('[notes-generate] chunks outside requested range', badChunks.map(function (c) {
          return { page_start: c.page_start, page_end: c.page_end };
        }));
        chunks = chunks.filter(function (c) {
          return !(c.page_end < filterStart || c.page_start > filterEnd);
        });
      }
    }

    if (chunks.length) {
      var built = buildContext(chunks, fileName);
      context        = built.context;
      sources        = built.sources;
      rawContextText = chunks.map(function (c) { return c.chunk_text; }).join(' ');
    }
  }

  // ── Fallback to pdfText ───────────────────────────────────────────────────
  if (!context) {
    if (pdfText && pdfText.trim().length > 100) {
      // Noise filter: reject template/title-slide content when a specific page is requested
      var TEMPLATE_NOISE = ['platzhalter', 'titelfolie', 'bild einsetzen', 'hinter das logo', 'masterfolie', 'vorlage für'];
      var pdfLower = pdfText.toLowerCase();
      var isNoise = filterStart != null && filterStart > 3 &&
        TEMPLATE_NOISE.some(function (t) { return pdfLower.includes(t); });

      if (isNoise) {
        console.warn('[notes-generate] pdfText looks like title-slide/template noise for page', filterStart, '— rejecting fallback');
        return jsonResponse(200, {
          error: 'Die Seiten ' + filterStart + '–' + filterEnd + ' wurden noch nicht indiziert. Bitte warte auf die Indizierung oder wähle "Ganzes PDF".'
        });
      }

      var text = pdfText.slice(0, MAX_CONTEXT_CHARS);
      context        = 'QUELLE: ' + (fileName || 'PDF') + '\n\n' + text;
      rawContextText = text;
    } else {
      return jsonResponse(200, {
        error: documentId
          ? 'Keine indizierten Chunks für Seite ' + (filterStart || '?') + ' gefunden. Bitte warte auf die Indizierung.'
          : 'Kein Inhalt verfügbar. Öffne zuerst ein PDF.'
      });
    }
  }

  // ── Build prompt + user message ───────────────────────────────────────────
  var systemPrompt = tool === 'summary' ? summaryPrompt(language) : notesPrompt(language);

  var pageHint = '';
  if (filterStart != null) {
    pageHint = '\n\nFOKUS: ' + (filterStart === filterEnd
      ? 'Seite ' + filterStart
      : 'Seiten ' + filterStart + '–' + filterEnd) + ' des PDFs.';
  }

  var userMessage = 'PDF-INHALT:\n\n' + context + pageHint +
    '\n\n' + (tool === 'summary'
      ? 'Erstelle eine prägnante Zusammenfassung aus dem obigen Text.'
      : 'Erstelle detaillierte Lernnotizen aus dem obigen Text. Erfasse ALLE Definitionen, Listen, Formeln und Prozessschritte.');

  // ── Generate ──────────────────────────────────────────────────────────────
  var markdown;
  try {
    markdown = await callOpenAI(systemPrompt, userMessage);
  } catch (e) {
    console.error('notes-generate OpenAI error:', e.message);
    return jsonResponse(200, { error: 'KI-Generierung fehlgeschlagen: ' + e.message });
  }

  // ── Quality validation (notes mode only) ─────────────────────────────────
  if (tool === 'notes') {
    var validation = validateNotes(markdown, rawContextText);
    if (!validation.valid) {
      console.log('[notes-generate] validation failed:', validation.issues, '— regenerating with strict prompt');
      try {
        var strictPrompt   = strictNotesPrompt(language, validation.missingTerms);
        var strictMessage  = userMessage + '\n\nFEHLENDE BEGRIFFE — müssen in den Notizen vorkommen: ' +
          validation.missingTerms.join(', ');
        markdown = await callOpenAI(strictPrompt, strictMessage);
      } catch (e) {
        console.error('notes-generate strict regen error:', e.message);
        // keep original markdown
      }
    }
  }

  // ── Save & return ─────────────────────────────────────────────────────────
  var pageLabel = filterStart != null
    ? ' — S. ' + filterStart + (filterEnd && filterEnd !== filterStart ? '–' + filterEnd : '')
    : '';
  var fallbackTitle = (fileName ? fileName.replace(/\.pdf$/i, '') : 'Notizen') +
    pageLabel + ' — ' + (tool === 'summary' ? 'Zusammenfassung' : 'Notizen');

  var title = extractTitle(markdown, fallbackTitle);

  var noteId = null;
  try {
    noteId = await saveNote(serviceKey, {
      userId: user.id, courseId, documentId, title, type: tool, markdown, sources,
      filterStart: filterStart, filterEnd: filterEnd
    });
  } catch (e) {
    console.error('notes-generate save error:', e.message);
  }

  return jsonResponse(200, {
    note: { id: noteId, title, type: tool, content_markdown: markdown, sources }
  });
};
