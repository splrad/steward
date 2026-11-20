import YAML from 'yaml';
import {minimatch} from 'minimatch';
import {forkRunName} from './product-ci-evidence.mjs';
import {execFileSync} from 'node:child_process';
import {readFile,appendFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPolicy,dependencyMode,assertGovernanceOnlyScope,configurationCallers} from './private-dependency-policy.mjs';
import {parseRegistration,registrationPath,registrationWorkflow} from './repository-registration-policy.mjs';
import {assertLifecycleScope} from './private-lifecycle-policy.mjs';
import {NativeEvidenceReader,nativeEvidenceTransport} from '../packages/runner/dist/index.js';
import {assertRepositoryPolicyMarker,readRepositoryPolicySelection,
  repositoryPolicyAdoptionPath} from './repository-policy-projection.mjs';
const check=(ok,code)=>{if(!ok)throw Error('VALIDATION_'+code);};
export function git(workspace,args) {
  return execFileSync('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=',...args],
    {cwd:workspace,encoding:'buffer',maxBuffer:128*1024*1024,timeout:60000,windowsHide:true});
}
export async function regular(workspace,path) {
  const root=await realpath(workspace),file=join(root,path),actual=await realpath(file),info=await lstat(file);
  check(actual.startsWith(root+sep)&&info.isFile()&&!info.isSymbolicLink(),'FILE_BOUNDARY');return file;
}
// Community repositories can contain governance metadata alongside documentation.
const communityFiles=new Set([...configurationCallers,repositoryPolicyAdoptionPath,'LICENSE','.copier-answers.yml','.github/VULNERABILITY_REPORT.yml',
  '.github/labeler.yml','.github/release-template.md.mustache','.github/workflows/actions.lock',
  '.github/workflows/pr-labeler.yml','.github/workflows/pr-title.yml']);
