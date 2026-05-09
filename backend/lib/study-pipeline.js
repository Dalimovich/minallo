// study-pipeline.js
// Multi-step pipeline for generating exam-quality flashcards and quizzes.
//
// Pipeline:
//   1. Embed retrieval queries once (shared across all files)
//   2. Fetch all indexed document IDs for the course
//   3. Process one file at a time — retrieve chunks, generate items
//   4. Track a wall-clock deadline; return partial results if time runs low
//   5. Deduplicate generated items across files
//
// Exported: runPipeline(opts) → { items, sources, error? }

'use strict';

const https = require('https');
const { requireEnv, optionalEnv } = require('./env');
const { supaRequest } = require('./supabase-admin');

// ─── Constants ────────────────────────────────────────────────────────────────

const EMBED_MODEL        = 'text-embedding-3-small';
const EMBED_DIMENSIONS   = 1536;
const OPENAI_MODEL_DEFAULT = optionalEnv('OPENAI_GENERATE_MODEL', 'gpt-4o-mini');
const OPENAI_MODEL_STRONG  = optionalEnv('OPENAI_GENERATE_MODEL_STRONG', 'gpt-4o');
const MIN_SIMILARITY     = 0.10;
const CANDIDATE_LIMIT    = 60;

// Wall-clock budget: leave ~4 s buffer before Netlify's 26 s hard kill.
const PIPELINE_DEADLINE_MS = 22000;

// German/English section keywords that indicate high-value study material
const HIGH_VALUE_SECTIONS = [
  'aufgabe','übung','übungen','beispiel','beispiele','lösung','lösungen',
  'definition','satz','sätze','theorem','formel','formeln','formelzettel',
  'formelsammlung','zusammenfassung','prüfung','klausur','exercise','example',
  'solution','formula','theorem','proof','method','algorithm','procedure',
  'wichtig','merke','hinweis','note','tip','exam','summary','cheatsheet',
  'merkblatt','tabelle','tabellenbuch','keypoint','key point','leitsatz'
];

const FORMULA_SHEET_NAMES = [
  'formel','formelzettel','formelsammlung','zusammenfassung','tabelle',
  'tabellenbuch','cheatsheet','formula','summary','merkblatt','übersicht',
  'cheat','sheet'
];

const SOURCE_BASE = {
  solution: 0.20,
  exercise: 0.18,
  lecture:  0.14,
  exam:     0.16,
  notes:    0.08,
  summary:  0.06,
  other:    0.0
};

// ─── OpenAI helpers ───────────────────────────────────────────────────────────

