// study-pipeline.js
// Multi-step pipeline for generating exam-quality flashcards and quizzes.
//
// Pipeline:
//   1. Retrieve a large candidate pool (multi-query, formula-sheet boosting)
//   2. Score each chunk for study value (formulas, exercises, definitions …)
//   3. Keep only high-value chunks; deduplicate across documents
//   4. Build structured context with section labels
//   5. Call OpenAI with rich, role-specific prompts
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
const CANDIDATE_LIMIT    = 60;  // larger pool so scoring has more to work with

// German/English section keywords that indicate high-value study material
const HIGH_VALUE_SECTIONS = [
  'aufgabe','übung','übungen','beispiel','beispiele','lösung','lösungen',
  'definition','satz','sätze','theorem','formel','formeln','formelzettel',
  'formelsammlung','zusammenfassung','prüfung','klausur','exercise','example',
  'solution','formula','theorem','proof','method','algorithm','procedure',
  'wichtig','merke','hinweis','note','tip','exam','summary','cheatsheet',
  'merkblatt','tabelle','tabellenbuch','keypoint','key point','leitsatz'
];

// File-name fragments that indicate formula sheets / summaries (big boost)
const FORMULA_SHEET_NAMES = [
  'formel','formelzettel','formelsammlung','zusammenfassung','tabelle',
  'tabellenbuch','cheatsheet','formula','summary','merkblatt','übersicht',
  'cheat','sheet'
];

// Source-type base scores
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
    req.setTimeout(15000, function () { req.destroy(new Error('Embed timed out')); });
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
      max_tokens: maxTokens || 2800,
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
    req.setTimeout(45000, function () { req.destroy(new Error('OpenAI timed out')); });
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

