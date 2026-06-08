// All AI endpoints flow through Cloudflare Pages Functions (which forward to python-ai).
// See docs/python-ai-endpoints.md for shapes.

function _backendUrl(): string {
  return window.BACKEND_URL || '';
}

function _token(): string {
  return window._sbToken || '';
}

function _authJsonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + _token(),
  };
}

async function _detectAiCapError(response: Response): Promise<boolean> {
  const mod = await import(/* @vite-ignore */ atob('Li9haS11c2FnZS5qcw=='));
  return mod.detectAiCapError(response);
}

export async function sendAiRequest(payload: unknown): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/ai', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify(payload),
  });
  await _detectAiCapError(response);
  return response.json();
}

// RAG ask — uses uploaded course documents as context.
export interface RagSource {
  file_name?: string;
  pages?: string | null;
  section?: string | null;
}

export interface RagAskResponse {
  answer: string;
  retrievalMode?: string;
  confidence?: string;
  unsupported?: boolean;
  sources?: RagSource[];
  cacheHit?: boolean;
  model?: string | null;
  [k: string]: unknown;
}

export async function sendRagRequest(
  courseId: string,
  question: string,
  mode?: string,
  activeDocumentId?: string | null,
  activeFileName?: string | null,
  openFileContext?: unknown,
  documentIds?: string[] | null,
): Promise<RagAskResponse> {
  const payload: Record<string, unknown> = {
    courseId,
    question,
    mode: mode || 'strict',
  };
  // activeDocumentId = ranking hint (currently open PDF).
  // documentIds = hard filter, set only when the user explicitly scopes
  // the question to a chosen subset of documents.
  if (activeDocumentId) payload.activeDocumentId = activeDocumentId;
  if (documentIds && documentIds.length) payload.documentIds = documentIds;
  if (activeFileName) payload.activeFileName = activeFileName;
  if (openFileContext) payload.openFileContext = openFileContext;

  const response = await fetch(_backendUrl() + '/api/ai/ask', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify(payload),
  });
  await _detectAiCapError(response);
  if (!response.ok) {
    let detail = 'HTTP ' + response.status;
    try {
      const data = (await response.json()) as { detail?: string; error?: { message?: string } };
      detail = data.detail || data.error?.message || detail;
    } catch {
      /* keep status fallback */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<RagAskResponse>;
}

interface UploadResponse {
  document?: { id: string; processingStatus?: string };
  error?: { message?: string };
  [k: string]: unknown;
}

export function uploadCourseDocument(
  file: File,
  courseId: string,
  sourceType?: string
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const result = e.target?.result;
      if (typeof result !== 'string') {
        reject(new Error('Upload failed (no data)'));
        return;
      }
      const base64 = result.split(',')[1] || '';
      try {
        const response = await fetch(_backendUrl() + '/api/documents/upload', {
          method: 'POST',
          headers: _authJsonHeaders(),
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || 'application/pdf',
            fileBase64: base64,
            courseId,
            sourceType: sourceType || 'lecture',
          }),
        });
        const text = await response.text();
        let data: UploadResponse;
        try {
          data = JSON.parse(text) as UploadResponse;
        } catch {
          reject(new Error('Upload failed (' + response.status + ')'));
          return;
        }
        if (!response.ok) {
          reject(
            new Error((data.error && data.error.message) || 'Upload failed (' + response.status + ')')
          );
        } else {
          resolve(data);
        }
      } catch (err: unknown) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

export interface CourseDocument {
  id: string;
  file_name: string;
  fileName?: string;
  file_type?: string;
  source_type?: string;
  processing_status?: string;
  processing_error?: string | null;
  page_count?: number;
  extraction_quality?: 'good' | 'weak' | 'failed' | string | null;
  ocr_assessment?: {
    ocrRecommended?: boolean;
    pagesLikelyScanned?: number;
    pagesImageHeavy?: number;
    pagesAlmostNoText?: number;
    [key: string]: unknown;
  } | null;
  created_at?: string;
  updated_at?: string;
}

export async function listCourseDocuments(courseId: string): Promise<CourseDocument[]> {
  // Wait for session restore so the Authorization header isn't empty during
  // dashboard prewarm. Otherwise the proxy returns 401 and cards show no files
  // until the user manually reopens the course.
  if (window._sbSessionReady) await window._sbSessionReady;

  const response = await fetch(
    _backendUrl() + '/api/documents/list?courseId=' + encodeURIComponent(courseId),
    { headers: { Authorization: 'Bearer ' + _token() } }
  );
  const data = (await response.json()) as { documents?: CourseDocument[] };
  return data.documents || [];
}