function embedText(text) {
  return new Promise(function (resolve, reject) {
    const apiKey = requireEnv('OPENAI_API_KEY');
    const body = JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMENSIONS });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        try {
          const p = JSON.parse(d);
          if (res.statusCode >= 300) return reject(new Error('Embed ' + res.statusCode + ': ' + d));
          if (!p.data || !p.data[0]) return reject(new Error('Embed empty: ' + d));
          resolve(p.data[0].embedding);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(12000, function () { req.destroy(new Error('Embed timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callOpenAI(systemPrompt, userMessage, maxTokens, model) {
  return new Promise(function (resolve, reject) {
    const apiKey = requireEnv('OPENAI_API_KEY');
    const body = JSON.stringify({
      model: model || OPENAI_MODEL_DEFAULT,
      max_tokens: maxTokens || 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage }
      ]
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        try {
          const p = JSON.parse(d);
          if (res.statusCode >= 300) return reject(new Error('OpenAI ' + res.statusCode + ': ' + d));
          const text = p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content;
          if (!text) return reject(new Error('Empty OpenAI response'));
          resolve(parseJsonSafe(text));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(18000, function () { req.destroy(new Error('OpenAI timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJsonSafe(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Response not JSON');
  return JSON.parse(m[0]);
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

function rpcChunks(serviceKey, supaUrl, payload) {
  return new Promise(function (resolve) {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: new URL(supaUrl).hostname,
      path: '/rest/v1/rpc/match_chunks_hybrid',
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        try {
          const p = JSON.parse(d);
          resolve(Array.isArray(p) ? p : []);
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', function () { resolve([]); });
    req.write(body);
    req.end();
  });
}

// Retrieve chunks using pre-computed embeddings (avoids re-embedding per file).
async function retrieveWithEmbeddings(serviceKey, userId, courseId, queries, embeddings, docIds) {
  const supaUrl = requireEnv('SUPABASE_URL');

  const allResults = await Promise.all(embeddings.map(function (emb, qi) {
    const basePayload = {
      p_user_id:    userId,
      p_course_id:  courseId,
      p_embedding:  '[' + emb.join(',') + ']',
      p_query:      queries[qi] || '',
      p_match_count: CANDIDATE_LIMIT,
      p_threshold:  MIN_SIMILARITY
    };
    if (docIds && docIds.length) {
      const withFilter = Object.assign({}, basePayload, { p_document_ids: docIds });
      return rpcChunks(serviceKey, supaUrl, withFilter).then(function (chunks) {
        if (chunks.length) return chunks;
        return rpcChunks(serviceKey, supaUrl, basePayload).then(function (all) {
          const idSet = new Set(docIds.map(String));
          return all.filter(function (c) { return idSet.has(String(c.document_id)); });
        });
      });
    }
    return rpcChunks(serviceKey, supaUrl, basePayload);
  }));

  const byId = new Map();
  allResults.forEach(function (chunks) {
    chunks.forEach(function (c) {
      const existing = byId.get(c.id);
      if (!existing || c.similarity > existing.similarity) byId.set(c.id, c);
    });
  });

  return Array.from(byId.values());
}

// ─── Study-value scoring ──────────────────────────────────────────────────────

function isFormulaSheetFile(fileName) {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return FORMULA_SHEET_NAMES.some(function (kw) { return lower.includes(kw); });
}

function sectionScore(sectionTitle) {
  if (!sectionTitle) return 0;
  const lower = sectionTitle.toLowerCase();
  return HIGH_VALUE_SECTIONS.some(function (kw) { return lower.includes(kw); }) ? 0.20 : 0;
}

function textStudyScore(text) {
  if (!text) return 0;
  let score = 0;
  const lower = text.toLowerCase();

  if (/[=≈∑∫∂√π]/.test(text) || /\b[a-z]_?\{?[a-z0-9]\}?\s*=/.test(text)) score += 0.15;
  if (/^\s*\d+[\.\)]/m.test(text)) score += 0.08;
  HIGH_VALUE_SECTIONS.forEach(function (kw) {
    if (lower.includes(kw)) score += 0.06;
  });
  if (/fehler|mistake|achtung|attention|nicht verwechseln|do not|never|always/i.test(text)) score += 0.08;
  if (/^\s*\d+\s*\.{3,}/m.test(text)) score -= 0.20;
  if (text.trim().split('\n').length < 3 && text.length < 80) score -= 0.15;

  return score;
}

function scoreChunk(chunk, docNamesMap) {
  const fileName = docNamesMap[chunk.document_id] || '';
  const formulaSheetBoost = isFormulaSheetFile(fileName) ? 0.25 : 0;
  const officialBoost = chunk.is_official ? 0.08 : 0;
  const sourceBase = SOURCE_BASE[chunk.source_type] || 0;
  const secScore = sectionScore(chunk.section_title);
  const textScore = textStudyScore(chunk.chunk_text);

  return chunk.similarity + sourceBase + formulaSheetBoost + officialBoost + secScore + textScore;
}

function filterAndRank(chunks, docNamesMap) {
  return chunks
    .map(function (c) {
      return Object.assign({}, c, { study_score: scoreChunk(c, docNamesMap) });
    })
    .sort(function (a, b) { return b.study_score - a.study_score; });
}

function deduplicateChunks(chunks, maxCount) {
  const selected = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    const overlaps = selected.some(function (s) {
      return s.document_id === c.document_id &&
        Math.max(s.page_start, c.page_start) <= Math.min(s.page_end, c.page_end);
    });
    if (!overlaps) selected.push(c);
    if (selected.length >= (maxCount || 25)) break;
  }
  return selected;
}

// ─── Document metadata ────────────────────────────────────────────────────────

function fetchDocNames(serviceKey, docIds) {
  if (!docIds.length) return Promise.resolve({});
  const ids = docIds.map(function (id) { return '"' + id + '"'; }).join(',');
  return supaRequest('GET', 'documents?id=in.(' + ids + ')&select=id,file_name', null, serviceKey)
    .then(function (r) {
      const map = {};
      if (Array.isArray(r.body)) r.body.forEach(function (d) { map[d.id] = d.file_name; });
      return map;
    })
    .catch(function () { return {}; });
}

// Fetch all indexed document IDs for a course (used when no docIds filter provided).
function fetchCourseDocIds(serviceKey, userId, courseId) {
  return supaRequest(
    'GET',
    'documents?course_id=eq.' + encodeURIComponent(courseId) +
      '&user_id=eq.' + encodeURIComponent(userId) +
      '&processing_status=eq.ready&select=id',
    null,
    serviceKey
  )
    .then(function (r) {
      if (Array.isArray(r.body)) return r.body.map(function (d) { return d.id; });
      return [];
    })
    .catch(function () { return []; });
}

// ─── Context builder ──────────────────────────────────────────────────────────

function buildContext(chunks, docNamesMap) {
  return chunks.map(function (c, i) {
    const file  = docNamesMap[c.document_id] || 'Unknown';
    const pages = c.page_start === c.page_end ? 'p.' + c.page_start : 'pp.' + c.page_start + '-' + c.page_end;
    const lines = ['[Source ' + (i + 1) + '] ' + file + ', ' + pages];
    if (c.section_title) lines.push('Section: ' + c.section_title);
    if (c.source_type)   lines.push('Type: ' + c.source_type);
    lines.push(c.chunk_text);
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function flashcardsSystemPrompt(count) {
  return `You are an expert university tutor preparing ${count} high-quality flashcards for a student's exam.

Your job is to extract the MOST IMPORTANT study material from the course context below and turn it into varied, exam-relevant flashcards.

CARD TYPES you must use (mix them):
- "definition"   : term on front, precise definition + notation on back
- "formula"      : "What is the formula for X?" on front; formula + meaning of each symbol on back
- "when_to_use"  : "When do you use method X?" on front; conditions + reasoning on back
- "method_steps" : "How do you solve X step by step?" on front; numbered steps on back
- "common_mistake": "What is the common mistake when …?" on front; explanation + correct approach on back
- "comparison"   : "Difference between X and Y?" on front; side-by-side comparison on back
- "mini_exercise": a short calculation or scenario on front; full worked solution on back
- "notation"     : professor-specific symbol or convention on front; meaning + usage on back

RULES:
1. Every card must be grounded in the provided context. Never invent facts.
2. Prioritise: formulas, definitions, theorems, worked examples, exercise patterns, common mistakes.
3. Ignore: table-of-contents lines, headers/footers, administrative text, filler sentences.
4. Back must be substantial — not a one-word answer. Explain the idea clearly.
5. Use the professor's own notation and terminology from the context.
6. Write all math using KaTeX notation: inline math as $...$, display math as $$...$$. For example: $x^2$, $x_0$, $\\sum_i$, $\\int_a^b f(x)\\,dx$.
7. Include difficulty: "easy" | "medium" | "hard".
8. Include why_important: one sentence on why this is exam-relevant.
9. Include source: file name and page (copy from the [Source N] header).

CRITICAL: You MUST generate EXACTLY ${count} items in the "items" array — no more, no fewer.

Respond ONLY with valid JSON:
{"items":[{"front":"...","back":"...","card_type":"formula","difficulty":"medium","why_important":"...","source":"filename, p.X"}]}`;
}

function quizSystemPrompt(count, difficulty) {
  const diffGuide = {
    easy:   'Mostly definition recall and single-step identification. 1-2 medium questions allowed.',
    medium: 'Mix of concept application, formula use, and 1-step calculations. At least 3 questions should require applying a formula or method.',
    hard:   'At least half must require multi-step reasoning, formula application, or spotting a wrong step. Include calculation, trap, and professor-style exercise questions.'
  };

  return `You are an expert university professor writing a ${difficulty} exam quiz with ${count} questions.

Your job is to create challenging, exam-relevant multiple-choice questions from the course context.

QUESTION TYPES you must use (mix them):
- "recall"         : straightforward definition or fact (use sparingly)
- "formula_select" : which formula applies here?
- "calculation"    : compute a result using a given formula and values
- "application"    : apply a concept/method to a new situation
- "multi_step"     : requires 2+ reasoning steps before arriving at the answer
- "wrong_step"     : "Which step in this solution is wrong?"
- "trap"           : tests a common misconception (distractors look plausible)
- "method_choice"  : when/why to use one method over another
- "interpretation" : given a result or graph, what does it mean?
- "professor_style": styled like an actual exam question from the course

DIFFICULTY GUIDE for "${difficulty}": ${diffGuide[difficulty] || diffGuide.medium}

RULES:
1. Every question must be grounded in the context. Never invent facts or values.
2. Distractors (wrong options) must be plausible — not obviously wrong.
3. For calculation questions: use actual values from the context, show the formula in the explanation.
4. explanation: 2-3 sentences. Reference the source, show the correct reasoning or formula.
5. Include difficulty per question: "easy" | "medium" | "hard".
6. Include question_type from the list above.
7. Include why_important: one sentence.
8. Include source: file name and page.
9. Write math using KaTeX notation: inline as $...$, display as $$...$$.
10. answer must be the letter "A", "B", "C", or "D".

CRITICAL: You MUST generate EXACTLY ${count} items in the "items" array — no more, no fewer.

Respond ONLY with valid JSON:
{"items":[{"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"A","explanation":"...","difficulty":"medium","question_type":"calculation","why_important":"...","source":"filename, p.X"}]}`;
}

function summarySystemPrompt() {
  return `You are an expert tutor summarising course materials for exam preparation.
Write a structured, exam-focused summary of the provided COURSE CONTEXT.
Rules:
1. Use ## headings for main topics found in the context.
2. Use bullet points for key facts, definitions, formulas, and methods.
3. Write math using KaTeX notation: inline as $...$, display as $$...$$.
4. End with a "Key Takeaways" section (3-5 bullets).
5. Only include content from the context — no invented facts.
6. Cite (filename, p.X) inline for important claims.
Respond ONLY with valid JSON: {"text":"## Topic\\n- point\\n..."}`;
}

// ─── Output deduplication ─────────────────────────────────────────────────────

function wordJaccard(a, b) {
  const wordsOf = function (s) {
    return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9äöüß\s]/g, ' ').split(/\s+/).filter(Boolean));
  };
  const sa = wordsOf(a);
  const sb = wordsOf(b);
  if (!sa.size || !sb.size) return 0;
  let intersection = 0;
  sa.forEach(function (w) { if (sb.has(w)) intersection++; });
  return intersection / (sa.size + sb.size - intersection);
}

function deduplicateItems(items, threshold) {
  const THRESHOLD = threshold !== undefined ? threshold : 0.72;
  const kept = [];
  items.forEach(function (item) {
    const text = item.question || item.front || '';
    const isDup = kept.some(function (k) {
      return wordJaccard(text, k.question || k.front || '') >= THRESHOLD;
    });
    if (!isDup) kept.push(item);
  });
  return kept;
}

// ─── Retrieval queries by tool ────────────────────────────────────────────────

function buildQueries(tool, topic) {
  if (topic) return [topic];
  if (tool === 'flashcards') {
    return [
      'formulas definitions theorems important concepts notation',
      'exercises solved examples step by step methods procedures',
      'common mistakes professor highlights Aufgabe Beispiel Lösung Formel',
      'Satz Definition Theorem Formelzettel Zusammenfassung'
    ];
  }
  if (tool === 'quiz') {
    return [
      'exercises solved examples calculations exam questions professor problems',
      'formulas applications methods step by step Aufgabe Klausur Prüfung',
      'common mistakes tricky concepts misconceptions Lösung Beispiel',
      'theorems definitions important results Satz Formel'
    ];
  }
  return ['main topics overview key concepts summary'];
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runPipeline({ serviceKey, userId, courseId, tool, topic, count, difficulty, docIds, seenItems }) {
  const startTime   = Date.now();
  const timeLeft    = function () { return PIPELINE_DEADLINE_MS - (Date.now() - startTime); };

  const itemCount   = Math.min(Math.max(parseInt(count) || 8, 3), 15);
  const diff        = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
  const useStrongModel = tool === 'quiz' && diff === 'hard';
  const model       = useStrongModel ? OPENAI_MODEL_STRONG : OPENAI_MODEL_DEFAULT;

  // Summary tool: single-pass (no per-file loop needed)
  if (tool === 'summary') {
    return runSummaryPipeline({ serviceKey, userId, courseId, tool, topic, docIds, model, timeLeft });
  }

  // ── Step 1: embed queries once ──────────────────────────────────────────────
  const queries = buildQueries(tool, topic);
  let embeddings;
  try {
    embeddings = await Promise.all(queries.map(function (q) {
      return embedText(q).catch(function () { return null; });
    }));
    embeddings = embeddings.filter(Boolean);
    if (!embeddings.length) throw new Error('All embeddings failed');
  } catch (e) {
    throw new Error('Retrieval failed: ' + (e.message || e));
  }

  // ── Step 2: determine which files to process ────────────────────────────────
  let fileIds;
  if (docIds && docIds.length) {
    fileIds = docIds;
  } else {
    fileIds = await fetchCourseDocIds(serviceKey, userId, courseId);
    // Fall back: do a broad retrieval to discover which docs have chunks indexed
    if (!fileIds.length) {
      const broad = await retrieveWithEmbeddings(serviceKey, userId, courseId, queries, embeddings, null);
      fileIds = [...new Set(broad.map(function (c) { return c.document_id; }))];
    }
  }

  if (!fileIds.length) {
    return { items: [], sources: [], error: 'No indexed course documents found. Upload and index your course files first.' };
  }

  // ── Step 3: fetch doc names (needed for formula-sheet scoring) ──────────────
  const docNamesMap = await fetchDocNames(serviceKey, fileIds);

  // ── Step 4: per-file generation loop ───────────────────────────────────────
  const allItems   = [];
  const allSources = [];
  const seenSourceFiles = new Set();
  const seen       = Array.isArray(seenItems) ? seenItems.filter(Boolean).slice(0, 50) : [];

  // How many items to request from each file; recalculate as we go
  for (var fi = 0; fi < fileIds.length; fi++) {
    const remaining = itemCount - allItems.length;
    if (remaining <= 0) break;
    // Need at least 5 s: ~2 s for vector search + ~3 s minimum for generation
    if (timeLeft() < 5000) break;

    const docId       = fileIds[fi];
    const thisCount   = Math.max(2, remaining);
    // Ask the model for a small buffer so 1-2 deduped items don't leave us short.
    // The final .slice(0, itemCount) trims back to the requested count.
    const promptCount = fi === 0 ? thisCount + 3 : thisCount;

    // Retrieve chunks for this file using pre-computed embeddings
    let rawChunks;
    try {
      rawChunks = await retrieveWithEmbeddings(serviceKey, userId, courseId, queries, embeddings, [docId]);
    } catch (e) {
      continue;
    }
    if (!rawChunks.length) continue;

    const ranked    = filterAndRank(rawChunks, docNamesMap);
    const maxChunks = Math.min(thisCount * 2, 24);
    const topChunks = deduplicateChunks(ranked, maxChunks);
    if (!topChunks.length) continue;

    // Re-check time after retrieval
    if (timeLeft() < 4000) break;

    const context = buildContext(topChunks, docNamesMap);

    let systemPrompt;
    if (tool === 'flashcards') systemPrompt = flashcardsSystemPrompt(promptCount);
    else                       systemPrompt = quizSystemPrompt(promptCount, diff);

    // Tell the model to avoid items already generated
    const alreadySeen = seen.concat(allItems.map(function (it) { return it.question || it.front || ''; })).filter(Boolean).slice(0, 50);
    if (alreadySeen.length) {
      systemPrompt += '\n\nPREVIOUSLY SHOWN — do NOT generate questions/cards covering the same topic or phrasing as any of these:\n' +
        alreadySeen.map(function (s) { return '- ' + String(s).slice(0, 120); }).join('\n');
    }

    const focusPart   = topic ? '\n\n---\nFocus topic: ' + topic : '';
    const userMessage = 'COURSE CONTEXT:\n\n' + context + focusPart;
    const maxTokens   = tool === 'flashcards'
      ? Math.min(12000, 900 + promptCount * 550)
      : Math.min(8000, 1000 + promptCount * 350);

    let result;
    try {
      result = await callOpenAI(systemPrompt, userMessage, maxTokens, model);
    } catch (e) {
      // Timeout or API error — return whatever we have so far
      break;
    }

    const fileItems = deduplicateItems(result.items || []);
    allItems.push.apply(allItems, fileItems);

    // Accumulate unique sources
    topChunks.forEach(function (c) {
      const fn = docNamesMap[c.document_id] || 'Unknown';
      if (!seenSourceFiles.has(fn)) {
        seenSourceFiles.add(fn);
        allSources.push({
          file_name: fn,
          pages: c.page_start === c.page_end ? String(c.page_start) : c.page_start + '-' + c.page_end,
          section: c.section_title || null
        });
      }
    });
  }

  if (!allItems.length) {
    return { items: [], sources: [], error: 'No indexed course documents found. Upload and index your course files first.' };
  }

  let finalItems = deduplicateItems(allItems).slice(0, itemCount);

  // ── Repair pass: backfill if deduplication left us short ───────────────────
  const shortage = itemCount - finalItems.length;
  if (shortage > 0 && timeLeft() > 5000 && allSources.length) {
    // Re-use the best context we already retrieved (first source file)
    const repairDocId = fileIds[0];
    let repairChunks = [];
    try {
      const raw = await retrieveWithEmbeddings(serviceKey, userId, courseId, queries, embeddings, [repairDocId]);
      repairChunks = deduplicateChunks(filterAndRank(raw, docNamesMap), Math.min(shortage * 3, 20));
    } catch (e) {}

    if (repairChunks.length) {
      const repairContext = buildContext(repairChunks, docNamesMap);
      const alreadyGenerated = finalItems.map(function (it) { return it.question || it.front || ''; }).filter(Boolean);
      let repairPrompt = tool === 'flashcards'
        ? flashcardsSystemPrompt(shortage)
        : quizSystemPrompt(shortage, diff);
      repairPrompt += '\n\nDO NOT repeat any of these already-generated items:\n' +
        alreadyGenerated.map(function (s) { return '- ' + s.slice(0, 120); }).join('\n');

      const repairTokens = tool === 'flashcards'
        ? Math.min(8000, 900 + shortage * 400)
        : Math.min(6000, 1000 + shortage * 320);

      try {
        const repairResult = await callOpenAI(repairPrompt, 'COURSE CONTEXT:\n\n' + repairContext, repairTokens, model);
        const repairItems = deduplicateItems((repairResult.items || []).concat(finalItems)).slice(0, itemCount);
        if (repairItems.length > finalItems.length) finalItems = repairItems;
      } catch (e) {}
    }
  }

  return { items: finalItems, text: '', sources: allSources };
}

// ─── Summary pipeline (single-pass, unchanged behaviour) ─────────────────────

async function runSummaryPipeline({ serviceKey, userId, courseId, tool, topic, docIds, model, timeLeft }) {
  const queries = buildQueries(tool, topic);
  let embeddings;
  try {
    embeddings = await Promise.all(queries.map(function (q) {
      return embedText(q).catch(function () { return null; });
    }));
    embeddings = embeddings.filter(Boolean);
    if (!embeddings.length) throw new Error('All embeddings failed');
  } catch (e) {
    throw new Error('Retrieval failed: ' + (e.message || e));
  }

  let rawChunks;
  try {
    rawChunks = await retrieveWithEmbeddings(serviceKey, userId, courseId, queries, embeddings, docIds || null);
  } catch (e) {
    throw new Error('Retrieval failed: ' + (e.message || e));
  }
  if (!rawChunks.length) {
    return { items: [], sources: [], error: 'No indexed course documents found.' };
  }

  const uniqueDocIds = [...new Set(rawChunks.map(function (c) { return c.document_id; }))];
  const docNamesMap  = await fetchDocNames(serviceKey, uniqueDocIds);
  const ranked       = filterAndRank(rawChunks, docNamesMap);
  const topChunks    = deduplicateChunks(ranked, 18);
  const context      = buildContext(topChunks, docNamesMap);
  const focusPart    = topic ? '\n\n---\nFocus topic: ' + topic : '';

  if (timeLeft() < 4000) return { items: [], sources: [], error: 'Not enough time remaining.' };

  let result;
  try {
    result = await callOpenAI(summarySystemPrompt(), 'COURSE CONTEXT:\n\n' + context + focusPart, 1600, model);
  } catch (e) {
    throw new Error('Generation failed: ' + (e.message || e));
  }

  const seenFiles = new Set();
  const sources = topChunks
    .map(function (c) {
      return {
        file_name: docNamesMap[c.document_id] || 'Unknown',
        pages: c.page_start === c.page_end ? String(c.page_start) : c.page_start + '-' + c.page_end,
        section: c.section_title || null
      };
    })
    .filter(function (s) {
      if (seenFiles.has(s.file_name)) return false;
      seenFiles.add(s.file_name);
      return true;
    });

  return { items: [], text: result.text || '', sources };
}

module.exports = {
  runPipeline,
  _testing: { parseJsonSafe, wordJaccard, deduplicateItems, textStudyScore, flashcardsSystemPrompt, quizSystemPrompt }
};
