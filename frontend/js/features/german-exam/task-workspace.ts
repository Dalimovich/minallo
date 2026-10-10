import { mountSpeaking } from './speaking-task.js';
import { mountWriting, type ProductivePart, type ProductiveContent } from './productive-task.js';
import { createWritingGrader } from './writing-grader.js';
import { createSpeakingRecordingGrader } from './speaking-grader.js';
/** One manifest-driven workspace for reusable interactions across exam families. */
import { mountMediaTask, MEDIA_TASKS, type MediaPart, type MediaContent } from './media-task.js';
import { fetchSegmentClips } from './media-task-audio.js';
import { mountSelection, gradeSelection, SELECTION_TYPES, type SelectionPart, type SelectionContent } from './source-selection.js';
import { mountOrdering, gradeOrdering, type OrderingPart, type OrderingContent } from './ordering-task.js';
import { mountSummaryError, type SummaryErrorPart, type SummaryErrorContent } from './summary-error-task.js';
import { mountDshOpenAnswer, type DshOpenAnswerContent } from './dsh-open-answer-task.js';
import { mountDshWritingStimulus, mountDshOralStimulus, type DshStimulusContent } from './dsh-stimulus-task.js';
import { mountGoetheWriting, type GoetheWritingContent } from './goethe-writing-task.js';
export interface TaskPart {id: string; title: string; taskType: string; implemented: boolean; gradingDimensions?: string[]; constraints?: Record<string, unknown>}
export interface TaskManifest {profileId: string; profileVersion: number; modules: Array<{id: string; label: string; code?: string | null; parts: TaskPart[]}>}
export interface TaskEnvelope {generationId?: string; exam: {profileId: string; profileVersion: number}; module: string; part: {id: string; taskType: string}; content: unknown}
export type TaskRenderer = (root: HTMLElement, part: TaskPart, content: unknown, identity: string, envelope: TaskEnvelope) => () => void;
export const TASK_RENDERERS: Record<string, TaskRenderer> = {};
// argumentative_essay/text_graph_summary = TestDaF: the real productive-task-v1 shape
// (schemaVersion/id/prompt/sources), graded through the same backend adapter
// (german_exam_writing_grading.py) TELC's own Writing already uses.
for (const type of ['argumentative_essay','text_graph_summary'])
  TASK_RENDERERS[type]=(root,part,content,identity,envelope)=>mountWriting(root,part as unknown as ProductivePart,content as ProductiveContent,identity,
    createWritingGrader(envelope,content as ProductiveContent,part.gradingDimensions||[]));
// forum_discussion_post/formal_context_message = Goethe C1: a genuinely different shape (no
// id/prompt/sources — see goethe-writing-task.ts's own header comment for why this is NOT routed
// through mountWriting/ProductiveContent, same reasoning as DSH's dsh-stimulus-task.ts below).
for (const type of ['forum_discussion_post','formal_context_message'])
  TASK_RENDERERS[type]=(root,part,content,identity,envelope)=>mountGoetheWriting(root,part as unknown as ProductivePart,content as GoetheWritingContent,identity,envelope);
for (const type of ['spoken_advice','spoken_option_comparison','spoken_text_summary','spoken_information_comparison','recorded_topic_presentation','spoken_argument_response','spoken_measure_critique'])
  TASK_RENDERERS[type]=(root,part,content,_identity,envelope)=>mountSpeaking(root,part as unknown as ProductivePart,content as ProductiveContent,
    {submitRecording:createSpeakingRecordingGrader(envelope,content as ProductiveContent)});
for (const type of Object.keys(MEDIA_TASKS)) TASK_RENDERERS[type] = (root,part,content) => mountMediaTask(root,part as unknown as MediaPart,content as MediaContent,{fetchClips:fetchSegmentClips});
// DSH: own content shape (german_exam_dsh_generators.py), own renderers — not forced through
// media-task.ts/productive-task.ts (see dsh-open-answer-task.ts/dsh-stimulus-task.ts's own
// header comments for why). WS (scientific_structures) has no entry here: its generator is not
// wired into generate_task() at all yet (a documented, pre-existing engine gap), so no content
// for it can ever reach this dispatcher.
TASK_RENDERERS['dsh_hv_lecture_tasks']=(root,_part,content)=>mountDshOpenAnswer(root,content as DshOpenAnswerContent,'hv');
TASK_RENDERERS['dsh_lv_text_tasks']=(root,_part,content)=>mountDshOpenAnswer(root,content as DshOpenAnswerContent,'lv');
TASK_RENDERERS['dsh_tp_chart_based_argumentation']=(root,_part,content,identity)=>mountDshWritingStimulus(root,content as DshStimulusContent,identity);
TASK_RENDERERS['dsh_oral_presentation_conversation']=(root,part,content)=>mountDshOralStimulus(root,content as DshStimulusContent,part.constraints?.preparationSeconds as number|undefined);
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
TASK_RENDERERS['reading_summary_error_detection']=(root,part,content)=>mountSummaryError(root,part as unknown as SummaryErrorPart,content as SummaryErrorContent);
TASK_RENDERERS['paragraph_ordering']=(root,part,content)=>{
  const container=document.createElement('div'); root.append(container);
  const answers: Record<string,string|null>={}; const c=content as OrderingContent;
  let dispose=mountOrdering(container,part as unknown as OrderingPart,c,answers);
  const submit=document.createElement('button'); submit.type='button';submit.textContent='Submit';root.append(submit);
  submit.onclick=()=>{const result=Object.values(gradeOrdering(c,answers));dispose();
    dispose=mountOrdering(container,part as unknown as OrderingPart,c,answers,true);
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
      disposeTask=TASK_RENDERERS[part.taskType]!(content,part,envelope.content,identity,envelope);
    } catch {if(mine===epoch) content.textContent='Could not load this exercise. Select the part to retry.';}
  };
  for (const module of manifest.modules) {
    const group=document.createElement('div');const title=document.createElement('h4');title.textContent=(module.code ? module.code + ' \u2014 ' : '') + module.label;group.append(title);
    for (const part of module.parts) {
      const button=document.createElement('button');button.type='button';button.dataset.partId=part.id;
      button.textContent=part.title+(part.constraints?.itemCount!=null?` (${part.constraints.itemCount})`:'');
      button.disabled=!part.implemented || !TASK_RENDERERS[part.taskType];
      button.dataset.state=button.disabled ? 'unavailable' : 'available'; if (button.disabled) button.title='Coming soon';
      button.onclick=()=>{void open(module.id,part);};group.append(button);
    }
    nav.append(group);
  }
  root.append(nav,content);
  return ()=>{epoch++;pending?.abort();disposeTask?.();root.replaceChildren();};
}
