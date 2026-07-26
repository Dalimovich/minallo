import { escapeHtml } from '../../utils/escape-html.js';
import { listCourseDocuments, type CourseDocument } from '../../services/ai-service.js';
import type { ActivePdfContext } from '../pdf-viewer/active-pdf-context.js';
import { openStudyToolWorkspace, type StudyWorkspaceKind } from './workspace-library.js';

export type InlineStudyToolKind = 'examforge' | 'flashcards' | 'deep_learn';
export type StudyToolConfigurationStatus = 'collecting_parameters' | 'awaiting_confirmation' | 'generating' | 'failed' | 'completed';
export type StudyToolSourceScope = 'current_document' | 'current_page' | 'page_range' | 'selected_documents' | 'whole_course';
export type DocumentGenerationReadiness = 'ready' | 'indexing' | 'failed' | 'unsupported';

export interface CourseDocumentOption {
  documentId: string;
  courseId: string;
  fileName: string;
  readiness: DocumentGenerationReadiness;
  pageCount?: number;
}

export interface StudyToolSource {
  scope: StudyToolSourceScope;
  courseId: string;
  documentIds: string[];
  activeDocumentId?: string;
  activeFileName?: string;
  page?: number;
  pageRange?: { start: number; end: number };
  displayLabel: string;
}

