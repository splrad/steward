import {appendFile,readFile} from 'node:fs/promises';
import {EvidenceReadError,NativeEvidenceReader,nativeEvidenceTransport} from '../packages/runner/dist/index.js';
import {git,regular} from './validation-input.mjs';
import {readRepositoryPolicySelection} from './repository-policy-projection.mjs';
import {configurationConflicts,nativeReleaseConflict,parseRegistration,registrationPath} from './repository-registration-policy.mjs';
import {registrationProductPaths,registrationProposal} from './repository-registration-proposal.mjs';

function previewTransport(token) {
  const github=nativeEvidenceTransport(token);
  return {...github,async request(...args){
    const result=await github.request(...args);
    if(result.status===429||result.status===403&&(result.headers.get('x-ratelimit-remaining')==='0'||
      result.headers.has('retry-after')||/rate limit/i.test(result.bytes.toString('utf8'))))
      throw Error('VALIDATION_REGISTRATION_PREVIEW_RETRY_RATE_LIMIT');
    return result;
  }};
}

async function publicRepository(selection,io) {
  const getRepository=async()=>{
    const result=await io.request('GET','/repositories/'+selection.repositoryId);
    if(result.status!==200)throw new EvidenceReadError(result.status,result.headers.get('retry-after'));
    return JSON.parse(result.bytes.toString('utf8'));
  };
  const repository=await getRepository();
  if(repository.id!==selection.repositoryId||repository.full_name!==selection.repository||
    repository.owner?.login!=='splrad'||repository.owner.id!==302208797)
    throw Error('VALIDATION_REGISTRATION_PREVIEW_IDENTITY');
  if(repository.private!==false)return null;
  return {repository,reader:new NativeEvidenceReader(io,repository.full_name),getRepository};
}

async function withPublicRepository(selection,token,operation) {
  let publicIdentityVerified=false;
  for(const credential of token?[token,undefined]:[undefined]) {
    try {
      const target=await publicRepository(selection,previewTransport(credential));
      publicIdentityVerified||=Boolean(target);
      return target?await operation(target):null;
    } catch(error) {
      if(credential&&(error.status===403||error.status===404))continue;
      if(!publicIdentityVerified&&error.status===404)return null;
      throw error;
    }
  }
}

async function publicProposal({repository,reader,getRepository}) {
  if(repository.archived||repository.disabled)throw Error('VALIDATION_REGISTRATION_PREVIEW_INACTIVE');
  const branch=encodeURIComponent(repository.default_branch);
  const initial=await reader.json('branches/'+branch);
  const source=initial.commit?.sha;
  if(initial.protected!==true||!/^[a-f0-9]{40}$/.test(source??'')||initial.name!==repository.default_branch)
    throw Error('VALIDATION_REGISTRATION_PREVIEW_DEFAULT_BRANCH');
  const tree=await reader.json('git/trees/'+source+'?recursive=1');
  const paths=registrationProductPaths(tree),tracked=new Map(tree.tree.map(entry=>[entry.path,entry]));
  const read=async path=>{
    if(!tracked.has(path))return null;
    const file=await reader.json('contents/'+path+'?ref='+source);
    if(file.path!==path||file.type!=='file'||file.sha!==tracked.get(path).sha||file.encoding!=='base64')
      throw Error('VALIDATION_REGISTRATION_PREVIEW_CONTENT');
    return Buffer.from(file.content,'base64').toString('utf8');
  };
  const proposal=await registrationProposal(repository,read,paths);
  const latest=await getRepository();
  const current=await reader.json('branches/'+branch);
  if(latest.id!==repository.id||latest.full_name!==repository.full_name||latest.owner?.id!==repository.owner.id||
    latest.private!==false||latest.archived||latest.disabled||latest.default_branch!==repository.default_branch||
    current.name!==initial.name||current.protected!==true||current.commit?.sha!==source)
    throw Error('VALIDATION_REGISTRATION_PREVIEW_SOURCE_MOVED');
  return {proposal,source};
}

