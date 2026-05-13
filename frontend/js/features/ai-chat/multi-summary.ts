import { sendAiRequest } from '../../services/ai-service.js';
import { extractMultiplePdfs } from '../pdf-viewer/pdf-text-extraction.js';

interface AiContentBlock { text?: string }
interface AiResponse {
  content?: AiContentBlock[];
  error?: { message?: string };
}

interface CourseLite {
  name: string;
  short?: string;
}

export async function runMultiSummary(fnames: string[], course: CourseLite): Promise<void> {
  if (window._requirePro && !window._requirePro('Multi-PDF summaries are a Pro feature.')) return;

  const modal = document.getElementById('multiSumModal');
  const body = document.getElementById('msmBody');
  const title = document.getElementById('msmTitle');
  if (!modal || !body || !title) return;

  window.msmCurrentText = '';
  window.msmCurrentTitle = '';
  const saveBtn = document.getElementById('msmSaveBtn');
  if (saveBtn) saveBtn.style.display = 'none';

  const shortNames = fnames.map((n) => n.replace(/\.pdf$/i, '').slice(0, 30));
  window.msmCurrentTitle = (course.short || course.name) + ' — Combined: ' + shortNames.join(', ');
  title.textContent = '✨ Combined Summary (' + fnames.length + ' files)';

  const tagsHtml =
    '<div class="msm-files-list">' +
    fnames.map((n) => '<span class="msm-file-tag">📄 ' + n + '</span>').join('') +
    '</div>';

  body.innerHTML =
    tagsHtml +
    '<div class="msm-loading"><div class="msm-dots"><span></span><span></span><span></span></div><p>Extracting text from ' +
    fnames.length +
    ' files…</p></div>';
  modal.classList.add('show');

  try {
    const parts = await extractMultiplePdfs(fnames, 20);
    const combined = parts.join('\n\n').slice(0, 20000);
    body.innerHTML =
      tagsHtml +
      '<div class="msm-loading"><div class="msm-dots"><span></span><span></span><span></span></div><p>Asking AI to summarise all files together…</p></div>';

    const data = (await sendAiRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system:
        'You are Minallo, an AI tutor for TU Braunschweig engineering students. The student has selected multiple related files (e.g. different parts of the same lecture script) and wants a single unified summary. Combine and synthesise all content into one coherent study guide. Use the same language as the documents (German or English).',
      messages: [
        {
          role: 'user',
          content:
            'These are ' +
            fnames.length +
            ' related course files from ' +
            course.name +
            ':\n\n' +
            combined +
            '\n\n---\nCreate a single unified study summary covering all files:\n\n## 📝 Summary\nUnified summary across all files (8-12 sentences).\n\n## 🔑 Key Concepts\nAll important concepts from all files combined.\n\n## 🔢 Formulas & Definitions\nAll formulas and definitions from all files.\n\n## 📂 File Breakdown\nBrief note on what each file covers.\n\n## ❓ Quiz Questions\n5 questions that span across the combined content.',
        },
      ],
    })) as AiResponse;

    if (data.error) {
      body.innerHTML =
        tagsHtml +
        '<p style="color:#ff6b35">❌ ' +
        (data.error.message || 'API error') +
        '</p>';
      return;
    }
    window.msmCurrentText = data.content
      ? data.content.map((b) => b.text || '').join('')
      : '';
    body.innerHTML =
      tagsHtml +
      (window.lnRenderMarkdown
        ? window.lnRenderMarkdown(window.msmCurrentText)
        : window.msmCurrentText);
    if (saveBtn) saveBtn.style.display = '';
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    body.innerHTML = tagsHtml + '<p style="color:#ff6b35">❌ ' + message + '</p>';
  }
}
