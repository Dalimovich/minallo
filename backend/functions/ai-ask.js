// POST /api/ai/ask
// RAG endpoint: embeds the question, retrieves relevant chunks from the student's
// course documents, then calls Claude with only those chunks as context.
//
// Request body:
//   { courseId, question, mode? }
//   mode: "strict" (default) | "general"
//
// Response:
//   { answer, sources, confidence, unsupported }

const https = require('https');
const crypto = require('crypto');
const { requireEnv, optionalEnv } = require('../lib/env');
const { jsonResponse, fail, handleOptions } = require('../lib/responses');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');
const { supaRequest } = require('../lib/supabase-admin');
const { countRecentEvents, rateLimitResponse } = require('../lib/rate-limit');

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 1536;
const OPENAI_CHAT_MODEL = optionalEnv('AI_MODEL', 'gpt-4o');
const OPENAI_FAST_MODEL = 'gpt-4o-mini'; // used for HyDE + query expansion (cheap, fast)
const MAX_CHUNKS = 12;
const MIN_SIMILARITY = 0.18; // raised from 0.12 — rerank now handles fine ordering, so we can be stricter
const STRONG_SIMILARITY_THRESHOLD = 0.3;
const MAX_COMPLETION_TOKENS = 3000;

// ─── Circuit breaker for fast LLM calls (HyDE / classify / rerank / verify) ──
// If 3 calls in a row time out, skip the next 5 fast calls (each module instance).
// Prevents wasting time on repeated 6s timeouts during OpenAI degradation.
const _fastBreaker = { failures: 0, skipsRemaining: 0 };
function _breakerShouldSkip() {
  if (_fastBreaker.skipsRemaining > 0) {
    _fastBreaker.skipsRemaining--;
    return true;
  }
  return false;
}
function _breakerNoteSuccess() { _fastBreaker.failures = 0; }
function _breakerNoteFailure() {
  _fastBreaker.failures++;
  if (_fastBreaker.failures >= 3) {
    _fastBreaker.skipsRemaining = 5;
    _fastBreaker.failures = 0;
  }
}

const AI_RATE_LIMIT_MAX = Number(optionalEnv('AI_RATE_LIMIT_MAX', '20'));
const AI_RATE_LIMIT_WINDOW_MS = Number(optionalEnv('AI_RATE_LIMIT_WINDOW_MS', '3600000'));

// Source type priority boost for ranking (added to cosine similarity)
const SOURCE_BOOST = {
  solution: 0.08,
  exercise: 0.08,
  lecture: 0.1,
  exam: 0.06,
  notes: 0.02,
  summary: -0.03,
  other: 0.0
};

// ─── OpenAI embeddings ────────────────────────────────────────────────────────

