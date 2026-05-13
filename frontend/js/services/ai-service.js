// All AI endpoints flow through Netlify proxies (which forward to python-ai).
// See docs/python-ai-endpoints.md for shapes.
function _backendUrl() {
    return window.BACKEND_URL || '';
}
function _token() {
    return window._sbToken || '';
}
function _authJsonHeaders() {
    return {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + _token(),
    };
}
export async function sendAiRequest(payload) {
    const response = await fetch(_backendUrl() + '/api/ai', {
        method: 'POST',
        headers: _authJsonHeaders(),
        body: JSON.stringify(payload),
    });
    return response.json();
}
export async function sendRagRequest(courseId, question, mode, documentId, activeFileName, openFileContext) {
    const payload = {
        courseId,
        question,
        mode: mode || 'strict',
    };
    if (documentId)
        payload.documentId = documentId;
    if (activeFileName)
        payload.activeFileName = activeFileName;
    if (openFileContext)
        payload.openFileContext = openFileContext;
    const response = await fetch(_backendUrl() + '/api/ai/ask', {
        method: 'POST',
        headers: _authJsonHeaders(),
        body: JSON.stringify(payload),
    });
    if (!response.ok)
        throw new Error('HTTP ' + response.status);
    return response.json();
}
export function uploadCourseDocument(file, courseId, sourceType) {
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
                let data;
                try {
                    data = JSON.parse(text);
                }
                catch {
                    reject(new Error('Upload failed (' + response.status + ')'));
                    return;
                }
                if (!response.ok) {
                    reject(new Error((data.error && data.error.message) || 'Upload failed (' + response.status + ')'));
                }
                else {
                    resolve(data);
                }
            }
            catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        };
        reader.onerror = () => reject(new Error('FileReader error'));
        reader.readAsDataURL(file);
    });
}
export async function listCourseDocuments(courseId) {
    const response = await fetch(_backendUrl() + '/api/documents/list?courseId=' + encodeURIComponent(courseId), { headers: { Authorization: 'Bearer ' + _token() } });
    const data = (await response.json());
    return data.documents || [];
}
export async function indexExistingDocument(courseId, storageName, fileName, sourceType, folder, meta) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const payload = {
        courseId,
        storageName,
        fileName,
        sourceType: sourceType || 'lecture',
        folder: folder || null,
    };
    if (meta) {
        if (meta.professorName)
            payload.professorName = meta.professorName;
        if (meta.lectureNumber != null)
            payload.lectureNumber = Number(meta.lectureNumber);
        if (meta.exerciseNumber != null)
            payload.exerciseNumber = Number(meta.exerciseNumber);
        if (meta.language)
            payload.language = meta.language;
        if (meta.isOfficialProfMaterial != null)
            payload.isOfficialProfMaterial = !!meta.isOfficialProfMaterial;
        if (meta.forceReindex)
            payload.forceReindex = true;
    }
    try {
        const response = await fetch(_backendUrl() + '/api/documents/index-existing', {
            method: 'POST',
            headers: _authJsonHeaders(),
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (response.status === 401)
            throw new Error('SESSION_EXPIRED');
        const text = await response.text();
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error('Index failed (' + response.status + ')');
        }
    }
    catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}
export async function deleteRagDocument(documentId) {
    const response = await fetch(_backendUrl() + '/api/documents/delete', {
        method: 'POST',
        headers: _authJsonHeaders(),
        body: JSON.stringify({ documentId }),
    });
    return response.json();
}
export async function generateStudyTool(courseId, tool, opts) {
    const response = await fetch(_backendUrl() + '/api/ai/generate', {
        method: 'POST',
        headers: _authJsonHeaders(),
        body: JSON.stringify({ courseId, tool, ...(opts || {}) }),
    });
    return response.json();
}
export async function submitRagFeedback(courseId, question, rating, answerCacheId) {
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
export async function courseHasRagDocs(courseId) {
    if (!courseId)
        return false;
    try {
        const docs = await listCourseDocuments(courseId);
        return docs.some((d) => d.processing_status === 'ready');
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=ai-service.js.map