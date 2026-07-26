import { escapeHtml } from '../../utils/escape-html.js';
import { openStudyToolWorkspace, type StudyWorkspaceKind } from './workspace-library.js';

export type InlineStudyToolKind = 'examforge' | 'flashcards' | 'deep_learn';
export type StudyToolConfigurationStatus = 'collecting_parameters' | 'awaiting_confirmation' | 'generating' | 'failed' | 'completed';

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
  availableDocuments?: Array<{ id: string; name: string }>;
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

export function resolveStudyToolSource(courseId: string, selectedSourceIds: string[], sourceItems: SourceItem[], openName: string): { documentIds: string[]; label: string; documentName?: string; availableDocuments: Array<{ id: string; name: string }> } {
  const all = sourceItems.filter(item => item.courseId === courseId).flatMap(item => item.documents || []);
  const availableDocuments = all.filter((doc): doc is { id: string; name: string } => !!doc.id).map(doc => ({ id: doc.id, name: doc.name }));
  const selected = sourceItems.filter(item => selectedSourceIds.includes(item.id) && item.courseId === courseId).flatMap(item => item.documents || []);
  const open = openName ? all.find(doc => doc.name.toLowerCase() === openName.toLowerCase()) : undefined;
  if (open) return { documentIds: open.id ? [open.id] : [], label: `Current PDF: ${open.name}`, documentName: open.name, availableDocuments };
  if (openName) return { documentIds: [], label: `Current PDF: ${openName}`, documentName: openName, availableDocuments };
  const ids = selected.map(doc => doc.id).filter((id): id is string => !!id);
  if (selected.length) return { documentIds: ids, label: selected.length === 1 ? selected[0]!.name : `${selected.length} selected files`, availableDocuments };
  return { documentIds: [], label: 'Choose a course document', availableDocuments };
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
  if (!marker.documentIds.length) return 'Choose at least one indexed source document.';
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
  if (marker.intent === 'examforge') {
    const result = await svc.generateExamForge(marker.courseId, { documentIds: marker.documentIds, count: Number(p.count), requestedCount: Number(p.count), difficulty: p.difficulty as 'easy' | 'medium' | 'hard' | 'mixed', questionTypes: p.questionTypes, language: String(p.language || 'auto'), topic: String(p.topic || '') });
    const raw = result as { sessionId?: string; id?: string; questions?: unknown[]; error?: string };
    const id = raw.sessionId || raw.id;
    if (!id) throw new Error(raw.error || 'The exam was not persisted.');
    return { artifactType: 'examforge', artifactId: id, persistedResourceId: id, rendererVersion: 1, title: 'ExamForge created', summary: `${raw.questions?.length || Number(p.count)} questions · ${String(p.difficulty)} · ${String(p.mode)} mode`, payload: raw as Record<string, unknown> };
  }
  if (marker.intent === 'flashcards') {
    const raw = await svc.generateStudyTool(marker.courseId, 'flashcards', { documentIds: marker.documentIds, count: Number(p.count), difficulty: p.difficulty as 'easy' | 'medium' | 'hard' | 'mixed', topic: String(p.topic || ''), seenItems: p.avoidSeen ? [] : undefined }) as { items?: Array<{ front?: string; back?: string; source?: string }>; error?: string };
    const cards = (raw.items || []).filter(card => card.front?.trim() && card.back?.trim());
    if (!cards.length) throw new Error(raw.error || 'No flashcards were generated.');
    const name = String(p.deckName || '').trim() || 'Course flashcards';
    const id = await saveFlashcardDeck(marker.courseId, name, cards);
    return { artifactType: 'flashcards', artifactId: id, persistedResourceId: id, rendererVersion: 1, title: 'Flashcards created', summary: `${cards.length} cards · ${String(p.difficulty)}`, payload: { id, name, cards } };
  }
  const raw = await svc.generateDeepLearn(marker.courseId, String(p.topic), { documentIds: marker.documentIds, lessonMode: String(p.lessonMode), lessonLanguage: String(p.lessonLanguage) });
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
  const sourceOptions = docs.map(doc => `<option value="${escapeHtml(doc.id)}"${marker.documentIds.includes(doc.id) ? ' selected' : ''}>${escapeHtml(doc.name)}</option>`).join('');
  host.innerHTML = `<section class="ncb-tool-config" data-study-tool-configuration="${marker.intent}" data-action-id="${escapeHtml(marker.actionId)}"><header><span class="ncb-tool-config-badge">${escapeHtml(definition.title)}</span><h3>${escapeHtml(definition.title)} setup</h3></header><label class="ncb-tool-field"><span>Source</span><select data-source${docs.length > 1 ? ' multiple' : ''}>${sourceOptions || '<option value="">Choose a course document</option>'}</select></label><div class="ncb-tool-config-values">${definition.fields.map(field => control(field, marker.parameters)).join('')}</div><div class="ncb-tool-config-validation" role="alert">${escapeHtml(marker.validationMessage || '')}</div><button type="button" class="ncb-tool-config-generate">${escapeHtml(definition.actionLabel)}</button></section>`;
  const update = () => { marker.status = 'awaiting_confirmation'; marker.validationMessage = ''; persist(marker); };
  host.querySelector<HTMLSelectElement>('[data-source]')?.addEventListener('change', event => { marker.documentIds = Array.from((event.currentTarget as HTMLSelectElement).selectedOptions).map(o => o.value).filter(Boolean); const names = docs.filter(d => marker.documentIds.includes(d.id)).map(d => d.name); marker.sourceLabel = names.length === 1 ? names[0]! : `${names.length} selected files`; update(); });
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
}