const messages={
  PRODUCT_CI:'当前配置需要从产品默认分支选择至少一个可运行的 CI 入口。仅适用组织公共检查的仓库可以留空。',
  RELEASE:'当前发行入口按产品已审声明冻结渠道和文件。请核对发行单元、渠道、产物和元数据，先让产品声明体现计划发布的范围。'
};

function neverAdopted(workspace,base,path,id) {
  const revisions=git(workspace,['log','--full-history','--format=%H',base,'--',path]).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return revisions.length>0&&revisions.every(revision=>{
    if(!git(workspace,['ls-tree',revision,'--',path]).length)return true;
    const policy=parseRegistration(git(workspace,['show',revision+':'+path]),id);
    return !policy.adoption||policy.adoption==='legacy';
  });
}

export async function validateRegistrationPreview(workspace,{input,files},env) {
  const paths=input.changedPaths.filter(path=>registrationPath.test(path));
  const token=env.REPOSITORY_POLICY_TOKEN;
  const summary=[];
  let invalid=false;
  const report=(path,note,failure=false)=>{
    console.log(`::${failure?'error':'notice'} file=${path},title=逐仓配置::${note}`);
    summary.push(`- \`${path}\`：${note}`);
    if(failure)invalid=true;
  };
  for(const path of paths) {
    const id=Number(registrationPath.exec(path)[1]);
    if(!files.includes(path)) {
      const previous=parseRegistration(git(workspace,['show',input.base+':'+path]),id);
      const centralRetirement=previous.adoption==='central';
      if(env.GITHUB_EVENT_NAME==='push'&&!centralRetirement)continue;
      const evidence=await withPublicRepository(previous,token,async({reader})=>({
        projection:await readRepositoryPolicySelection(reader,id,{useOptionalProjection:true,requireProtectedBranch:centralRetirement})
      }));
      if(centralRetirement) {
        if(evidence?.projection===null)
          summary.push('- '+path+'：已从受保护的治理分支确认旧投影撤回。');
        else report(path,'仍有旧投影或无法确认其撤回，暂时保留逐仓登记。',true);
        continue;
      }
      if(!evidence) {
        if(neverAdopted(workspace,input.base,path,id))
          summary.push('- '+path+'：登记历史中没有已采用的中央投影。');
        else report(path,'无法确认目标仓的撤回状态。保留该登记，直到旧配置的产品侧撤回可读回。',true);
        continue;
      }
      if(evidence.projection!==null&&evidence.projection.adoption!=='legacy')
        report(path,'请保留登记，先将目标仓回退到 legacy 并读回，再移除记录。',true);
      continue;
    }
    if(env.GITHUB_EVENT_NAME==='push')continue;
    const selection=parseRegistration(await readFile(await regular(workspace,path)),id);
    const transition=selection.adoption==='paused'||selection.adoption==='legacy';
    const observed=await withPublicRepository(selection,token,target=>transition?{identityVerified:true}:publicProposal(target));
    if(!observed) {
      report(path,'当前 PR 检查无法读取目标仓的公开声明。采用前，请按仓库 ID 运行私仓的登记复核。');
      continue;
    }
    if(transition) {
      summary.push('- '+path+'：目标仓身份相符。');
      continue;
    }
    const native=observed.proposal.nativeReleaseUnits;
    const previous=native&&git(workspace,['ls-tree',input.base,'--',path]).length
      ?parseRegistration(git(workspace,['show',input.base+':'+path]),id):null;
    const conflicts=configurationConflicts(selection,observed.proposal,previous?.release);
    if(conflicts.length) {
      for(const field of conflicts)report(path,native&&field==='RELEASE'?nativeReleaseConflict:messages[field],true);
    } else summary.push(`- \`${path}\`：与产品默认分支 \`${observed.source}\` 的声明相符。`);
  }
  if(summary.length&&env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,'### 逐仓配置复核\n\n'+summary.join('\n')+'\n\n');
  if(invalid)throw Error('VALIDATION_REGISTRATION_PREVIEW_SELECTION');
}