async function retrieveMultiQuery(serviceKey, userId, courseId, queries, docIds) {
  const supaUrl = requireEnv('SUPABASE_URL');

  // Embed all queries in parallel
  const embeddings = await Promise.all(queries.map(function (q) {
    return embedText(q).catch(function () { return null; });
  }));

  const validEmbeddings = embeddings.filter(Boolean);
  if (!validEmbeddings.length) throw new Error('All embeddings failed');

  // Fetch chunks for each query in parallel
  const allResults = await Promise.all(validEmbeddings.map(function (emb, qi) {
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

  // Merge: deduplicate by chunk id, keep highest similarity per chunk
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

  // Formula indicators
  if (/[=≈∑∫∂√π]/.test(text) || /\b[a-z]_?\{?[a-z0-9]\}?\s*=/.test(text)) score += 0.15;
  // Numbered list / steps
  if (/^\s*\d+[\.\)]/m.test(text)) score += 0.08;
  // German section keywords in body
  HIGH_VALUE_SECTIONS.forEach(function (kw) {
    if (lower.includes(kw)) score += 0.06;
  });
  // Common mistake signals
  if (/fehler|mistake|achtung|attention|nicht verwechseln|do not|never|always/i.test(text)) score += 0.08;
  // Table-of-contents / header noise (penalise)
  if (/^\s*\d+\s*\.{3,}/m.test(text)) score -= 0.20;  // dotted TOC line
  if (text.trim().split('\n').length < 3 && text.length < 80) score -= 0.15; // very short fragment

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
6. Write all math using KaTeX notation: inline math as $...$, display math as $$...$$. For example: $x^2$, $x_0$, $\sum_i$, $\int_a^b f(x)\,dx$.
7. Include difficulty: "easy" | "medium" | "hard".
8. Include why_important: one sentence on why this is exam-relevant.
9. Include source: file name and page (copy from the [Source N] header).

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

Respond ONLY with valid JSON:
{"items":[{"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"A","explanation":"...","difficulty":"medium","question_type":"calculation","why_important":"...","source":"filename, p.X"}]}`;
}

// ─── Output deduplication ─────────────────────────────────────────────────────

// Jaccard similarity on word sets — catches rephrased duplicates.
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

// Remove generated items whose question/front text is too similar to an earlier item.
function deduplicateItems(items) {
  const THRESHOLD = 0.55;
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

// ─── Topic discovery ──────────────────────────────────────────────────────────

// When no topic is specified, retrieve a broad sample and ask the model to list
// the main topics — then use those as targeted retrieval queries. This ensures
// the generated items cover the full course rather than whichever generic queries
// happen to score highest.
async function discoverTopics(serviceKey, userId, courseId, tool, docIds) {
  const broadQueries = [
    'main topics key concepts overview',
    'Themen Kapitel Übersicht Inhaltsverzeichnis'
  ];
  let chunks;
  try {
    chunks = await retrieveMultiQuery(serviceKey, userId, courseId, broadQueries, docIds);
  } catch (e) {
    return null;
  }
  if (!chunks.length) return null;

  // Take top 10 chunks by similarity for the topic-discovery call
  const sample = chunks
    .sort(function (a, b) { return b.similarity - a.similarity; })
    .slice(0, 10)
    .map(function (c) { return c.chunk_text; })
    .join('\n\n---\n\n');

  const systemPrompt =
    'You are a course analyst. Given excerpts from course materials, list the 4-6 distinct ' +
    'main topics covered. Return ONLY valid JSON: {"topics":["topic 1","topic 2",...]}. ' +
    'Each topic should be a short phrase (3-8 words) that would make a good search query.';

  try {
    const result = await callOpenAI(systemPrompt, sample, 300, OPENAI_MODEL_DEFAULT);
    if (Array.isArray(result.topics) && result.topics.length) return result.topics;
  } catch (e) { /* fall through to generic queries */ }
  return null;
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
  const itemCount  = Math.min(Math.max(parseInt(count) || 8, 3), 15);
  const diff       = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';

  // Use the stronger model for hard quizzes — gpt-4o-mini can't reliably produce
  // multi-step calculation and trap questions at hard difficulty.
  const useStrongModel = tool === 'quiz' && diff === 'hard';
  const model = useStrongModel ? OPENAI_MODEL_STRONG : OPENAI_MODEL_DEFAULT;

  // Scale context to item count: more items need more source material to avoid repetition.
  const maxContextChunks = Math.min(itemCount * 2, 25);

  // Step 1: build retrieval queries — use discovered course topics when no topic
  // is specified so retrieval covers the full course rather than relying on generic queries.
  let queries;
  if (!topic) {
    const discovered = await discoverTopics(serviceKey, userId, courseId, tool, docIds);
    queries = discovered || buildQueries(tool, topic);
  } else {
    queries = buildQueries(tool, topic);
  }

  // Step 2: retrieve large candidate pool across multiple queries
  let rawChunks;
  try {
    rawChunks = await retrieveMultiQuery(serviceKey, userId, courseId, queries, docIds);
  } catch (e) {
    throw new Error('Retrieval failed: ' + (e.message || e));
  }

  if (!rawChunks.length) {
    return { items: [], sources: [], error: 'No indexed course documents found. Upload and index your course files first.' };
  }

  // Step 3: fetch doc names so we can score formula-sheet files
  const uniqueDocIds = [...new Set(rawChunks.map(function (c) { return c.document_id; }))];
  const docNamesMap  = await fetchDocNames(serviceKey, uniqueDocIds);

  // Step 4: score for study value, rank, deduplicate chunks
  const ranked    = filterAndRank(rawChunks, docNamesMap);
  const topChunks = deduplicateChunks(ranked, maxContextChunks);

  if (!topChunks.length) {
    return { items: [], sources: [], error: 'Could not find enough high-value study material. Try indexing more files.' };
  }

  // Step 5: build context string
  const context = buildContext(topChunks, docNamesMap);

  // Step 6: choose prompt and call OpenAI
  let systemPrompt;
  if (tool === 'flashcards')  systemPrompt = flashcardsSystemPrompt(itemCount);
  else if (tool === 'quiz')   systemPrompt = quizSystemPrompt(itemCount, diff);
  else systemPrompt = summarySystemPrompt();

  // Append seen-items block so the model avoids repeating them
  const seen = Array.isArray(seenItems) ? seenItems.filter(Boolean).slice(0, 50) : [];
  if (seen.length) {
    systemPrompt += '\n\nPREVIOUSLY SHOWN — do NOT generate questions/cards covering the same topic or phrasing as any of these:\n' +
      seen.map(function (s) { return '- ' + String(s).slice(0, 120); }).join('\n');
  }

  const focusPart  = topic ? '\n\n---\nFocus topic: ' + topic : '';
  const userMessage = 'COURSE CONTEXT:\n\n' + context + focusPart;

  const maxTokens = tool === 'flashcards' ? 3200 : tool === 'quiz' ? (useStrongModel ? 4096 : 3200) : 2000;

  let result;
  try {
    result = await callOpenAI(systemPrompt, userMessage, maxTokens, model);
  } catch (e) {
    throw new Error('Generation failed: ' + (e.message || e));
  }

  // Step 7: deduplicate generated items — the model sometimes produces near-identical
  // questions/cards when context chunks overlap, especially at lower item counts.
  const rawItems = result.items || [];
  const items = deduplicateItems(rawItems);

  // Build sources list
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

  return { items, text: result.text || '', sources };
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

module.exports = { runPipeline };
