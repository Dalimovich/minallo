import fs from 'node:fs';
import path from 'node:path';
import { classifyAiError } from '../../frontend/js/services/ai-error-message.ts';

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
const emitted = new Map();
for (const file of files('backend/python-ai/app').filter(f=>f.endsWith('.py'))) {
  const source=fs.readFileSync(file,'utf8');
  for (const match of source.matchAll(/(?:\bcode\s*=|["'](?:code|errorCode)["']\s*:)\s*["']([a-zA-Z][a-zA-Z0-9_]+)["']/g)) {
    const locations=emitted.get(match[1]) || [];
    locations.push(file.replaceAll('\\','/')+':'+((source.slice(0,match.index).match(/\n/g)||[]).length+1));
    emitted.set(match[1],locations);
  }
}
const mapped=[...fs.readFileSync('frontend/js/services/ai-error-message.ts','utf8').matchAll(/^  (\w+): \{ title:/gm)].map(m=>m[1]);
const rows=[...emitted.keys()].sort().map(code=>{
  const c=classifyAiError({code});
  return `| ${code} | ${emitted.get(code)[0]} | ${c.title} | ${c.message} | ${c.retryable} | ${c.action} | ${c.preservePartialAnswer} | ${mapped.includes(code)?'Typed':c.title !== 'Could not finish'?'Typed alias':'Legacy fallback'} |`;
});
fs.writeFileSync('audit/error-contract.md', '# Error contract inventory\n\nStatic literal emission inventory, with real frontend classifier execution for each code. Location identifies subsystem; it is not an injected failure. Dynamic codes and legacy text exceptions require separate execution. Retryable/action defaults below can be overridden by backend payload.\n\n| Backend code | Emission location / stage | Frontend title | Message | Retryable | Action | Partial preserved | Mapping |\n|---|---|---|---|---|---|---|---|\n'+rows.join('\n')+'\n\nMapped codes without a literal Python emission (may originate in frontend, proxy, or dynamic lane classification): '+mapped.filter(c=>!emitted.has(c)).join(', ')+'\n');
console.log(JSON.stringify({literalCodes:emitted.size,explicitlyMapped:[...emitted.keys()].filter(c=>mapped.includes(c)).length}));
console.log('session_expired:',classifyAiError({code:'session_expired'}));
console.log('document_access_revoked:',classifyAiError({code:'document_access_revoked'}));
