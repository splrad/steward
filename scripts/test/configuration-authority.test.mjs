import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {planFromForm} from '../configuration-form.mjs';
import {sourceOptions} from '../pages-maintenance.mjs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authorizePull,checkEvent,protectedChanges,requestPath} from '../configuration-authorization.mjs';
import {dispatchTrial,findEvidence,requestFromRun,rerunValidation,trialInventory} from '../configuration-native.mjs';
import {inspectRepository,versionsPath,pagesPath} from '../configuration-view.mjs';
import {applySelection,prepareTarget,trialKey} from '../configuration-selection.mjs';
import {optionState,reconcile} from '../repository-configuration.mjs';
import YAML from 'yaml';
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),actor={id:12,login:'maintainer',type:'User'};
const repo={id:21,full_name:'splrad/sample',default_branch:'trunk',owner:{login:'splrad'}};
const response=data=>({data});
function fake(contents) {
  return {target:{},rest:{repos:{getContent:async({ref,path})=>{
    const value=contents.get(ref+'/'+path);
    if(value===undefined) throw Object.assign(Error('Missing'),{status:404});
    return response({type:'file',encoding:'base64',content:Buffer.from(value).toString('base64')});
  },getBranch:async()=>response({commit:{sha:B}}),getCollaboratorPermissionLevel:async()=>response({permission:'admin',user:actor})},
  pulls:{get:async()=>response({number:1,changed_files:1,head:{sha:A},base:{ref:'trunk'},state:'open'}),listFiles:()=>{},listReviews:()=>{}},
  issues:{listComments:()=>{}},actions:{getWorkflowRun:async()=>{},listWorkflowRuns:()=>{},listJobsForWorkflowRunAttempt:()=>{}}}};
}
test('manual run and rerun both require live administrator or delegated identity before any mutation',async()=>{
  const source=await readFile('templates/repository/'+requestPath,'utf8'), api=fake(new Map([[B+'/'+requestPath,source]]));
  const native={repository:repo,head_repository:repo,head_branch:'trunk',id:1,head_sha:B,run_attempt:2,status:'completed',conclusion:'success',
    path:requestPath,event:'workflow_dispatch',actor,triggering_actor:{...actor,id:13,login:'other'}};
  api.rest.actions.getWorkflowRun=async()=>response(native);
  const archive=async()=>({data:{event:'workflow_dispatch',repository:21,actor:12,source:B,run:'1',attempt:'2'}});
  await assert.rejects(requestFromRun(api,'',repo,1,2,B,archive),/administrator/);
  native.triggering_actor=actor;
  assert.equal((await requestFromRun(api,'',repo,1,2,B,archive)).data.actor,12);
  await assert.rejects(requestFromRun(api,'',repo,1,1,B,archive),/Stale/);
});