export function filterDocsByCourseFiles(
  docs: CourseDocument[],
  courseId: string
): CourseDocument[] {
  const course = window.activeCourseRef;
  if (!course || course.id !== courseId) return docs;
  const names = new Set<string>();
  ((course.files || []) as Array<{ name?: string }>).forEach((f) => {
    const name = String(f.name || '').trim().toLowerCase();
    if (name) names.add(name);
  });
  ((course.userFolders || []) as Array<{ files: Array<{ name?: string }> }>).forEach((fd) => {
    (fd.files || []).forEach((f) => {
      const name = String(f.name || '').trim().toLowerCase();
      if (name) names.add(name);
    });
  });
  if (!names.size) return docs;
  return docs.filter((d) => {
    const name = String(d.file_name || d.fileName || '').trim().toLowerCase();
    return !!name && names.has(name);
  });
}

export interface DocumentMeta {
  professorName?: string;
  lectureNumber?: number | string;
  exerciseNumber?: number | string;
  language?: string;
  isOfficialProfMaterial?: boolean;
  forceReindex?: boolean;
}

export async function indexExistingDocument(
  courseId: string,
  storageName: string,
  fileName: string,
  sourceType?: string,
  folder?: string | null,
  meta?: DocumentMeta
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  const payload: Record<string, unknown> = {
    courseId,
    storageName,
    fileName,
    sourceType: sourceType || 'lecture',
    folder: folder || null,
  };
  if (meta) {
    if (meta.professorName) payload.professorName = meta.professorName;
    if (meta.lectureNumber != null) payload.lectureNumber = Number(meta.lectureNumber);
    if (meta.exerciseNumber != null) payload.exerciseNumber = Number(meta.exerciseNumber);
    if (meta.language) payload.language = meta.language;
    if (meta.isOfficialProfMaterial != null)
      payload.isOfficialProfMaterial = !!meta.isOfficialProfMaterial;
    if (meta.forceReindex) payload.forceReindex = true;
  }
  try {
    const response = await fetch(_backendUrl() + '/api/documents/index-existing', {
      method: 'POST',
      headers: _authJsonHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.status === 401) throw new Error('SESSION_EXPIRED');
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Index failed (' + response.status + ')');
    }
  } catch (e: unknown) {
    clearTimeout(timeoutId);
    throw e;
  }
}

export async function deleteRagDocument(documentId: string): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/documents/delete', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ documentId }),
  });
  return response.json();
}

export interface OcrReviewPage {
  pageNumber: number;
  provider?: string | null;
  mode?: string | null;
  confidence?: number | null;
  unclearCount?: number;
  text: string;
}

/** Fetch the OCR'd pages of a document that were flagged for student review
 *  (handwriting pages, or pages with [unclear] markers / low confidence). */
export async function getDocumentReviewPages(
  documentId: string
): Promise<OcrReviewPage[]> {
  const response = await fetch(_backendUrl() + '/api/documents/review-pages', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ documentId }),
  });
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) throw new Error('Failed to load review pages (' + response.status + ')');
  const data = (await response.json()) as { pages?: OcrReviewPage[] };
  return data.pages || [];
}

/** Save a student's corrected transcription for one OCR'd page. The backend
 *  updates the page text and re-embeds the document in the background. */
export async function correctDocumentPage(
  courseId: string,
  documentId: string,
  pageNumber: number,
  correctedText: string
): Promise<{ documentId: string; pageNumber: number; status: string }> {
  const response = await fetch(_backendUrl() + '/api/documents/correct-page', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ courseId, documentId, pageNumber, correctedText }),
  });
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) {
    const text = await response.text();
    let detail = 'Failed to save correction (' + response.status + ')';
    try { detail = (JSON.parse(text) as { error?: string }).error || detail; } catch { /* keep */ }
    throw new Error(detail);
  }
  return response.json();
}

export interface CourseTopic {
  name: string;
  importance?: string;
  difficulty?: string;
  chunk_count?: number;
  source_pages?: number[];
  source_document_ids?: string[];
  related_exercise_ids?: string[];
}

