import { escapeHtml } from '../../utils/escape-html.js';
import { openStudyToolWorkspace, type StudyWorkspaceKind } from './workspace-library.js';

export interface StudyToolConfigurationMarker {
  actionId: string;
  intent: 'examforge' | 'flashcards' | 'deep_learn';
  courseId: string;
  parameters: Record<string, unknown>;
  documentIds: string[];
  sourceLabel: string;
  sourceDocumentName?: string;
}

interface SourceItem {
  id: string;
  courseId: string;
  documents: Array<{ name: string; id?: string }>;
}

export function resolveStudyToolSource(
  courseId: string,
  selectedSourceIds: string[],
  sourceItems: SourceItem[],
  openName: string
): { documentIds: string[]; label: string; documentName?: string } {
  const selected = sourceItems.filter((item) => selectedSourceIds.includes(item.id) && item.courseId === courseId);
  const documents = selected.flatMap((item) => item.documents || []);
  const open = openName ? documents.find((doc) => doc.name.toLowerCase() === openName.toLowerCase()) : undefined;
  if (open) return { documentIds: open.id ? [open.id] : [], label: `Current PDF: ${open.name}`, documentName: open.name };
  if (openName) return { documentIds: [], label: `Current PDF: ${openName}`, documentName: openName };
  const ids = documents.map((doc) => doc.id).filter((id): id is string => !!id);
  if (documents.length) return { documentIds: ids, label: documents.length === 1 ? documents[0]!.name : `${documents.length} selected files` };
  return { documentIds: [], label: 'Choose a course document' };
}

export function renderStudyToolConfiguration(host: HTMLElement, marker: StudyToolConfigurationMarker): void {
  const labels: Record<StudyToolConfigurationMarker['intent'], string> = { examforge: 'ExamForge', flashcards: 'Flashcards', deep_learn: 'Deep Learn' };
  const defaults: Record<StudyToolConfigurationMarker['intent'], Record<string, unknown>> = {
    examforge: { count: 10, difficulty: 'medium', questionTypes: ['mcq', 'true_false', 'short_answer'], language: 'auto', mode: 'exam', topic: '' },
    flashcards: { count: 10, difficulty: 'medium', topic: '' },
    deep_learn: { lessonMode: 'exam', lessonLanguage: 'auto', topic: '' }
  };
  const values = { ...defaults[marker.intent], ...marker.parameters };
  const rows = Object.entries(values).filter(([, value]) => value !== '' && value != null).map(([key, value]) =>
    `<div class="ncb-tool-config-row"><span>${escapeHtml(key.replace(/([A-Z])/g, ' $1'))}</span><strong>${escapeHtml(Array.isArray(value) ? value.join(', ') : String(value))}</strong></div>`
  ).join('');
  host.innerHTML = `<section class="ncb-tool-config" data-study-tool-configuration="${marker.intent}">
    <header><span class="ncb-tool-config-badge">${escapeHtml(labels[marker.intent])}</span><h3>${escapeHtml(labels[marker.intent])} setup</h3></header>
    <div class="ncb-tool-config-source"><span>Source</span><strong>${escapeHtml(marker.sourceLabel)}</strong></div>
    <div class="ncb-tool-config-values">${rows}</div>
    <button type="button" class="ncb-tool-config-open">Configure and create with ${escapeHtml(labels[marker.intent])}</button>
  </section>`;
  host.querySelector<HTMLButtonElement>('.ncb-tool-config-open')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const opened = await openStudyToolWorkspace(marker.intent as StudyWorkspaceKind, marker.courseId, values, marker.documentIds, marker.sourceDocumentName || '');
    if (!opened) {
      button.disabled = false;
      button.textContent = `${labels[marker.intent]} could not be opened — retry`;
    }
  });
}
