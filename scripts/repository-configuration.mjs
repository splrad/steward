import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nativeReleaseApp} from '../packages/runner/dist/index.js';
import {authorized,authorizePull,delegatesPath,fileText} from './configuration-authorization.mjs';
import {client,commitFiles,dispatchTrial,findEvidence,must,openPull,positive,requestFromRun,rerunValidation,sha,trialInventory} from './configuration-native.mjs';
import {applySelection,digest,prepareTarget} from './configuration-selection.mjs';
import {ciPath,deliveryPath,inspectRepository,versionsPath} from './configuration-view.mjs';

const exec=promisify(execFile), lockPath='.github/workflows/actions.lock';
import {candidates,configurationForm,parseForm,planFromForm} from './configuration-form.mjs';
import {readBotComment,readSession,writeSession} from './configuration-session.mjs';
const receipt=(run)=>'Configuration request: '+run.id+'/'+run.run_attempt;
const page='.github/repository-configuration.md';
const pathsForModel=/^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml)$/;

async function snapshot(api,ref) {
  const tree=(await api.rest.git.getTree({...api.target,tree_sha:ref,recursive:'1'})).data;
  must(!tree.truncated,'Incomplete product tree');
  const files=new Map(tree.tree.filter(x=>x.type==='blob' && ['100644','100755'].includes(x.mode)).map(x=>[x.path,null]));
  const relevant=new Set(['.github/release-template.md.mustache',page,ciPath,deliveryPath,versionsPath,lockPath,'.release-please-manifest.json']);
  for(const path of files.keys()) if(pathsForModel.test(path)||path.startsWith('.github/actions/configuration/')) relevant.add(path);
  for(const path of relevant) if(files.has(path)) files.set(path,await fileText(api,path,ref));
  const model=inspectRepository(files);
  model.oids=new Map(tree.tree.filter(x=>files.has(x.path)).map(x=>[x.path,x.sha]));
  for(const [path,cfg] of Object.entries(model.versions?.packages??{})) {
    const version=cfg['version-file']??model.versions['version-file'];
    if(version) {
      const key=path==='.'?version:path+'/'+version;
      if(files.has(key)) files.set(key,await fileText(api,key,ref));
    }
  }
  return model;
}