/** Read the stored per-course Topic Map (Learning Agent Core). */
export async function getCourseTopicMap(courseId: string): Promise<CourseTopic[]> {
  const response = await fetch(_backendUrl() + '/api/learning/topic-map', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ courseId }),
  });
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) return [];
  const data = (await response.json()) as { topics?: CourseTopic[] };
  return data.topics || [];
}

/** Trigger a (background) rebuild of the course Topic Map; returns the current
 *  map immediately (callers should re-read shortly after to get the refresh). */
export async function generateCourseTopicMap(courseId: string): Promise<CourseTopic[]> {
  const response = await fetch(_backendUrl() + '/api/learning/topic-map-generate', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ courseId }),
  });
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) return [];
  const data = (await response.json()) as { topics?: CourseTopic[] };
  return data.topics || [];
}

export interface GenerateOpts {
  topic?: string;
  count?: number;
  difficulty?: 'easy' | 'medium' | 'hard' | 'mixed';
  documentIds?: string[];
  [k: string]: unknown;
}

export async function generateStudyTool(
  courseId: string,
  tool: 'flashcards' | 'quiz' | 'summary',
  opts?: GenerateOpts
): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/ai/generate', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ courseId, tool, ...(opts || {}) }),
  });
  return response.json();
}

export interface ExamForgeOpts extends GenerateOpts {
  requestedCount?: number;
}

export async function generateExamForge(
  courseId: string,
  opts?: ExamForgeOpts
): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/ai/examforge', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({
      action: 'generate',
      courseId,
      ...(opts || {}),
    }),
  });
  await _detectAiCapError(response);
  return response.json();
}

export interface CheatsheetSettings {
  preset?: 'exam_night' | 'open_book_exam' | 'formula_reference' | 'balanced' | 'deep_revision' | 'topic_mastery';
  pages?: number;
  columns?: 2 | 3 | 4;
  style?: 'academic' | 'modern' | 'compact' | 'classic';
  fontSize?: 'auto' | 'small' | 'medium' | 'large';
  detailLevel?: 'general' | 'balanced' | 'specific' | 'very_thorough';
  focusMode?: 'whole_course' | 'specific_topic' | 'selected_files' | 'selected_pages';
  language?: 'source' | 'en' | 'de' | 'de_terms_en_explanations';
  output?: 'web' | 'pdf' | 'both';
}

/** Normalized layout config the backend echoes back (drives the renderer). */
export interface CheatsheetResolvedSettings extends CheatsheetSettings {
  columns?: 2 | 3 | 4;
  font?: 'xs' | 'sm' | 'md';
  densityTarget?: string;
  maxTopics?: number;
  perTopicTopK?: number;
  maxEvidence?: number;
}

export interface CheatsheetResult {
  noteId?: string | null;
  title?: string | null;
  text: string;
  topicsCovered?: string[];
  groundedSources?: Array<{ fileName?: string; pageStart?: number | null }>;
  settings?: CheatsheetResolvedSettings;
  grounding?: { total: number; grounded: number; ratio: number | null };
  quality?: {
    evidenceNormalization?: {
      chunks_in?: number;
      chunks_out?: number;
      repaired_chunks?: number;
      dropped_chunks?: number;
      dropped_formula_lines?: number;
    };
    droppedMalformedFormulas?: number;
    droppedUnsupportedFormulas?: number;
    droppedGenericNotes?: number;
    metrics?: Record<string, number | boolean | null>;
  };
  warning?: string;
  citationWarning?: string;
  error?: string;
}

export async function generateCheatsheet(
  courseId: string,
  opts?: { topic?: string; documentIds?: string[]; settings?: CheatsheetSettings }
): Promise<CheatsheetResult> {
  const response = await fetch(_backendUrl() + '/api/ai/cheatsheet', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ courseId, ...(opts || {}) }),
  });
  await _detectAiCapError(response);
  return response.json();
}

