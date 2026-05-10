// POST /api/notes/generate
// Body: { courseId, documentId, tool, pdfText?, fileName?,
//         scope: 'page'|'section'|'range'|'document',
//         currentPage?, pageRange?: {start,end},
//         language: 'same_as_source'|'en'|'de'|'bilingual',
//         detailLevel: 'brief'|'balanced'|'detailed'|'exam' }
// Response: { note: { id, title, type, content_markdown, sources } }

'use strict';

const https = require('https');
const { requireEnv, optionalEnv } = require('../lib/env');
const { jsonResponse, fail, handleOptions } = require('../lib/responses');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');
const { supaRequest } = require('../lib/supabase-admin');
const {
  langInstr,
  getMaxTokens,
  targetWordCount,
  summaryPrompt,
  sectionSummaryPrompt,
  mergeSummaryPrompt,
  strictSummaryPrompt,
  validateSummary,
  FILLER_PHRASES,
  TEMPLATE_NOISE_TERMS
} = require('../lib/summary-prompts');

const {
  classifyChunk,
  cleanChunkText,
  chooseSummaryStrategy,
  buildSummaryPipeline,
  computeEffectivePages,
  LOW_VALUE_CATEGORIES
} = require('../lib/summary-pipeline');

const OPENAI_MODEL    = optionalEnv('OPENAI_GENERATE_MODEL_STRONG', 'gpt-4o');
const MAX_CONTEXT_CHARS = 28000;

// ── Notes prompts (notes-only logic stays here) ───────────────────────────────

function notesPrompt(lang) {
  return `You are generating detailed, exam-ready study notes from university lecture PDF slides.

${langInstr(lang)}

IGNORE completely: author names, institute names, semester labels, university logos, slide numbers, copyright lines, and any administrative text that is not course content.

CRITICAL RULES:
- Use ONLY the provided PDF text. Do NOT invent facts.
- This is DETAILED NOTES mode — not a summary. Be exhaustive.
- Do NOT write vague bullets like "Overview of methods" or "Various casting techniques" — name every specific method, material, step, and property found in the source.
- Every method or process named in the source → dedicate a ### subsection with: what it is, how it works, materials used, all listed advantages, all listed disadvantages/limitations.
- Every definition-like sentence → quote it verbatim or near-verbatim under Definitions.
- Every list in the PDF → reproduce it COMPLETELY with ALL items — do not shorten.
- Every formula → KaTeX inline $...$ or display $$...$$, explain every variable and unit.
- Section headings in the PDF (bold text, capitalized titles) → use those as ### headings in your notes.
- Notes must be detailed enough to study from WITHOUT reopening the PDF.

STRUCTURE — follow the order of topics as they appear in the source:

# [Main topic from the PDF title or first major heading]

## Definitionen / Definitions
- **Term**: exact source definition with page ref *(S. X)*

## Einteilungen und Normen / Classifications and Standards
All classification schemes (e.g. DIN norms), complete with ALL listed categories.

## Verfahren / Methods and Processes
For EACH method named in the source, create a subsection:
### [Method Name] *(S. X)*
- **Prinzip**: how it works
- **Werkstoffe / Materials**: what materials are used
- **Vorteile**: every advantage listed in the source
- **Nachteile / Grenzen**: every disadvantage or limitation
- **Anwendungen**: applications if mentioned

## Formeln / Formulas
KaTeX with variable explanations.

## Vergleiche / Comparisons
Comparison tables or side-by-side lists for methods/materials.

## Prüfungsrelevanz / Exam Focus
Concrete exam-likely questions and answers based on the source content.

Rules:
- Minimum one ### subsection per named method/process in the source
- Use tables for comparisons (Markdown table syntax)
- Cite page numbers: *(S. X)* or *(S. X–Y)*
- Every sentence must add information — no filler, no repetition`;
}

function strictNotesPrompt(lang, missingTerms) {
  return notesPrompt(lang) + `

ADDITIONAL REQUIREMENT — FINAL CHECK:
The following terms were found in the source text but are MISSING from your notes. You MUST include all of them:
${missingTerms.map(function (t) { return '- ' + t; }).join('\n')}

Do not submit notes that omit these terms.`;
}