export interface StudyArtifactMarker {
  artifactType: InlineStudyToolKind;
  artifactId: string;
  persistedResourceId: string;
  rendererVersion: 1;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface StudyToolConfigurationMarker {
  actionId: string;
  intent: InlineStudyToolKind;
  courseId: string;
  parameters: Record<string, unknown>;
  documentIds: string[];
  sourceLabel: string;
  sourceDocumentName?: string;
  requestedSourceName?: string;
  source?: StudyToolSource;
  activePdf?: Pick<ActivePdfContext, 'courseId' | 'documentId' | 'fileName' | 'visiblePage' | 'pageCount'>;
  availableDocuments?: CourseDocumentOption[];
  documentsHydrated?: boolean;
  sourcePickerOpen?: boolean;
  status?: StudyToolConfigurationStatus;
  validationMessage?: string;
  revision?: number;
  artifact?: StudyArtifactMarker;
}

interface SourceItem { id: string; courseId: string; documents: Array<{ name: string; id?: string }> }
interface FieldOption { value: string; label: string }
interface FieldDefinition { key: string; label: string; type: 'select' | 'segmented' | 'multi' | 'text' | 'checkbox'; options?: FieldOption[]; placeholder?: string }
interface ToolDefinition {
  title: string;
  actionLabel: string;
  defaults: Record<string, unknown>;
  fields: FieldDefinition[];
}

const DEFINITIONS: Record<InlineStudyToolKind, ToolDefinition> = {
  examforge: {
    title: 'ExamForge', actionLabel: 'Create exam',
    defaults: { count: 10, difficulty: 'medium', questionTypes: ['mcq', 'true_false', 'short_answer'], language: 'auto', mode: 'exam', topic: '' },
    fields: [
      { key: 'count', label: 'Number of questions', type: 'select', options: [6, 8, 10, 12].map(String).map(value => ({ value, label: value })) },
      { key: 'difficulty', label: 'Difficulty', type: 'segmented', options: ['easy', 'medium', 'hard', 'mixed'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) },
      { key: 'questionTypes', label: 'Question types', type: 'multi', options: [{ value: 'mcq', label: 'Multiple choice' }, { value: 'true_false', label: 'True / False' }, { value: 'short_answer', label: 'Short answer' }] },
      { key: 'language', label: 'Language', type: 'select', options: [{ value: 'auto', label: 'Same as course' }, { value: 'de', label: 'German' }, { value: 'en', label: 'English' }] },
      { key: 'mode', label: 'Mode', type: 'segmented', options: [{ value: 'exam', label: 'Exam' }, { value: 'practice', label: 'Practice' }] },
      { key: 'topic', label: 'Topic', type: 'text', placeholder: 'All topics' }
    ]
  },
  flashcards: {
    title: 'Flashcards', actionLabel: 'Create flashcards',
    defaults: { count: 10, difficulty: 'medium', language: 'auto', topic: '', avoidSeen: true, deckName: '' },
    fields: [
      { key: 'count', label: 'Card count', type: 'select', options: [5, 10, 15, 20].map(String).map(value => ({ value, label: value })) },
      { key: 'difficulty', label: 'Difficulty', type: 'segmented', options: ['easy', 'medium', 'hard', 'mixed'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) },
      { key: 'language', label: 'Language', type: 'select', options: [{ value: 'auto', label: 'Same as course' }, { value: 'de', label: 'German' }, { value: 'en', label: 'English' }] },
      { key: 'topic', label: 'Topic', type: 'text', placeholder: 'All topics' },
      { key: 'deckName', label: 'Deck name', type: 'text', placeholder: 'Course flashcards' },
      { key: 'avoidSeen', label: 'Avoid seen cards', type: 'checkbox' }
    ]
  },
  deep_learn: {
    title: 'Deep Learn', actionLabel: 'Create lesson',
    defaults: { lessonMode: 'professor', lessonLanguage: 'auto', topic: '' },
    fields: [
      { key: 'topic', label: 'Topic', type: 'text', placeholder: 'What should the lesson cover?' },
      { key: 'lessonMode', label: 'Lesson mode', type: 'segmented', options: [{ value: 'professor', label: 'Professor' }, { value: 'simple', label: 'Simple' }, { value: 'exam', label: 'Exam prep' }] },
      { key: 'lessonLanguage', label: 'Language', type: 'select', options: [{ value: 'auto', label: 'Same as course' }, { value: 'de', label: 'German' }, { value: 'en', label: 'English' }] }
    ]
  }
};

const pendingKey = (id: string) => `minallo_pending_study_action_${id}`;
function persist(marker: StudyToolConfigurationMarker): void {
  marker.revision = (marker.revision || 0) + 1;
  try { localStorage.setItem(pendingKey(marker.actionId), JSON.stringify(marker)); } catch { /* optional cache */ }
}
function restore(marker: StudyToolConfigurationMarker): StudyToolConfigurationMarker {
  try {
    const saved = JSON.parse(localStorage.getItem(pendingKey(marker.actionId)) || 'null') as StudyToolConfigurationMarker | null;
    return saved?.actionId === marker.actionId ? Object.assign(marker, saved) : marker;
  } catch { return marker; }
}

function readiness(doc: CourseDocument): DocumentGenerationReadiness {
  const status = String(doc.processing_status || '').toLowerCase();
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  if (doc.file_type && !/pdf/i.test(doc.file_type)) return 'unsupported';
  return 'indexing';
}

function option(courseId: string, doc: CourseDocument): CourseDocumentOption {
  return { documentId: doc.id, courseId, fileName: doc.file_name || doc.fileName || 'Untitled document', readiness: readiness(doc), pageCount: doc.page_count };
}

export function resolveStudyToolSource(courseId: string, selectedSourceIds: string[], sourceItems: SourceItem[], activePdf: ActivePdfContext | null): { source: StudyToolSource; documentIds: string[]; label: string; documentName?: string; availableDocuments: CourseDocumentOption[]; activePdf?: StudyToolConfigurationMarker['activePdf'] } {
  const all = sourceItems.filter(item => item.courseId === courseId).flatMap(item => item.documents || []);
  const availableDocuments = all.filter((doc): doc is { id: string; name: string } => !!doc.id).map(doc => ({ documentId: doc.id, courseId, fileName: doc.name, readiness: 'ready' as const }));
  const selected = sourceItems.filter(item => selectedSourceIds.includes(item.id) && item.courseId === courseId).flatMap(item => item.documents || []);
  const ids = selected.map(doc => doc.id).filter((id): id is string => !!id);
  if (selected.length) {
    const label = selected.length === 1 ? selected[0]!.name : `${selected.length} selected files`;
    return { source: { scope: 'selected_documents', courseId, documentIds: ids, displayLabel: label }, documentIds: ids, label, availableDocuments };
  }
  if (activePdf?.courseId === courseId && activePdf.documentId) {
    const label = `Open document — ${activePdf.fileName}`;
    return { source: { scope: 'current_document', courseId, documentIds: [activePdf.documentId], activeDocumentId: activePdf.documentId, activeFileName: activePdf.fileName, displayLabel: label }, documentIds: [activePdf.documentId], label, documentName: activePdf.fileName, availableDocuments, activePdf };
  }
  return { source: { scope: 'selected_documents', courseId, documentIds: [], displayLabel: 'No source selected' }, documentIds: [], label: 'No source selected', availableDocuments };
}

function control(field: FieldDefinition, values: Record<string, unknown>): string {
  const value = values[field.key];
  if (field.type === 'text') return `<label class="ncb-tool-field"><span>${escapeHtml(field.label)}</span><input data-field="${field.key}" type="text" value="${escapeHtml(String(value || ''))}" placeholder="${escapeHtml(field.placeholder || '')}"></label>`;
  if (field.type === 'checkbox') return `<label class="ncb-tool-check"><input data-field="${field.key}" type="checkbox"${value ? ' checked' : ''}><span>${escapeHtml(field.label)}</span></label>`;
  if (field.type === 'select') return `<label class="ncb-tool-field"><span>${escapeHtml(field.label)}</span><select data-field="${field.key}">${(field.options || []).map(o => `<option value="${escapeHtml(o.value)}"${String(value) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></label>`;
  const selected = Array.isArray(value) ? value.map(String) : [String(value)];
  return `<fieldset class="ncb-tool-choice"><legend>${escapeHtml(field.label)}</legend>${(field.options || []).map(o => `<label><input data-field="${field.key}" type="${field.type === 'multi' ? 'checkbox' : 'radio'}" name="${field.key}" value="${escapeHtml(o.value)}"${selected.includes(o.value) ? ' checked' : ''}><span>${escapeHtml(o.label)}</span></label>`).join('')}</fieldset>`;
}

function validate(marker: StudyToolConfigurationMarker): string {
  if (!marker.source?.courseId) return 'Choose a course first.';
  if (!marker.documentsHydrated) return 'Checking source readiness. Please wait a moment.';
  if (marker.source.scope !== 'whole_course' && !marker.source.documentIds.length) return 'Choose at least one indexed source document.';
  const selected = new Set(marker.source.documentIds);
  const selectedOptions = (marker.availableDocuments || []).filter(doc => selected.has(doc.documentId));
  if (marker.source.scope !== 'whole_course' && selectedOptions.length !== selected.size) return 'The selected document is not available in this course.';
  if (selectedOptions.some(doc => doc.readiness !== 'ready')) return 'Every selected document must finish indexing before generation.';
  if (marker.intent === 'examforge' && !(marker.parameters.questionTypes as unknown[] || []).length) return 'Choose at least one question type.';
  if (marker.intent === 'deep_learn' && !String(marker.parameters.topic || '').trim()) return 'Enter a topic for the lesson.';
  return '';
}

async function saveFlashcardDeck(courseId: string, name: string, cards: unknown[]): Promise<string> {
  const db = (window as unknown as { _ssDb?: { supaUrl?: () => string; supaHeaders?: () => Record<string, string> } })._ssDb;
  const url = db?.supaUrl?.();
  if (!url) throw new Error('Flashcard persistence is unavailable.');
  const response = await fetch(`${url}/rest/v1/flashcard_decks`, { method: 'POST', headers: { ...(db?.supaHeaders?.() || {}), Prefer: 'return=representation', 'Content-Type': 'application/json' }, body: JSON.stringify({ course_id: courseId, name, cards }) });
  const rows = await response.json() as Array<{ id?: string }>;
  if (!response.ok || !rows[0]?.id) throw new Error('The deck could not be saved.');
  return rows[0].id;
}

async function generate(marker: StudyToolConfigurationMarker): Promise<StudyArtifactMarker> {
  const svc = await import('../../services/ai-service.js');
  const p = marker.parameters;
  const documentIds = marker.source?.documentIds || marker.documentIds;
  if (marker.intent === 'examforge') {
    const result = await svc.generateExamForge(marker.courseId, { documentIds, count: Number(p.count), requestedCount: Number(p.count), difficulty: p.difficulty as 'easy' | 'medium' | 'hard' | 'mixed', questionTypes: p.questionTypes, language: String(p.language || 'auto'), topic: String(p.topic || ''), sourceScope: marker.source?.scope });
    const raw = result as { sessionId?: string; id?: string; questions?: unknown[]; error?: string };
    const id = raw.sessionId || raw.id;
    if (!id) throw new Error(raw.error || 'The exam was not persisted.');
    return { artifactType: 'examforge', artifactId: id, persistedResourceId: id, rendererVersion: 1, title: 'ExamForge created', summary: `${raw.questions?.length || Number(p.count)} questions · ${String(p.difficulty)} · ${String(p.mode)} mode`, payload: raw as Record<string, unknown> };
  }
  if (marker.intent === 'flashcards') {
    const raw = await svc.generateStudyTool(marker.courseId, 'flashcards', { documentIds, count: Number(p.count), difficulty: p.difficulty as 'easy' | 'medium' | 'hard' | 'mixed', topic: String(p.topic || ''), seenItems: p.avoidSeen ? [] : undefined, sourceScope: marker.source?.scope }) as { items?: Array<{ front?: string; back?: string; source?: string }>; error?: string };
    const cards = (raw.items || []).filter(card => card.front?.trim() && card.back?.trim());
    if (!cards.length) throw new Error(raw.error || 'No flashcards were generated.');
    const name = String(p.deckName || '').trim() || 'Course flashcards';
    const id = await saveFlashcardDeck(marker.courseId, name, cards);
    return { artifactType: 'flashcards', artifactId: id, persistedResourceId: id, rendererVersion: 1, title: 'Flashcards created', summary: `${cards.length} cards · ${String(p.difficulty)}`, payload: { id, name, cards, sourceScope: marker.source?.scope, sourceDocumentIds: documentIds, sourceDisplayNames: (marker.availableDocuments || []).filter(doc => documentIds.includes(doc.documentId)).map(doc => doc.fileName) } };
  }
  const raw = await svc.generateDeepLearn(marker.courseId, String(p.topic), { documentIds, lessonMode: String(p.lessonMode), lessonLanguage: String(p.lessonLanguage) });
  if (!raw.noteId) throw new Error(raw.error || 'The lesson was not persisted.');
  return { artifactType: 'deep_learn', artifactId: raw.noteId, persistedResourceId: raw.noteId, rendererVersion: 1, title: 'Deep Learn lesson ready', summary: `${raw.title || raw.topic} · ${String(p.lessonMode)} style`, payload: raw as unknown as Record<string, unknown> };
}

function renderArtifact(host: HTMLElement, marker: StudyToolConfigurationMarker): void {
  const artifact = marker.artifact;
  if (!artifact?.persistedResourceId) return;
  host.innerHTML = `<section class="ncb-study-artifact" data-study-artifact="${artifact.artifactType}" data-resource-id="${escapeHtml(artifact.persistedResourceId)}"><header><span class="ncb-tool-config-badge">${escapeHtml(DEFINITIONS[artifact.artifactType].title)}</span><h3>${escapeHtml(artifact.title)}</h3></header><p>${escapeHtml(artifact.summary)}</p><p class="ncb-study-artifact-source">Source: ${escapeHtml(marker.sourceLabel)}</p><div class="ncb-study-artifact-preview"></div><div class="ncb-study-artifact-actions"><button type="button" data-open-artifact>${artifact.artifactType === 'examforge' ? 'Start exam' : artifact.artifactType === 'flashcards' ? 'Open full deck' : 'Start lesson'}</button><button type="button" data-adjust>Adjust</button></div></section>`;
  const flashcardPlayer = (window as unknown as { mountFlashcardDeckPlayer?: (target: HTMLElement | null, deck: unknown, options: Record<string, unknown>) => void }).mountFlashcardDeckPlayer;
  if (artifact.artifactType === 'flashcards' && typeof flashcardPlayer === 'function') flashcardPlayer(host.querySelector<HTMLElement>('.ncb-study-artifact-preview'), artifact.payload, {});
  host.querySelector<HTMLButtonElement>('[data-open-artifact]')?.addEventListener('click', () => {
    if (!artifact.persistedResourceId) return;
    void openStudyToolWorkspace(
      artifact.artifactType as StudyWorkspaceKind,
      marker.courseId,
      { ...marker.parameters, persistedResourceId: artifact.persistedResourceId },
      marker.documentIds,
      marker.sourceDocumentName || ''
    );
  });
  host.querySelector<HTMLButtonElement>('[data-adjust]')?.addEventListener('click', () => { marker.artifact = undefined; marker.status = 'awaiting_confirmation'; persist(marker); renderStudyToolConfiguration(host, marker); });
}

export function renderStudyToolConfiguration(host: HTMLElement, input: StudyToolConfigurationMarker): void {
  const marker = restore(input);
  if (marker.artifact?.persistedResourceId) { renderArtifact(host, marker); return; }
  const definition = DEFINITIONS[marker.intent];
  marker.parameters = { ...definition.defaults, ...marker.parameters };
  marker.status ||= 'awaiting_confirmation';
  const docs = marker.availableDocuments || [];
  marker.source ||= { scope: marker.documentIds.length ? 'selected_documents' : 'selected_documents', courseId: marker.courseId, documentIds: marker.documentIds.slice(), displayLabel: marker.sourceLabel || 'No source selected' };
  marker.documentIds = marker.source.documentIds.slice();
  const scope = marker.source.scope;
  const readyDocs = docs.filter(doc => doc.readiness === 'ready');
  const selected = new Set(marker.source.documentIds);
  const current = marker.activePdf;
  const currentStatus = current ? (docs.find(doc => doc.documentId === current.documentId)?.readiness || (marker.documentsHydrated ? 'indexing' : 'Checking readiness…')) : null;
  const fileRows = docs.map(doc => `<label class="ncb-source-file${doc.readiness !== 'ready' ? ' is-disabled' : ''}"><input type="checkbox" data-source-document value="${escapeHtml(doc.documentId)}"${selected.has(doc.documentId) ? ' checked' : ''}${doc.readiness !== 'ready' ? ' disabled' : ''}><span><strong>${escapeHtml(doc.fileName)}</strong><small>${escapeHtml(doc.readiness === 'ready' ? `${doc.pageCount || ''}${doc.pageCount ? ' pages · ' : ''}Ready` : doc.readiness === 'indexing' ? 'Indexing' : doc.readiness === 'failed' ? 'Processing failed' : 'Unsupported')}</small></span></label>`).join('');
  const sourceSummary = scope === 'current_document' && current ? current.fileName : scope === 'whole_course' ? `Whole course · ${readyDocs.length} ready files` : selected.size ? `${selected.size} selected ${selected.size === 1 ? 'file' : 'files'}` : 'Choose course files';
  host.innerHTML = `<section class="ncb-tool-config" data-study-tool-configuration="${marker.intent}" data-action-id="${escapeHtml(marker.actionId)}"><header><span class="ncb-tool-config-badge">${escapeHtml(definition.title)}</span><h3>${escapeHtml(definition.title)} setup</h3></header>
    <div class="ncb-source-selector"><span class="ncb-source-label">Source</span><button type="button" class="ncb-source-trigger" aria-expanded="${marker.sourcePickerOpen ? 'true' : 'false'}"><span class="ncb-source-trigger-icon" aria-hidden="true">⌁</span><span class="ncb-source-trigger-copy"><strong>${escapeHtml(scope === 'current_document' ? 'Open document' : scope === 'whole_course' ? 'Whole course' : 'Course files')}</strong><small>${escapeHtml(sourceSummary)}</small></span><span class="ncb-source-chevron" aria-hidden="true">⌄</span></button><div class="ncb-source-popover"${marker.sourcePickerOpen ? '' : ' hidden'}><div class="ncb-source-modes">
      <label${!current ? ' class="is-disabled"' : ''}><input type="radio" name="sourceScope-${marker.actionId}" value="current_document"${scope === 'current_document' ? ' checked' : ''}${!current ? ' disabled' : ''}><span>Open document</span></label>
      <label><input type="radio" name="sourceScope-${marker.actionId}" value="selected_documents"${scope === 'selected_documents' ? ' checked' : ''}><span>Course files</span></label>
      <label><input type="radio" name="sourceScope-${marker.actionId}" value="whole_course"${scope === 'whole_course' ? ' checked' : ''}><span>Whole course</span></label>
    </div>
    ${current ? `<div class="ncb-source-current"${scope === 'current_document' ? '' : ' hidden'}><strong>${escapeHtml(current.fileName)}</strong><span>${current.pageCount} pages · ${escapeHtml(currentStatus === 'ready' ? 'Ready' : String(currentStatus))}</span></div>` : ''}
    <div class="ncb-source-files"${scope === 'selected_documents' ? '' : ' hidden'}><input type="search" data-source-search placeholder="Search course files"><div class="ncb-source-file-actions"><button type="button" data-source-select-all>Select all ready</button><button type="button" data-source-clear>Clear</button><span data-source-count>${selected.size} selected</span></div><div class="ncb-source-file-list">${fileRows || '<p class="ncb-source-empty">Loading indexed course files…</p>'}</div></div>
    <div class="ncb-source-whole"${scope === 'whole_course' ? '' : ' hidden'}>Use all ${readyDocs.length} ready files in this course. Larger generations may take longer.</div>
    </div></div><div class="ncb-tool-config-values">${definition.fields.map(field => control(field, marker.parameters)).join('')}</div><div class="ncb-tool-config-validation" role="alert">${escapeHtml(marker.validationMessage || '')}</div><button type="button" class="ncb-tool-config-generate">${escapeHtml(definition.actionLabel)}</button></section>`;
  const update = () => { marker.status = 'awaiting_confirmation'; marker.validationMessage = ''; persist(marker); };
  const setSource = (nextScope: StudyToolSourceScope, ids: string[]) => {
    const chosen = docs.filter(doc => ids.includes(doc.documentId));
    const label = nextScope === 'current_document' && current ? `Open document — ${current.fileName}` : nextScope === 'whole_course' ? `Whole course — ${readyDocs.length} ready files` : chosen.length ? `${chosen.length} selected ${chosen.length === 1 ? 'file' : 'files'}` : 'No source selected';
    marker.source = { scope: nextScope, courseId: marker.courseId, documentIds: ids, activeDocumentId: current?.documentId, activeFileName: current?.fileName, displayLabel: label };
    marker.documentIds = ids.slice(); marker.sourceLabel = label; marker.sourceDocumentName = nextScope === 'current_document' ? current?.fileName : undefined; update();
  };
  host.querySelector<HTMLButtonElement>('.ncb-source-trigger')?.addEventListener('click', event => {
    marker.sourcePickerOpen = !marker.sourcePickerOpen;
    const trigger = event.currentTarget as HTMLButtonElement;
    trigger.setAttribute('aria-expanded', marker.sourcePickerOpen ? 'true' : 'false');
    const panel = host.querySelector<HTMLElement>('.ncb-source-popover');
    if (panel) panel.hidden = !marker.sourcePickerOpen;
    persist(marker);
  });
  host.querySelectorAll<HTMLInputElement>('input[type="radio"][name^="sourceScope-"]').forEach(radio => radio.addEventListener('change', () => {
    marker.sourcePickerOpen = true;
    const next = radio.value as StudyToolSourceScope;
    if (next === 'current_document' && current) setSource(next, [current.documentId]);
    else if (next === 'whole_course') setSource(next, readyDocs.map(doc => doc.documentId));
    else setSource('selected_documents', marker.source?.scope === 'selected_documents' ? marker.source.documentIds : []);
    renderStudyToolConfiguration(host, marker);
  }));
  const checkedIds = () => Array.from(host.querySelectorAll<HTMLInputElement>('[data-source-document]:checked')).map(el => el.value);
  host.querySelectorAll<HTMLInputElement>('[data-source-document]').forEach(box => box.addEventListener('change', () => { setSource('selected_documents', checkedIds()); const count = host.querySelector<HTMLElement>('[data-source-count]'); if (count) count.textContent = `${checkedIds().length} selected`; }));
  host.querySelector<HTMLButtonElement>('[data-source-select-all]')?.addEventListener('click', () => { setSource('selected_documents', readyDocs.map(doc => doc.documentId)); renderStudyToolConfiguration(host, marker); });
  host.querySelector<HTMLButtonElement>('[data-source-clear]')?.addEventListener('click', () => { setSource('selected_documents', []); renderStudyToolConfiguration(host, marker); });
  host.querySelector<HTMLInputElement>('[data-source-search]')?.addEventListener('input', event => { const query = (event.currentTarget as HTMLInputElement).value.toLowerCase(); host.querySelectorAll<HTMLElement>('.ncb-source-file').forEach(row => { row.hidden = !row.textContent?.toLowerCase().includes(query); }); });
  definition.fields.forEach(field => host.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-field="${field.key}"]`).forEach(el => el.addEventListener('change', () => {
    if (field.type === 'multi') marker.parameters[field.key] = Array.from(host.querySelectorAll<HTMLInputElement>(`[data-field="${field.key}"]:checked`)).map(x => x.value);
    else if (field.type === 'checkbox') marker.parameters[field.key] = (el as HTMLInputElement).checked;
    else marker.parameters[field.key] = field.key === 'count' ? Number(el.value) : el.value;
    update();
  })));
  host.querySelectorAll<HTMLInputElement>('input[type="text"][data-field]').forEach(el => el.addEventListener('input', () => { marker.parameters[el.dataset.field!] = el.value; update(); }));
  host.querySelector<HTMLButtonElement>('.ncb-tool-config-generate')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const error = validate(marker);
    if (error) { marker.validationMessage = error; marker.status = 'failed'; persist(marker); const alert = host.querySelector<HTMLElement>('.ncb-tool-config-validation'); if (alert) alert.textContent = error; return; }
    marker.status = 'generating'; marker.validationMessage = ''; persist(marker); button.disabled = true; button.textContent = 'Generating and saving…';
    try { marker.artifact = await generate(marker); marker.status = 'completed'; persist(marker); renderArtifact(host, marker); }
    catch (err) { marker.status = 'failed'; marker.validationMessage = err instanceof Error ? err.message : 'Generation failed. Please retry.'; persist(marker); button.disabled = false; button.textContent = `Retry ${definition.actionLabel.toLowerCase()}`; const alert = host.querySelector<HTMLElement>('.ncb-tool-config-validation'); if (alert) alert.textContent = marker.validationMessage; }
  });
  if (!marker.documentsHydrated) void listCourseDocuments(marker.courseId).then(courseDocs => {
    marker.availableDocuments = courseDocs.map(doc => option(marker.courseId, doc));
    marker.documentsHydrated = true;
    const named = marker.requestedSourceName?.trim().toLowerCase();
    if (named) {
      const matches = marker.availableDocuments.filter(doc => doc.fileName.toLowerCase() === named || doc.fileName.toLowerCase().replace(/\.[^.]+$/, '') === named);
      if (matches.length === 1 && matches[0]) {
        marker.source = { scope: 'selected_documents', courseId: marker.courseId, documentIds: [matches[0].documentId], displayLabel: matches[0].fileName };
        marker.documentIds = [matches[0].documentId]; marker.sourceLabel = matches[0].fileName;
      } else if (matches.length !== 1) marker.validationMessage = matches.length ? 'More than one course file matches that name. Choose one below.' : 'The requested document was not found. Choose a course file below.';
    }
    persist(marker);
    console.info('[study-tool-source]', { tool: marker.intent, activeCourseId: marker.courseId, activeDocumentId: marker.activePdf?.documentId || null, activeFileName: marker.activePdf?.fileName || null, courseDocumentsLoaded: courseDocs.length, readyDocuments: marker.availableDocuments.filter(doc => doc.readiness === 'ready').length, visiblePickerOptions: marker.availableDocuments.length, defaultSourceMode: marker.source?.scope });
    renderStudyToolConfiguration(host, marker);
  }).catch(() => { marker.validationMessage = 'Course files could not be loaded. Retry by reopening this card.'; persist(marker); renderStudyToolConfiguration(host, marker); });
}
