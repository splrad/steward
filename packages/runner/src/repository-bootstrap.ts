import { createHash } from 'node:crypto';
import { decodeStateFile } from '../../core/src/release-observation.js';

export const bootstrapVariable = 'STEWARD_BOOTSTRAP_RECOVERY';
type Response = {status:number;value:any};
export interface BootstrapIO {request(method:string,path:string,body?:unknown):Promise<Response>}
export interface BootstrapRepository {id:number;full_name:string;name:string;default_branch:string;archived:boolean;disabled:boolean}
export interface BootstrapSource {workflowId:number;runId:number;runAttempt:number;controllerSha:string}
export interface BootstrapRule {ruleId:number;policyDigest:string;controllerWorkflow?:true}
interface AffectedRule {ruleId:number;excludedRepository:string;originalConditionsDigest:string;alreadyExcluded:boolean;lastWrittenConditionsDigest:string|null;observedAt:string}
export interface BootstrapRecovery extends BootstrapSource {
  schemaVersion:1;repositoryId:number;defaultBranch:string;firstCommitSha:string|null;
  phase:'PREPARED'|'TEMP_EXCLUDED'|'INITIALIZED'|'RESTORED';affectedRules:AffectedRule[];
}
const check=(value:unknown,reason:string):void=>{if(!value)throw Error('BOOTSTRAP_'+reason);};
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const commit=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const positive=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;

/** A trusted binding covers rule responsibility, never the mutable repository exclusions. */
export function bootstrapRulePolicyDigest(rule:any,controllerSha?:string):string {
  const value=structuredClone(rule.conditions);
  check(value?.repository_name&&Array.isArray(value.repository_name.exclude),'RULE_CONDITIONS');
  value.repository_name.exclude=[];
  const rules=structuredClone(rule.rules);
  if(controllerSha!==undefined) {
    const required=rules.filter((r:any)=>r.type==='workflows');
    check(commit(controllerSha)&&required.length===1&&required[0].parameters?.workflows?.length===1,'CONTROLLER_WORKFLOW');
    const workflow=required[0].parameters.workflows[0];
    check(workflow.repository_id===1296724484&&workflow.path==='.github/workflows/pr-validation-native.yml'&&workflow.sha===controllerSha,'CONTROLLER_WORKFLOW');
    workflow.sha='<controller-sha>';
  }
  return digest({name:rule.name,target:rule.target,enforcement:rule.enforcement,bypass_actors:rule.bypass_actors,rules,conditions:value});
}

export function decodeBootstrapRecovery(raw:string,repository:BootstrapRepository):BootstrapRecovery {
  check(Buffer.byteLength(raw,'utf8')<=32*1024,'VARIABLE_SIZE');
  const value=JSON.parse(raw);
  // The variable retains the baseline's closed recovery fields. Archive-only origin is not executable input.
  check(Object.keys(value).sort().join(',')===['schemaVersion','repositoryId','defaultBranch','workflowId','runId','runAttempt','controllerSha','firstCommitSha','phase','affectedRules'].sort().join(','),'VARIABLE_FIELDS');
  decodeStateFile('steward/governance-state',`bootstrap/${value.runId}-${value.runAttempt}.json`,Buffer.from(raw),repository.id);
  check(value.defaultBranch===repository.default_branch&&value.affectedRules.every((r:AffectedRule)=>r.excludedRepository===repository.name),'VARIABLE_TARGET');
  return value;
}

