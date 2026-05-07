// Netlify Edge Function — /api/ai/stream
// Streams OpenAI responses as Server-Sent Events.
// Runs on Deno V8 — uses fetch API, no Node.js require().

export default async function handler(request, context) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return new Response('Missing token', { status: 401, headers: corsHeaders() });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
  const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';
  const AI_MODEL = Deno.env.get('AI_MODEL') || 'gpt-4o';

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
    return new Response('Server misconfigured', { status: 500, headers: corsHeaders() });
  }

  // Verify token via Supabase /auth/v1/user
  const authRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_SERVICE_KEY }
  });
  if (!authRes.ok) return new Response('Invalid token', { status: 401, headers: corsHeaders() });
  const userObj = await authRes.json();
  const userId = userObj.id;
  if (!userId) return new Response('Invalid token', { status: 401, headers: corsHeaders() });

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400, headers: corsHeaders() }); }
  const { courseId, question, mode, documentId, activeFileName, openFileContext } = body;
  if (!courseId || !question) return new Response('courseId and question required', { status: 400, headers: corsHeaders() });
  const activeDocId = (typeof documentId === 'string' && documentId) ? documentId : null;
  const openFileName = (typeof activeFileName === 'string' && activeFileName) ? activeFileName : null;
  const openCtx = (typeof openFileContext === 'string' && openFileContext.trim()) ? openFileContext.trim() : null;
  if (question.length > 2000) return new Response('Question too long', { status: 400, headers: corsHeaders() });

  const ragMode = mode === 'general' ? 'general' : 'strict';

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const _rateLimitOk = await checkAndRecordRateLimit(userId, SUPABASE_URL, SUPABASE_SERVICE_KEY);
  if (!_rateLimitOk) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }), {
      status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  // ── Build SSE stream ──────────────────────────────────────────────────────
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  function send(obj) {
    try { writer.write(enc.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (e) {}
  }

  // Run async pipeline — don't await, let it run while we return the stream
  (async () => {
    try {
      // 1. Base embedding (needed for cache lookups + as retrieval fallback)
      let baseEmbedding;
      try {
        const _be = await embedBatch([question], OPENAI_API_KEY);
        baseEmbedding = _be[0];
      } catch (e) {
        send({ error: 'Embedding service unavailable' });
        await writer.close();
        return;
      }

      // 2. Doc version hash + question hash (for caching)
      const docVersionHash = await getDocVersionHash(userId, courseId, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const questionHash = await makeQuestionHash(userId, courseId, question, docVersionHash, ragMode, openFileName);
      const normalizedQ = question.toLowerCase().replace(/\s+/g, ' ').trim();

      // 3. Check exact answer cache — stream it back quickly if found
      const exactHit = await getExactAnswerCache(questionHash, docVersionHash, ragMode, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      if (exactHit && exactHit.answer_json) {
        const cached = exactHit.answer_json;
        const cachedText = cached.answer || '';
        for (let i = 0; i < cachedText.length; i += 60) send({ t: cachedText.slice(i, i + 60) });
        send({ done: true, sources: cached.sources || [], confidence: cached.confidence || 'medium', question_type: cached.question_type || '', answerCacheId: exactHit.id, cached: true });
        await writer.close();
        return;
      }

      // 4. Retrieval: check cache or run full HyDE + multi-query pipeline
      let rawChunks;
      let qType = null;
      let skipRerank = false;

      const retrievalHit = await getRetrievalCache(questionHash, docVersionHash, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      if (retrievalHit) {
        const entries = Array.isArray(retrievalHit.chunk_entries) ? retrievalHit.chunk_entries : [];
        const fetched = await fetchChunksByIds(userId, courseId, entries.map(e => e.id), SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const simMap = {}, rerankMap = {};
        entries.forEach(e => { simMap[e.id] = e.similarity; if (e.rerank_score != null) rerankMap[e.id] = e.rerank_score; });
        rawChunks = fetched.map(c => ({ ...c, similarity: simMap[c.id] || 0.5, ...(rerankMap[c.id] != null ? { rerank_score: rerankMap[c.id] } : {}) }));
        skipRerank = true;
      } else {
        const [hydeResult] = await Promise.all([generateHydeAndQueries(question, OPENAI_API_KEY)]);
        const textsToEmbed = [question];
        if (hydeResult.hypothetical) textsToEmbed.push(hydeResult.hypothetical);
        hydeResult.queries.forEach(q => { if (q) textsToEmbed.push(q); });

        let allEmbeddings;
        try {
          allEmbeddings = textsToEmbed.length > 1 ? await embedBatch(textsToEmbed, OPENAI_API_KEY) : [baseEmbedding];
        } catch (e) { allEmbeddings = [baseEmbedding]; }

        const allChunks = await Promise.all(
          allEmbeddings.map((emb, i) => retrieveChunks(userId, courseId, emb, textsToEmbed[i] || question, SUPABASE_URL, SUPABASE_SERVICE_KEY, activeDocId))
        );
        rawChunks = mergeChunks(allChunks);
      }

      // 5. No chunks found
      if (!rawChunks.length) {
        if (ragMode === 'strict') {
          send({ t: "I couldn't find relevant information in your uploaded course materials for this question. Please make sure the relevant lecture, exercise, or solution files are indexed for this course." });
        } else {
          const fbSys = 'You are StudySphere AI — a knowledgeable academic tutor. No uploaded course documents matched this question. Answer from general academic knowledge. Start with: "⚠️ *No matching course material found — answering from general knowledge.*" Math: use KaTeX $...$ and $$...$$.';
          const fbRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: AI_MODEL, max_tokens: 1500, temperature: 0.1, stream: true,
              messages: [{ role: 'system', content: fbSys }, { role: 'user', content: question }] })
          });
          if (fbRes.ok) {
            const fbReader = fbRes.body.getReader();
            const fbDecoder = new TextDecoder();
            let fbBuf = '';
            while (true) {
              const { done, value } = await fbReader.read();
              if (done) break;
              fbBuf += fbDecoder.decode(value, { stream: true });
              const lines = fbBuf.split('\n'); fbBuf = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const d = line.slice(6).trim();
                if (d === '[DONE]') continue;
                try { const tok = JSON.parse(d).choices?.[0]?.delta?.content; if (tok) send({ t: tok }); } catch (e) {}
              }
            }
          }
        }
        send({ done: true, sources: [], confidence: 'low', unsupported: true });
        await writer.close();
        return;
      }

      // 6. Classify + fetch doc names in parallel
      const [qTypeResult, docNames] = await Promise.all([
        classifyQuestion(question, OPENAI_API_KEY),
        fetchDocNames([...new Set(rawChunks.map(c => c.document_id))], SUPABASE_URL, SUPABASE_SERVICE_KEY)
      ]);
      qType = qTypeResult;

      const openDocId = openFileName
        ? Object.entries(docNames).find(([, name]) => name === openFileName || name.toLowerCase() === openFileName.toLowerCase())?.[0] || null
        : null;

      // 7. Fetch indexed open-file chunks (works for scanned PDFs)
      let effectiveOpenCtx = openCtx;
      if (openDocId) {
        const indexedCtx = await fetchOpenDocChunks(userId, courseId, openDocId, baseEmbedding, question, SUPABASE_URL, SUPABASE_SERVICE_KEY);
        if (indexedCtx) effectiveOpenCtx = indexedCtx;
      }

      // 8. LLM rerank (skip if retrieval cache hit — scores already restored)
      if (!skipRerank) {
        rawChunks = await llmRerank(question, rawChunks, OPENAI_API_KEY);
        storeRetrievalCache(userId, courseId, questionHash, docVersionHash, rawChunks, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      }

      // 9. Rank with source-type + open-file boosting, then deduplicate
      const ranked = deduplicate(rank(rawChunks, qType, openDocId));
      const topScore = ranked[0] ? ranked[0].final_score : 0;
      const weakRetrieval = topScore < 0.3;

      // 10. Build context + prompt
      const { text: contextText } = buildContext(ranked, docNames, effectiveOpenCtx, openFileName);
      const lang = detectLang(ranked);
      const tokenBudget = { exercise: 3000, derivation: 3000, concept: 2000, definition: 1500, formula: 1800, other: 2000 };
      const tempMap = { exercise: 0.1, derivation: 0.1, formula: 0.1, definition: 0.1, concept: 0.15, other: 0.1 };
      const systemPrompt = buildPrompt(ragMode, lang, qType, openFileName);

      // 11. Stream OpenAI
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          max_tokens: tokenBudget[qType] || 2000,
          temperature: tempMap[qType] !== undefined ? tempMap[qType] : 0.1,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'COURSE CONTEXT:\n\n' + contextText + '\n\n---\n\nSTUDENT QUESTION:\n' + question }
          ]
        })
      });

      if (!openaiRes.ok) {
        send({ error: 'AI service error: ' + openaiRes.status });
        await writer.close();
        return;
      }

      const reader = openaiRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const p = JSON.parse(data);
            const tok = p.choices?.[0]?.delta?.content;
            if (tok) { fullText += tok; send({ t: tok }); }
          } catch (e) {}
        }
      }

      // 12. Parse META block
      let sources = [];
      let confidence = weakRetrieval ? 'medium' : 'high';
      const metaMatch = fullText.match(/<!--META-->([\s\S]*?)<!--\/META-->/);
      if (metaMatch) {
        try {
          const meta = JSON.parse(metaMatch[1]);
          sources = Array.isArray(meta.sources) ? meta.sources : [];
          confidence = meta.confidence || confidence;
        } catch (e) {}
      }
      sources = validateSources(sources, ranked, docNames);

      // 13. Self-verify + store answer cache in parallel
      const cleanAnswer = fullText.replace(/<!--META-->[\s\S]*?<!--\/META-->/, '').trim();
      const [verification, cacheId] = await Promise.all([
        verifyClaims(question, contextText, cleanAnswer, OPENAI_API_KEY),
        storeAnswerCache(userId, courseId, questionHash, normalizedQ, docVersionHash, ragMode,
          { answer: cleanAnswer, sources, confidence, question_type: qType, unsupported: false },
          SUPABASE_URL, SUPABASE_SERVICE_KEY)
      ]);
      if (!verification.ok && weakRetrieval) confidence = 'low';

      send({ done: true, sources, confidence, question_type: qType, answerCacheId: cacheId || null });
    } catch (e) {
      send({ error: e.message || 'Stream error' });
    } finally {
      try { await writer.close(); } catch (e) {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...corsHeaders()
    }
  });
}