export interface DeepLearnResult {
  noteId?: string | null;
  topic: string;
  title?: string | null;
  lesson: string;
  workedExample: string;
  structuredLesson?: {
    title?: string;
    subjectArea?: string;
    contentType?: string;
    lessonMode?: string;
    learningGoal?: string;
    bigPicture?: string;
    simpleExplanation?: string;
    intuition?: string;
    coreExplanation?: string;
    keyDetails?: string[];
    keyFormulas?: Array<{
      formula?: string;
      meaning?: string;
      variables?: string;
      conditions?: string;
      source?: string;
      commonMistake?: string;
      relevance?: string;
      confidence?: string;
    }>;
    methodGuide?: Array<{ method?: string; useWhen?: string; avoidWhen?: string; source?: string }>;
    adaptiveBlocks?: Array<{ type?: string; title?: string; body?: string; items?: string[]; source?: string }>;
    stepByStepMethod?: string[];
    workedExamples?: Array<{
      title?: string;
      problem?: string;
      solutionSteps?: string[];
      finalAnswer?: string;
      sourceOrBasis?: string;
      difficulty?: string;
      isMiniExample?: boolean;
    }>;
    workedExample?: {
      problem?: string;
      solutionSteps?: string[];
      finalAnswer?: string;
      sourceOrBasis?: string;
      isMiniExample?: boolean;
    };
    commonMistakes?: string[];
    examTraps?: string[];
    selfCheck?: Array<{ question?: string; hint?: string; answer?: string; explanation?: string; stepByStep?: string[] }>;
    practiceTasks?: Array<{ prompt?: string; goal?: string; source?: string }>;
    nextStep?: string;
    nextTopics?: string[];
    groundedSources?: string[];
    citationWarning?: string;
  } | null;
  check?: { question: string; answer: string; explanation: string } | null;
  groundedSources?: Array<{ fileName?: string; pageStart?: number | null; documentId?: string | null; label?: string }>;
  citationWarning?: string;
  evidenceSummary?: Record<string, number>;
  warning?: string;
  error?: string;
}

export async function generateDeepLearn(
  courseId: string,
  topic: string,
  opts?: { documentIds?: string[]; lessonMode?: string; lessonLanguage?: string }
): Promise<DeepLearnResult> {
  const response = await fetch(_backendUrl() + '/api/ai/deep-learn', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({ courseId, topic, ...(opts || {}) }),
  });
  await _detectAiCapError(response);
  return response.json();
}

export interface SavedNote {
  id: string;
  title: string;
  type: string;
  preview?: string;
  content_markdown?: string;
  course_id?: string;
  document_id?: string | null;
  note_sources?: Array<{ fileName?: string; pageStart?: number | null; file_name?: string }>;
  created_at?: string;
  updated_at?: string;
}

/** List the user's saved notes for a course (all types). */
export async function listCourseNotes(courseId: string): Promise<SavedNote[]> {
  const response = await fetch(
    _backendUrl() + '/api/notes?courseId=' + encodeURIComponent(courseId),
    { headers: _authJsonHeaders() }
  );
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) return [];
  const data = (await response.json()) as { notes?: SavedNote[] };
  return data.notes || [];
}

/** Fetch one saved note (with full content_markdown). */
export async function getNoteById(
  id: string
): Promise<{ id: string; title: string; content_markdown: string; note_sources?: unknown[] } | null> {
  const response = await fetch(
    _backendUrl() + '/api/notes?id=' + encodeURIComponent(id),
    { headers: _authJsonHeaders() }
  );
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) return null;
  const data = (await response.json()) as {
    note?: { id: string; title: string; content_markdown: string; note_sources?: unknown[] } | null;
  };
  return data.note || null;
}

/** Delete a saved note by id. */
export async function deleteNote(id: string): Promise<boolean> {
  const response = await fetch(_backendUrl() + '/api/notes?id=' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: _authJsonHeaders(),
  });
  return response.ok;
}

export async function gradeExamForgeAnswer(
  examSessionId: string,
  examQuestionId: string,
  userAnswer: string
): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/ai/examforge', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({
      action: 'grade',
      examSessionId,
      examQuestionId,
      userAnswer,
    }),
  });
  return response.json();
}

export async function submitRagFeedback(
  courseId: string,
  question: string,
  rating: string,
  answerCacheId?: string | null
): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/ai/feedback', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify({
      courseId,
      question,
      rating,
      answerCacheId: answerCacheId || null,
    }),
  });
  return response.json();
}

export async function courseHasRagDocs(courseId: string): Promise<boolean> {
  if (!courseId) return false;
  try {
    const docs = await listCourseDocuments(courseId);
    return docs.some((d) => d.processing_status === 'ready');
  } catch {
    return false;
  }
}