export function documentationOnly(files) {
  return files.every(path=>communityFiles.has(path)||/^(?:\.github\/|docs\/)?CODEOWNERS$/.test(path)
    ||/^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path)||/\.(?:md|mdx|html?|png|jpe?g|gif|svg|webp|ico)$/i.test(path));
}
// The registered settings administrator owns upstream configuration, not the upstream application.
export function requiresProductCI(files,dependency,administrator) {
  if(dependency==='private-governance'||documentationOnly(files))return false;
  if(dependency!=='private-administrator')return true;
  const managed=new Set([administrator.workflow,registrationWorkflow,administrator.lockException?.manifestPath,administrator.lockException?.patchPath,
    'safe-settings/settings.yml','safe-settings/deployment-settings.yml','.gitignore','mise.toml','mise.lock',
    '.github/dependabot.yml','.github/renovate.json']);
  return files.some(path=>!documentationOnly([path])&&!managed.has(path)&&!registrationPath.test(path)
    &&!/^\.mise\/locks\/npm\/\d+\.\d+\.\d+\/(?:aube-lock\.yaml|package\.json)$/.test(path));
}
export function productWorkflows(value,files) {
  check(Array.isArray(value)&&value.length>0&&new Set(value).size===value.length,'PRODUCT_CI_DECLARATION');
  for(const path of value)check(typeof path==='string'&&/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(path)
    &&path!=='.github/workflows/pr-validation-native.yml'&&files.includes(path),'PRODUCT_CI_PATH');
  return value;
}
export function workflowEvent(triggers,type,action) {
  if(typeof triggers==='string')return triggers===type;
  if(Array.isArray(triggers))return triggers.includes(type);
  if(!triggers || !Object.hasOwn(triggers,type))return false;
  const types=triggers[type]?.types;
  return !types || Array.isArray(types) && types.includes(action);
}
// A required run must be scheduled for every changed path and every PR base.
function coversAll(patterns) {
  if(patterns===undefined)return true;
  if(!Array.isArray(patterns))return false;
  const all=patterns.findLastIndex(pattern=>pattern==='**' || pattern==='**/*');
  return all>=0 && !patterns.slice(all+1).some(pattern=>typeof pattern!=='string' || pattern.startsWith('!'));
}
function coversBranch(filters,branch) {
  if(!filters)return true;
  const {branches,'branches-ignore':ignore}=filters;
  if(!branches && !ignore && (filters.tags || filters['tags-ignore']))return false;
  if(!branch)return coversAll(branches) && !ignore?.length;
  const matches=pattern=>minimatch(branch,pattern,{dot:true,nonegate:true,nocomment:true,noext:true,nobrace:true});
  if(ignore)return Array.isArray(ignore) && !ignore.some(matches);
  if(!branches)return true;
  return Array.isArray(branches) && branches.reduce((included,pattern)=>{
    const negative=pattern.startsWith('!');
    return matches(negative?pattern.slice(1):pattern)?!negative:included;
  },false);
}
export function productCITriggerGap(workflow,defaultBranch) {
  const triggers=workflow.document?.on;
  if(workflow.path==='.github/workflows/pr-validation-native.yml')return '组织验证工作流';
  if(!workflowEvent(triggers,'push'))return '缺少 push 事件';
  const missing=['opened','synchronize','reopened'].filter(action=>!workflowEvent(triggers,'pull_request',action));
  if(missing.length)return '缺少 pull_request '+missing.join('、');
  for(const event of ['push','pull_request']) {
    const filters=triggers?.[event];
    if(!coversAll(filters?.paths) || filters?.['paths-ignore']?.length)return event+' 的路径筛选不能覆盖全部变更';
  }
  if(!coversBranch(triggers?.push,defaultBranch))return 'push 的分支或标签筛选未覆盖默认分支 '+(defaultBranch??'');
  if(!coversBranch(triggers?.pull_request))return 'pull_request 的分支筛选不能覆盖全部目标分支';
  return '';
}
export function selectableProductCI(workflow,defaultBranch) {
  return !productCITriggerGap(workflow,defaultBranch);
}
export async function validationFileInputs(workspace,env=process.env) {
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
  }else{check(env.GITHUB_EVENT_NAME==='push'&&typeof event.repository.default_branch==='string'&&event.ref==='refs/heads/'+event.repository.default_branch,'EVENT');base=event.before;head=event.after;}
  check([base,head].every(v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)&&!/^0+$/.test(v)),'COMMITS');
  for(const value of [base,head])check(git(workspace,['rev-parse','--verify',value+'^{commit}']).toString().trim()===value,'COMMITS');
  check(git(workspace,['rev-parse','HEAD']).toString().trim()===head,'CHECKOUT');
  check(git(workspace,['rev-parse','--is-shallow-repository']).toString().trim()==='false','SHALLOW');
  // Native Git supplies both rename sides for DOC-LINK. Scope matching belongs to paths-filter in trusted YAML.
  const changedPaths=new TextDecoder('utf-8',{fatal:true}).decode(git(workspace,['diff','--no-ext-diff','--no-textconv','--name-only','--no-renames','-z',base,head])).split('\0').filter(Boolean);
  const input={complete:true,repositoryId,base,head,workflowSha:env.WORKFLOW_SHA,changedPaths};
  const files=git(workspace,['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
  if(event.repository.full_name.startsWith('splrad/')&&changedPaths.includes(repositoryPolicyAdoptionPath)&&files.includes(repositoryPolicyAdoptionPath))
    assertRepositoryPolicyMarker(await readFile(await regular(workspace,repositoryPolicyAdoptionPath)));
  const policy=await loadPolicy();
  const dependency=dependencyMode(event,policy,env.PRIVATE_GOVERNANCE_REPOSITORY_ID);
  if(dependency==='private-administrator') {
    for(const path of files) {
      const registered=registrationPath.exec(path);
      if(registered)parseRegistration(await readFile(await regular(workspace,path)),Number(registered[1]));
    }
    for(const path of changedPaths.filter(path=>registrationPath.test(path)&&!files.includes(path))) {
      const previous=parseRegistration(git(workspace,['show',base+':'+path]),Number(registrationPath.exec(path)[1]));
      check(!previous.adoption||previous.adoption==='legacy','REPOSITORY_POLICY_ROLLBACK_REQUIRED');
    }
  }
  // Reject product inputs before scope outputs can schedule any candidate build.
  if(dependency==='private-governance')assertGovernanceOnlyScope(files);
  if(dependency==='private-lifecycle')assertLifecycleScope(files);
  const administrator=policy.administrators.find(item=>item.repositoryId===repositoryId);
  return {event,input,files,dependencyMode:dependency,administrator};
}

export async function validationInput(workspace,env=process.env) {
  const {event,input,files,dependencyMode:dependency,administrator}=await validationFileInputs(workspace,env);
  const {repositoryId}=input;
  const declaration='.github/product-ci.json';
  const productApplicable=files.includes(declaration)||requiresProductCI(files,dependency,administrator);
  const available=files.includes(declaration)
    ? productWorkflows(JSON.parse(await readFile(await regular(workspace,declaration),'utf8')),files) : [];
  const organizationRepository=event.repository.full_name.startsWith('splrad/');
  if(organizationRepository&&env.GITHUB_ACTIONS==='true')check(env.REPOSITORY_POLICY_TOKEN,'REPOSITORY_POLICY_TOKEN');
  const policyReader=env.REPOSITORY_POLICY_TOKEN&&organizationRepository
    ? new NativeEvidenceReader(nativeEvidenceTransport(env.REPOSITORY_POLICY_TOKEN),event.repository.full_name) : null;
  const selection=policyReader?await readRepositoryPolicySelection(policyReader,repositoryId,{useOptionalProjection:true}):null;
  const workflows=selectedProductWorkflows(selection,available,productApplicable);
  const boundNames=[];
  for(const path of workflows){
    const workflow=YAML.parse(await readFile(await regular(workspace,path),'utf8'));
    const triggers=workflow?.on;
    const type=env.GITHUB_EVENT_NAME;
    const gap=productCITriggerGap({path,document:workflow},event.repository.default_branch);
    check(!gap && workflowEvent(triggers,type,event.action),'PRODUCT_CI_TRIGGER '+path+' '+gap);
    if(workflow['run-name']===forkRunName)boundNames.push(path);
  }
  return {input,files,productApplicable,workflows,boundNames,dependencyMode:dependency,
    ...(selection?{repositoryPolicy:{adoption:selection.adoption,sourceDigest:selection.sourceDigest}}:{})};
}
export function selectedProductWorkflows(selection,available,productApplicable) {
  if(selection?.adoption!=='central')return available;
  check(selection.productCi.every(path=>available.includes(path))&&(!productApplicable||selection.productCi.length>0),'PRODUCT_CI_REPOSITORY_POLICY');
  return selection.productCi;
}
export async function main(env=process.env) {
  const workspace=resolve(env.VALIDATION_WORKSPACE??'target'),value=await validationInput(workspace,env);
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,Object.entries({productApplicable:value.productApplicable,workflows:JSON.stringify(value.workflows),boundNames:JSON.stringify(value.boundNames),dependencyMode:value.dependencyMode,base:value.input.base,head:value.input.head}).map(([k,v])=>`${k}=${v}\n`).join(''));
  if(env.VALIDATION_EVIDENCE)await writeFile(env.VALIDATION_EVIDENCE,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify({identity:value.input,workflows:value.workflows},null,2)+'\n```\n');
  return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