export async function bootstrapRepository(repository:BootstrapRepository,source:BootstrapSource,bindings:readonly BootstrapRule[],
  io:BootstrapIO,services:{verifySource:(source:BootstrapSource)=>Promise<void>;
    verifyProtection:(repository:BootstrapRepository)=>Promise<void>;
    archive:(record:BootstrapRecovery,origin:'app'|'external')=>Promise<string>;
    identity:{name:string;email:string;id:number};now:()=>string}) {
  check(positive(repository.id)&&repository.full_name===`splrad/${repository.name}`&&/^[A-Za-z0-9_.-]+$/.test(repository.name)
    &&repository.default_branch&&!repository.archived&&!repository.disabled,'TARGET');
  check([source.workflowId,source.runId,source.runAttempt].every(positive)&&commit(source.controllerSha),'SOURCE');
  check(new Set(bindings.map(b=>b.ruleId)).size===bindings.length&&bindings.every(b=>positive(b.ruleId)&&/^[a-f0-9]{64}$/.test(b.policyDigest)&&(b.controllerWorkflow===undefined||b.controllerWorkflow===true)),'RULE_BINDINGS');
  const prefix=`/repos/${repository.full_name}`,variable=`${prefix}/actions/variables/${bootstrapVariable}`;
  const native=async(method:string,path:string,body?:unknown,optional=false)=>{
    const response=await io.request(method,path,body);
    if(optional&&response.status===404)return null;
    check(response.status>=200&&response.status<300,'NATIVE_UNAVAILABLE');return response.value;
  };
  const current=await native('GET',prefix);
  check(current.id===repository.id&&current.full_name===repository.full_name&&current.owner?.id===302208797
    &&current.default_branch===repository.default_branch&&!current.archived&&!current.disabled,'TARGET_CHANGED');
  const readVariable=async()=>{
    const value=await native('GET',variable,undefined,true);
    check(value===null||value.name===bootstrapVariable&&typeof value.value==='string','VARIABLE_RESPONSE');return value?.value??null;
  };
  const pages=async(path:string)=>{
    const result:any[]=[];
    for(let page=1;page<=10000;page++) {
      const batch=await native('GET',`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
      check(Array.isArray(batch),'PAGINATION');result.push(...batch);
      if(batch.length<100)return result;
    }
    throw Error('BOOTSTRAP_PAGINATION_INCOMPLETE');
  };
  const refs=async()=>{
    const response=await io.request('GET',`${prefix}/git/matching-refs/`);
    if(response.status===409&&/^Git Repository is empty\.?$/i.test(response.value?.message??''))return [];
    check(response.status===200&&Array.isArray(response.value),'REFS_UNAVAILABLE');
    // matching-refs has no pagination; it returns every matching reference.
    const values=response.value;
    check(new Set(values.map((r:any)=>r.ref)).size===values.length&&values.every((r:any)=>typeof r.ref==='string'&&r.ref.startsWith('refs/')&&commit(r.object?.sha)),'REFS');
    return values;
  };
  let saved:string|null=await readVariable();
  const resuming=saved!==null;
  const firstRefs=await refs();
  if(saved===null&&firstRefs.length)return {status:'EXISTING' as const};
  await services.verifySource(source);
  const rule=async(id:number)=>{
    const binding=bindings.find(b=>b.ruleId===id);check(binding,'UNREGISTERED_RULE');
    const value=await native('GET',`/orgs/splrad/rulesets/${id}`);
    check(value.id===id&&value.source_type==='Organization'&&value.source==='splrad'&&value.target==='branch'&&value.enforcement==='active'
      &&bootstrapRulePolicyDigest(value,binding!.controllerWorkflow?source.controllerSha:undefined)===binding!.policyDigest,'RULE_POLICY_CHANGED');
    check(value.conditions.repository_name.exclude.every((name:unknown)=>typeof name==='string')&&value.conditions.ref_name,'RULE_CONDITIONS');return value;
  };
  let recovery:BootstrapRecovery;
  if(saved!==null) {
    recovery=decodeBootstrapRecovery(saved,repository);await services.verifySource(recovery);
    for(const affected of recovery.affectedRules)await rule(affected.ruleId);
  } else {
    const affectedRules:AffectedRule[]=[];
    for(const binding of bindings) {
      const value=await rule(binding.ruleId);
      affectedRules.push({ruleId:value.id,excludedRepository:repository.name,originalConditionsDigest:digest(value.conditions),
        alreadyExcluded:value.conditions.repository_name.exclude.includes(repository.name),lastWrittenConditionsDigest:null,observedAt:services.now()});
    }
    recovery={schemaVersion:1,repositoryId:repository.id,defaultBranch:repository.default_branch,...source,firstCommitSha:null,phase:'PREPARED',affectedRules};
  }
  const persist=async()=>{
    const encoded=JSON.stringify(recovery);decodeBootstrapRecovery(encoded,repository);
    check(await readVariable()===saved,'VARIABLE_CONCURRENT_CHANGE');
    try {await native(saved===null?'POST':'PATCH',saved===null?`${prefix}/actions/variables`:variable,{name:bootstrapVariable,value:encoded});}catch{}
    check(await readVariable()===encoded,'VARIABLE_WRITE_UNCONFIRMED');saved=encoded;
  };
  if(saved===null)await persist();
  const changeExclusion=async(affected:AffectedRule,add:boolean)=>{
    const latest=await rule(affected.ruleId),excluded:string[]=latest.conditions.repository_name.exclude;
    if(affected.alreadyExcluded)return;
    if(excluded.includes(repository.name)===add) {
      if(add&&affected.lastWrittenConditionsDigest===null) {
        const original=structuredClone(latest.conditions);original.repository_name.exclude=excluded.filter(n=>n!==repository.name);
        check(digest(original)===affected.originalConditionsDigest,'EXCLUSION_OWNERSHIP_UNKNOWN');
      }
      return;
    }
    if(!add&&affected.lastWrittenConditionsDigest===null) {
      const original=structuredClone(latest.conditions);original.repository_name.exclude=excluded.filter(n=>n!==repository.name);
      check(digest(original)===affected.originalConditionsDigest,'EXCLUSION_OWNERSHIP_UNKNOWN');
    }
    const conditions=structuredClone(latest.conditions);
    conditions.repository_name.exclude=add?[...excluded,repository.name]:excluded.filter(n=>n!==repository.name);
    // Only this field is sent. Native update preserves rule name, rules, bypass and other metadata.
    check(same((await rule(affected.ruleId)).conditions,latest.conditions),'RULE_CONCURRENT_CHANGE');
    try {await native('PUT',`/orgs/splrad/rulesets/${affected.ruleId}`,{conditions});}catch{}
    const observed=await rule(affected.ruleId);
    check(same(observed.conditions,conditions),'RULE_WRITE_UNCONFIRMED');
    affected.lastWrittenConditionsDigest=digest(conditions);affected.observedAt=services.now();await persist();
  };
  const restore=async()=>{
    let failed=false;
    for(const affected of recovery.affectedRules)try {await changeExclusion(affected,false);}catch{failed=true;}
    check(!failed,'RESTORE_INCOMPLETE');
    recovery.phase='RESTORED';await persist();
  };
  // On a later wake restore before considering any new initialization, even when refs exist.
  if(resuming)await restore();
  let failure:unknown=null;
  try {
    if((await refs()).length===0) {
      for(const affected of recovery.affectedRules) {
        if(!affected.alreadyExcluded) {
          const latest=await rule(affected.ruleId);
          if(!latest.conditions.repository_name.exclude.includes(repository.name)) {
            affected.originalConditionsDigest=digest(latest.conditions);affected.lastWrittenConditionsDigest=null;await persist();
          }
        }
        await changeExclusion(affected,true);
      }
      recovery.phase='TEMP_EXCLUDED';await persist();
      if((await refs()).length===0) {
        const message=`chore: initialize repository\n\nSigned-off-by: ${services.identity.name} <${services.identity.email}>\nSteward-Bootstrap-Run: 1296724484/${recovery.runId}/${recovery.runAttempt}\n`;
        try {await native('PUT',`${prefix}/contents/README.md`,{message,content:Buffer.from('# Repository\n').toString('base64'),branch:repository.default_branch});}catch{}
      }
    }
    const observed=await refs();
    check(observed.some((r:any)=>r.ref===`refs/heads/${repository.default_branch}`),'FIRST_COMMIT_UNAVAILABLE');
    const history=await pages(`${prefix}/commits?sha=${encodeURIComponent(repository.default_branch)}`);
    const roots=history.filter((c:any)=>Array.isArray(c.parents)&&c.parents.length===0);
    check(roots.length===1&&commit(roots[0].sha),'FIRST_COMMIT_HISTORY');
    if(recovery.firstCommitSha!==null)check(recovery.firstCommitSha===roots[0].sha,'FIRST_COMMIT_CHANGED');
    recovery.firstCommitSha=roots[0].sha;recovery.phase='INITIALIZED';await persist();
  }catch(error){failure=error;}
  await restore();
  if(failure)throw failure;
  const currentRefs=await refs();
  check(currentRefs.some((r:any)=>r.ref===`refs/heads/${repository.default_branch}`),'DEFAULT_BRANCH_MISSING');
  await services.verifyProtection(repository);
  const first=await native('GET',`${prefix}/commits/${recovery.firstCommitSha}`);
  const expected=`chore: initialize repository\n\nSigned-off-by: ${services.identity.name} <${services.identity.email}>\nSteward-Bootstrap-Run: 1296724484/${recovery.runId}/${recovery.runAttempt}\n`;
  const content=await native('GET',`${prefix}/contents/README.md?ref=${recovery.firstCommitSha}`,undefined,true);
  const origin=first.author?.id===services.identity.id&&first.commit?.message===expected&&content?.encoding==='base64'
    &&Buffer.from(content.content,'base64').toString()==='# Repository\n'?'app':'external';
  const archive=await services.archive(structuredClone(recovery),origin);check(commit(archive),'ARCHIVE_UNCONFIRMED');
  check(await readVariable()===saved,'VARIABLE_CONCURRENT_CHANGE');
  try{await native('DELETE',variable);}catch{}
  check(await readVariable()===null,'VARIABLE_DELETE_UNCONFIRMED');
  return {status:'READY' as const,firstCommitSha:recovery.firstCommitSha,origin,archive};
}