export function optionState(model) {
  const relevant=new Set([ciPath,deliveryPath,versionsPath,'.release-please-manifest.json']);
  for(const workflow of model.workflows) relevant.add(workflow.path);
  for(const p of model.files.keys()) if(p.startsWith('.github/actions/configuration/')) relevant.add(p);
  for(const unit of model.delivery?.units??[]) {
    relevant.add(unit.notesPath);
    for(const path of unit.buildLocks??[]) relevant.add(path);
    for(const asset of unit.assets)if(asset.rightsSource)relevant.add(asset.rightsSource);
  }
  for(const [path,value] of Object.entries(model.versions?.packages??{})) {
    for(const file of [value['version-file']??model.versions['version-file'],value['changelog-path']??'CHANGELOG.md'])
      if(file)relevant.add(path==='.'?file:path+'/'+file);
  }
  const paths=[...model.files.keys()];
  for(const file of [...relevant]) {
    const source=model.files.get(file);
    if(typeof source!=='string')continue;
    for(const match of source.matchAll(/(?:^|[\s"'=])(?:\.\/)?([\w./-]+\.(?:sh|ps1|py|mjs|cjs|js|slnx?|csproj|toml|lock))(?:$|[\s"'])/gm)) {
      for(const p of paths)if(p===match[1]||p.endsWith('/'+match[1]))relevant.add(p);
    }
  }
  return new Map([...relevant].filter(p=>model.files.has(p)).sort().map(p=>[p,model.oids?.get(p)??digest(String(model.files.get(p)))]));
}

async function generateLock(files,changes,repo,token) {
  if(![...changes.keys()].some(path=>pathsForModel.test(path))) return;
  const directory=await mkdtemp(join(tmpdir(),'configuration-lock-'));
  try {
    const target=join(directory,'target');
    for(const [path,bytes] of files) if((pathsForModel.test(path)||path===lockPath) && bytes!==null) {
      const full=join(target,path);
      await mkdir(dirname(full),{recursive:true});
      await writeFile(full,bytes);
    }
    const proposed=join(directory,'proposed.json');
    await writeFile(proposed,JSON.stringify(Object.fromEntries([...changes].filter(([p])=>pathsForModel.test(p)))));
    await exec('uv',['run','--project','tools/template','--frozen','--no-sync','python','tools/template/configuration_lock.py',target,proposed,repo.full_name,process.env.GITHUB_SHA],
      {env:{PATH:process.env.PATH,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,SYSTEMROOT:process.env.SYSTEMROOT,
        READ_TOKEN:token,TMP:process.env.TMP,TEMP:process.env.TEMP}});
    const bytes=await readFile(join(target,lockPath),'utf8');
    if(files.get(lockPath)!==bytes) changes.set(lockPath,bytes);
  } finally {await rm(directory,{recursive:true,force:true});}
}

async function operatorApproval(api,write,actions,repo,base,head,number,actor) {
  const pr=(await api.rest.pulls.get({...api.target,pull_number:positive(number)})).data;
  must(pr.state==='open' && pr.base.repo.id===repo.id && pr.base.ref===repo.default_branch && pr.head.sha===head,'Approval head moved');
  const files=await api.paginate(api.rest.pulls.listFiles,{...api.target,pull_number:number,per_page:100});
  must(files.length===pr.changed_files,'Incomplete approval diff');
  const adminOnly=files.some(f=>[f.filename,f.previous_filename].includes(delegatesPath));
  must(await authorized(api,actor,base,adminOnly),'Administrator authorization required');
  const body='<!-- steward-config-approval '+head+' '+actor.id+' -->';
  const comments=await api.paginate(api.rest.issues.listComments,{...api.target,issue_number:number,per_page:100});
  let found=false;
  for(const comment of comments.filter(c=>c.body===body)) if(await readBotComment(api,comment)===body){found=true;break;}
  if(!found) await write.rest.issues.createComment({...api.target,issue_number:number,body});
  await rerunValidation(api,actions,pr);
}

export async function reconcile({repo,base,run,data,api,write,actions,readToken,load=snapshot,lock=generateLock,
  sessions={read:readSession,write:writeSession},find=findEvidence,dispatch=dispatchTrial,inventory=trialInventory}) {
  if(run.event==='pull_request_review') {
    const pr=(await api.rest.pulls.get({...api.target,pull_number:data.pull.number})).data;
    if(pr.head.sha===data.pull.head && await authorizePull(api,pr.number,pr.head.sha,repo.default_branch)) await rerunValidation(api,actions,pr);
    return;
  }
  let pr=await openPull(api,repo);
  let reason='';
  if(run.event==='push') {
    const associated=await api.paginate(api.rest.repos.listPullRequestsAssociatedWithCommit,{...api.target,commit_sha:base,per_page:100});
    if(associated.some(p=>p.merged_at && p.base.repo.id===repo.id && p.user.id===301115370 && p.head.ref.startsWith('steward/repository-configuration-'))) return;
    must(sha(data.before),'Missing previous default-branch commit');
    const prior=/^0{40}$/.test(data.before)?new Map():optionState(await load(api,data.before,{}));
    const next=optionState(await load(api,base,{}));
    const changed=[...new Set([...prior.keys(),...next.keys()])].filter(p=>prior.get(p)!==next.get(p));
    if(!changed.length)return;
    reason='默认分支配置依据有变化：'+changed.map(p=>'`'+p.replace(/[`<>\r\n]/g,'')+'`（'+(next.has(p)?prior.has(p)?'已修改':'新增':'已缺失')+'）').join('、');
  }
  if(data.trial && !pr) return;
  const branch=pr?.head.ref??'steward/repository-configuration-'+base;
  let state=await sessions.read(api,pr?.number);
  if(reason) state.notice=reason;
  const ref=(await api.rest.git.getRef({...api.target,ref:'heads/'+branch}).catch(e=>{if(e.status!==404)throw e;return {data:null};})).data;
  let head=ref?.object.sha??base;
  let tip;
  if(ref) {
    tip=(await api.rest.repos.getCommit({...api.target,ref:head})).data;
    if(!pr && head!==base) {
      const closed=await api.paginate(api.rest.pulls.list,{...api.target,head:repo.owner.login+':'+branch,state:'closed',per_page:100});
      if(closed.some(p=>p.head.sha===head && p.merged_at)) {
        // Do not force-reset or delete an existing branch. Use a fresh per-base branch after a merge.
        throw Error('The merged configuration branch is still present. Preserve its history before starting the next configuration.');
      }
      must(tip.author?.id===301115370 && tip.commit.verification?.verified && tip.commit.message.includes('Configuration request: '),'Unknown configuration branch owner');
      must(!closed.some(p=>p.head.sha===head),'A maintainer closed the previous configuration PR');
    }
  }
  must(!pr || head===pr.head.sha,'Open configuration branch moved');
  const replay=tip?.author?.id===301115370 && tip.commit.verification?.verified && tip.commit.message.split('\n').includes(receipt(run));
  const view=await load(api,head,{});
  let changes=new Map();
  const originalBody=pr?.body;
  if(data.pull && state.last!==receipt(run) && !replay) {
    must(pr?.number===data.pull.number && head===data.pull.head && originalBody===data.pull.body && state.head===head,'PR head or body moved');
    const previous=configurationForm(view,head,state);
    try {
    must(previous.body.replaceAll('\r\n','\n')===data.pull.previous?.replaceAll('\r\n','\n'),'Refresh the current configuration before editing');
    const values=parseForm(previous.body,data.pull.body,previous.items);
    const operations=Object.entries(values).filter(([k,v])=>k.startsWith('operation.') && v);
    must(operations.length<=1,'Select one operation per edit');
    const changedChannel=Object.entries(values).some(([id,value])=>id.startsWith('channel.') && previous.items.find(i=>i.id===id)?.value!==value);
    const op=operations[0]?.[0].slice('operation.'.length)??(changedChannel?'configure':'draft');
    for(const [k] of operations) delete values[k];
    state={...state,values,notice:''};
    if(op==='approve') {
      await operatorApproval(api,write,actions,repo,base,head,pr.number,run.triggering_actor);
      state.notice='已核验当前提交的配置授权。';
    } else if(op!=='draft') {
      const plan=planFromForm(view,state,op);
      if(op==='trial') {
        const selected=candidates(view,state.values).filter(c=>state.values[c.id+'.use']);
        const notices=[];
        for(const [index,target] of plan.targets.entries()) {
          try {
          const entry=selected[index];
          const known=await find(api,readToken,repo,base,head,target,view);
          if(known) state.evidence[entry.id]=known;
          else {
            const prepared=prepareTarget(view,target);
            must([...prepared.files].every(([path,bytes])=>view.files.get(path)===bytes),'Prepare and review the product scripts before requesting a trial');
            await dispatch(api,actions,repo,base,head,target,prepared.recipe);
          }
          } catch(error) {
            if(error.status || error.code) throw error;
            notices.push(target.unit+'/'+target.target+' · '+error.message);
          }
        }
        state.notice=['已核对构建请求。完成的归档在对应目标下列出。',...notices].join('\n');
      } else {
        changes=await applySelection(view,op,plan,{repo,readSource:path=>fileText(api,path,head),controllerSha:process.env.GITHUB_SHA,seed:await readFile('templates/release/steward-release-publish.yml','utf8'),
          inventory:(target,recipe)=>inventory(api,readToken,repo,base,head,target,recipe),describe:line=>{state.notice=[state.notice,line].filter(Boolean).join('\n');}});
        await lock(view.files,changes,repo,readToken);
      }
    }
    } catch(error) {
      changes=new Map();
      // Keep authorized drafts editable. Unknown API outcomes must be recovered by readback.
      if(error.status || error.code || /fetch failed/i.test(error.message)) throw error;
      state.notice='待调整：'+String(error.message).replace(/[<>\r\n]/g,' ').slice(0,400);
    }
  } else if(data.trial && state.head===head) {
    const plan=planFromForm(view,state,'trial');
    const selected=candidates(view,state.values).filter(c=>state.values[c.id+'.use']);
    for(const [index,target] of plan.targets.entries()) {
      const known=await find(api,readToken,repo,base,head,target,view,data.trial);
      if(known) state.evidence[selected[index].id]=known;
    }
  } else if(pr && !data.pull && !data.trial) {
    const compare=(await api.rest.repos.compareCommitsWithBasehead({...api.target,basehead:base+'...'+head})).data;
    if(compare.behind_by>0) {
      await write.rest.pulls.updateBranch({...api.target,pull_number:pr.number,expected_head_sha:head});
      const updated=(await api.rest.pulls.get({...api.target,pull_number:pr.number})).data;
      must(updated.head.sha!==head,'Branch update pending; retry the configuration run');
      head=updated.head.sha;
    }
  }
  const pageBytes=view.files.get(page);
  if(pageBytes && (!pr || changes.size || reason)) {
    const sources=[[ciPath,'产品 CI'],[versionsPath,'发行单元与版本文件'],['.release-please-manifest.json','已记录版本'],[deliveryPath,'资产与渠道'],
      ['.github/workflows/steward-release-publish.yml','正式构建'],['.github/workflows/pages.yml','文档站']];
    const links=sources.filter(([p])=>changes.has(p)||view.files.has(p)).map(([p,label])=>'- ['+label+']('+(p.startsWith('.github/')?p.slice(8):'../'+p)+')');
    const replacement=['<!-- steward-configuration-sources -->',...links,'<!-- /steward-configuration-sources -->'].join('\n');
    const updated=pageBytes.replace(/<!-- steward-configuration-sources -->[\s\S]*?<!-- \/steward-configuration-sources -->/,replacement);
    if(updated!==pageBytes)changes.set(page,updated);
  }
  if(!ref) await write.rest.git.createRef({...api.target,ref:'refs/heads/'+branch,sha:base});
  if(!replay && (changes.size || !pr && head===base)) {
    state.last=receipt(run);
    // Recover after a confirmed commit and an interrupted body/comment update.
    const recovery=Buffer.from(JSON.stringify({values:state.values})).toString('base64url');
    head=await commitFiles(write,repo,branch,head,changes,receipt(run)+'\nConfiguration actor: '+run.triggering_actor.id+'\nConfiguration form: '+recovery);
  } else if(replay && state.head!==head) {
    const saved=/^Configuration form: ([A-Za-z0-9_-]+)$/m.exec(tip.commit.message);
    if(saved) Object.assign(state,JSON.parse(Buffer.from(saved[1],'base64url')));
  }
  state.head=head;state.last=receipt(run);
  for(const [id,evidence] of Object.entries(state.evidence)) if(evidence.head!==head) delete state.evidence[id];
  const current=await load(api,head,{});
  const body=configurationForm(current,head,state).body;
  if(!pr) {
    try {await write.rest.pulls.create({...api.target,base:repo.default_branch,head:branch,title:'chore: 配置 '+repo.name+' 仓库功能',body});}
    catch(error) {if(!await openPull(api,repo)) throw error;}
    pr=await openPull(api,repo);
  }
  must(pr,'Configuration PR was not created');
  await sessions.write(write,pr.number,state);
  if(pr.body!==body) {
    const latest=(await api.rest.pulls.get({...api.target,pull_number:pr.number})).data;
    must(latest.body===pr.body && latest.head.sha===head,'PR body or head changed during reconciliation');
    await write.rest.pulls.update({...api.target,pull_number:pr.number,body});
  }
  must((await api.rest.pulls.get({...api.target,pull_number:pr.number})).data.head.sha===head,'Configuration PR readback failed');
  return {number:pr.number,head};
}
export async function main() {
  const id=positive(process.env.REPOSITORY_ID);
  must(process.env.GITHUB_REPOSITORY==='splrad/steward' && process.env.GITHUB_REPOSITORY_ID==='1296724484'
    && process.env.GITHUB_EVENT_NAME==='workflow_dispatch','Run configuration reconciliation from its central workflow');
  const app=await nativeReleaseApp(process.env.STEWARD_APP_PRIVATE_KEY);
  let repo=(await app.discover()).find(r=>r.id===id);
  must(repo && !repo.archived && !repo.disabled,'Repository not installed or inactive');
  const [owner,name]=repo.full_name.split('/');
  repo={...repo,owner:{login:owner},name};
  await app.forTemplateRepository(id,async(writeToken,readToken)=>{
    const api=client(readToken,repo),write=client(writeToken,repo);
    const base=(await api.rest.repos.getBranch({...api.target,branch:repo.default_branch})).data.commit.sha;
    const {run,data}=await requestFromRun(api,readToken,repo,process.env.REQUEST_RUN,process.env.REQUEST_ATTEMPT,base);
    await app.forRepository(id,async token=>reconcile({repo,base,run,data,api,write,actions:client(token,repo),readToken}),'configuration-actions');
  },'configuration-read');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{
  console.error(error.status?'Configuration GitHub request failed (HTTP '+error.status+')':error.message);process.exitCode=1;
});