export const config = { path: '/api/ai/stream' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

async function embedBatch(texts, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts, dimensions: 1536 })
  });
  const data = await res.json();
  if (!data.data) throw new Error('Embed failed');
  return data.data.slice().sort((a, b) => a.index - b.index).map(e => e.embedding);
}

async function callFast(sys, user, maxTokens, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: maxTokens || 300, temperature: 0.2,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
    })
  });
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

async function generateHydeAndQueries(question, apiKey) {
  try {
    const raw = await callFast(
      'Given a student question, output JSON: {"hypothetical":"2-3 sentence academic passage answering this","queries":["alt phrasing 1","alt phrasing 2"]}. ONLY JSON.',
      question, 350, apiKey
    );
    const p = JSON.parse(raw);
    return { hypothetical: (p.hypothetical || '').trim(), queries: Array.isArray(p.queries) ? p.queries.slice(0, 2) : [] };
  } catch (e) { return { hypothetical: '', queries: [] }; }
}

async function classifyQuestion(question, apiKey) {
  try {
    const r = (await callFast('Classify: exercise, definition, derivation, concept, formula, other. ONE WORD.', question, 10, apiKey)).trim().toLowerCase();
    return ['exercise', 'definition', 'derivation', 'concept', 'formula', 'other'].includes(r) ? r : 'other';
  } catch (e) { return 'other'; }
}

