export interface ProductivePart {taskType: string; gradingDimensions?: string[]; constraints: {
  requiredSourceKinds?: string[]; wordCountMin?: number; wordCountMinApprox?: number; wordCountMaxApprox?: number;
  practiceTimeLimitSeconds?: number; speakingSeconds?: number; preparationSeconds?: number; hideSourceAfterPreparation?: boolean;
  recordingPolicy?: {autoStop: boolean; manualStopAllowed: boolean; retryAllowed: boolean};
}}
export interface Graphic {title: string; unit: string; columns: Array<{id:string;label:string}>;rows:Array<{id:string;label:string;values:Record<string,number>}>}
export interface ProductiveContent {schemaVersion:'productive-task-v1';id:string;prompt:string;sources:Array<{id:string;kind:'text'|'script'|'graphic';text?:string;graphic?:Graphic;media?:{audioUrl?:string}}>}
export interface Feedback {kind:'practice_feedback';wordCount?:number;dimensions:Array<{id:string;feedback:string;evidence:Array<{quote:string;startSeconds?:number}>}>}
export type ProductiveGrader=(submission:{text?:string;recordingId?:string;durationSeconds?:number},signal:AbortSignal)=>Promise<Feedback>;
export function wordCount(text:string):number {return text.trim()?text.trim().split(/\s+/).length:0;}
export function validateProductive(part:ProductivePart,c:ProductiveContent):void {
  if(c?.schemaVersion!=='productive-task-v1'||typeof c.id!=='string'||!c.id.trim()||typeof c.prompt!=='string'||!c.prompt.trim()||!Array.isArray(c.sources))throw new Error('Invalid task');
  if(c.sources.some(s=>!s||typeof s.id!=='string'||!s.id.trim())||new Set(c.sources.map(s=>s.id)).size!==c.sources.length)throw new Error('Invalid source IDs');
  for(const source of c.sources){
    if(source.kind==='graphic'){
      const g=source.graphic;
      if(!g||!g.title||!g.unit||!Array.isArray(g.columns)||!g.columns.length||!Array.isArray(g.rows)||!g.rows.length)throw new Error('Invalid graphic');
      for(const rows of [g.columns,g.rows])if(rows.some(r=>!r.id||!r.label)||new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('Invalid graphic IDs');
      for(const row of g.rows)if(!row.values||Object.keys(row.values).length!==g.columns.length||g.columns.some(col=>!Number.isFinite(row.values[col.id])))throw new Error('Invalid graphic values');
    }else if(!['text','script'].includes(source.kind)||typeof source.text!=='string'||!source.text.trim())throw new Error('Invalid source');
  }
  if(part.constraints.requiredSourceKinds?.some(kind=>!c.sources.some(s=>s.kind===kind)))throw new Error('Missing required source');
}
export function renderProductiveSources(root:HTMLElement,part:ProductivePart,c:ProductiveContent):HTMLElement {
  validateProductive(part,c);const prompt=document.createElement('p');prompt.textContent=c.prompt;root.append(prompt);
  const sources=document.createElement('section');root.append(sources);
  for(const s of c.sources){
    if(s.kind==='script'){const audio=document.createElement('audio');audio.controls=true;const url=s.media?.audioUrl;
      if(url&&/^(https:\/\/|\/(?!\/)|blob:)/.test(url))audio.src=url;
      else{const unavailable=document.createElement('p');unavailable.textContent='Source audio unavailable';sources.append(unavailable);}
      sources.append(audio);continue;}
    if(s.kind!=='graphic'){const text=document.createElement('p');text.textContent=s.text||'';sources.append(text);continue;}
    const g=s.graphic!;const table=document.createElement('table');const caption=table.createCaption();caption.textContent=g.title+' ('+g.unit+')';
    const heading=table.createTHead().insertRow();heading.append(document.createElement('th'));
    for(const col of g.columns){const th=document.createElement('th');th.scope='col';th.textContent=col.label;heading.append(th);}
    const body=table.createTBody();for(const row of g.rows){const tr=body.insertRow();const label=document.createElement('th');label.scope='row';label.textContent=row.label;tr.append(label);
      for(const col of g.columns){const cell=tr.insertCell();cell.textContent=String(row.values[col.id]);}}
    sources.append(table);
  }return sources;
}
export function renderFeedback(root:HTMLElement,part:ProductivePart,result:Feedback,text?:string):void {
  if(result?.kind!=='practice_feedback'||!Array.isArray(result.dimensions)||['tdn','scaledScore','officialScore','rawScore','pass'].some(k=>k in result))throw new Error('Invalid formative feedback');
  const ids=result.dimensions.map(d=>d.id);const expected=part.gradingDimensions||[];
  if(ids.length!==expected.length||new Set(ids).size!==ids.length||expected.some(id=>!ids.includes(id)))throw new Error('Missing dimensions');
  if(text!==undefined&&result.wordCount!==wordCount(text))throw new Error('Word count mismatch');
  for(const d of result.dimensions){if(!d.feedback||!Array.isArray(d.evidence)||d.evidence.some(e=>!e.quote||(text!==undefined&&!text.includes(e.quote))))throw new Error('Invalid feedback evidence');}
  root.replaceChildren();const title=document.createElement('h4');title.textContent='Practice feedback';root.append(title);
  for(const d of result.dimensions){const heading=document.createElement('h5');heading.textContent=d.id;const feedback=document.createElement('p');feedback.textContent=d.feedback;root.append(heading,feedback);
    for(const e of d.evidence){const quote=document.createElement('blockquote');quote.textContent=e.quote;root.append(quote);}}
}
export function mountWriting(root:HTMLElement,part:ProductivePart,c:ProductiveContent,identity:string,
  grader:ProductiveGrader=async()=>{throw new Error('Grading is not connected yet');},
  storage:Storage=localStorage, now:()=>number=Date.now):()=>void {
  root.replaceChildren();renderProductiveSources(root,part,c);
  const key='german-writing:'+identity+':'+c.id;const controller=new AbortController();let disposed=false;let submitting=false;
  const editor=document.createElement('textarea');editor.setAttribute('aria-label','Your response');editor.rows=12;
  const status=document.createElement('p');status.setAttribute('role','status');const count=document.createElement('output');
  const timer=document.createElement('output');const feedback=document.createElement('section');
  const guidance=document.createElement('p');const min=part.constraints.wordCountMin;
  guidance.textContent=min!=null?`Minimum: ${min} words`:`Approximate length: ${part.constraints.wordCountMinApprox??'?'}?${part.constraints.wordCountMaxApprox??'?'} words`;
  let deadline=part.constraints.practiceTimeLimitSeconds?now()+part.constraints.practiceTimeLimitSeconds*1000:null;
  try{const saved=JSON.parse(storage.getItem(key)||'null');if(saved&&typeof saved.text==='string'&&(saved.deadline===null||Number.isFinite(saved.deadline))){editor.value=saved.text;deadline=saved.deadline;}}catch{status.textContent='Draft recovery unavailable.';}
  const save=():void=>{count.textContent=`${wordCount(editor.value)} words`;try{storage.setItem(key,JSON.stringify({text:editor.value,deadline}));}catch{status.textContent='Draft could not be saved on this device.';}};
  editor.addEventListener('input',save,{signal:controller.signal});save();
  const tick=():void=>{if(deadline!==null){const seconds=Math.max(0,Math.ceil((deadline-now())/1000));timer.textContent=`${seconds}s remaining`;if(seconds===0)editor.readOnly=true;}};
  tick();const interval=setInterval(tick,250);
  const submit=document.createElement('button');submit.type='button';submit.textContent='Submit';
  submit.onclick=async()=>{if(submitting||disposed||!editor.value.trim())return;submitting=true;submit.disabled=true;editor.readOnly=true;status.textContent='Submitting?';save();
    try{const result=await grader({text:editor.value},controller.signal);if(disposed)return;renderFeedback(feedback,part,result,editor.value);status.textContent='Submitted';}
    catch{if(!disposed){status.textContent='Grading failed. Your draft is saved; retry submission.';submitting=false;submit.disabled=false;editor.readOnly=deadline!==null&&now()>=deadline;}}
  };
  root.append(guidance,editor,count,timer,submit,status,feedback);
  return()=>{disposed=true;save();controller.abort();clearInterval(interval);root.replaceChildren();};
}
