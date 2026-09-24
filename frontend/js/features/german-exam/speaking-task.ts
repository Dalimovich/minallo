import {renderProductiveSources,renderFeedback,type ProductivePart,type ProductiveContent,type ProductiveGrader} from './productive-task.js';
export interface RecordingDependencies {
  getMedia:()=>Promise<MediaStream>; recorder:(stream:MediaStream)=>MediaRecorder;
  upload:(blob:Blob,signal:AbortSignal)=>Promise<{recordingId:string}>; grader:ProductiveGrader;
  now:()=>number;
}
export function mountSpeaking(root:HTMLElement,part:ProductivePart,c:ProductiveContent,dependencies:Partial<RecordingDependencies>={}):()=>void {
  root.replaceChildren();const sources=renderProductiveSources(root,part,c);
  const seconds=part.constraints.speakingSeconds;const policy=part.constraints.recordingPolicy;
  if(!seconds||!policy)throw new Error('Missing recording policy');
  const deps:RecordingDependencies={getMedia:()=>navigator.mediaDevices.getUserMedia({audio:true}),recorder:s=>new MediaRecorder(s),
    upload:async()=>{throw new Error('Upload is not connected');},grader:async()=>{throw new Error('Grader is not connected');},now:Date.now,...dependencies};
  const controller=new AbortController();let disposed=false;let stream:MediaStream|undefined;let recorder:MediaRecorder|undefined;
  let phase='idle';let deadline=0;let started=0;let duration=0;let blob:Blob|undefined;let previewUrl:string|undefined;let chunks:Blob[]=[];
  const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Microphone not requested';
  const clock=document.createElement('output');const preview=document.createElement('audio');preview.controls=true;preview.hidden=true;
  const start=document.createElement('button');start.type='button';start.textContent='Prepare and record';
  if(c.sources.some(s=>s.kind==='script'&&!s.media?.audioUrl)){start.disabled=true;status.textContent='Source audio unavailable';}
  const stop=document.createElement('button');stop.type='button';stop.textContent='Stop recording';stop.disabled=true;
  const retry=document.createElement('button');retry.type='button';retry.textContent='Record again';retry.disabled=true;retry.hidden=!policy.retryAllowed;
  const submit=document.createElement('button');submit.type='button';submit.textContent='Submit recording';submit.disabled=true;
  const feedback=document.createElement('section');
  const releaseStream=():void=>{stream?.getTracks().forEach(t=>t.stop());stream=undefined;};
  const clearPreview=():void=>{preview.pause();preview.removeAttribute('src');preview.load();preview.hidden=true;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=undefined;blob=undefined;};
  const finish=():void=>{if(phase!=='recording')return;duration=Math.min(seconds,Math.max(0,(deps.now()-started)/1000));phase='stopping';stop.disabled=true;recorder?.stop();};
  const begin=():void=>{if(disposed||!recorder)return;phase='recording';started=deps.now();deadline=started+seconds*1000;
    if(part.constraints.hideSourceAfterPreparation)sources.hidden=true;
    recorder.start();status.textContent='Recording';stop.disabled=!policy.manualStopAllowed;};
  start.onclick=async()=>{if(disposed||phase!=='idle')return;phase='permission';start.disabled=true;status.textContent='Requesting microphone permission?';
    try{const acquired=await deps.getMedia();if(disposed){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;recorder=deps.recorder(stream);chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>{releaseStream();if(!disposed){phase='idle';start.disabled=false;status.textContent='Recording failed. Try again.';}};
      recorder.onstop=()=>{releaseStream();if(disposed)return;blob=new Blob(chunks,{type:recorder?.mimeType||'audio/webm'});
        if(!blob.size||duration<=0){phase='idle';start.disabled=false;status.textContent='No recording captured. Try again.';return;}
        phase='preview';previewUrl=URL.createObjectURL(blob);preview.src=previewUrl;preview.hidden=false;submit.disabled=false;retry.disabled=!policy.retryAllowed;status.textContent='Recording ready';};
      const prep=part.constraints.preparationSeconds||0;if(prep){phase='preparing';deadline=deps.now()+prep*1000;status.textContent='Preparation';}else begin();
    }catch{releaseStream();if(!disposed){phase='idle';start.disabled=false;status.textContent='Microphone permission unavailable. Allow access and retry.';}}
  };
  stop.onclick=()=>{if(policy.manualStopAllowed)finish();};
  retry.onclick=()=>{if(!policy.retryAllowed||!['preview','error'].includes(phase))return;clearPreview();phase='idle';start.disabled=false;submit.disabled=true;retry.disabled=true;sources.hidden=false;status.textContent='Ready for a new recording';};
  submit.onclick=async()=>{if(disposed||!blob||!['preview','error'].includes(phase))return;phase='submitting';submit.disabled=true;retry.disabled=true;status.textContent='Uploading recording?';
    try{const uploaded=await deps.upload(blob,controller.signal);if(disposed)return;if(!uploaded.recordingId)throw new Error('Missing recording id');status.textContent='Assessing recording?';
      const result=await deps.grader({recordingId:uploaded.recordingId,durationSeconds:duration},controller.signal);if(disposed)return;
      if(result.dimensions.some(d=>d.evidence.some(e=>typeof e.startSeconds!=='number'||e.startSeconds<0||e.startSeconds>=duration)))throw new Error('Invalid audio evidence');
      renderFeedback(feedback,part,result);phase='submitted';status.textContent='Submitted';
    }catch{if(!disposed){phase='error';submit.disabled=false;retry.disabled=!policy.retryAllowed;status.textContent='Upload or grading failed. Your recording remains available to retry.';}}
  };
  const interval=setInterval(()=>{if(phase==='preparing'||phase==='recording'){const remaining=Math.max(0,Math.ceil((deadline-deps.now())/1000));
    clock.textContent=phase==='preparing'?`${remaining}s preparation remaining`:`${Math.min(seconds,Math.floor((deps.now()-started)/1000))}s elapsed / ${remaining}s remaining`;
    if(!remaining){if(phase==='preparing')begin();else if(policy.autoStop)finish();}}},100);
  root.append(status,clock,start,stop,preview,retry,submit,feedback);
  return()=>{disposed=true;controller.abort();clearInterval(interval);if(recorder?.state==='recording')recorder.stop();releaseStream();clearPreview();sources.querySelectorAll('audio').forEach(a=>{a.pause();a.removeAttribute('src');a.load();});root.replaceChildren();};
}