async function retrieveChunks(userId, courseId, embedding, query, supaUrl, serviceKey, documentId) {
  try {
    const params = {
      p_user_id: userId, p_course_id: courseId,
      p_embedding: '[' + embedding.join(',') + ']',
      p_query: query || '', p_match_count: 12, p_threshold: 0.12
    };
    if (documentId) params.p_document_id = documentId;
    const res = await fetch(supaUrl + '/rest/v1/rpc/match_chunks_hybrid', {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function mergeChunks(arrays) {
  const map = {};
  arrays.forEach(arr => arr.forEach(c => { if (!map[c.id] || c.similarity > map[c.id].similarity) map[c.id] = c; }));
  return Object.values(map);
}

const SOURCE_BOOST = { solution: 0.08, exercise: 0.08, lecture: 0.1, exam: 0.06, notes: 0.02, summary: -0.03, other: 0.0 };

function rank(chunks, qType, openDocId) {
  return chunks.map(c => {
    const sb = SOURCE_BOOST[c.source_type] || 0;
    const ob = c.is_official ? 0.05 : 0;
    const eb = qType === 'exercise' ? (c.source_type === 'solution' ? 0.18 : c.source_type === 'exercise' ? 0.12 : 0) : 0;
    const openBoost = (openDocId && c.document_id === openDocId) ? 0.06 : 0;
    // Use rerank_score if available (weighted blend with cosine similarity)
    const base = c.rerank_score != null ? (c.rerank_score * 0.6 + c.similarity * 0.4) : c.similarity;
    return { ...c, final_score: base + sb + ob + eb + openBoost };
  }).sort((a, b) => b.final_score - a.final_score);
}

function deduplicate(chunks) {
  const selected = [];
  for (const c of chunks) {
    if (!selected.some(s => s.document_id === c.document_id &&
      Math.max(s.page_start, c.page_start) <= Math.min(s.page_end, c.page_end)))
      selected.push(c);
    if (selected.length >= 12) break;
  }
  return selected;
}

// ─── Caching + rate-limit helpers (Deno/fetch version) ───────────────────────

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkAndRecordRateLimit(userId, supaUrl, serviceKey) {
  const maxEvents = 20;
  const since = new Date(Date.now() - 3600000).toISOString();
  try {
    const res = await fetch(
      supaUrl + '/rest/v1/rate_limit_events?user_id=eq.' + userId +
      '&event_type=eq.ai_ask&created_at=gte.' + encodeURIComponent(since) + '&select=id',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length >= maxEvents) return false;
    fetch(supaUrl + '/rest/v1/rate_limit_events', {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, event_type: 'ai_ask' })
    }).catch(() => {});
    return true;
  } catch (e) { return true; } // fail open
}

async function getDocVersionHash(userId, courseId, supaUrl, serviceKey) {
  try {
    const res = await fetch(
      supaUrl + '/rest/v1/documents?user_id=eq.' + userId +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&processing_status=eq.ready&select=id,updated_at&order=id.asc',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return 'empty';
    return sha256hex(data.map(d => d.id + ':' + d.updated_at).join('|'));
  } catch (e) { return 'unknown'; }
}

async function makeQuestionHash(userId, courseId, question, docVersionHash, mode, openFileName) {
  const str = 'v3|' + userId + '|' + courseId + '|' +
    question.toLowerCase().replace(/\s+/g, ' ').trim() + '|' +
    docVersionHash + '|' + (mode || 'strict') + '|' + (openFileName || '');
  return sha256hex(str);
}

async function getExactAnswerCache(questionHash, docVersionHash, mode, supaUrl, serviceKey) {
  try {
    const res = await fetch(
      supaUrl + '/rest/v1/ai_answer_cache?question_hash=eq.' + questionHash +
      '&document_version_hash=eq.' + docVersionHash +
      '&mode=eq.' + (mode || 'strict') + '&select=id,answer_json&limit=1',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch (e) { return null; }
}

async function storeAnswerCache(userId, courseId, questionHash, normalizedQ, docVersionHash, mode, answerJson, supaUrl, serviceKey) {
  try {
    const res = await fetch(supaUrl + '/rest/v1/ai_answer_cache', {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: userId, course_id: courseId, question_hash: questionHash, normalized_question: normalizedQ, document_version_hash: docVersionHash, mode: mode || 'strict', answer_json: answerJson })
    });
    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0].id : null;
  } catch (e) { return null; }
}

async function getRetrievalCache(questionHash, docVersionHash, supaUrl, serviceKey) {
  try {
    const res = await fetch(
      supaUrl + '/rest/v1/retrieval_cache?question_hash=eq.' + questionHash +
      '&document_version_hash=eq.' + docVersionHash + '&select=id,chunk_entries&limit=1',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch (e) { return null; }
}

function storeRetrievalCache(userId, courseId, questionHash, docVersionHash, chunks, supaUrl, serviceKey) {
  const entries = chunks.map(c => ({
    id: c.id, similarity: c.similarity,
    ...(c.rerank_score != null ? { rerank_score: c.rerank_score } : {})
  }));
  fetch(supaUrl + '/rest/v1/retrieval_cache', {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, course_id: courseId, question_hash: questionHash, document_version_hash: docVersionHash, chunk_entries: entries })
  }).catch(() => {});
}

async function fetchChunksByIds(userId, courseId, ids, supaUrl, serviceKey) {
  if (!ids.length) return [];
  const idStr = ids.map(id => '"' + id + '"').join(',');
  try {
    const res = await fetch(
      supaUrl + '/rest/v1/document_chunks?id=in.(' + idStr + ')&user_id=eq.' + userId +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,document_id,chunk_text,page_start,page_end,source_type,section_title,is_official',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

const _rerankCacheMap = new Map();
async function llmRerank(question, chunks, apiKey) {
  if (!chunks || chunks.length <= 1) return chunks;
  const cacheKey = question.slice(0, 80) + '|' + chunks.slice(0, 12).map(c => c.id).sort().join(',');
  if (_rerankCacheMap.has(cacheKey)) {
    const scores = _rerankCacheMap.get(cacheKey);
    return chunks.map(c => scores[c.id] != null ? { ...c, rerank_score: scores[c.id] } : c);
  }
  const pool = chunks.slice(0, 20);
  const lines = pool.map((c, i) => '[' + (i + 1) + '] ' + (c.chunk_text || '').replace(/\s+/g, ' ').slice(0, 280));
  try {
    const raw = await callFast(
      'Score each passage 0-10 by relevance to the student question. 10=directly answers it. Return ONLY JSON: {"scores":[{"i":1,"s":8},...]}',
      'QUESTION: ' + question + '\n\nPASSAGES:\n' + lines.join('\n'),
      400, apiKey
    );
    if (!raw) return chunks;
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0) return chunks;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed.scores)) return chunks;
    const scoreMap = {};
    parsed.scores.forEach(e => {
      const idx = (parseInt(e.i) || 0) - 1;
      if (idx >= 0 && idx < pool.length) scoreMap[pool[idx].id] = Math.max(0, Math.min(10, parseFloat(e.s) || 0)) / 10;
    });
    if (_rerankCacheMap.size > 100) _rerankCacheMap.delete(_rerankCacheMap.keys().next().value);
    _rerankCacheMap.set(cacheKey, scoreMap);
    return chunks.map(c => scoreMap[c.id] != null ? { ...c, rerank_score: scoreMap[c.id] } : c);
  } catch (e) { return chunks; }
}

async function verifyClaims(question, contextBlock, answerText, apiKey) {
  try {
    const raw = await callFast(
      'Check if the answer contains claims NOT supported by the source context. Respond ONLY JSON: {"ok":true} or {"ok":false,"issues":"brief description"}',
      'QUESTION:\n' + question + '\n\nSOURCE CONTEXT:\n' + contextBlock.slice(0, 2500) + '\n\nANSWER:\n' + answerText.slice(0, 1200),
      100, apiKey
    );
    const parsed = JSON.parse(raw);
    return { ok: parsed.ok !== false, issues: parsed.issues || null };
  } catch (e) { return { ok: true, issues: null }; }
}

async function fetchOpenDocChunks(userId, courseId, docId, embedding, question, supaUrl, serviceKey) {
  try {
    const res = await fetch(supaUrl + '/rest/v1/rpc/match_chunks_hybrid', {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_user_id: userId, p_course_id: courseId,
        p_embedding: '[' + embedding.join(',') + ']',
        p_query: question || '', p_match_count: 5, p_threshold: 0.05,
        p_document_id: docId
      })
    });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const texts = data.slice(0, 5).map(c => c.chunk_text || '').filter(Boolean);
    return texts.length ? texts.join('\n\n') : null;
  } catch (e) { return null; }
}

