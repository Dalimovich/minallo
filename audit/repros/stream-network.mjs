import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { SseParser } from '../../frontend/js/services/sse-parser.ts';
const source=fs.readFileSync('frontend/js/features/chatbot-new/shell.ts','utf8');
const ast=ts.createSourceFile('shell.ts',source,ts.ScriptTarget.Latest,true);
const names=['streamFromAskStream','AskStreamError'];
const selected=ast.statements.filter(n=>n.name&&names.includes(n.name.text)).map(n=>n.getText(ast)).join('\n');
const code=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let tokenSent=false;
const context={console,TextDecoder,TextEncoder,DOMException,AbortController,SseParser,crypto:globalThis.crypto,
 window:{AI_SERVICE_URL:'https://example.invalid',setTimeout,clearTimeout},STREAM_IDLE_WARNING_MS:100000,STREAM_IDLE_FAILURE_MS:200000,
 courseFileScopeForActiveChat:()=> 'all_course_files',sourceModeForActiveChat:()=> 'auto',
 currentMessageUsesSelectedRegion:()=>false,getCurrentTutorMode:()=> 'default',buildWorkspaceContext:()=>({}),buildPageContext:()=>({}),
 sanitizeChatbotDiagrams:x=>x,stripSourceMarkers:x=>x,
 createSoftStreamReveal:()=>({push:()=>{},finish:async()=>{}}),
 authenticatedFetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>{if(!tokenSent){tokenSent=true;return {done:false,value:new TextEncoder().encode('data: {"t":"Useful partial explanation"}\n\n')};}throw new TypeError('network disconnected');},cancel:async()=>{}})}}),
};
vm.createContext(context);vm.runInContext(code,context);
const message={id:'assistant',requestSnapshot:{}};
try{await context.streamFromAskStream('Explain torque','course',null,new AbortController(),[],null,[],[],undefined,null,true,null,undefined,[],false,'request',message);assert.fail('expected error');}
catch(e){console.log(e.stack);assert.equal(e.message,'network disconnected');assert.equal(e.metadata,undefined);assert.equal(message.text,'Useful partial explanation');console.log('REPRO SSE-01: real stream function emits raw transport exception without its received partial answer');}

let capturedPayload;
context.authenticatedFetch=async(_url,init)=>{capturedPayload=JSON.parse(init.body);throw new Error('captured');};
context.captureStablePdfSnapshot=async()=>{context.sourceModeForActiveChat=()=> 'internet';context.courseFileScopeForActiveChat=()=> 'all_course_files';return {status:'captured',snapshot:{activeDocument:{documentId:'doc-a',courseId:'course-a',fileName:'a.pdf',visiblePage:7,pageCount:10,pageText:'page'},images:[]}};};
context.isPdfViewerVisible=()=>true;
context.sourceModeForActiveChat=()=> 'course_files';context.courseFileScopeForActiveChat=()=> 'specific_files';
try{await context.streamFromAskStream('Use only selected PDF','course-a',null,new AbortController(),[],null,['doc-a'],['a.pdf'],{retrievalScope:{type:'documents',documentIds:['doc-a']}},null,true,{documentId:'doc-a'},'conversation-a',[],true,'request-a',{id:'assistant-a',requestSnapshot:{sourceMode:'course_files',courseFileScope:'specific_files'}});}catch(e){assert.equal(e.message,'captured');}
assert.equal(capturedPayload.courseId,'course-a');assert.equal(capturedPayload.sourceMode,'internet');assert.equal(capturedPayload.courseFileScope,'all_course_files');assert.equal(capturedPayload.documentIds,undefined);
console.log('REPRO STATE-01: chat switch during capture sends A request using B internet/all-course settings and omits original selected documentIds');