function sectionNotesPrompt(lang, pageStart, pageEnd) {
  var pageRef = pageStart != null
    ? (pageStart === pageEnd ? 'Seite ' + pageStart : 'Seiten ' + pageStart + '–' + pageEnd)
    : 'diesem Abschnitt';
  return `You are generating detailed study notes for ONE specific page group from a university lecture PDF.

${langInstr(lang)}

IGNORE: author names, institute names, university logos, semester labels, copyright lines.

Your task: extract EVERYTHING worth studying from ${pageRef}. This is a section of a larger chapter — do not introduce the chapter context, just cover what is on these pages.

Rules:
- For each method, process, or material named: create a ### heading with what it is, how it works, all advantages, all disadvantages, materials, applications.
- For each definition: quote it near-verbatim with page ref *(S. X)*.
- For each list: reproduce it COMPLETELY with all items.
- For each formula: use KaTeX $...$ or $$...$$, explain every variable.
- If a piece of information is not clearly in the source, do NOT include it. Simply omit unclear content.
- Every claim needs a page reference *(S. X)*.
- No filler sentences. Every bullet adds information.
- No formulas section if there are no formulas on these pages — write "Keine Formeln auf diesen Seiten."

Format:
## [Topic heading from the page — use the actual slide/section title]

### [Method / Term / Process name] *(S. X)*
- **Was es ist**: ...
- **Vorteile**: ...
- **Nachteile**: ...
- **Materialien / Werkstoffe**: ...
- **Anwendung**: ...

Preserve exact page references throughout.`;
}