async function fetchDocNames(docIds, supaUrl, serviceKey) {
  if (!docIds.length) return {};
  const ids = docIds.map(id => '"' + id + '"').join(',');
  const res = await fetch(supaUrl + '/rest/v1/documents?id=in.(' + ids + ')&select=id,file_name', {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }
  });
  const data = await res.json();
  const map = {};
  if (Array.isArray(data)) data.forEach(d => { map[d.id] = d.file_name; });
  return map;
}

function _parsePagesStr(pagesStr) {
  if (!pagesStr) return null;
  const m = String(pagesStr).match(/(\d+)(?:[–\-](\d+))?/);
  if (!m) return null;
  return { from: parseInt(m[1], 10), to: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10) };
}

function validateSources(sources, chunks, docNames) {
  const knownFiles = new Set(Object.values(docNames));
  const fileChunkMap = {};
  chunks.forEach(c => {
    const fn = docNames[c.document_id];
    if (!fn) return;
    if (!fileChunkMap[fn]) fileChunkMap[fn] = [];
    fileChunkMap[fn].push({ page_start: c.page_start, page_end: c.page_end, section_title: c.section_title || '' });
  });
  return sources
    .filter(s => !s.file_name || knownFiles.has(s.file_name))
    .map(s => {
      if (!s.file_name || !s.pages) return s;
      const chunkList = fileChunkMap[s.file_name];
      if (!chunkList || !chunkList.length) return s;
      const cited = _parsePagesStr(s.pages);
      if (!cited) return s;
      const overlaps = chunkList.some(c => c.page_start <= cited.to && c.page_end >= cited.from);
      if (overlaps) return s;
      const nearest = chunkList.reduce((best, c) => {
        const dist = Math.min(Math.abs(c.page_start - cited.from), Math.abs(c.page_end - cited.from));
        const bd = Math.min(Math.abs(best.page_start - cited.from), Math.abs(best.page_end - cited.from));
        return dist < bd ? c : best;
      });
      const correctedPages = nearest.page_start === nearest.page_end
        ? String(nearest.page_start)
        : nearest.page_start + '-' + nearest.page_end;
      return { ...s, pages: correctedPages, section: s.section || nearest.section_title || '' };
    });
}

