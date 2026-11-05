import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

interface InstructionTransition {
  repositoryId?: number;
  legacy?: readonly {repositoryId:number;sha256:string}[];
  templateSource?: boolean;
}
function validFormat(bytes:Buffer):boolean {
  const body=bytes.toString('utf8');
  return bytes.equals(Buffer.from(body))&&!body.startsWith('\uFEFF')&&!body.includes('\r')
    &&body.endsWith('\n')&&!body.endsWith('\n\n')&&body.includes('## Code Review Rules');
}
const isCarrier=(path:string)=>/(^|\/)(AGENTS(?:\.override)?\.md|\.github\/copilot-instructions\.md)$/.test(path)
  ||/(^|\/)\.github\/instructions\/.*\.instructions\.md$/.test(path);

/** Read the actual repository carrier against the complete trusted template. Never rewrites files. */
export async function assertRepositoryInstructions(workspace:string, expected:Buffer, transition:InstructionTransition={}):Promise<void> {
  if(!validFormat(expected))throw Error('INSTRUCTIONS_TEMPLATE_INVALID');
  const legacy=transition.legacy??[];
  if(!Array.isArray(legacy)||legacy.some(row=>!row||!Number.isSafeInteger(row.repositoryId)||row.repositoryId<=0||!/^([a-f0-9]{64})$/.test(row.sha256)))
    throw Error('INSTRUCTIONS_TRANSITION_INVALID');
  const accepted=(bytes:Buffer)=>validFormat(bytes)&&(bytes.equals(expected)||legacy.some(row=>
    row.repositoryId===transition.repositoryId&&row.sha256===createHash('sha256').update(bytes).digest('hex')));
  // The validated checkout's complete Git index supplies paths; do not follow untracked directory junctions.
  const listing=execFileSync('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','ls-files','-z','--cached'],
    {cwd:workspace,encoding:'buffer',maxBuffer:128*1024*1024,timeout:60000,windowsHide:true});
  const paths=new TextDecoder('utf-8',{fatal:true}).decode(listing).split('\0').filter(isCarrier);
  for(const path of new Set(['AGENTS.md','AGENTS.override.md','.github/copilot-instructions.md','.github/instructions/runtime.instructions.md',
    ...(transition.templateSource?['templates/repository/AGENTS.md']:[]),...paths])) {
    if(path.split('/').some(p=>!p||p==='.'||p==='..'||p.includes('\\')))throw Error('INSTRUCTIONS_PATH_INVALID');
    let current=workspace,present=true;
    const parts=path.split('/');
    for(const [index,part] of parts.entries()) {
      current=join(current,part);let metadata;
      try{metadata=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){present=false;break;}throw error;}
      if(metadata.isSymbolicLink()||(index<parts.length-1?!metadata.isDirectory():!metadata.isFile()))throw Error('INSTRUCTIONS_PATH_TYPE: '+path);
    }
    if(path==='AGENTS.md') {
      if(!present)throw Error('INSTRUCTIONS_BYTES_DIFFER: AGENTS.md');
      const actual=await readFile(current);
      if(!accepted(actual))throw Error('INSTRUCTIONS_BYTES_DIFFER: AGENTS.md');
    }else if(present) {
      // The central source is a template artifact, not a second repository review policy.
      // A prior trusted validator must be able to admit the separately approved
      // next template. Use only its repository-bound digest transition, never
      // a registry supplied by the checkout being reviewed.
      if(transition.templateSource&&path==='templates/repository/AGENTS.md'&&accepted(await readFile(current)))continue;
      throw Error('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION: '+path);
    }
  }
}