function mergeNotesPrompt(lang) {
  return `You are merging multiple section notes from a university lecture PDF into one final structured study note.

${langInstr(lang)}

Rules:
- Preserve ALL content from ALL sections. Do NOT shorten, compress, or summarize aggressively.
- Remove exact duplicates (same fact stated twice identically), but keep near-duplicates if they have different context or page refs.
- Keep ALL page references (S. X) — they are critical for studying.
- Organize by topic: group related content under ## headings matching the lecture's structure.
- Do NOT invent new information. Only use what is in the provided sections.
- Every method/process must still have its own ### subsection with pros/cons.
- Add a final ## Prüfungsrelevanz / Exam Focus section summarizing the 5–10 most exam-relevant points.

Output a complete, well-structured Markdown document starting with:
# [Chapter/Topic Title]

The merged note should be significantly longer than any individual section note.`;
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

function callOpenAI(systemPrompt, userMessage, maxTokens) {
  return new Promise(function (resolve, reject) {
    var apiKey = requireEnv('OPENAI_API_KEY');
    var body = JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens || 4000,
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

// ── Notes quality validation ──────────────────────────────────────────────────

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

function validateNotes(markdown, contextText) {
  var issues = [];

  if (markdown.length < 700) issues.push('too_short');

  var keyTerms = extractKeyTerms(contextText);
  var mdLower  = markdown.toLowerCase();
  var missingTerms = keyTerms.filter(function (t) { return !mdLower.includes(t); });
  if (keyTerms.length > 0 && missingTerms.length / keyTerms.length > 0.45) {
    issues.push('missing_terms');
  }

  for (var i = 0; i < FILLER_PHRASES.length; i++) {
    if (mdLower.includes(FILLER_PHRASES[i])) { issues.push('generic_filler'); break; }
  }

  for (var j = 0; j < TEMPLATE_NOISE_TERMS.length; j++) {
    if (mdLower.includes(TEMPLATE_NOISE_TERMS[j])) { issues.push('template_noise'); break; }
  }

  return { valid: issues.length === 0, issues: issues, missingTerms: missingTerms.slice(0, 15) };
}

// ── Chunk retrieval ───────────────────────────────────────────────────────────

var METADATA_NOISE = [
  'institut für', 'technische universität', 'prof.', 'dr.-ing.', 'wintersemester',
  'sommersemester', 'lehrstuhl', 'fachgebiet', 'vorlesung', 'folien', 'slides',
  'copyright', '©', 'all rights reserved', 'tu braunschweig', 'tu berlin'
];

function isMetadataChunk(text) {
  if (!text || text.length > 400) return false;
  var lower = text.toLowerCase();
  var hits = METADATA_NOISE.filter(function (t) { return lower.includes(t); }).length;
  return hits >= 2;
}

async function fetchChunks(serviceKey, userId, courseId, documentId, pageStart, pageEnd) {
  var limit = (pageStart == null && pageEnd == null) ? 150 : 80;
  var path = 'document_chunks' +
    '?select=chunk_text,page_start,page_end,section_title,source_type' +
    '&user_id=eq.' + encodeURIComponent(userId) +
    '&course_id=eq.' + encodeURIComponent(courseId) +
    '&document_id=eq.' + encodeURIComponent(documentId) +
    '&order=page_start.asc,id.asc' +
    '&limit=' + limit;
  if (pageEnd   != null) path += '&page_start=lte.' + pageEnd;
  if (pageStart != null) path += '&page_end=gte.'   + pageStart;

  var result = await supaRequest('GET', path, null, serviceKey);
  var chunks = Array.isArray(result.body) ? result.body : [];
  return chunks.filter(function (c) { return !isMetadataChunk(c.chunk_text); });
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
      user_id:           opts.userId,
      course_id:         opts.courseId,
      document_id:       opts.documentId || null,
      title:             opts.title,
      type:              opts.type,
      content_markdown:  opts.markdown,
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
  var detailLevel = body.detailLevel || 'balanced';  // brief | balanced | detailed | exam
  var scope       = body.scope       || 'section';   // page | section | range | document
  var currentPage = body.currentPage != null ? Number(body.currentPage) : null;
  var pageRange   = body.pageRange   || null;

  var mode = body.mode || 'generate'; // 'generate' | 'section' | 'merge'

  if (!courseId) return fail(400, 'courseId is required');
  if (!['notes', 'summary'].includes(tool)) return fail(400, 'tool must be notes or summary');

  var serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // ── ANALYZE MODE: classify + group chunks, return topic groups to frontend ─
  if (mode === 'analyze') {
    if (!documentId) return jsonResponse(200, { groups: [] });

    var analyzeStart = body.pageRange && body.pageRange.start != null ? Number(body.pageRange.start) : null;
    var analyzeEnd   = body.pageRange && body.pageRange.end   != null ? Number(body.pageRange.end)   : null;

    var rawChunks = await fetchChunks(serviceKey, user.id, courseId, documentId, analyzeStart, analyzeEnd)
      .catch(function () { return []; });

    var pipeline = buildSummaryPipeline(rawChunks, false);

    var groups = pipeline.groups.map(function (g) {
      return {
        title:     g.title,
        pageStart: g.pageStart,
        pageEnd:   g.pageEnd,
        category:  g.chunks && g.chunks[0] && g.chunks[0]._category
      };
    });

    var analyzeEffective = computeEffectivePages(pipeline.keptChunks);

    console.log('[notes-generate analyze]', {
      total: pipeline.totalCount,
      filtered: pipeline.filteredCount,
      groups: groups.length,
      effectivePages: analyzeEffective
    });

    return jsonResponse(200, { groups: groups, effectivePages: analyzeEffective });
  }

  // ── MERGE MODE ────────────────────────────────────────────────────────────
  if (mode === 'merge') {
    var sections = body.sections || [];
    if (!sections.length) return fail(400, 'sections required for merge mode');

    var combinedInput = sections.map(function (s, i) {
      var hdr = (s.pageStart != null)
        ? '=== SECTION ' + (i + 1) + ': Seiten ' + s.pageStart + '–' + s.pageEnd + ' ==='
        : '=== SECTION ' + (i + 1) + ' ===';
      if (s.title) hdr += ' — ' + s.title;
      return hdr + '\n\n' + s.markdown;
    }).join('\n\n');

    // Compute total effective pages from all section markdowns as a proxy for content size
    var mergeEffectivePages = body.effectivePages != null ? Number(body.effectivePages) : null;
    var mergeTotalWords     = mergeEffectivePages != null ? targetWordCount(detailLevel, mergeEffectivePages) : null;
    var topicGroupTitles    = sections.map(function (s) { return s.title || null; }).filter(Boolean);

    var mergePromptFn   = tool === 'summary'
      ? mergeSummaryPrompt(language, detailLevel, mergeTotalWords, topicGroupTitles.length ? topicGroupTitles : null)
      : mergeNotesPrompt(language);
    var mergeInstruction = tool === 'summary'
      ? 'Merge these section summaries into one final structured study summary:\n\n'
      : 'Merge these section notes into one final study note:\n\n';
    var mergeMaxTokens = tool === 'summary'
      ? getMaxTokens('summary', detailLevel, mergeEffectivePages) + 1000
      : 5000;

    var mergedMarkdown;
    try {
      mergedMarkdown = await callOpenAI(
        mergePromptFn,
        mergeInstruction + combinedInput.slice(0, MAX_CONTEXT_CHARS),
        mergeMaxTokens
      );
    } catch (e) {
      return jsonResponse(200, { error: 'Merge failed: ' + e.message });
    }

    var mergeTitle = extractTitle(mergedMarkdown,
      (fileName || 'Notizen') + ' — ' + (tool === 'summary' ? 'Zusammenfassung' : 'Notizen'));

    var mergeFilterStart = sections[0] && sections[0].pageStart != null ? sections[0].pageStart : null;
    var mergeFilterEnd   = sections[sections.length - 1] && sections[sections.length - 1].pageEnd != null
      ? sections[sections.length - 1].pageEnd : null;

    var mergeSources = [];
    sections.forEach(function (s) {
      if (s.pageStart != null) mergeSources.push({ page_start: s.pageStart, page_end: s.pageEnd });
    });

    var mergeNoteId = null;
    try {
      mergeNoteId = await saveNote(serviceKey, {
        userId: user.id, courseId, documentId, title: mergeTitle, type: tool,
        markdown: mergedMarkdown, sources: mergeSources,
        filterStart: mergeFilterStart, filterEnd: mergeFilterEnd
      });
    } catch (e) { console.error('merge save error:', e.message); }

    return jsonResponse(200, {
      note: { id: mergeNoteId, title: mergeTitle, type: tool, content_markdown: mergedMarkdown, sources: mergeSources }
    });
  }

  // ── SECTION MODE ──────────────────────────────────────────────────────────
  if (mode === 'section') {
    var secStart    = body.pageRange && body.pageRange.start != null ? Number(body.pageRange.start) : null;
    var secEnd      = body.pageRange && body.pageRange.end   != null ? Number(body.pageRange.end)   : null;
    var topicTitle  = body.topicTitle || null;

    var rawSecChunks = documentId
      ? await fetchChunks(serviceKey, user.id, courseId, documentId, secStart, secEnd)
      : [];

    // For summary mode: classify, filter low-value pages, and clean text
    var secChunks;
    if (tool === 'summary' && rawSecChunks.length) {
      secChunks = rawSecChunks
        .map(function (c) {
          return Object.assign({}, c, {
            _category:  classifyChunk(c),
            chunk_text: cleanChunkText(c.chunk_text)
          });
        })
        .filter(function (c) {
          return !LOW_VALUE_CATEGORIES.has(c._category) && c.chunk_text.length > 30;
        });
    } else {
      secChunks = rawSecChunks;
    }

    var secContext = null;
    if (secChunks.length) {
      var secBuilt = buildContext(secChunks, body.fileName);
      secContext = secBuilt.context;
    } else if (body.pdfText && body.pdfText.trim().length > 50) {
      secContext = 'QUELLE: ' + (body.fileName || 'PDF') + '\n\n' + body.pdfText.slice(0, MAX_CONTEXT_CHARS);
    }

    if (!secContext) {
      return jsonResponse(200, { markdown: '', pageStart: secStart, pageEnd: secEnd, empty: true });
    }

    var secEffectivePages = secChunks.length ? computeEffectivePages(
      secChunks.map(function (c) { return Object.assign({}, c, { _category: c._category || classifyChunk(c) }); })
    ) : null;
    var secTargetWords = secEffectivePages != null ? targetWordCount(detailLevel, secEffectivePages) : null;
    var secMaxTokens   = tool === 'summary'
      ? getMaxTokens('summary', detailLevel, secEffectivePages)
      : 2500;

    var secPrompt = tool === 'summary'
      ? sectionSummaryPrompt(language, detailLevel, secStart, secEnd, topicTitle, secTargetWords)
      : sectionNotesPrompt(language, secStart, secEnd);
    var secInstruction = tool === 'summary'
      ? 'Erstelle eine Zusammenfassung NUR für diesen Abschnitt (S. ' + secStart + '–' + secEnd + ').'
      : 'Erstelle detaillierte Lernnotizen NUR für diesen Abschnitt.';

    var secMarkdown;
    try {
      secMarkdown = await callOpenAI(
        secPrompt,
        'PDF-INHALT (Seiten ' + secStart + '–' + secEnd + '):\n\n' + secContext + '\n\n' + secInstruction,
        secMaxTokens
      );
    } catch (e) {
      return jsonResponse(200, { error: 'Section generation failed: ' + e.message });
    }

    return jsonResponse(200, { markdown: secMarkdown, pageStart: secStart, pageEnd: secEnd });
  }

  // ── GENERATE MODE ─────────────────────────────────────────────────────────
  console.log('[notes-generate]', { mode, scope, currentPage, pageRange, tool, detailLevel });

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
    if (filterStart == null && pageRange) {
      filterStart = pageRange.start != null ? Number(pageRange.start) : null;
      filterEnd   = pageRange.end   != null ? Number(pageRange.end)   : null;
    }
  }

  console.log('[notes-generate page filter]', { filterStart, filterEnd, scope, currentPage });

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
      // For summary: classify, filter low-value pages, clean text before building context
      var contextChunks = chunks;
      if (tool === 'summary') {
        contextChunks = chunks
          .map(function (c) {
            return Object.assign({}, c, {
              _category:  classifyChunk(c),
              chunk_text: cleanChunkText(c.chunk_text)
            });
          })
          .filter(function (c) {
            return !LOW_VALUE_CATEGORIES.has(c._category) && c.chunk_text.length > 30;
          });
        if (!contextChunks.length) contextChunks = chunks; // fallback if everything filtered
      }

      var built = buildContext(contextChunks, fileName);
      context        = built.context;
      sources        = built.sources;
      rawContextText = contextChunks.map(function (c) { return c.chunk_text; }).join(' ');
    }
  }

  if (!context) {
    if (pdfText && pdfText.trim().length > 100) {
      var TEMPLATE_NOISE_INLINE = ['platzhalter', 'titelfolie', 'bild einsetzen', 'hinter das logo', 'masterfolie', 'vorlage für'];
      var pdfLower = pdfText.toLowerCase();
      var isNoise  = filterStart != null && filterStart > 3 &&
        TEMPLATE_NOISE_INLINE.some(function (t) { return pdfLower.includes(t); });

      if (isNoise) {
        console.warn('[notes-generate] pdfText looks like title-slide/template noise for page', filterStart);
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

  // Compute effective content pages from classified chunks (summary only)
  var genEffectivePages = null;
  if (tool === 'summary' && context) {
    var classifiedForWeight = (documentId ? chunks : []).map(function (c) {
      return Object.assign({}, c, { _category: c._category || classifyChunk(c) });
    });
    if (classifiedForWeight.length) {
      genEffectivePages = computeEffectivePages(classifiedForWeight);
      console.log('[notes-generate effective pages]', genEffectivePages);
    }
  }
  var genTargetWords = genEffectivePages != null ? targetWordCount(detailLevel, genEffectivePages) : null;

  var systemPrompt = tool === 'summary'
    ? summaryPrompt(language, detailLevel, genTargetWords)
    : notesPrompt(language);
  var maxTokens = getMaxTokens(tool, detailLevel, genEffectivePages);

  var pageHint = '';
  if (filterStart != null) {
    pageHint = '\n\nFOKUS: ' + (filterStart === filterEnd
      ? 'Seite ' + filterStart
      : 'Seiten ' + filterStart + '–' + filterEnd) + ' des PDFs. Verwende NUR Inhalte aus diesem Seitenbereich.';
  }

  var userMessage = 'PDF-INHALT:\n\n' + context + pageHint +
    '\n\n' + (tool === 'summary'
      ? 'Erstelle eine studentengerechte Zusammenfassung aus dem obigen Text. Halte dich strikt an den angegebenen Seitenbereich. Erfasse alle wichtigen Definitionen, Formeln, Listen, Prozesse und Vergleiche.'
      : 'Erstelle detaillierte Lernnotizen aus dem obigen Text. Erfasse ALLE Definitionen, Listen, Formeln und Prozessschritte.');

  var markdown;
  try {
    markdown = await callOpenAI(systemPrompt, userMessage, maxTokens);
  } catch (e) {
    console.error('notes-generate OpenAI error:', e.message);
    return jsonResponse(200, { error: 'KI-Generierung fehlgeschlagen: ' + e.message });
  }

  // ── Quality validation ────────────────────────────────────────────────────
  if (tool === 'notes') {
    var validation = validateNotes(markdown, rawContextText);
    if (!validation.valid) {
      console.log('[notes-generate] notes validation failed:', validation.issues, '— regenerating');
      try {
        var sPrompt  = strictNotesPrompt(language, validation.missingTerms);
        var sMessage = userMessage + '\n\nFEHLENDE BEGRIFFE — müssen in den Notizen vorkommen: ' +
          validation.missingTerms.join(', ');
        markdown = await callOpenAI(sPrompt, sMessage, maxTokens);
      } catch (e) {
        console.error('notes-generate strict regen error:', e.message);
      }
    }
  } else if (tool === 'summary') {
    var selectedPageCount = (filterStart != null && filterEnd != null) ? filterEnd - filterStart + 1 : 0;
    var sumValidation = validateSummary(markdown, rawContextText, detailLevel, selectedPageCount, genTargetWords);
    if (!sumValidation.valid) {
      console.log('[notes-generate] summary validation failed:', sumValidation.issues, '— regenerating');
      try {
        markdown = await callOpenAI(
          strictSummaryPrompt(language, detailLevel, sumValidation.missingTerms),
          userMessage,
          maxTokens
        );
      } catch (e) {
        console.error('notes-generate summary strict regen error:', e.message);
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
      filterStart, filterEnd
    });
  } catch (e) {
    console.error('notes-generate save error:', e.message);
  }

  return jsonResponse(200, {
    note: { id: noteId, title, type: tool, content_markdown: markdown, sources }
  });
};