function buildContext(chunks, docNames, openCtx, openFileName) {
  let total = 0;
  const blocks = [];
  if (openCtx && openFileName) {
    const header = '=== OPEN FILE (student is currently reading this — contains the problem) ===\nFILE: ' + openFileName + '\nTEXT:\n' + openCtx;
    blocks.push(header);
    total += Math.ceil(header.length / 4);
  }
  for (const [i, c] of chunks.entries()) {
    const fn = docNames[c.document_id] || 'Unknown';
    const pg = c.page_start === c.page_end ? 'p.' + c.page_start : 'pp.' + c.page_start + '-' + c.page_end;
    const lines = ['=== SOURCE ' + (i + 1) + ' ===', 'FILE: ' + fn, 'PAGES: ' + pg,
      'TYPE: ' + (c.source_type || 'document'),
      c.section_title ? 'SECTION_ID: ' + c.section_title : null, 'TEXT:', c.chunk_text].filter(Boolean);
    const block = lines.join('\n');
    const tokens = Math.ceil(block.length / 4);
    if (total + tokens > 14000) break;
    blocks.push(block);
    total += tokens;
  }
  return { text: blocks.join('\n\n') };
}

function detectLang(chunks) {
  const sample = chunks.slice(0, 4).map(c => c.chunk_text || '').join(' ').toLowerCase();
  const de = ['der', 'die', 'das', 'und', 'ist', 'mit', 'fur', 'eine', 'wird', 'sind', 'auf', 'von', 'den', 'bei', 'als', 'auch', 'sich', 'nicht', 'nach'];
  const words = sample.split(/\s+/);
  const total = Math.min(words.length, 200);
  const count = words.slice(0, total).filter(w => de.includes(w)).length;
  return total > 0 && count / total > 0.04 ? 'de' : 'en';
}

