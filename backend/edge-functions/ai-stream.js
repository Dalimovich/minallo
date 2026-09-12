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
  const AI_NANO_MODEL = Deno.env.get('AI_NANO_MODEL') || 'gpt-4.1-nano';

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
  const { courseId, question, mode, documentId, activeFileName, openFileContext, pageImages, forceRefresh, prevQuestion } = body;
  if (!courseId || !question) return new Response('courseId and question required', { status: 400, headers: corsHeaders() });
  const activeDocId = (typeof documentId === 'string' && documentId) ? documentId : null;
  const openFileName = (typeof activeFileName === 'string' && activeFileName) ? activeFileName : null;
  const openCtx = (typeof openFileContext === 'string' && openFileContext.trim()) ? openFileContext.trim() : null;
  const prevQ = (typeof prevQuestion === 'string' && prevQuestion.trim()) ? prevQuestion.trim() : null;
  const handwrittenImages = Array.isArray(pageImages) && pageImages.length ? pageImages.slice(0, 8) : null;
  if (question.length > 2000) return new Response('Question too long', { status: 400, headers: corsHeaders() });

  // Verify the courseId belongs to the authenticated user
  const courseCheckRes = await fetch(
    SUPABASE_URL + '/rest/v1/courses?id=eq.' + encodeURIComponent(courseId) + '&user_id=eq.' + userId + '&select=id&limit=1',
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY } }
  );
  const courseCheck = await courseCheckRes.json();
  if (!Array.isArray(courseCheck) || !courseCheck.length) {
    return new Response('Course not found', { status: 403, headers: corsHeaders() });
  }
  if (activeDocId) {
    const docCheckRes = await fetch(
      SUPABASE_URL + '/rest/v1/documents?id=eq.' + encodeURIComponent(activeDocId) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&user_id=eq.' + userId +
        '&select=id&limit=1',
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY } }
    );
    const docCheck = await docCheckRes.json();
    if (!Array.isArray(docCheck) || !docCheck.length) {
      return new Response('Document not found', { status: 403, headers: corsHeaders() });
    }
  }

  const ragMode = mode === 'general' ? 'general' : 'strict';

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
      // Build enriched query early — used for base embedding AND all downstream retrieval.
      // If the open PDF context is available, prepend it so every embedding/HyDE call
      // reflects the actual exercise topic rather than just "Löse 13.1".
      // If the question is a vague follow-up ("now b)", "question c)") with no open file,
      // prepend the previous question so retrieval searches the right topic.
      const _isVagueFollowup = !openCtx && prevQ && question.length < 80 &&
        /\b([a-d])\s*\)?$|\b(?:now|jetzt|weiter|next|question|teil|part|aufgabe|mach|solve|löse)\s+([a-d])\b|\b(?:next\s+question|nächste\s+aufgabe|weiter|nächste[sr]?|continue|and\s+(?:now|next)|next\s+(?:one|part|exercise|task))\b/i.test(question);
      const enrichedQuestion = openCtx
        ? 'Aufgabe-Kontext: ' + openCtx.slice(0, 2000) + '\n\nFrage: ' + question
        : _isVagueFollowup
          ? 'Vorherige Frage: ' + prevQ.slice(0, 400) + '\n\nFolgefrage: ' + question
          : question;

      // 1. Base embedding — embed the enriched question so cache lookups, fetchSummaryChunks,
      //    and all fallback retrievals use the topic-rich query, not the short student message.
      let baseEmbedding;
      try {
        const _be = await embedBatch([enrichedQuestion], OPENAI_API_KEY);
        baseEmbedding = _be[0];
      } catch (e) {
        send({ error: 'Embedding service unavailable' });
        await writer.close();
        return;
      }

      // 2. Doc version hash + question hash (for caching)
      const docVersionHash = await getDocVersionHash(userId, courseId, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const questionHash = await makeQuestionHash(userId, courseId, question, docVersionHash, ragMode, openFileName, activeDocId);
      const normalizedQ = question.toLowerCase().replace(/\s+/g, ' ').trim();

      // 3. Check exact answer cache — stream it back quickly if found
      // Skip cache when the user explicitly regenerated (forceRefresh=true)
      const exactHit = !forceRefresh && await getExactAnswerCache(questionHash, docVersionHash, ragMode, SUPABASE_URL, SUPABASE_SERVICE_KEY);
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

      const retrievalHit = !forceRefresh && await getRetrievalCache(questionHash, docVersionHash, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      if (retrievalHit) {
        const entries = Array.isArray(retrievalHit.chunk_entries) ? retrievalHit.chunk_entries : [];
        const fetched = await fetchChunksByIds(userId, courseId, entries.map(e => e.id), SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const simMap = {}, rerankMap = {};
        entries.forEach(e => { simMap[e.id] = e.similarity; if (e.rerank_score != null) rerankMap[e.id] = e.rerank_score; });
        rawChunks = fetched.map(c => ({ ...c, similarity: simMap[c.id] || 0.5, ...(rerankMap[c.id] != null ? { rerank_score: rerankMap[c.id] } : {}) }));
        skipRerank = true;
      } else {
        const [hydeResult] = await Promise.all([generateHydeAndQueries(enrichedQuestion, OPENAI_API_KEY)]);
        const textsToEmbed = [enrichedQuestion];
        if (hydeResult.hypothetical) textsToEmbed.push(hydeResult.hypothetical);
        hydeResult.queries.forEach(q => { if (q) textsToEmbed.push(q); });

        let allEmbeddings;
        try {
          allEmbeddings = textsToEmbed.length > 1 ? await embedBatch(textsToEmbed, OPENAI_API_KEY) : [baseEmbedding];
        } catch (e) { allEmbeddings = [baseEmbedding]; }

        // NEVER restrict main retrieval to activeDocId — the Formelzettel is a different file.
        // activeDocId is used only for ranking boosts, not for filtering retrieval.
        const [allChunks, summaryInject] = await Promise.all([
          Promise.all(allEmbeddings.map((emb, i) => retrieveChunks(userId, courseId, emb, textsToEmbed[i] || enrichedQuestion, SUPABASE_URL, SUPABASE_SERVICE_KEY, null))),
          fetchSummaryChunks(userId, courseId, SUPABASE_URL, SUPABASE_SERVICE_KEY, baseEmbedding)
        ]);
        const pinnedSummary = summaryInject.map(c => ({ ...c, _pinned: true }));
        rawChunks = mergeChunks([...allChunks, pinnedSummary]);
      }

      // Always ensure summary/Formelzettel chunks are in the pool for cache-restored paths
      if (skipRerank) {
        const summaryInject = await fetchSummaryChunks(userId, courseId, SUPABASE_URL, SUPABASE_SERVICE_KEY, baseEmbedding);
        if (summaryInject.length) rawChunks = mergeChunks([rawChunks, summaryInject.map(c => ({ ...c, _pinned: true }))]);
      }

      // 5. No chunks found
      if (!rawChunks.length) {
        if (ragMode === 'strict') {
          send({ t: "I couldn't find relevant information in your uploaded course materials for this question. Please make sure the relevant lecture, exercise, or solution files are indexed for this course." });
        } else {
          const fbSys = 'You are Minallo AI — a knowledgeable academic tutor. No uploaded course documents matched this question. Answer from general academic knowledge. Start with: "⚠️ *No matching course material found — answering from general knowledge.*" Math: use KaTeX $...$ and $$...$$.';
          const fbRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, temperature: 0.1, stream: true,
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
      // Pass open PDF context to classifier so "Löse 13.1" with an Aufgabe open → 'exercise'
      const classifyInput = openCtx
        ? question + '\n\nOpen PDF context: ' + openCtx.slice(0, 300)
        : question;
      const [qTypeResult, docNames] = await Promise.all([
        classifyQuestion(classifyInput, OPENAI_API_KEY),
        fetchDocNames([...new Set(rawChunks.map(c => c.document_id))], userId, SUPABASE_URL, SUPABASE_SERVICE_KEY)
      ]);
      qType = qTypeResult;
      // Force exercise type when the open PDF clearly contains an exercise — catches short
      // queries like "mach a" or "13.1 bitte" that the classifier sees as 'other'
      if (qType === 'other' && openCtx) {
        const _ctx = (question + ' ' + openCtx).toLowerCase();
        if (/aufgabe|übung|uebung|gegeben|gesucht|berechne|bestimme|ermittle|prüfe|löse|solve|calculate|determine/.test(_ctx))
          qType = 'exercise';
      }

      const namedOpenDocId = openFileName
        ? Object.entries(docNames).find(([, name]) => name === openFileName || name.toLowerCase() === openFileName.toLowerCase())?.[0] || null
        : null;
      const openDocId = activeDocId || namedOpenDocId;

      // 7. Fetch indexed open-file chunks (works for scanned PDFs)
      let effectiveOpenCtx = openCtx;
      if (openDocId) {
        const indexedCtx = await fetchOpenDocChunks(userId, courseId, openDocId, baseEmbedding, question, SUPABASE_URL, SUPABASE_SERVICE_KEY);
        if (indexedCtx) effectiveOpenCtx = indexedCtx;
      }

      // 8. LLM rerank (skip if retrieval cache hit — scores already restored)
      // Use enrichedQuestion so the reranker knows the actual exercise topic, not just "Löse 13.1"
      if (!skipRerank) {
        rawChunks = await llmRerank(enrichedQuestion, rawChunks, OPENAI_API_KEY);
        storeRetrievalCache(userId, courseId, questionHash, docVersionHash, rawChunks, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      }

      // 9. Rank with source-type + open-file boosting, then deduplicate
      const ranked = deduplicate(rank(rawChunks, qType, openDocId, docNames));
      const topScore = ranked[0] ? ranked[0].final_score : 0;
      const weakRetrieval = topScore < 0.3;

      // 10. Build context + prompt
      const { text: contextText } = buildContext(ranked, docNames, effectiveOpenCtx, openFileName);
      const lang = detectLang(question, ranked);
      const tokenBudget = { exercise: 8000, derivation: 8000, concept: 5000, definition: 3000, formula: 5000, other: 5000 };
      const tempMap = { exercise: 0.1, derivation: 0.1, formula: 0.1, definition: 0.1, concept: 0.15, other: 0.1 };
      const systemPrompt = buildPrompt(ragMode, lang, qType, openFileName, !!handwrittenImages);

      // 11. Stream OpenAI
      // Handwritten images require a vision-capable model — force gpt-4o regardless of AI_MODEL setting
      // (o3, o4-mini and other reasoning models do not support image inputs)
      const selectedModel = handwrittenImages
        ? 'gpt-4o'
        : ['exercise', 'derivation', 'formula'].includes(qType) ? AI_MODEL : AI_NANO_MODEL;
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: tokenBudget[qType] || 5000,
          temperature: tempMap[qType] !== undefined ? tempMap[qType] : 0.1,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: handwrittenImages
                ? [
                    { type: 'text', text:
                        'COURSE CONTEXT (Formelsammlung and lecture material):\n\n' + contextText +
                        '\n\n---\n\n' +
                        'OPEN PDF PAGES (images below): The student has a PDF open showing these pages. ' +
                        'The PDF may contain handwritten solutions, worked examples, or diagrams alongside printed text. ' +
                        'CRITICAL: If any image shows a worked solution with explicit numerical values (e.g. F_M,min = 90,942.88 N), ' +
                        'you MUST use those exact values — do NOT recalculate from scratch with different formulas. ' +
                        'Read every handwritten value, formula, subscript, and number carefully. ' +
                        'If the images show a step-by-step solution, reproduce it exactly.\n\n' +
                        'STUDENT QUESTION: ' + question
                    },
                    ...handwrittenImages.map(b64 => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }))
                  ]
                : 'COURSE CONTEXT:\n\n' + contextText + '\n\n---\n\nSTUDENT QUESTION:\n' + question
            }
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

      // Fire-and-forget: persist Q&A to chat_history table
      if (userId && courseId && question && cleanAnswer) {
        fetch(SUPABASE_URL + '/rest/v1/chat_history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ user_id: userId, course_id: courseId, question, answer: cleanAnswer })
        }).catch(() => {});
      }

      // Never cache an empty answer — it would poison every future ask of this question
      if (!cleanAnswer) {
        send({ error: 'AI returned an empty response. Please try again.' });
        await writer.close();
        return;
      }

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
  const origin = Deno.env.get('ALLOWED_ORIGIN') || 'http://localhost:8888';
  return {
    'Access-Control-Allow-Origin': origin,
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

// summary = Formelsammlung / Zusammenfassung — highly valuable, never penalise
const SOURCE_BOOST = { solution: 0.08, exercise: 0.08, lecture: 0.1, exam: 0.06, notes: 0.04, summary: 0.06, other: 0.0 };

function rank(chunks, qType, openDocId, docNames) {
  return chunks.map(c => {
    const sb = SOURCE_BOOST[c.source_type] || 0;
    const ob = c.is_official ? 0.05 : 0;
    // Exercise boost: solutions first, then exercises, then summaries (Formelsammlung)
    const eb = qType === 'exercise'
      ? (c.source_type === 'solution' ? 0.18 : c.source_type === 'exercise' ? 0.12 : c.source_type === 'summary' ? 0.10 : c.source_type === 'notes' ? 0.06 : 0)
      : qType === 'formula' || qType === 'derivation'
        ? (c.source_type === 'summary' ? 0.18 : c.source_type === 'notes' ? 0.10 : c.source_type === 'lecture' ? 0.06 : 0)
        : 0;
    // Filename-based formula sheet boost — catches Formelzettel uploaded as 'lecture' or 'other'
    const fnBoost = isFormulaSheetName(docNames && docNames[c.document_id]) ? 0.08 : 0;
    const openBoost = (openDocId && c.document_id === openDocId) ? 0.06 : 0;
    const base = c.rerank_score != null ? (c.rerank_score * 0.6 + c.similarity * 0.4) : c.similarity;
    return { ...c, final_score: base + sb + ob + eb + fnBoost + openBoost };
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

async function checkAndRecordRateLimit(userId, supaUrl, serviceKey, maxEvents) {
  maxEvents = maxEvents || 200;
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

async function makeQuestionHash(userId, courseId, question, docVersionHash, mode, openFileName, activeDocId) {
  const str = 'v7-interactive-input|' + userId + '|' + courseId + '|' +
    question.toLowerCase().replace(/\s+/g, ' ').trim() + '|' +
    docVersionHash + '|' + (mode || 'strict') + '|' + (openFileName || '') + '|' + (activeDocId || '');
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

async function fetchDocNames(docIds, userId, supaUrl, serviceKey) {
  if (!docIds.length) return {};
  const ids = docIds.map(id => '"' + id + '"').join(',');
  const res = await fetch(
    supaUrl + '/rest/v1/documents?id=in.(' + ids + ')&user_id=eq.' + userId + '&select=id,file_name',
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
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

  // Always inject pinned Formelzettel chunks first — regardless of rank score.
  // These bypass the reranker cutoff so the AI always has the formula sheet.
  const pinned = chunks.filter(c => c._pinned);
  const normal = chunks.filter(c => !c._pinned);

  let srcIdx = 1;
  if (pinned.length) {
    for (const c of pinned) {
      const fn = docNames[c.document_id] || 'Unknown';
      const pg = c.page_start === c.page_end ? 'p.' + c.page_start : 'pp.' + c.page_start + '-' + c.page_end;
      const lines = ['=== FORMELZETTEL ' + srcIdx + ' ===', 'FILE: ' + fn, 'PAGES: ' + pg,
        c.section_title ? 'SECTION_ID: ' + c.section_title : null, 'TEXT:', c.chunk_text].filter(Boolean);
      const block = lines.join('\n');
      const tokens = Math.ceil(block.length / 4);
      if (total + tokens > 6000) break; // cap Formelzettel at 6k tokens to leave room for exercise chunks
      blocks.push(block);
      total += tokens;
      srcIdx++;
    }
  }

  for (const c of normal) {
    const fn = docNames[c.document_id] || 'Unknown';
    const pg = c.page_start === c.page_end ? 'p.' + c.page_start : 'pp.' + c.page_start + '-' + c.page_end;
    const lines = ['=== SOURCE ' + srcIdx + ' ===', 'FILE: ' + fn, 'PAGES: ' + pg,
      'TYPE: ' + (c.source_type || 'document'),
      c.section_title ? 'SECTION_ID: ' + c.section_title : null, 'TEXT:', c.chunk_text].filter(Boolean);
    const block = lines.join('\n');
    const tokens = Math.ceil(block.length / 4);
    if (total + tokens > 14000) break;
    blocks.push(block);
    total += tokens;
    srcIdx++;
  }
  return { text: blocks.join('\n\n') };
}

const _DE_WORDS = new Set(['der','die','das','und','ist','ein','eine','mit','für','wie','was','berechne','bestimme','zeige','erkläre','warum','welche','welcher','welches','wenn','dann','gegeben','gesucht','aufgabe','lösung','nicht','auch','sich','nach','von','auf','dem','den','bei','sein','sind','wird','kann','muss','soll','durch','über','wird','haben','dieser','diese','dieses','im','am','zu','zum','zur','ich','sie','er','wir','ihr','bitte','gib','zeig','nenne']);
const _EN_WORDS = new Set(['the','and','what','is','are','how','why','calculate','explain','show','find','given','solution','problem','prove','determine','which','when','then','can','should','must','through','about','this','that','with','have','for','not','give','tell','list','define','describe','compare']);

function detectLang(question, chunks) {
  // Question language is the strongest signal — match the student's language
  const qWords = question.toLowerCase().split(/\s+/);
  let de = 0, en = 0;
  for (const w of qWords) {
    if (_DE_WORDS.has(w)) de++;
    if (_EN_WORDS.has(w)) en++;
  }
  if (de > en) return 'de';
  if (en > de) return 'en';
  // Tie or ambiguous (e.g. pure math notation): sample chunks
  const sample = chunks.slice(0, 6).map(c => c.chunk_text || '').join(' ').toLowerCase().split(/\s+/).slice(0, 300);
  let cde = 0, cen = 0;
  for (const w of sample) { if (_DE_WORDS.has(w)) cde++; if (_EN_WORDS.has(w)) cen++; }
  if (cde > cen) return 'de';
  if (cen > cde) return 'en';
  return 'de'; // default: German university context
}

// Detect Formelzettel/formula sheets by filename — regardless of stored source_type.
// Users often upload these as 'lecture' or 'other', so source_type alone is unreliable.
function isFormulaSheetName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes('formel') || n.includes('zusammenfassung') || n.includes('tabelle') ||
         n.includes('tabellenbuch') || n.includes('cheatsheet') || n.includes('cheat') ||
         n.includes('formula') || n.includes('merkblatt') || n.includes('summary') ||
         n.includes('überblick') || n.includes('uberblick');
}

// Always inject Formelzettel/summary chunks into the candidate pool.
// Detects formula sheets by BOTH source_type AND filename so misclassified uploads are caught.
async function fetchSummaryChunks(userId, courseId, supaUrl, serviceKey, embedding) {
  try {
    // Step 1: find all formula-sheet documents in this course (by source_type OR filename)
    const docsRes = await fetch(
      supaUrl + '/rest/v1/documents?user_id=eq.' + userId +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&processing_status=eq.ready&select=id,file_name,source_type',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const docs = await docsRes.json();
    const formulaDocIds = Array.isArray(docs)
      ? docs.filter(d => d.source_type === 'summary' || d.source_type === 'notes' || isFormulaSheetName(d.file_name))
             .map(d => d.id)
      : [];

    if (!formulaDocIds.length) return [];

    // Step 2: if we have an embedding, vector-search within those documents
    if (embedding) {
      const results = await Promise.all(formulaDocIds.map(docId =>
        fetch(supaUrl + '/rest/v1/rpc/match_chunks_hybrid', {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            p_user_id: userId, p_course_id: courseId,
            p_embedding: '[' + embedding.join(',') + ']',
            p_query: '', p_match_count: 8, p_threshold: 0.05,
            p_document_id: docId
          })
        }).then(r => r.json()).then(d => Array.isArray(d) ? d : []).catch(() => [])
      ));
      const merged = mergeChunks(results);
      if (merged.length) return merged;
    }

    // Step 3: fallback — fetch up to 30 chunks from formula-sheet documents
    const idStr = formulaDocIds.map(id => '"' + id + '"').join(',');
    const res = await fetch(
      supaUrl + '/rest/v1/document_chunks' +
      '?user_id=eq.' + userId +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&document_id=in.(' + idStr + ')' +
      '&select=id,document_id,chunk_text,page_start,page_end,source_type,section_title,is_official' +
      '&limit=30',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(c => ({ ...c, similarity: 0.18 }));
  } catch (e) { return []; }
}

const TYPE_INSTRUCTIONS = {
  exercise: '\n\n## Exercise rules\n1. **Read the OPEN FILE block first** — it contains the Aufgabenstellung with all given values (forces, dimensions, materials, pressures, factors). Extract every given value before starting any calculation.\n2. **Solve ALL sub-questions** (a, b, c, d …) — do not stop after the first one.\n3. For each sub-question state explicitly: what is given, what is asked.\n4. **FORMULAS: Use formulas from (in priority order): (a) handwritten page images if present, (b) COURSE CONTEXT source blocks (Formelsammlung/lecture/solution). Do NOT invent formulas. If no formula is found, say: "Die benötigte Formel wurde nicht gefunden."**\n5. For EVERY calculation step, write it out in this exact format:\n   - Formula (symbolic): e.g. $F_{M,min} = F_{K,erf} + F_Z + (1 - n \\cdot \\phi_K) \\cdot F_A$\n   - Substitution (numbers): e.g. $= 12500 + 5763.7 + (1 - 0.7 \\cdot 0.12) \\cdot 72679.4$\n   - Result: e.g. $= 90{,}942.88\\ \\text{N}$\n6. NEVER skip a step. NEVER jump from formula to final answer. Show the number substitution.\n7. **CRITICAL: Every term you write in a formula MUST have a corresponding numerical calculation.** If you write $\\delta_s = \\delta_1 + \\delta_2 + \\delta_K + \\delta_G + \\delta_M$, you MUST calculate ALL five terms. If you cannot calculate a term because no value is given, remove it from the formula entirely — do NOT leave uncalculated terms.\n8. If a later sub-question (b, c) depends on results from an earlier one (a), use those results explicitly.\n9. Piecewise kinematics: carry velocity/state across internal boundaries. Never reset velocity to zero at a region boundary unless the statement says the object stops or is released again. If a horizontal current/force acts only in one height/position region, apply its acceleration only during time spent in that region.\n10. **Bold the final answer** with units for each sub-question.\n11. After solving, state whether each result looks physically plausible.',
  definition: '\n\nQuote the exact definition from the material first. Then explain it in plain language. Then give one example.',
  derivation: '\n\nShow every algebraic step numbered. State the rule applied at each step. Use the professor\'s notation.',
  concept: '\n\nExplain what it is, why it matters, how it works. Use a concrete example from the course material.',
  formula: '\n\nState the formula clearly. Define every variable. Give units. Show a brief worked example.',
  other: ''
};

function buildPrompt(mode, lang, qType, openFileName, hasHandwritten) {
  const strict = mode !== 'general';
  const langLine = lang === 'de'
    ? 'Respond in **German** because the student\'s question is German.'
    : 'Respond in **English** because the student\'s question is English. German document text or labels such as "Aufgabe 13.1" must not change the response language.';
  const openFileLine = openFileName
    ? 'The student is currently reading **' + openFileName + '**. The OPEN FILE block contains the problem/exercise text from that file. Use it to understand exactly what is being asked. Look in ALL other course documents (lectures, solution sheets) for the explanation and full solution.'
    : '';
  const handwrittenLine = hasHandwritten
    ? '⚠️ OPEN PDF WITH PAGE IMAGES: The student has a PDF open. Page images are included in the user message. The PDF may have printed text AND handwritten solutions. CRITICAL RULE: If any image shows a worked solution with explicit numerical results (e.g. F_M,min = 90,942.88 N), you MUST reproduce those exact numbers — do NOT recalculate from scratch. Read images carefully for handwritten values, formulas, and subscripts.'
    : '';
  return [
    'You are Minallo AI — a precise, expert-level academic study assistant for engineering students.', langLine,
    openFileLine ? openFileLine : '',
    handwrittenLine ? handwrittenLine : '',
    '',
    '## CORE ANSWER QUALITY RULES (follow every single one)',
    '',
    '1. Read ALL source blocks in COURSE CONTEXT before writing anything.',
    '2. Ground every claim in the COURSE CONTEXT. Use the professor\'s exact notation and terminology.',
    '3. STEP-BY-STEP SOLVING: For any calculation or derivation, never skip steps. Show:',
    '   - The formula (symbolic, from the course materials)',
    '   - Every substitution with the actual numbers and units',
    '   - Each intermediate result',
    '   - The final result with units and a clear statement of what it means',
    '   If a sub-question has multiple parts (e.g. first find F, then find M), solve each part fully before proceeding.',
    '4. PRECISION: Use exact values from the course materials. Do not round intermediate results unless instructed.',
    '   Always include units. Always verify dimensional consistency.',
    '5. COMPLETENESS: Do not summarise or skip the derivation. The student needs to understand every step.',
    '   A short answer is only acceptable for purely conceptual yes/no questions.',
    '6. Math: use KaTeX. Inline: $...$  Display: $$...$$ — NEVER use \\( or \\[. No Unicode math letters.',
    '7. Structure: use markdown headings and bullet points to separate Given / Find / Formula / Calculation / Result.',
    '8. After each major claim, add inline citation: *(filename, p.X)* or *(filename, p.X, SECTION_ID)*.',
    strict
      ? '9. **COURSE MODE:** Answer from the COURSE CONTEXT. Use formulas from the Formelsammlung/lecture to solve sub-questions even if a solution PDF is not present — do NOT refuse to answer just because the worked solution is missing. Only say materials are missing if you truly have no relevant formulas or definitions at all.'
      : '9. **TUTOR MODE:** Use COURSE CONTEXT as primary source. You may supplement with general academic knowledge only after exhausting the course materials. Label all general knowledge clearly with *(general knowledge)*.',
    '10. Confidence: "high" when COURSE CONTEXT directly supports the answer. "medium" when substantial portions rely on general knowledge. "low" when mostly general knowledge.',
    '11. CRITICAL: Do NOT include confidence, sources, or metadata in your markdown answer text. Only in the META block.',
    TYPE_INSTRUCTIONS[qType] || '',
    '',
    '12. FOLLOW-UP NAVIGATION RULE: When the student says "next question", "next one", "weiter", "nächste Aufgabe" etc.:',
    '   a) If the CURRENT exercise has remaining sub-questions (b, c, d…), answer the next sub-question directly.',
    '   b) If ALL sub-questions of the current exercise are done, do NOT jump to the next exercise automatically.',
    '      Instead, write a one-sentence summary that the exercise is complete, then ask: "Shall I continue with the next exercise?" (or equivalent in the reply language).',
    '   c) Only move to the next exercise after the student explicitly confirms (e.g. "yes", "ja", "continue").',
    '',
    'After your full markdown answer, on a new line output ONLY this (fill in real values):',
    '<!--META-->{"sources":[{"file_name":"exact FILE value","pages":"exact PAGES value","section":"SECTION_ID or empty"}],"confidence":"high|medium|low"}<!--/META-->'
  ].join('\n');
}
