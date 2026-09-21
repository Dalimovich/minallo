import { mountWriting, type ProductivePart, type ProductiveContent } from './productive-task.js';
/** One manifest-driven workspace for reusable interactions across exam families. */
import { mountMediaTask, MEDIA_TASKS, type MediaPart, type MediaContent } from './media-task.js';
import { mountSelection, gradeSelection, SELECTION_TYPES, type SelectionPart, type SelectionContent } from './source-selection.js';
export interface TaskPart {id: string; title: string; taskType: string; implemented: boolean; gradingDimensions?: string[]; constraints?: Record<string, unknown>}
export interface TaskManifest {profileId: string; profileVersion: number; modules: Array<{id: string; label: string; parts: TaskPart[]}>}
export interface TaskEnvelope {generationId?: string; exam: {profileId: string; profileVersion: number}; module: string; part: {id: string; taskType: string}; content: unknown}
export type TaskRenderer = (root: HTMLElement, part: TaskPart, content: unknown, identity: string) => () => void;
export const TASK_RENDERERS: Record<string, TaskRenderer> = {};
for (const type of ['argumentative_essay','text_graph_summary']) TASK_RENDERERS[type]=(root,part,content,identity)=>mountWriting(root,part as unknown as ProductivePart,content as ProductiveContent,identity);
for (const type of Object.keys(MEDIA_TASKS)) TASK_RENDERERS[type] = (root,part,content) => mountMediaTask(root,part as unknown as MediaPart,content as MediaContent);
for (const type of SELECTION_TYPES) TASK_RENDERERS[type] = (root,part,content) => {
  const source=document.createElement('div'); const questions=document.createElement('div'); root.append(source,questions);
  const answers: Record<string,string|null>={}; const c=content as SelectionContent;
  let dispose=mountSelection(source,questions,part as unknown as SelectionPart,c,answers);
  const submit=document.createElement('button'); submit.type='button';submit.textContent='Submit';root.append(submit);
  submit.onclick=()=>{const result=Object.values(gradeSelection(c,answers));dispose();
    dispose=mountSelection(source,questions,part as unknown as SelectionPart,c,answers,true);
    submit.disabled=true; const status=document.createElement('p');status.setAttribute('role','status');
    status.textContent=`${result.filter(r=>r.correct).length} / ${result.length} correct (practice)`;root.append(status);};
  return ()=>{dispose();root.replaceChildren();};
};
export function mountTaskWorkspace(root: HTMLElement, manifest: TaskManifest,
  load: (module: string, part: TaskPart, signal: AbortSignal) => Promise<TaskEnvelope>): () => void {
  root.replaceChildren(); let epoch=0; let disposeTask: (()=>void)|undefined; let pending: AbortController|undefined;
  const nav=document.createElement('nav'); nav.setAttribute('aria-label','Exam parts');
  const content=document.createElement('section'); content.setAttribute('aria-live','polite');
  const open = async (module: string, part: TaskPart): Promise<void> => {
    if (!part.implemented || !TASK_RENDERERS[part.taskType]) return;
    const mine=++epoch; pending?.abort(); disposeTask?.(); disposeTask=undefined;
    const controller=new AbortController();pending=controller;content.textContent='Loading exercise?';
    try {
      const envelope=await load(module,part,controller.signal);
      if (mine!==epoch) return;
      if (envelope.exam.profileId!==manifest.profileId || envelope.exam.profileVersion!==manifest.profileVersion || envelope.module!==module || envelope.part.id!==part.id || envelope.part.taskType!==part.taskType) throw new Error('Exercise identity mismatch');
      content.replaceChildren();
      const identity=[window._currentUser?.id || 'anonymous',manifest.profileId,manifest.profileVersion,module,part.id,envelope.generationId || crypto.randomUUID()].join(':');
      disposeTask=TASK_RENDERERS[part.taskType]!(content,part,envelope.content,identity);
    } catch {if(mine===epoch) content.textContent='Could not load this exercise. Select the part to retry.';}
  };
  for (const module of manifest.modules) {
    const group=document.createElement('div');const title=document.createElement('h4');title.textContent=module.label;group.append(title);
    for (const part of module.parts) {
      const button=document.createElement('button');button.type='button';button.dataset.partId=part.id;
      button.textContent=part.title+(part.constraints?.itemCount!=null?` (${part.constraints.itemCount})`:'');
      button.disabled=!part.implemented || !TASK_RENDERERS[part.taskType];
      button.onclick=()=>{void open(module.id,part);};group.append(button);
    }
    nav.append(group);
  }
  root.append(nav,content);
  return ()=>{epoch++;pending?.abort();disposeTask?.();root.replaceChildren();};
}