const TYPE_INSTRUCTIONS = {
  exercise: '\n\n## Exercise rules\nThe COURSE CONTEXT contains the full solution. Read every source block carefully.\n1. State what is given and what is asked.\n2. Write out the complete solution step by step, numbered.\n3. At each step state the formula or principle used, in the professor\'s exact notation.\n4. Show every algebraic manipulation. Do NOT skip steps.\n5. **Bold the final answer** with units.\n6. If a solution PDF is a source, follow it exactly — reproduce its steps.\nNEVER say the solution "is not explicitly provided" if sources are retrieved.',
  definition: '\n\nQuote the exact definition from the material first. Then explain it in plain language. Then give one example.',
  derivation: '\n\nShow every algebraic step numbered. State the rule applied at each step. Use the professor\'s notation.',
  concept: '\n\nExplain what it is, why it matters, how it works. Use a concrete example from the course material.',
  formula: '\n\nState the formula clearly. Define every variable. Give units. Show a brief worked example.',
  other: ''
};

function buildPrompt(mode, lang, qType, openFileName) {
  const strict = mode !== 'general';
  const langLine = lang === 'de' ? 'Respond in **German** — the course materials are in German.' : 'Respond in **English**.';
  const openFileLine = openFileName
    ? 'The student is currently reading **' + openFileName + '**. The OPEN FILE block contains the problem/exercise text from that file. Use it to understand exactly what is being asked. Look in ALL other course documents (lectures, solution sheets) for the explanation and full solution.'
    : '';
  return [
    'You are StudySphere AI — a precise, expert-level academic study assistant.', langLine,
    openFileLine ? openFileLine : '',
    '',
    '1. Read ALL source blocks in COURSE CONTEXT before writing anything.',
    '2. Ground every claim in the COURSE CONTEXT. Use the professor\'s exact notation and terminology.',
    '3. Structure your answer clearly in markdown. Start with a direct 1-2 sentence answer.',
    '4. Math: use KaTeX. Inline: $...$  Display: $$...$$ — NEVER use \\( or \\[. No Unicode math letters.',
    '5. After each major claim, add inline citation: *(filename, p.X)* or *(filename, p.X, SECTION_ID)*.',
    strict
      ? '6. **COURSE MODE:** Only answer from the COURSE CONTEXT. If the course materials do not contain sufficient information, respond: "I could not find enough information in your uploaded course materials for this. Please check that the relevant lecture, exercise, or solution PDF is indexed." Do NOT use general knowledge in Course Mode.'
      : '6. **TUTOR MODE:** Use COURSE CONTEXT as primary source. You may supplement with general academic knowledge only after exhausting the course materials. Label all general knowledge clearly with *(general knowledge)*.',
    '7. Confidence: "high" when COURSE CONTEXT directly supports the answer. "medium" when substantial portions rely on general knowledge. "low" when mostly general knowledge.',
    '8. CRITICAL: Do NOT include confidence, sources, or metadata in your markdown answer text. Only in the META block.',
    TYPE_INSTRUCTIONS[qType] || '',
    '',
    'After your full markdown answer, on a new line output ONLY this (fill in real values):',
    '<!--META-->{"sources":[{"file_name":"exact FILE value","pages":"exact PAGES value","section":"SECTION_ID or empty"}],"confidence":"high|medium|low"}<!--/META-->'
  ].join('\n');
}
