import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export function validationSummary(needs) {
  const keys=['scope','source-linux','source-windows','governance','dependency','docs'];
  if(!needs||Object.keys(needs).length!==keys.length||keys.some(k=>!needs[k])||needs.scope.result!=='success')throw Error('VALIDATION_REQUIRED_JOB_INCOMPLETE');
  const outputs=needs.scope.outputs;
  if(!outputs||['source','dependency','docs','governance'].some(k=>!['true','false'].includes(outputs[k])))throw Error('VALIDATION_SCOPE_MISSING');
  for(const key of keys.slice(1)){
    const group=key.startsWith('source-')?'source':key;
    const expected=outputs[group]==='true'?'success':'skipped';
    if(needs[key].result!==expected)throw Error('VALIDATION_REQUIRED_JOB_INCOMPLETE');
  }
  return keys.map(k=>`${k}: ${needs[k].result}`).join('\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const text=validationSummary(JSON.parse(process.env.VALIDATION_NEEDS));
    if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,text+'\n');else console.log(text);
  }catch(e){console.error(e.message);process.exitCode=1;}
}
