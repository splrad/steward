import {execFileSync} from 'node:child_process';
import {readFile,appendFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPolicy,dependencyMode,assertGovernanceOnlyScope} from './private-dependency-policy.mjs';
const check=(ok,code)=>{if(!ok)throw Error('VALIDATION_'+code);};
export function git(workspace,args) {
  return execFileSync('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=',...args],
    {cwd:workspace,encoding:'buffer',maxBuffer:128*1024*1024,timeout:60000,windowsHide:true});
}
export async function regular(workspace,path) {
  const root=await realpath(workspace),file=join(root,path),actual=await realpath(file),info=await lstat(file);
  check(actual.startsWith(root+sep)&&info.isFile()&&!info.isSymbolicLink(),'FILE_BOUNDARY');return file;
}
export function buildMode(files) {
  const modes=[['node',files.includes('package.json')],['dotnet',files.includes('CADFontAutoReplace.slnx')&&files.includes('global.json')],['python',files.includes('pyproject.toml')]].filter(([,selected])=>selected);
  check(modes.length<=1,'AMBIGUOUS_BUILD');
  const mode=modes[0]?.[0]??'none';
  check(mode!=='python'||files.includes('requirements-build.txt'),'PYTHON_BUILD_LOCK_MISSING');
  check(mode!=='none'||!files.some(p=>/\.(?:[cm]?[jt]sx?|cs|py|go|rs|java|cpp|c)$/.test(p)),'UNSUPPORTED_BUILD');
  return mode;
}
export async function validationInput(workspace,env=process.env) {
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  check(env.WORKFLOW_REPOSITORY==='splrad/steward'&&env.WORKFLOW_PATH==='.github/workflows/pr-validation-native.yml'
    &&/^[a-f0-9]{40}$/.test(env.WORKFLOW_SHA),'TRUSTED_SOURCE');
  const repositoryId=Number(env.GITHUB_REPOSITORY_ID);
  check(repositoryId===event.repository?.id&&event.repository?.full_name===env.GITHUB_REPOSITORY,'REPOSITORY');
  let base,head;
  if(env.GITHUB_EVENT_NAME==='pull_request'){
    check(event.pull_request?.base?.repo?.id===repositoryId,'PULL_SOURCE');
    base=event.pull_request.base.sha;head=event.pull_request.head.sha;
    const ref=event.pull_request.base.ref;
    git(workspace,['check-ref-format','--branch',ref]);
    check(git(workspace,['rev-parse','--verify',`refs/remotes/origin/${ref}^{commit}`]).toString().trim()===base,'BASE_MOVED');
  }else{check(env.GITHUB_EVENT_NAME==='push'&&event.ref==='refs/heads/main','EVENT');base=event.before;head=event.after;}
  check([base,head].every(v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)&&!/^0+$/.test(v)),'COMMITS');
  for(const value of [base,head])check(git(workspace,['rev-parse','--verify',value+'^{commit}']).toString().trim()===value,'COMMITS');
  check(git(workspace,['rev-parse','HEAD']).toString().trim()===head,'CHECKOUT');
  check(git(workspace,['rev-parse','--is-shallow-repository']).toString().trim()==='false','SHALLOW');
  // Native Git supplies both rename sides for DOC-LINK. Scope matching belongs to paths-filter in trusted YAML.
  const changedPaths=new TextDecoder('utf-8',{fatal:true}).decode(git(workspace,['diff','--no-ext-diff','--no-textconv','--name-only','--no-renames','-z',base,head])).split('\0').filter(Boolean);
  const input={complete:true,repositoryId,base,head,workflowSha:env.WORKFLOW_SHA,changedPaths};
  const files=git(workspace,['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
  const dependency=dependencyMode(event,await loadPolicy(),env.PRIVATE_GOVERNANCE_REPOSITORY_ID);
  // Reject product inputs before scope outputs can schedule any candidate build.
  if(dependency==='private-governance')assertGovernanceOnlyScope(files);
  const mode=buildMode(files);
  if(mode==='python')for(const path of ['pyproject.toml','requirements-build.txt'])await regular(workspace,path);
  return {input,files,mode,dependencyMode:dependency};
}
export async function main(env=process.env) {
  const workspace=resolve(env.VALIDATION_WORKSPACE??'target'),value=await validationInput(workspace,env);
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,Object.entries({mode:value.mode,dependencyMode:value.dependencyMode,base:value.input.base,head:value.input.head}).map(([k,v])=>`${k}=${v}\n`).join(''));
  if(env.VALIDATION_EVIDENCE)await writeFile(env.VALIDATION_EVIDENCE,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify({identity:value.input,mode:value.mode},null,2)+'\n```\n');
  return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