test('first CI adoption, prior and proposed inputs, renames, exact heads and merge group bytes are protected',async()=>{
  const old='.github/workflows/old.yml',next='.github/workflows/next.yml',ci='.github/product-ci.json';
  const api=fake(new Map([[A+'/'+ci,JSON.stringify([next])],[B+'/'+ci,JSON.stringify([old])]]));
  const changed={filename:next,previous_filename:old,status:'renamed',sha:C};
  const review={state:'APPROVED',commit_id:A,user:actor};
  api.paginate=async method=>method===api.rest.pulls.listFiles?[changed]:method===api.rest.pulls.listReviews?[review]:[];
  assert.deepEqual([...(await protectedChanges(api,[changed],B,A))].sort(),[next,old].sort());
  assert.equal(await authorizePull(api,1,A,'trunk'),true);
  review.commit_id=B;
  await assert.rejects(authorizePull(api,1,A,'trunk'),/required/);review.commit_id=A;
  const groupRepo={...repo,default_branch:'trunk'};
  const compare={files:[{...changed,sha:B}],commits:[{sha:A}],total_commits:1};
  api.rest.repos.compareCommitsWithBasehead=async()=>response(compare);
  api.rest.repos.listPullRequestsAssociatedWithCommit=()=>{};
  const prior=api.paginate;api.paginate=async method=>method===api.rest.repos.listPullRequestsAssociatedWithCommit?
    [{number:1,head:{sha:A},base:{ref:'trunk'},state:'open'}]:prior(method);
  await assert.rejects(checkEvent(api,{repository:groupRepo,merge_group:{base_sha:B,head_sha:A}}),/without exact pull approval/);
  compare.files=[changed];await checkEvent(api,{repository:groupRepo,merge_group:{base_sha:B,head_sha:A}});
  const first=fake(new Map([[A+'/'+ci,JSON.stringify([next])]]));
  assert.ok((await protectedChanges(first,[{filename:ci}],B,A)).has(ci));
});
test('delegate renames and adopted configuration manifest or entry page require authorization',async()=>{
  const delegates='.github/configuration-delegates.json', paths=['.release-please-manifest.json','.github/repository-configuration.md'];
  assert.ok((await protectedChanges(fake(new Map()),[{filename:'moved.json',previous_filename:delegates}],B,A)).has(delegates));
  const adopted=fake(new Map([[B+'/'+requestPath,'adopted']]));
  for(const path of paths) assert.ok((await protectedChanges(adopted,[{filename:path}],B,A)).has(path));
});
test('only the recorded candidate can advance the existing manifest without configuration approval',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'candidate-manifest-'));
  t.after(()=>rm(dir,{force:true,recursive:true}));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
  git('init','--quiet');git('config','user.name','Candidate fixture');git('config','user.email','candidate@example.invalid');
  const path='.release-please-manifest.json';
  const commit=async version=>{
    const manifest=JSON.stringify({'tools/route':version})+'\n';
    await writeFile(join(dir,path),manifest);git('add',path);
    git('-c','commit.gpgsign=false','commit','--quiet','-m','Release '+version);
    return [git('rev-parse','HEAD'),manifest];
  };
  const [base,old]=await commit('2.4.1'),[published,generated]=await commit('2.4.2'),[manual,changed]=await commit('3.0.0');
  const contents=new Map([[base+'/'+requestPath,'adopted'],[base+'/'+path,old],[published+'/'+path,generated],
    [manual+'/'+path,changed],[C+'/state.json',JSON.stringify({repositoryId:repo.id,candidate:{prNumber:2,branch:'steward/release-candidate',
      publishedHead:published,generatedSnapshotPath:'generated/fixture.json',pendingWrite:null}})]]);
  const api=fake(contents);
  let head=published;
  api.rest.git={getRef:async()=>response({object:{sha:C}})};
  api.rest.repos.getBranch=async()=>response({commit:{sha:base}});
  api.rest.pulls.get=async()=>response({number:2,state:'open',changed_files:1,user:{id:301115370},
    head:{repo,sha:head,ref:'steward/release-candidate'},base:{repo,ref:'trunk'}});
  api.paginate=async method=>method===api.rest.pulls.listFiles?git('diff','--name-only',base,head).split('\n').map(filename=>({filename})):[];
  assert.equal(await authorizePull(api,2,published,'trunk'),true);
  head=manual;
  await assert.rejects(authorizePull(api,2,manual,'trunk'),/Configuration approval is required/);
});

