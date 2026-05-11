export async function sendAiRequest(payload) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var response = await fetch(BACKEND_URL + '/api/ai', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify(payload)
  });
  return response.json();
}

// RAG ask — uses uploaded course documents as context
export async function sendRagRequest(courseId, question, mode, documentId, activeFileName, openFileContext) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var payload = { courseId: courseId, question: question, mode: mode || 'strict' };
  if (documentId) payload.documentId = documentId;
  if (activeFileName) payload.activeFileName = activeFileName;
  if (openFileContext) payload.openFileContext = openFileContext;
  var response = await fetch(BACKEND_URL + '/api/ai/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

// Upload a PDF for RAG indexing
export async function uploadCourseDocument(file, courseId, sourceType) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = async function (e) {
      var base64 = e.target.result.split(',')[1];
      try {
        var response = await fetch(BACKEND_URL + '/api/documents/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token
          },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || 'application/pdf',
            fileBase64: base64,
            courseId: courseId,
            sourceType: sourceType || 'lecture'
          })
        });
        var text = await response.text();
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          reject(new Error('Upload failed (' + response.status + ')'));
          return;
        }
        if (!response.ok)
          reject(
            new Error(
              (data.error && data.error.message) || 'Upload failed (' + response.status + ')'
            )
          );
        else resolve(data);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// List RAG-indexed documents for a course
export async function listCourseDocuments(courseId) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var response = await fetch(
    BACKEND_URL + '/api/documents/list?courseId=' + encodeURIComponent(courseId),
    {
      headers: { Authorization: 'Bearer ' + token }
    }
  );
  var data = await response.json();
  return data.documents || [];
}

// Index a file already in course-uploads storage (server-side copy — no browser upload)
// meta (optional): { professorName, lectureNumber, exerciseNumber, language, isOfficialProfMaterial }
export async function indexExistingDocument(
  courseId,
  storageName,
  fileName,
  sourceType,
  folder,
  meta
) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, 12000);
  var payload = {
    courseId: courseId,
    storageName: storageName,
    fileName: fileName,
    sourceType: sourceType || 'lecture',
    folder: folder || null
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
    var response = await fetch(BACKEND_URL + '/api/documents/index-existing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.status === 401) throw new Error('SESSION_EXPIRED');
    var text = await response.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Index failed (' + response.status + ')');
    }
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// Delete a RAG-indexed document and all its chunks
export async function deleteRagDocument(documentId) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var response = await fetch(BACKEND_URL + '/api/documents/delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({ documentId: documentId })
  });
  return response.json();
}

// Generate study tools (flashcards / quiz / summary) from course documents
// opts: { topic?, count?, difficulty? }
export async function generateStudyTool(courseId, tool, opts) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var response = await fetch(BACKEND_URL + '/api/ai/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ courseId: courseId, tool: tool }, opts || {}))
  });
  return response.json();
}

// Submit feedback on a RAG answer
export async function submitRagFeedback(courseId, question, rating, answerCacheId) {
  var BACKEND_URL = window.BACKEND_URL || '';
  var token = window._sbToken || '';
  var response = await fetch(BACKEND_URL + '/api/ai/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({
      courseId: courseId,
      question: question,
      rating: rating,
      answerCacheId: answerCacheId || null
    })
  });
  return response.json();
}

// Check if a course has any ready RAG documents
export async function courseHasRagDocs(courseId) {
  if (!courseId) return false;
  try {
    var docs = await listCourseDocuments(courseId);
    return docs.some(function (d) {
      return d.processing_status === 'ready';
    });
  } catch (e) {
    return false;
  }
}