function embedQuestion(question) {
  return new Promise(function (resolve, reject) {
    const apiKey = requireEnv('OPENAI_API_KEY');
    const body = JSON.stringify({
      model: EMBED_MODEL,
      input: question,
      dimensions: EMBED_DIMENSIONS
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/embeddings',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let data = '';
        res.on('data', function (c) {
          data += c;
        });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.data || !parsed.data[0])
              return reject(new Error('Embedding failed: ' + data));
            resolve(parsed.data[0].embedding);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── HyDE + multi-query ───────────────────────────────────────────────────────
// HyDE: generate a short hypothetical passage that would answer the question,
// then embed that passage. Documents are written as answers; this closes the
// vocabulary gap and dramatically improves retrieval for technical content.
//
// Multi-query: also generate 2 alternative phrasings, retrieve for each,
// then merge results. Catches chunks that one phrasing misses.

function callFastOpenAI(systemPrompt, userMsg, maxTokens) {
  // Circuit breaker: skip the call entirely when consecutive failures spike.
  if (_breakerShouldSkip()) return Promise.resolve('');
  return new Promise(function (resolve, reject) {
    const apiKey = requireEnv('OPENAI_API_KEY');
    const body = JSON.stringify({
      model: OPENAI_FAST_MODEL,
      max_tokens: maxTokens || 300,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ]
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let d = '';
        res.on('data', function (c) {
          d += c;
        });
        res.on('end', function () {
          try {
            const p = JSON.parse(d);
            const text =
              p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content;
            if (text) _breakerNoteSuccess(); else _breakerNoteFailure();
            resolve(text || '');
          } catch (e) {
            _breakerNoteFailure();
            resolve('');
          }
        });
      }
    );
    req.setTimeout(6000, function () {
      req.destroy();
      _breakerNoteFailure();
      resolve('');
    });
    req.on('error', function () {
      _breakerNoteFailure();
      resolve('');
    });
    req.write(body);
    req.end();
  });
}

async function generateHydeAndQueries(question) {
  // Single fast LLM call: returns hypothetical passage + 2 query variants + question type.
  // Fusing classification into HyDE saves one round-trip vs a separate classifyQuestion call.
  const sysPrompt = [
    'You are a retrieval query generator + classifier for an academic study assistant.',
    'Given a student question, output JSON with:',
    '  "hypothetical": a 2-3 sentence passage from an academic lecture or textbook that would directly answer this question (write as if extracted from a course document),',
    '  "queries": array of exactly 2 alternative phrasings of the question optimized for keyword search,',
    '  "type": exactly one of "exercise" | "definition" | "derivation" | "concept" | "formula" | "other".',
    'Type meanings: exercise=solve a numbered problem; definition=what something is; derivation=show/prove; concept=how/why; formula=specific equation; other=anything else.',
    'Output ONLY valid JSON. No markdown, no explanation.'
  ].join('\n');

  const raw = await callFastOpenAI(sysPrompt, question, 400);
  const validTypes = ['exercise', 'definition', 'derivation', 'concept', 'formula', 'other'];
  try {
    const parsed = JSON.parse(raw);
    const t = (parsed.type || '').toLowerCase().trim();
    return {
      hypothetical: (parsed.hypothetical || '').trim(),
      queries: Array.isArray(parsed.queries) ? parsed.queries.slice(0, 2) : [],
      question_type: validTypes.includes(t) ? t : null
    };
  } catch (e) {
    return { hypothetical: '', queries: [], question_type: null };
  }
}

function embedBatch(texts) {
  // Embed up to 3 texts in a single API call
  return new Promise(function (resolve, reject) {
    const apiKey = requireEnv('OPENAI_API_KEY');
    const body = JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMENSIONS });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/embeddings',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let d = '';
        res.on('data', function (c) {
          d += c;
        });
        res.on('end', function () {
          try {
            const p = JSON.parse(d);
            if (!p.data) return reject(new Error('Embed batch failed'));
            // Sort by index to preserve order
            const sorted = p.data.slice().sort(function (a, b) {
              return a.index - b.index;
            });
            resolve(
              sorted.map(function (e) {
                return e.embedding;
              })
            );
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(6000, function () {
      req.destroy(new Error('Embed timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Question type classifier ─────────────────────────────────────────────────
// Classifies the question so the prompt can be adapted.
// Types: "exercise" | "definition" | "derivation" | "concept" | "formula" | "other"
// Runs in parallel with HyDE — adds ~0ms net latency on cache miss.

async function classifyQuestion(question) {
  const sys =
    'Classify this student question into exactly one of these types: exercise, definition, derivation, concept, formula, other.\nExercise: asks to solve a specific numbered problem or compute a value.\nDefinition: asks what something is or means.\nDerivation: asks to show, prove, or derive a formula or result.\nConcept: asks how/why something works.\nFormula: asks for a specific formula or equation.\nOther: anything else.\nRespond with ONLY the type word, nothing else.';
  const result = await callFastOpenAI(sys, question, 10);
  const type = (result || '').trim().toLowerCase();
  const valid = ['exercise', 'definition', 'derivation', 'concept', 'formula', 'other'];
  return valid.includes(type) ? type : 'other';
}

// Extra instructions appended to the system prompt based on question type
function questionTypeInstructions(type) {
  const map = {
    exercise:
      '\n\n## Exercise instructions\nThe COURSE CONTEXT contains the full solution — read every source block carefully, the answer IS there.\n1. State what is given and what is asked.\n2. Write out the complete solution step by step, numbered.\n3. At each step state the formula or principle used in the professor\'s exact notation.\n4. Show every algebraic manipulation — do NOT skip steps.\n5. **Bold the final answer** with units.\n6. If a solution PDF is cited, follow its steps exactly — reproduce them, not a generic approach.\nNEVER say the solution "is not explicitly provided" when sources from the document are retrieved — the content IS there; read it more carefully.',
    definition:
      '\n\n## Definition instructions\nFirst give the exact definition as stated in the course material (quote it). Then explain it in plain language. Then give one concrete example from the material.',
    derivation:
      "\n\n## Derivation instructions\nShow every algebraic step. Number them. State what rule or identity you apply at each step. The final result should be clearly labeled. Use the professor's notation throughout.",
    concept:
      '\n\n## Concept instructions\nExplain the concept clearly: what it is, why it matters, how it works. Use an analogy if it helps. Then give a concrete example from the course material.',
    formula:
      '\n\n## Formula instructions\nState the formula clearly. Define every variable. State the units if applicable. State any conditions or assumptions the formula requires. Show a brief worked example if one exists in the sources.',
    other: ''
  };
  return map[type] || '';
}

// ─── Self-verification ────────────────────────────────────────────────────────
// After generating the answer, run a fast check:
// - Does the answer contain claims that are NOT supported by the retrieved context?
// - Are citations plausible (right file, right page range)?
// Returns { ok: true } or { ok: false, issues: "..." }

async function verifyClaims(question, contextBlock, answerText) {
  const sys = [
    'You are a strict academic fact-checker.',
    'You will receive: (1) a student question, (2) the source context used to answer it, (3) a generated answer.',
    'Your job: check whether the answer contains any claims, formulas, or definitions that are NOT supported by the source context.',
    'Be concise. Respond with JSON only:',
    '{ "ok": true }  — if the answer is well-supported',
    '{ "ok": false, "issues": "brief description of unsupported claims" }  — if there are problems'
  ].join('\n');
  const userMsg =
    'QUESTION:\n' +
    question +
    '\n\nSOURCE CONTEXT (excerpts):\n' +
    contextBlock.slice(0, 3000) +
    '\n\nGENERATED ANSWER:\n' +
    answerText.slice(0, 1500);
  const raw = await callFastOpenAI(sys, userMsg, 120);
  try {
    const parsed = JSON.parse(raw);
    return { ok: parsed.ok !== false, issues: parsed.issues || null };
  } catch (e) {
    return { ok: true, issues: null }; // don't block on parse failure
  }
}

// ─── Merge chunk arrays from multiple retrievals ───────────────────────────────
function mergeChunkResults(arrays) {
  const map = {};
  arrays.forEach(function (arr) {
    arr.forEach(function (c) {
      if (!map[c.id] || c.similarity > map[c.id].similarity) {
        map[c.id] = c;
      }
    });
  });
  return Object.values(map);
}

// ─── LLM rerank ───────────────────────────────────────────────────────────────
// Score candidate chunks 0..10 by relevance to the question via gpt-4o-mini.
// Returns the same chunks with `rerank_score` (0..1) added. On failure, no scores
// are attached and downstream code falls back to similarity-only ranking.

// Process-scoped rerank cache. Within a warm Netlify container, identical
// (question, chunk-set) pairs hit this cache and skip the rerank LLM call.
// Bounded to ~200 entries; oldest entry evicted when full.
const _rerankCache = new Map();
const RERANK_CACHE_MAX = 200;
function _rerankCacheKey(question, chunks) {
  const ids = chunks.slice(0, 24).map(function (c) { return c.id; }).sort().join(',');
  return crypto.createHash('sha1').update((question || '') + '|' + ids).digest('hex');
}

async function llmRerank(question, chunks) {
  if (!chunks || chunks.length <= 1) return chunks;
  const cacheKey = _rerankCacheKey(question, chunks);
  const cached = _rerankCache.get(cacheKey);
  if (cached) {
    return chunks.map(function (c) {
      return cached[c.id] != null ? Object.assign({}, c, { rerank_score: cached[c.id] }) : c;
    });
  }
  const pool = chunks.slice(0, 24);
  const PREVIEW_CHARS = 320;
  const lines = pool.map(function (c, i) {
    const preview = (c.chunk_text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
    return '[' + (i + 1) + '] ' + preview;
  });
  const sys =
    'You score how relevant each passage is to the student question, on a 0-10 integer scale.\n' +
    '10 = directly answers or contains the exact target (e.g. the named exercise, definition, or formula).\n' +
    '7-9 = strongly relevant, same topic and contains usable information.\n' +
    '4-6 = related but not specifically what is asked.\n' +
    '0-3 = off-topic.\n' +
    'Return ONLY compact JSON of the form {"scores":[{"i":1,"s":8},{"i":2,"s":3},...]} with one entry per passage. No prose.';
  const user = 'QUESTION: ' + question + '\n\nPASSAGES:\n' + lines.join('\n');
  let raw;
  try {
    raw = await callFastOpenAI(sys, user, 400);
  } catch (e) {
    return chunks;
  }
  if (!raw) return chunks;
  let parsed;
  try {
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) return chunks;
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    return chunks;
  }
  if (!parsed || !Array.isArray(parsed.scores)) return chunks;
  const scoreById = {};
  parsed.scores.forEach(function (entry) {
    const idx = (parseInt(entry.i, 10) || 0) - 1;
    if (idx < 0 || idx >= pool.length) return;
    let s = parseFloat(entry.s);
    if (!isFinite(s)) return;
    s = Math.max(0, Math.min(10, s));
    scoreById[pool[idx].id] = s / 10;
  });
  // Cache the score map for warm-container reuse.
  if (_rerankCache.size >= RERANK_CACHE_MAX) {
    const firstKey = _rerankCache.keys().next().value;
    _rerankCache.delete(firstKey);
  }
  _rerankCache.set(cacheKey, scoreById);
  return chunks.map(function (c) {
    if (scoreById[c.id] != null) {
      return Object.assign({}, c, { rerank_score: scoreById[c.id] });
    }
    return c;
  });
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

function retrieveChunks(serviceKey, userId, courseId, embedding, question, documentId) {
  return new Promise(function (resolve, reject) {
    const supaUrl = requireEnv('SUPABASE_URL');
    const embeddingStr = '[' + embedding.join(',') + ']';
    const params = {
      p_user_id: userId,
      p_course_id: courseId,
      p_embedding: embeddingStr,
      p_query: question || '',
      p_match_count: MAX_CHUNKS,
      p_threshold: MIN_SIMILARITY
    };
    if (documentId) params.p_document_id = documentId;
    const body = JSON.stringify(params);
    const req = https.request(
      {
        hostname: new URL(supaUrl).hostname,
        path: '/rest/v1/rpc/match_chunks_hybrid',
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let data = '';
        res.on('data', function (c) {
          data += c;
        });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            resolve([]);
          }
        });
      }
    );
    req.on('error', function () {
      resolve([]);
    });
    req.write(body);
    req.end();
  });
}

// Apply source priority boost + official-material boost, then re-sort.
// qType: if 'exercise', heavily boost solution chunks so they appear first.
// openDocId: small boost for chunks from the file the student has open, so the
//            problem statement text stays in context alongside the solution chunks.
function rankChunks(chunks, qType, openDocId) {
  return chunks
    .map(function (c) {
      const sourceBoost = SOURCE_BOOST[c.source_type] || 0;
      const officialBoost = c.is_official ? 0.05 : 0;
      const exerciseBoost = (qType === 'exercise')
        ? (c.source_type === 'solution' ? 0.18 : c.source_type === 'exercise' ? 0.12 : 0)
        : 0;
      const openBoost = (openDocId && c.document_id === openDocId) ? 0.06 : 0;
      const base = (c.rerank_score != null)
        ? (c.rerank_score * 0.6 + c.similarity * 0.4)
        : c.similarity;
      return Object.assign({}, c, {
        final_score: base + sourceBoost + officialBoost + exerciseBoost + openBoost
      });
    })
    .sort(function (a, b) { return b.final_score - a.final_score; });
}

// Retrieve top chunks from a specific document — used to build the OPEN FILE context block
// from indexed content instead of browser-extracted raw text (works for scanned PDFs).
function fetchOpenDocChunks(serviceKey, userId, courseId, docId, embedding, question) {
  return new Promise(function (resolve) {
    const supaUrl = requireEnv('SUPABASE_URL');
    const body = JSON.stringify({
      p_user_id: userId, p_course_id: courseId,
      p_embedding: '[' + embedding.join(',') + ']',
      p_query: question || '', p_match_count: 5, p_threshold: 0.05,
      p_document_id: docId
    });
    const req = https.request(
      {
        hostname: new URL(supaUrl).hostname,
        path: '/rest/v1/rpc/match_chunks_hybrid',
        method: 'POST',
        headers: {
          apikey: serviceKey, Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed) || !parsed.length) return resolve(null);
            const texts = parsed.slice(0, 5).map(function (c) { return c.chunk_text || ''; }).filter(Boolean);
            resolve(texts.length ? texts.join('\n\n') : null);
          } catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', function () { resolve(null); });
    req.write(body);
    req.end();
  });
}

// Fetch file_name for each unique document_id so we can cite properly
function fetchDocumentNames(serviceKey, documentIds) {
  if (!documentIds.length) return Promise.resolve({});
  const ids = documentIds
    .map(function (id) {
      return '"' + id + '"';
    })
    .join(',');
  return supaRequest(
    'GET',
    'documents?id=in.(' + ids + ')&select=id,file_name',
    null,
    serviceKey
  ).then(function (result) {
    const map = {};
    if (Array.isArray(result.body)) {
      result.body.forEach(function (d) {
        map[d.id] = d.file_name;
      });
    }
    return map;
  });
}

// ─── Claude call ──────────────────────────────────────────────────────────────

// Detect language of retrieved chunks using stop-word frequency across major languages.
// Returns a language code; falls back to 'en' if no signal is strong enough.
const _LANG_STOPWORDS = {
  de: ['der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'eine', 'wird', 'sind', 'auf', 'von', 'den', 'bei', 'als', 'auch', 'sich', 'nicht', 'nach', 'durch', 'oder', 'aber', 'einer', 'einem', 'wenn', 'noch', 'unter', 'über'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'une', 'un', 'dans', 'pour', 'que', 'qui', 'sur', 'avec', 'pas', 'plus', 'cette', 'ces', 'aux', 'par', 'sont', 'mais', 'ou', 'comme', 'son', 'ses'],
  es: ['el', 'la', 'los', 'las', 'de', 'del', 'y', 'es', 'un', 'una', 'que', 'en', 'por', 'para', 'con', 'no', 'se', 'al', 'su', 'sus', 'como', 'pero', 'más', 'este', 'esta'],
  it: ['il', 'la', 'lo', 'gli', 'le', 'di', 'del', 'della', 'e', 'è', 'un', 'una', 'che', 'per', 'con', 'non', 'si', 'al', 'sono', 'come', 'ma', 'più', 'questo', 'questa'],
  pt: ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'e', 'é', 'um', 'uma', 'que', 'em', 'para', 'com', 'não', 'se', 'no', 'na', 'mais', 'como', 'mas', 'por']
};

const _LANG_NAMES = {
  de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', en: 'English'
};

function detectLanguage(chunks) {
  const sample = chunks.slice(0, 4).map(function (c) { return c.chunk_text || ''; }).join(' ').toLowerCase();
  const words = sample.split(/\s+/);
  const total = Math.min(words.length, 200);
  if (total === 0) return 'en';
  const slice = words.slice(0, total);

  let bestLang = 'en';
  let bestRatio = 0;
  Object.keys(_LANG_STOPWORDS).forEach(function (lang) {
    const stopSet = _LANG_STOPWORDS[lang];
    const count = slice.filter(function (w) { return stopSet.includes(w); }).length;
    const ratio = count / total;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestLang = lang;
    }
  });
  // Need a minimum signal to avoid noise-driven mislabels
  return bestRatio > 0.04 ? bestLang : 'en';
}

function buildSystemPrompt(mode, lang, openFileName) {
  const strict = mode !== 'general';
  const langName = _LANG_NAMES[lang] || 'English';
  const langInstruction = lang && lang !== 'en'
    ? 'Respond in **' + langName + '** — the course materials are in ' + langName + ', so your entire answer must be in ' + langName + '.'
    : 'Respond in **English**.';
  const openFileLine = openFileName
    ? 'The student is currently reading **' + openFileName + '**. The OPEN FILE block at the top of the context contains the problem text from that file. Use it to understand exactly what is being asked, then look in ALL other course documents (lectures, solution sheets) for the explanation and full solution.'
    : '';
  return [
    'You are StudySphere AI — a precise, expert-level academic study assistant.',
    'Your job is to give the student an accurate, well-structured answer grounded in their own course materials.',
    langInstruction,
    openFileLine ? openFileLine : '',
    '',
    '## How to answer',
    '',
    '1. **Read all COURSE CONTEXT sources carefully before writing anything.**',
    "2. **Ground every claim in the context.** Use the professor's exact notation, variable names, formulas, and terminology — not textbook alternatives.",
    '3. **Structure your answer clearly** using markdown:',
    '   - Start with a direct 1-2 sentence answer to the question.',
    '   - Then give a detailed explanation. Use `##` headings for multi-part answers.',
    '   - For derivations or proofs: show every step. Number them.',
    '   - For definitions: give the exact definition from the material, then explain it.',
    '   - For exercises: solve step-by-step, showing all work. Reference the method from the lecture.',
    '   - Use `**bold**` for key terms, formulas, and important results.',
    '   - Use bullet lists for enumerations, numbered lists for sequential steps.',
    '4. **Math notation:** Use KaTeX delimiters. Inline math: `$...$`. Display math: `$$...$$`. Examples: `$v_x(t) = -2ct\\sin(\\theta)$` or `$$a_n = \\frac{v^2}{r}$$`. NEVER use `\\(` or `\\[` — only `$` and `$$`. Do NOT use Unicode math letters (𝑎, 𝑣, 𝑥).',
    '5. **Citations:** After every major claim, add an inline citation using the exact FILE and PAGES from the source header: *(filename, p.X)*. If a SECTION_ID is present, include it: *(filename, p.X, Exercise 3b)*.',
    '6. **Confidence:** Set "high" when the COURSE CONTEXT directly supports the answer — even if you added a minor "(not explicitly in uploaded materials)" label for a small detail. Set "medium" ONLY when a substantial portion of the answer relies on general knowledge not in the context. Set "low" when the answer is mostly general knowledge.',
    '7. **CRITICAL:** Do NOT include confidence indicators, emoji, or source lists anywhere in your markdown answer text. ONLY put them in the JSON response fields (sources, confidence). Never write 🟢🟡🔴 or "Confidence:" in the answer itself.',
    strict
      ? '8. **COURSE MODE:** Only answer from the COURSE CONTEXT. If the course materials do not contain sufficient information, respond: "I could not find enough information in your uploaded course materials for this. Please check that the relevant lecture, exercise, or solution PDF is indexed for this course." Do NOT use general knowledge in Course Mode — if the answer is in the sources, use it fully.'
      : '8. **TUTOR MODE:** Use COURSE CONTEXT as primary source. You may supplement with general academic knowledge only after exhausting course materials. Label all general knowledge clearly with *(general knowledge)*.',
    '',
    '## Sources array rules',
    'For EACH source you actually used in the answer, add one entry. Fields:',
    '- "file_name": exact FILE value from the source header',
    '- "pages": exact PAGES value from the source header (e.g. "17" or "17-19")',
    '- "section": the SECTION_ID value if present — this must be the specific exercise, section, or heading label (e.g. "Exercise 3b", "Aufgabe 2a", "1.3 Moment of Inertia"). If no SECTION_ID, leave empty string.',
    'Do NOT invent page numbers or section names. Copy them exactly from the source headers.',
    '',
    '## Answer format',
    'Respond ONLY in this JSON. The "answer" field contains full markdown.',
    '{',
    '  "answer": "markdown answer here",',
    '  "sources": [{ "file_name": "...", "pages": "...", "section": "..." }],',
    '  "confidence": "high|medium|low",',
    '  "unsupported": false',
    '}'
  ].join('\n');
}

function buildFallbackSystemPrompt() {
  return [
    'You are StudySphere AI — a knowledgeable academic study assistant.',
    '',
    'No uploaded course documents matched this question.',
    'You MUST still give a complete, helpful answer using your general academic knowledge.',
    'NEVER say the question is incomplete or that you cannot answer — always provide a full response.',
    '',
    'Rules:',
    '1. Give a complete, step-by-step answer. Do not refuse or hedge.',
    '2. Start your answer with: "⚠️ *No matching course material found — answering from general knowledge.*"',
    '3. Structure: direct answer → detailed explanation → formulas/examples where relevant.',
    '4. Math notation: use KaTeX — inline $...$ and display $$...$$. NEVER use \\( or \\[.',
    '5. If the question seems incomplete or ambiguous, make a reasonable assumption and answer it.',
    '',
    'Respond ONLY in this JSON:',
    '{',
    '  "answer": "markdown answer here",',
    '  "sources": [],',
    '  "confidence": "medium",',
    '  "unsupported": true',
    '}'
  ].join('\n');
}

// Rough token estimate: ~4 chars per token for academic text
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// Max context tokens we'll send: gpt-4o has 128k context, leave room for system prompt + answer
const MAX_CONTEXT_TOKENS = 14000;

function buildContextBlock(rankedChunks, docNames, openCtx, openFileName) {
  let totalTokens = 0;
  const blocks = [];
  // Prepend the open file's text excerpt — this is the problem statement the student
  // is looking at. Ensures the AI sees the full question even when vector search
  // returns only solution/lecture chunks.
  if (openCtx && openFileName) {
    const header = '=== OPEN FILE (student is currently reading this — contains the problem) ===\nFILE: ' + openFileName + '\nTEXT:\n' + openCtx;
    blocks.push(header);
    totalTokens += estimateTokens(header);
  }
  if (!rankedChunks.length && !blocks.length) return 'No relevant course material found.';
  for (var i = 0; i < rankedChunks.length; i++) {
    var c = rankedChunks[i];
    const fileName = docNames[c.document_id] || 'Unknown file';
    const pages = c.page_start === c.page_end
      ? 'p.' + c.page_start
      : 'pp.' + c.page_start + '-' + c.page_end;
    const sectionId = c.section_title || null;
    const lines = [
      '=== SOURCE ' + (i + 1) + ' ===',
      'FILE: ' + fileName,
      'PAGES: ' + pages,
      'TYPE: ' + (c.source_type || 'document'),
      sectionId ? 'SECTION_ID: ' + sectionId : null,
      'TEXT:',
      c.chunk_text
    ].filter(Boolean);
    const block = lines.join('\n');
    const blockTokens = estimateTokens(block);
    if (totalTokens + blockTokens > MAX_CONTEXT_TOKENS) break; // stop before overflow
    blocks.push(block);
    totalTokens += blockTokens;
  }
  return blocks.join('\n\n');
}

function callOpenAI(systemPrompt, contextBlock, question, maxTokens, temperature) {
  return new Promise(function (resolve, reject) {
    const apiKey = requireEnv('OPENAI_API_KEY');
    const userMessage =
      'COURSE CONTEXT:\n\n' + contextBlock + '\n\n---\n\nSTUDENT QUESTION:\n' + question;
    const body = JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      max_tokens: maxTokens || MAX_COMPLETION_TOKENS,
      temperature: temperature !== undefined ? temperature : 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let data = '';
        res.on('data', function (c) {
          data += c;
        });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(data);
            const text =
              parsed.choices &&
              parsed.choices[0] &&
              parsed.choices[0].message &&
              parsed.choices[0].message.content;
            if (!text) return reject(new Error('Empty OpenAI response'));
            resolve(text);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseOpenAIResponse(text) {
  // Strip optional markdown code fences
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  // First try: parse as-is (works when response_format:json_object is used)
  try {
    const direct = JSON.parse(stripped);
    if (direct && typeof direct === 'object') return direct;
  } catch (e) {}
  // Second try: extract {...} block and repair literal newlines inside strings
  try {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      // Replace unescaped literal newlines inside JSON string values
      const repaired = match[0].replace(/("(?:[^"\\]|\\.)*")|(\n)/g, function (m, str) {
        return str ? str : '\\n';
      });
      const parsed = JSON.parse(repaired);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {}
  return { answer: text, sources: [], confidence: 'low', unsupported: false };
}

// ─── Citation validation ──────────────────────────────────────────────────────
// Removes hallucinated file names and corrects page numbers that don't match
// any retrieved chunk for the cited file.

function _parsePagesStr(pagesStr) {
  if (!pagesStr) return null;
  const m = String(pagesStr).match(/(\d+)(?:[–\-](\d+))?/);
  if (!m) return null;
  return { from: parseInt(m[1], 10), to: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10) };
}

function validateSources(sources, chunks, docNames) {
  const knownFiles = new Set(Object.values(docNames));
  // Build fileName → [{page_start, page_end, section_title}] from retrieved chunks
  const fileChunkMap = {};
  chunks.forEach(function (c) {
    const fn = docNames[c.document_id];
    if (!fn) return;
    if (!fileChunkMap[fn]) fileChunkMap[fn] = [];
    fileChunkMap[fn].push({ page_start: c.page_start, page_end: c.page_end, section_title: c.section_title || '' });
  });

  return sources
    .filter(function (s) { return !s.file_name || knownFiles.has(s.file_name); })
    .map(function (s) {
      if (!s.file_name || !s.pages) return s;
      const chunkList = fileChunkMap[s.file_name];
      if (!chunkList || !chunkList.length) return s;
      const cited = _parsePagesStr(s.pages);
      if (!cited) return s;
      // Check if cited page range overlaps with at least one chunk
      const overlaps = chunkList.some(function (c) {
        return c.page_start <= cited.to && c.page_end >= cited.from;
      });
      if (overlaps) return s;
      // No overlap — correct to the chunk whose start page is nearest to the cited page
      const nearest = chunkList.reduce(function (best, c) {
        const dist = Math.min(Math.abs(c.page_start - cited.from), Math.abs(c.page_end - cited.from));
        const bd = Math.min(Math.abs(best.page_start - cited.from), Math.abs(best.page_end - cited.from));
        return dist < bd ? c : best;
      });
      const correctedPages = nearest.page_start === nearest.page_end
        ? String(nearest.page_start)
        : nearest.page_start + '-' + nearest.page_end;
      return Object.assign({}, s, {
        pages: correctedPages,
        section: s.section || nearest.section_title || ''
      });
    });
}

// ─── Caching helpers ──────────────────────────────────────────────────────────

function normalizeQuestion(q) {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashQuestion(userId, courseId, normalizedQ, docVersionHash, mode, openFileName) {
  return crypto
    .createHash('sha256')
    .update(
      'v3|' +
        userId +
        '|' +
        courseId +
        '|' +
        normalizedQ +
        '|' +
        docVersionHash +
        '|' +
        (mode || 'strict') +
        '|' +
        (openFileName || '')
    )
    .digest('hex');
}

// Compute a hash over all document IDs + updated_at for the user's course
async function getDocumentVersionHash(serviceKey, userId, courseId) {
  const result = await supaRequest(
    'GET',
    'documents?user_id=eq.' +
      userId +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&processing_status=eq.ready&select=id,updated_at&order=id.asc',
    null,
    serviceKey
  );
  if (!Array.isArray(result.body) || !result.body.length) return 'empty';
  const str = result.body
    .map(function (d) {
      return d.id + ':' + d.updated_at;
    })
    .join('|');
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Look up exact answer cache
async function getExactCache(serviceKey, userId, courseId, questionHash, docVersionHash, mode) {
  const result = await supaRequest(
    'GET',
    'ai_answer_cache?user_id=eq.' +
      userId +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&question_hash=eq.' +
      questionHash +
      '&document_version_hash=eq.' +
      docVersionHash +
      '&mode=eq.' +
      (mode || 'strict') +
      '&select=id,answer_json&limit=1',
    null,
    serviceKey
  );
  if (Array.isArray(result.body) && result.body[0]) return result.body[0];
  return null;
}

// Touch last_used_at and increment usage_count on a cache hit
function touchAnswerCache(serviceKey, cacheId) {
  return supaRequest(
    'PATCH',
    'ai_answer_cache?id=eq.' + cacheId,
    { last_used_at: new Date().toISOString(), usage_count: null }, // usage_count incremented via DB
    serviceKey
  ).catch(function () {});
}

// Look up semantic cache via match_cached_questions RPC
async function getSemanticCache(serviceKey, userId, courseId, embedding, docVersionHash, mode) {
  const body = JSON.stringify({
    p_user_id: userId,
    p_course_id: courseId,
    p_embedding: '[' + embedding.join(',') + ']',
    p_document_version_hash: docVersionHash,
    p_mode: mode || 'strict',
    p_threshold: 0.92,
    p_limit: 1
  });
  return new Promise(function (resolve) {
    const supaUrl = requireEnv('SUPABASE_URL');
    const req = https.request(
      {
        hostname: new URL(supaUrl).hostname,
        path: '/rest/v1/rpc/match_cached_questions',
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let data = '';
        res.on('data', function (c) {
          data += c;
        });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) && parsed[0] ? parsed[0] : null);
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', function () {
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// Fetch a cached answer by its ID
async function getAnswerById(serviceKey, answerId) {
  const result = await supaRequest(
    'GET',
    'ai_answer_cache?id=eq.' + answerId + '&select=id,answer_json&limit=1',
    null,
    serviceKey
  );
  if (Array.isArray(result.body) && result.body[0]) return result.body[0];
  return null;
}

// Store a new answer in the cache
async function storeAnswerCache(
  serviceKey,
  userId,
  courseId,
  questionHash,
  normalizedQ,
  docVersionHash,
  mode,
  answerJson
) {
  const result = await supaRequest(
    'POST',
    'ai_answer_cache',
    {
      user_id: userId,
      course_id: courseId,
      question_hash: questionHash,
      normalized_question: normalizedQ,
      document_version_hash: docVersionHash,
      mode: mode || 'strict',
      answer_json: answerJson
    },
    serviceKey,
    { Prefer: 'return=representation' }
  );
  if (Array.isArray(result.body) && result.body[0]) return result.body[0].id;
  return null;
}

// Store question embedding for future semantic cache lookups
function storeQuestionCache(
  serviceKey,
  userId,
  courseId,
  question,
  embedding,
  answerId,
  docVersionHash,
  mode
) {
  return supaRequest(
    'POST',
    'ai_question_cache',
    {
      user_id: userId,
      course_id: courseId,
      question: question,
      question_embedding: '[' + embedding.join(',') + ']',
      answer_cache_id: answerId,
      document_version_hash: docVersionHash,
      mode: mode || 'strict'
    },
    serviceKey,
    { Prefer: 'return=minimal' }
  ).catch(function () {});
}

// ─── Retrieval cache ──────────────────────────────────────────────────────────
// Caches the ranked chunk set for a question+docVersion so repeated questions
// can skip the vector search and go straight to fetching chunks by PK.

async function getRetrievalCache(serviceKey, userId, courseId, questionHash, docVersionHash) {
  const result = await supaRequest(
    'GET',
    'retrieval_cache?user_id=eq.' +
      userId +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&question_hash=eq.' +
      questionHash +
      '&document_version_hash=eq.' +
      docVersionHash +
      '&select=id,chunk_entries&limit=1',
    null,
    serviceKey
  );
  if (Array.isArray(result.body) && result.body[0]) return result.body[0];
  return null;
}

// Fetch full chunk rows for a set of IDs (used on retrieval cache hit)
async function fetchChunksByIds(serviceKey, userId, courseId, chunkIds) {
  if (!chunkIds.length) return [];
  const ids = chunkIds
    .map(function (id) {
      return '"' + id + '"';
    })
    .join(',');
  const result = await supaRequest(
    'GET',
    'document_chunks?id=in.(' +
      ids +
      ')&user_id=eq.' +
      userId +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&select=id,document_id,chunk_text,page_start,page_end,source_type,section_title',
    null,
    serviceKey
  );
  return Array.isArray(result.body) ? result.body : [];
}

function storeRetrievalCache(
  serviceKey,
  userId,
  courseId,
  questionHash,
  docVersionHash,
  rankedChunks
) {
  // Store { id, similarity } per chunk so source-boost order is preserved on hit
  const entries = rankedChunks.map(function (c) {
    return { id: c.id, similarity: c.similarity };
  });
  return supaRequest(
    'POST',
    'retrieval_cache',
    {
      user_id: userId,
      course_id: courseId,
      question_hash: questionHash,
      document_version_hash: docVersionHash,
      chunk_entries: entries
    },
    serviceKey,
    { Prefer: 'return=minimal' }
  ).catch(function () {});
}

// ─── Chunk deduplication ──────────────────────────────────────────────────────
// After source-boost ranking, remove chunks that overlap in page range with an
// already-selected chunk from the same document. Prevents the same passage from
// appearing multiple times in the context window.

function deduplicateChunks(rankedChunks) {
  const selected = [];
  for (var i = 0; i < rankedChunks.length; i++) {
    var chunk = rankedChunks[i];
    var overlaps = selected.some(function (sel) {
      if (sel.document_id !== chunk.document_id) return false;
      return Math.max(sel.page_start, chunk.page_start) <= Math.min(sel.page_end, chunk.page_end);
    });
    if (!overlaps) selected.push(chunk);
    if (selected.length >= MAX_CHUNKS) break;
  }
  return selected;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');

  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // Rate limit
  const recentCount = await countRecentEvents(
    serviceKey,
    user.id,
    'ai_ask',
    AI_RATE_LIMIT_WINDOW_MS
  );
  if (recentCount >= AI_RATE_LIMIT_MAX) {
    return rateLimitResponse();
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return fail(400, 'Invalid JSON body');
  }

  const { courseId, question, mode, documentId, activeFileName, openFileContext } = body;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (!question || typeof question !== 'string') return fail(400, 'question is required');
  if (question.length > 2000) return fail(400, 'Question too long (max 2000 characters)');
  const activeDocId = (typeof documentId === 'string' && documentId) ? documentId : null;
  const openFileName = (typeof activeFileName === 'string' && activeFileName) ? activeFileName : null;
  const openCtx = (typeof openFileContext === 'string' && openFileContext.trim()) ? openFileContext.trim() : null;

  const normalizedQ = normalizeQuestion(question);
  const ragMode = mode === 'general' ? 'general' : 'strict';
  // openFileName is part of the cache key — same question with a different file open
  // produces different context and must be cached separately

  // 1. Embed question (needed for cache lookups)
  let embedding;
  try {
    embedding = await embedQuestion(question);
  } catch (e) {
    return fail(502, 'Embedding service unavailable');
  }

  // 2. Get document version hash (used for cache invalidation)
  const docVersionHash = await getDocumentVersionHash(serviceKey, user.id, courseId);
  const questionHash = hashQuestion(user.id, courseId, normalizedQ, docVersionHash, ragMode, openFileName);

  // 3. Check exact answer cache
  const exactHit = await getExactCache(
    serviceKey,
    user.id,
    courseId,
    questionHash,
    docVersionHash,
    ragMode
  );
  if (exactHit) {
    touchAnswerCache(serviceKey, exactHit.id);
    return jsonResponse(200, Object.assign({}, exactHit.answer_json, { cached: true }));
  }

  // 4. Check semantic question cache — skip when open file context is present.
  // "solve 1.1" asked while PDF A is open must not reuse the answer from the same
  // question asked while PDF B is open; the problem statements are different.
  const hasOpenFileCtx = !!(openFileName || activeDocId || openCtx);
  if (!hasOpenFileCtx) {
    const semanticHit = await getSemanticCache(
      serviceKey,
      user.id,
      courseId,
      embedding,
      docVersionHash,
      ragMode
    );
    if (semanticHit && semanticHit.answer_cache_id) {
      const cachedAnswer = await getAnswerById(serviceKey, semanticHit.answer_cache_id);
      if (cachedAnswer) {
        touchAnswerCache(serviceKey, cachedAnswer.id);
        return jsonResponse(200, Object.assign({}, cachedAnswer.answer_json, { cached: true }));
      }
    }
  }

  // 5. Check retrieval cache (skip vector search + HyDE for repeated questions)
  let rawChunks;
  let preClassifiedType = null; // populated by HyDE call when it succeeds
  const retrievalHit = await getRetrievalCache(
    serviceKey,
    user.id,
    courseId,
    questionHash,
    docVersionHash
  );
  if (retrievalHit) {
    const entries = Array.isArray(retrievalHit.chunk_entries) ? retrievalHit.chunk_entries : [];
    const ids = entries.map(function (e) {
      return e.id;
    });
    const fetchedChunks = await fetchChunksByIds(serviceKey, user.id, courseId, ids);
    const simMap = {};
    entries.forEach(function (e) {
      simMap[e.id] = e.similarity;
    });
    rawChunks = fetchedChunks.map(function (c) {
      return Object.assign({}, c, { similarity: simMap[c.id] || 0.5 });
    });
  } else {
    // HyDE + multi-query + classify in a single LLM round-trip.
    // Generate hypothetical passage + 2 alternative queries + question type, embed
    // queries in one batch, retrieve for each, then merge. Falls back gracefully.
    const hydeResult = await generateHydeAndQueries(question);
    if (hydeResult.question_type) preClassifiedType = hydeResult.question_type;

    const textsToEmbed = [question];
    if (hydeResult.hypothetical) textsToEmbed.push(hydeResult.hypothetical);
    hydeResult.queries.forEach(function (q) {
      if (q) textsToEmbed.push(q);
    });

    let embeddings;
    try {
      embeddings = await embedBatch(textsToEmbed);
    } catch (e) {
      embeddings = [embedding]; // fallback to pre-computed question embedding
    }

    // Retrieve for each embedding in parallel
    const retrievalPromises = embeddings.map(function (emb, i) {
      const queryText = textsToEmbed[i] || question;
      return retrieveChunks(serviceKey, user.id, courseId, emb, queryText, activeDocId);
    });
    const allResults = await Promise.all(retrievalPromises);
    rawChunks = mergeChunkResults(allResults);
  }

  // 6. No chunks found
  if (!rawChunks.length) {
    if (ragMode === 'strict') {
      // Course Mode: don't fall back to general knowledge
      return jsonResponse(200, {
        answer: "I couldn't find relevant information in your uploaded course materials for this question. Please make sure the relevant lecture, exercise, or solution files are indexed for this course.",
        sources: [], confidence: 'low', unsupported: true, cached: false
      });
    }
    // Tutor Mode: use general knowledge
    let fallbackResponse;
    try {
      fallbackResponse = await callOpenAI(buildFallbackSystemPrompt(), '', question);
    } catch (e) {
      return jsonResponse(200, {
        answer: 'I could not find this in your uploaded course materials. Please make sure you have uploaded the relevant lecture or exercise files for this course.',
        sources: [], confidence: 'low', unsupported: true, cached: false
      });
    }
    const fallbackResult = parseOpenAIResponse(fallbackResponse);
    const fallbackJson = {
      answer: fallbackResult.answer || '',
      sources: [], confidence: 'low', unsupported: true, cached: false
    };
    storeAnswerCache(serviceKey, user.id, courseId, questionHash, normalizedQ, docVersionHash, ragMode, fallbackJson).catch(function () {});
    return jsonResponse(200, fallbackJson);
  }

  // 7. Classify question type early (needed for ranking + prompt).
  const qType = preClassifiedType || (await classifyQuestion(question));

  // 7b. Fetch doc names early so we can resolve the open file's document ID for ranking.
  // We fetch for ALL chunks in rawChunks, not just the final ranked set.
  const allRawDocIds = [...new Set(rawChunks.map(function (c) { return c.document_id; }))];
  const allDocNames = await fetchDocumentNames(serviceKey, allRawDocIds);
  const earlyOpenDocId = openFileName
    ? (Object.keys(allDocNames).find(function (id) {
        return allDocNames[id] === openFileName || allDocNames[id].toLowerCase() === openFileName.toLowerCase();
      }) || null)
    : null;

  // 7c. If the open file is indexed, retrieve focused chunks from it — works for scanned PDFs
  let effectiveOpenCtx = openCtx;
  if (earlyOpenDocId) {
    const indexedCtx = await fetchOpenDocChunks(serviceKey, user.id, courseId, earlyOpenDocId, embedding, question);
    if (indexedCtx) effectiveOpenCtx = indexedCtx;
  }

  // 7d. LLM rerank candidates by true relevance before signal-based ranking.
  rawChunks = await llmRerank(question, rawChunks);

  // Rank with question-type-aware boosting + open-file boost, then deduplicate
  const rankedChunks = deduplicateChunks(rankChunks(rawChunks, qType, earlyOpenDocId));

  // Store retrieval cache for future identical questions (fire-and-forget)
  if (!retrievalHit && rankedChunks.length) {
    storeRetrievalCache(serviceKey, user.id, courseId, questionHash, docVersionHash, rankedChunks);
  }

  // Guardrail: best chunk is below strong threshold — still answer but flag low confidence
  const topScore = rankedChunks[0] ? rankedChunks[0].final_score : 0;
  const weakRetrieval = topScore < STRONG_SIMILARITY_THRESHOLD;

  // 8. Build doc name map for the final ranked set (reuse allDocNames fetched above)
  const docNames = allDocNames;
  const knownFileNames = new Set(Object.values(docNames));

  // 9. Build context + detect language from retrieved chunks
  const contextBlock = buildContextBlock(rankedChunks, docNames, effectiveOpenCtx, openFileName);
  const lang = detectLanguage(rankedChunks);
  const systemPrompt = buildSystemPrompt(ragMode, lang, openFileName) + questionTypeInstructions(qType);

  // Adaptive token budget: exercises/derivations need more room; definitions less
  const tokenBudget = { exercise: 3000, derivation: 3000, concept: 2000, definition: 1500, formula: 1800, other: 2000 };
  const tempMap = { exercise: 0.1, derivation: 0.1, formula: 0.1, definition: 0.1, concept: 0.15, other: 0.1 };
  const maxTokens = tokenBudget[qType] || 2000;
  const temperature = tempMap[qType] !== undefined ? tempMap[qType] : 0.1;

  let rawResponse;
  try {
    rawResponse = await callOpenAI(systemPrompt, contextBlock, question, maxTokens, temperature);
  } catch (e) {
    return fail(502, 'AI service unavailable');
  }

  // 10. Parse + self-verify (run verify in parallel while we parse)
  const result = parseOpenAIResponse(rawResponse);

  // Citation validation: strip hallucinated file names, then correct page numbers that
  // don't match any retrieved chunk (prevents citing real file but wrong page).
  const validatedSources = validateSources(
    Array.isArray(result.sources) ? result.sources : [],
    rankedChunks,
    docNames
  );

  // Self-verification: downgrade confidence (and retry once) when model invents claims.
  let verifiedConfidence = result.confidence || (weakRetrieval ? 'medium' : 'high');
  let verifierIssues = null;
  if (result.answer && result.answer.length > 100) {
    const verification = await verifyClaims(question, contextBlock, result.answer);
    if (!verification.ok) {
      verifierIssues = verification.issues || null;
      // Only downgrade confidence when retrieval was already weak. When retrieval
      // is strong, the AI's own assessment is more reliable than the verifier.
      if (weakRetrieval) verifiedConfidence = 'low';
      // Append a note to the answer so the student knows to double-check
      result.answer =
        result.answer +
        (verifierIssues
          ? '\n\n> ⚠️ *Some claims may go beyond your uploaded materials (' + String(verifierIssues).slice(0, 160) + '). Please verify with your course documents.*'
          : '\n\n> ⚠️ *Some claims in this answer may go beyond your uploaded materials. Please verify with your course documents.*');
    }
  }

  const answerJson = {
    answer: result.answer || '',
    sources: validatedSources,
    confidence: verifiedConfidence,
    unsupported: false,
    question_type: qType,
    verifier_issues: verifierIssues
  };

  // 11. Store in cache (fire-and-forget)
  storeAnswerCache(
    serviceKey,
    user.id,
    courseId,
    questionHash,
    normalizedQ,
    docVersionHash,
    ragMode,
    answerJson
  )
    .then(function (newCacheId) {
      // Don't store in semantic question cache for open-file requests — the answer
      // is specific to the problem in that file and must not be reused for other files.
      if (newCacheId && !hasOpenFileCtx) {
        storeQuestionCache(
          serviceKey,
          user.id,
          courseId,
          question,
          embedding,
          newCacheId,
          docVersionHash,
          ragMode
        );
      }
    })
    .catch(function () {});

  return jsonResponse(200, Object.assign({}, answerJson, { cached: false }));
};