test('retries only the configuration authorization step failure',async()=>{
  const api=fake(new Map()),retry=[];
  api.rest.actions.listWorkflowRunsForRepo=()=>{};
  api.paginate=async method=>method===api.rest.actions.listWorkflowRunsForRepo?[{id:3,path:'.github/workflows/pr-validation-native.yml',conclusion:'failure',status:'completed',run_attempt:1}]:
    [{id:5,name:'Validation scope',conclusion:'failure',steps:[{name:'Install dependencies',conclusion:'failure'}]},
      {id:6,name:'Validation scope',conclusion:'failure',steps:[{name:'Authorize repository configuration',conclusion:'failure'}]}];
  await rerunValidation(api,{rest:{actions:{reRunJobForWorkflowRun:async args=>retry.push(args.job_id)}}},{head:{sha:A}});
  assert.deepEqual(retry,[6]);
});
test('an existing container job with a service can provide bound native evidence without translating its commands',async()=>{
  const path='.github/workflows/build.yml',doc={on:'workflow_dispatch',jobs:{pack:{'runs-on':'ubuntu-24.04',container:'example',
    services:{db:{image:'postgres'}},steps:[{uses:'./reviewed-custom-action'},{name:'Upload release files',uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:'bin',path:'out'}}]}}};
  const model=inspectRepository(new Map([[path,YAML.stringify(doc)]]));
  const api=fake(new Map()), native={id:2,run_attempt:1,repository:repo,head_repository:repo,head_sha:B,path,status:'completed',conclusion:'success',html_url:'https://github.com/splrad/sample/actions/runs/2'};
  api.rest.repos.getCommit=async()=>response({commit:{tree:{sha:C}}});
  api.rest.actions.getWorkflowRun=async()=>response(native);
  api.paginate=async(method,args)=>method===api.rest.actions.listJobsForWorkflowRunAttempt?
    [{id:13,name:'pack',conclusion:'success',steps:[{name:'Upload release files',conclusion:'success',started_at:'2026-11-17T10:00:00Z',completed_at:'2026-11-17T10:00:05Z'}]}]:
    args.workflow_id==='build.yml' && args.head_sha===B?[native]:[];
  const result=await findEvidence(api,'',repo,B,A,{unit:'x',target:'one',workflow:path,job:'pack',matrix:{},archive:'bin'},model,undefined,
    (...args)=>trialInventory(...args,async()=>({asset:{created_at:'2026-11-17T10:00:01Z'},data:[{path:'app.zip',size:100}]})));
  assert.equal(result.binding.sourceSha,B);assert.equal(result.head,A);assert.equal(result.files[0].size,100);
});
test('a successful trial with an expired artifact can be requested again',async()=>{
  const path='.github/workflows/repository-configuration-trial.yml';
  const source=await readFile('templates/repository/'+path,'utf8'), api=fake(new Map([[B+'/'+path,source]]));
  const target={unit:'route',target:'hosted'},recipe={runner:'ubuntu-24.04',output:'out',tools:{},steps:[]};
  const key=trialKey(A,target.unit,target.target,recipe);
  const run={id:11,run_attempt:1,actor:{id:301115370},display_title:'Configuration trial '+A+' route/hosted '+key,status:'completed',conclusion:'success'};
  const asset={name:'trial-'+key+'-11-1',expired:true,expires_at:new Date(Date.now()+60000).toISOString()};
  api.rest.actions.listWorkflowRunArtifacts=()=>{};
  api.paginate=async method=>method===api.rest.actions.listWorkflowRuns?[run]:[asset];
  const requests=[];
  const actions={rest:{actions:{createWorkflowDispatch:async input=>requests.push(input)}}};
  await dispatchTrial(api,actions,repo,B,A,target,recipe);
  assert.equal(requests.length,1);
  asset.expired=false;
  await dispatchTrial(api,actions,repo,B,A,target,recipe);
  assert.equal(requests.length,1);
});
test('trial approvals bind output and tools as well as source, and preserve native Pages and version policies',async()=>{
  const recipe={runner:'ubuntu-24.04',output:'out',steps:[],tools:{}};
  assert.notEqual(trialKey(A,'app','linux',recipe),trialKey(A,'app','linux',{...recipe,output:'debug'}));
  const pages={jobs:{select:{if:"vars.STEWARD_DOCS_SOURCE != ''"},build:{if:"!cancelled() && needs.select.outputs.ready == 'true'",steps:[]},
    deploy:{if:"vars.STEWARD_DOCS_SOURCE == 'default-branch' || vars.STEWARD_DOCS_SOURCE == 'release'"}}};
  const files=new Map([[versionsPath,JSON.stringify({packages:{'.':{'release-type':'node'}}})],['VERSION','1.2.3'],['CHANGELOG.md','notes'],[pagesPath,YAML.stringify(pages)]]);
  const plan={site:{source:'default-branch',build:true,deploy:false},versions:[{path:'.',versionFile:'VERSION',changelog:'CHANGELOG.md'}]};
  const first=await applySelection(inspectRepository(files),'configure',plan,{});
  assert.equal(JSON.parse(first.get(versionsPath)).packages['.']['release-type'],'node');
  assert.match(YAML.parse(first.get(pagesPath)).jobs.deploy.if,/^\(false .*vars\.STEWARD_DOCS_SOURCE/);
  for(const [p,b] of first)files.set(p,b);
  assert.equal((await applySelection(inspectRepository(files),'configure',plan,{})).size,0);
  plan.site.deploy=true;
  assert.match(YAML.parse((await applySelection(inspectRepository(files),'configure',plan,{})).get(pagesPath)).jobs.deploy.if,/^\(true .*vars\.STEWARD_DOCS_SOURCE/);
});
test('adding a Windows asset preserves selected Linux files and channel metadata',()=>{
  const model=inspectRepository(new Map([['.github/delivery.json',JSON.stringify({schemaVersion:2,units:[{id:'cli',path:'.',
    assets:[{id:'linux',name:'cli.zip'},{id:'symbols',name:'symbols.zip'}],
    channels:[{id:'github-release',location:'github',required:true,artifactIds:['linux','symbols'],metadata:['SHA256SUMS']}]}]})]]));
  const file='win.zip',asset='s1.f'+createHash('sha256').update(file).digest('hex').slice(0,16);
  const state={evidence:{s1:{files:[{path:file}],binding:{}}},values:{'s1.use':true,'s1.unit':'cli','s1.target':'windows',
    's1.dest.github-release':'github',[asset+'.use']:true,[asset+'.id']:'win',[asset+'.github-release']:true,
    'channel.cli.github-release.asset.symbols':false}};
  const [edit]=planFromForm(model,state,'select').channels;
  assert.deepEqual(edit.artifactIds,['linux','win']);assert.deepEqual(edit.metadata,['SHA256SUMS']);
});
test('a failed target in the same release unit cannot add its existing asset to another channel',async()=>{
  const assets=['linux','windows'].map(id=>({id,name:id+'.zip',mediaType:'application/zip'}));
  const unit={id:'cli',path:'.',notesPath:'notes.md',assets,channels:[{id:'github-release',location:'github',required:true}]};
  const files=new Map([['.github/delivery.json',JSON.stringify({schemaVersion:2,repositoryAuthors:[{id:12,evidence:'fixture'}],units:[unit]})],
    ['release-please-config.json',JSON.stringify({packages:{'.':{'version-file':'VERSION'}}})],['VERSION','1.0.0'],['notes.md','notes'],
    ['pack.sh','true'],['.github/workflows/steward-release-channels.yml','adopted native adapter'],['.github/release-template.md.mustache','notes'],['.github/workflows/repository-configuration-trial.yml','protected']]);
  const model=inspectRepository(files),state={values:{signing:true},evidence:{}};
  for(const [index,asset] of assets.entries()){
    const id='s'+(index+1),field=id+'.f'+createHash('sha256').update(asset.name).digest('hex').slice(0,16);
    for(const [k,v] of Object.entries({use:true,unit:'cli',target:asset.id,path:'.',entry:'pack.sh',directory:'.',runner:'ubuntu-24.04',shell:'bash',
      command:'sh pack.sh',output:'out',notes:'notes.md','dest.ghcr-assets':'ghcr.io/splrad/fixture'}))state.values[id+'.'+k]=v;
    Object.assign(state.values,{[field+'.use']:true,[field+'.ghcr-assets']:true,[field+'.id']:asset.id,[field+'.name']:asset.name,[field+'.type']:asset.mediaType});
    state.evidence[id]={files:[{path:asset.name}],binding:{}};
  }
  const plan=planFromForm(model,state,'select');
  for(const t of plan.targets) for(const [path,bytes] of prepareTarget(model,t).files)files.set(path,bytes);
  const seed=await readFile('templates/release/steward-release-publish.yml','utf8');
  const {renderBuild}=await import('../configuration-build.mjs');
  const adopted=renderBuild(seed,plan.targets.map(t=>({unit:'cli',target:t.target,recipe:{runner:t.runner,steps:[{shell:'pwsh',
    name:'Run reviewed packaging entry',run:'node product/'+prepareTarget(model,t).path}],output:'out'},files:[{id:t.target,path:t.target+'.zip',pattern:t.target+'.zip'}]})),{signing:'not-applicable'});
  files.set('.github/workflows/steward-release-publish.yml',adopted);
  const warnings=[];
  const changes=await applySelection(inspectRepository(files),'select',plan,{seed,describe:m=>warnings.push(m),inventory:async t=>{
    if(t.target==='windows')throw Error('Expired artifact');return [{path:'linux.zip'}];
  }});
  const saved=JSON.parse(changes.get('.github/delivery.json')).units[0];
  assert.deepEqual(saved.channels.find(c=>c.id==='ghcr-assets').artifactIds,['linux']);
  assert.deepEqual(saved.assets.map(a=>a.id).sort(),['linux','windows']);
  assert.ok(warnings.some(m=>m.includes('windows') && m.includes('Expired artifact')));
});
test('reviewed Pages source selects the same unit for maintenance even with legacy online settings',async()=>{
  const workflow=Buffer.from(YAML.stringify({env:{STEWARD_DOCS_SOURCE:'release',STEWARD_DOCS_UNIT:'maps'}}));
  const path='.github/workflows/pages.yml',read=[];
  const reader={path:p=>p,io:{request:async(_,name)=>{
    read.push(name);return {status:200,bytes:Buffer.from(JSON.stringify({name:'STEWARD_DOCS_SOURCE',value:'default-branch'}))};
  }},json:async p=>p.startsWith('git/')?{ref:'refs/heads/trunk',object:{type:'commit',sha:B}}:
    {type:'file',path,encoding:'base64',content:workflow.toString('base64'),size:workflow.length,
      sha:createHash('sha1').update('blob '+workflow.length+'\0').update(workflow).digest('hex')}};
  const options=await sourceOptions(reader,repo,C,301115370);
  assert.equal(options.mode,'release');assert.equal(options.unitId,'maps');
  assert.deepEqual(read,['actions/variables/STEWARD_DOCS_SOURCE']);
});
test('a README-only push or completed configuration merge cannot create another PR',async()=>{
  const before=inspectRepository(new Map([['README.md','first']]));
  const after=inspectRepository(new Map([['README.md','second']]));
  assert.deepEqual(optionState(before),optionState(after));
  const changed=inspectRepository(new Map([['.github/workflows/build.yml','jobs: {}']]));
  assert.notDeepEqual(optionState(after),optionState(changed));
  const api=fake(new Map());
  api.rest.pulls.list=()=>{};api.rest.repos.listPullRequestsAssociatedWithCommit=()=>{};
  api.paginate=async()=>[];
  await reconcile({repo,base:A,api,write:null,run:{event:'push'},data:{before:B},load:async(_,ref)=>ref===A?after:before});
  api.paginate=async method=>method===api.rest.pulls.list?[]:[{merged_at:'now',base:{repo},head:{ref:'steward/repository-configuration-'+B},user:{id:301115370}}];
  await reconcile({repo,base:A,api,write:null,run:{event:'push'},data:{before:B},load:()=>{throw Error('Unexpected snapshot');}});
});

test('retains the product signing job and untouched release units when changing one managed producer',async()=>{
  const {renderBuild,adaptBuild}=await import('../configuration-build.mjs');
  const seed=await readFile('templates/release/steward-release-publish.yml','utf8');
  const target=(unit,label)=>({unit,target:'native',files:[{id:unit,path:unit+'.zip'}],recipe:{runner:label,output:'out',steps:[
    {name:'Run reviewed packaging entry',shell:'pwsh',run:'node product/.github/actions/configuration/'+unit+'/native/run.mjs'}]}});
  const one=target('one','ubuntu-24.04'),two=target('two','windows-2025');
  const adopted=YAML.parse(renderBuild(seed,[one,two],{signing:'not-applicable'}));
  adopted.jobs.sign={environment:'product-sign',steps:[{name:'Sign verified outputs',run:'./sign-approved.ps1'}]};
  adopted.jobs['custom-check']={needs:'sign',steps:[{run:'verify-signature'}]};
  const previous=adopted.jobs.build.steps.filter(s=>s.if?.includes("matrix.unit == 'two'"));
  const next=YAML.parse(adaptBuild(YAML.stringify(adopted),seed,[{...one,files:[{id:'revised',path:'release.zip'}]}]));
  assert.deepEqual(next.jobs.sign,adopted.jobs.sign);assert.deepEqual(next.jobs['custom-check'],adopted.jobs['custom-check']);
  assert.deepEqual(next.jobs.build.steps.filter(s=>s.if?.includes("matrix.unit == 'two'")),previous);
  adopted.jobs.build.steps.find(s=>s.name==='Collect selected files').run+='\n./custom-inspection';
  assert.throws(()=>adaptBuild(YAML.stringify(adopted),seed,[one]),/jobs.build/);
});
