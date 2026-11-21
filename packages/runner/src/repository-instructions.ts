import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

interface InstructionTransition {
  repositoryId?: number;
  legacy?: readonly {repositoryId:number;sha256:string}[];
  templateSource?: boolean;
  head?: string;
}
const repositoryRulesBegin = '<!-- BEGIN SPLRAD REPOSITORY REVIEW RULES -->';
const repositoryRulesEnd = '<!-- END SPLRAD REPOSITORY REVIEW RULES -->';
const repositoryRulesStart = `\n${repositoryRulesBegin}\n`;
const repositoryRulesFinish = `\n${repositoryRulesEnd}\n`;
const emptyRepositoryRules = repositoryRulesStart + repositoryRulesFinish;
const hasRepositoryRulesMarker = (body:string) => body.includes(repositoryRulesBegin)
  || body.includes(repositoryRulesEnd);

function validFormat(bytes:Buffer):boolean {
  const body=bytes.toString('utf8');
  return bytes.equals(Buffer.from(body))&&!body.startsWith('\uFEFF')&&!body.includes('\r')&&!body.includes('\0')
    &&body.endsWith('\n')&&!body.endsWith('\n\n')&&body.includes('## Code Review Rules');
}

function reviewTemplateForm(bytes:Buffer):Buffer | undefined {
  if (!validFormat(bytes)) return undefined;
  const body = bytes.toString('utf8');
  const start = body.indexOf(repositoryRulesStart);
  if (start === -1) return hasRepositoryRulesMarker(body) ? undefined : bytes;
  const publicRules = body.slice(0, start);
  if (!validFormat(Buffer.from(publicRules)) || hasRepositoryRulesMarker(publicRules)) return undefined;
  if (!body.endsWith(repositoryRulesFinish) || body.length - start < emptyRepositoryRules.length) return undefined;
  const repositoryRules = body.slice(start + repositoryRulesStart.length, -repositoryRulesFinish.length);
  if (hasRepositoryRulesMarker(repositoryRules) || (repositoryRules && !/[^ \t\n]/.test(repositoryRules))) return undefined;
  return Buffer.from(publicRules + emptyRepositoryRules, 'utf8');
}

const isCarrier=(path:string)=>/(^|\/)(AGENTS(?:\.override)?\.md|\.github\/copilot-instructions\.md)$/.test(path)
  ||/(^|\/)\.github\/instructions\/.*\.instructions\.md$/.test(path);

/** Check the complete trusted public rules and the shape of the optional repository rules. */
export async function assertRepositoryInstructions(workspace:string, expected:Buffer, transition:InstructionTransition={}):Promise<void> {
  if (!reviewTemplateForm(expected)?.equals(expected)) throw Error('INSTRUCTIONS_TEMPLATE_INVALID');
  const {head} = transition;
  if (head !== undefined && !/^[a-f0-9]{40}$/.test(head)) throw Error('INSTRUCTIONS_HEAD_INVALID');
  const legacy=transition.legacy??[];
  if(!Array.isArray(legacy)||legacy.some(row=>!row||!Number.isSafeInteger(row.repositoryId)||row.repositoryId<=0||!/^([a-f0-9]{64})$/.test(row.sha256)))
    throw Error('INSTRUCTIONS_TRANSITION_INVALID');
  const acceptedTemplate=(bytes:Buffer)=>bytes.equals(expected)||legacy.some(row=>
    row.repositoryId===transition.repositoryId&&row.sha256===createHash('sha256').update(bytes).digest('hex'));
  const git = (args:string[]) => execFileSync('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],
    {cwd:workspace,encoding:'buffer',maxBuffer:128*1024*1024,timeout:60000,windowsHide:true});
  // The validated checkout's complete Git index supplies paths; committed blobs supply the policy bytes in CI.
  const listing = git(['ls-files','-z','--cached']);
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
      const actual=reviewTemplateForm(head ? git(['show',`${head}:${path}`]) : await readFile(current));
      if(!actual||!acceptedTemplate(actual))throw Error('INSTRUCTIONS_BYTES_DIFFER: AGENTS.md');
    }else if(present) {
      // The central source is a template artifact, not a second repository review policy.
      // A prior trusted validator must be able to admit the separately approved
      // next public template via its repository-bound digest transition.
      if(transition.templateSource&&path==='templates/repository/AGENTS.md') {
        const actual = head ? git(['show',`${head}:${path}`]) : await readFile(current);
        if (reviewTemplateForm(actual)?.equals(actual) && acceptedTemplate(actual)) continue;
      }
      throw Error('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION: '+path);
    }
  }
}
