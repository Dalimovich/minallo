// All AI endpoints flow through Netlify proxies (which forward to python-ai).
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

export async function sendAiRequest(payload: unknown): Promise<unknown> {
  const response = await fetch(_backendUrl() + '/api/ai', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify(payload),
  });
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
  documentId?: string | null,
  activeFileName?: string | null,
  openFileContext?: unknown
): Promise<RagAskResponse> {
  const payload: Record<string, unknown> = {
    courseId,
    question,
    mode: mode || 'strict',
  };
  if (documentId) payload.documentId = documentId;
  if (activeFileName) payload.activeFileName = activeFileName;
  if (openFileContext) payload.openFileContext = openFileContext;

  const response = await fetch(_backendUrl() + '/api/ai/ask', {
    method: 'POST',
    headers: _authJsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
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
  file_type?: string;
  source_type?: string;
  processing_status?: string;
  processing_error?: string | null;
  page_count?: number;
  created_at?: string;
  updated_at?: string;
}

export async function listCourseDocuments(courseId: string): Promise<CourseDocument[]> {
  const response = await fetch(
    _backendUrl() + '/api/documents/list?courseId=' + encodeURIComponent(courseId),
    { headers: { Authorization: 'Bearer ' + _token() } }
  );
  const data = (await response.json()) as { documents?: CourseDocument[] };
  return data.documents || [];
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
