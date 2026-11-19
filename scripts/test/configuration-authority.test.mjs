import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {selectWorkflow} from '../configuration-build.mjs';
import {candidates,planFromForm} from '../configuration-form.mjs';
import {documentationOnly,requiresProductCI,selectableProductCI} from '../validation-input.mjs';
import {sourceOptions} from '../pages-maintenance.mjs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authorizePull,checkEvent,protectedChanges,requestPath} from '../configuration-authorization.mjs';
import {dispatchTrial,findEvidence,nativeChannelJobs,requestFromRun,rerunValidation,trialInventory} from '../configuration-native.mjs';
import {inspectRepository,versionsPath,pagesPath} from '../configuration-view.mjs';
import {applySelection,assertChannelWorkflow,prepareTarget,trialKey} from '../configuration-selection.mjs';
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
test('stacked pull requests compare their native base and retain the default branch authorization source',async()=>{
  const path='.github/product-ci.json',api=fake(new Map([[C+'/'+path,'[]'],[A+'/'+path,'[]']]));
  api.rest.pulls.get=async()=>response({number:1,state:'open',changed_files:1,head:{sha:A},base:{ref:'feature',sha:C}});
  const review={state:'APPROVED',commit_id:A,user:actor};
  let file='docs/intro.md';
  api.paginate=async method=>method===api.rest.pulls.listFiles?[{filename:file}]:method===api.rest.pulls.listReviews?[review]:[];
  assert.equal(await authorizePull(api,1,A,'trunk'),false);
  file=path;assert.equal(await authorizePull(api,1,A,'trunk'),true);
  review.commit_id=B;await assert.rejects(authorizePull(api,1,A,'trunk'),/approval is required/);
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

test('formal workflow references retain both revisions and exclude independent product workflows',async()=>{
  const publisher='.github/workflows/steward-release-publish.yml',prior='.github/workflows/old.yml',next='.github/workflows/new.yml';
  const nested='.github/workflows/reusable.yml',other='.github/workflows/unselected.yml';
  const publish=workflow=>YAML.stringify({jobs:{build:{steps:[{run:'node scripts/configuration-native-artifact.mjs','working-directory':'configuration-controller',
    env:{PRODUCER:Buffer.from(JSON.stringify({workflow})).toString('base64url')}}]}}});
  const contents=new Map([[B+'/'+requestPath,'on: push'],[B+'/'+publisher,publish(prior)],[A+'/'+publisher,publish(next)],
    [A+'/'+next,YAML.stringify({jobs:{build:{uses:'./'+nested}}})]]);
  const changes=await protectedChanges(fake(contents),[{filename:next,previous_filename:prior},{filename:nested},{filename:other}],B,A);
  assert.deepEqual(changes,new Set([prior,next,nested]));
});
test('central receiver requires an administrator and selected local actions follow both revisions',async()=>{
  const ci='.github/product-ci.json',build='.github/workflows/product.yml',receiver='.github/workflows/repository-configuration-event.yml';
  const files=new Map([[B+'/'+ci,JSON.stringify([build])],[A+'/'+ci,JSON.stringify([build])],
    [B+'/'+build,YAML.stringify({jobs:{build:{steps:[{uses:'./.github/actions/old'}]}}})],
    [A+'/'+build,YAML.stringify({jobs:{build:{steps:[{uses:'actions/checkout@v4',with:{path:'product'}},{uses:'./product/.github/actions/new'}]}}})],
    [A+'/.github/actions/new/action.yml',YAML.stringify({runs:{using:'composite',steps:[{uses:'./product/adapters/build'}]}})],
    [A+'/adapters/build/action.yaml',YAML.stringify({runs:{using:'node24',main:'../shared/entry.js'}})],
    [B+'/.github/configuration-delegates.json',JSON.stringify([actor.id])]]);
  const api=fake(files),changed=['.github/actions/old/bin.js','.github/actions/new/action.yml','adapters/build/tool.js','adapters/shared/entry.js','.github/actions/unselected/a.js'];
  assert.deepEqual(await protectedChanges(api,changed.map(filename=>({filename})),B,A),new Set(changed.slice(0,4)));
  api.paginate=async method=>method===api.rest.pulls.listFiles?[{filename:receiver}]:method===api.rest.pulls.listReviews?[{state:'APPROVED',commit_id:A,user:actor}]:[];
  assert.equal(await authorizePull(api,1,A,'trunk'),false);
  api.target={owner:'splrad',repo:'steward'};
  api.rest.repos.getCollaboratorPermissionLevel=async()=>response({permission:'write',user:actor});
  await assert.rejects(authorizePull(api,1,A,'trunk'),/Configuration approval/);
  api.rest.repos.getCollaboratorPermissionLevel=async()=>response({permission:'admin',user:actor});
  assert.equal(await authorizePull(api,1,A,'trunk'),true);
});
test('re-evaluates a passing required scope when its last authorized review is dismissed',async()=>{
  const ci='.github/product-ci.json',api=fake(new Map([[B+'/'+ci,'[]'],[A+'/'+ci,'[]']]));
  const review={state:'APPROVED',commit_id:A,user:actor};
  const runs=api.rest.actions.listWorkflowRunsForRepo=Symbol();
  let scopeConclusion='success',rechecked=0;
  api.paginate=async method=>{
    if(method===api.rest.pulls.listFiles)return [{filename:ci}];
    if(method===api.rest.pulls.listReviews)return [review];
    if(method===runs)return [{id:88,path:'.github/workflows/pr-validation-native.yml',status:'completed',run_attempt:1}];
    if(method===api.rest.actions.listJobsForWorkflowRunAttempt)return [{id:5,name:'Validation scope',steps:[{name:'Authorize repository configuration',conclusion:scopeConclusion}]}];
    return [];
  };
  const actions={rest:{actions:{reRunJobForWorkflowRun:async({job_id})=>{
    assert.equal(job_id,5);rechecked++;
    try {await authorizePull(api,1,A,'trunk');scopeConclusion='success';}
    catch(error){assert.equal(error.code,'CONFIGURATION_APPROVAL_REQUIRED');scopeConclusion='failure';}
  }}}};
  const reconcileReview=()=>reconcile({repo,base:B,api,actions,run:{event:'pull_request_review'},data:{pull:{number:1,head:A}}});
  await reconcileReview();assert.equal(rechecked,0);
  review.state='DISMISSED';await reconcileReview();
  assert.equal(rechecked,1);assert.equal(scopeConclusion,'failure');
  review.state='APPROVED';await reconcileReview();
  assert.equal(rechecked,2);assert.equal(scopeConclusion,'success');
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
  const api=fake(new Map()), native={id:2,run_attempt:1,repository:repo,head_repository:repo,head_sha:B,head_branch:'trunk',event:'workflow_dispatch',path,status:'completed',conclusion:'success',html_url:'https://github.com/splrad/sample/actions/runs/2'};
  api.rest.repos.getCommit=async()=>response({commit:{tree:{sha:C}}});
  api.rest.actions.getWorkflowRun=async()=>response(native);
  api.paginate=async(method,args)=>method===api.rest.actions.listJobsForWorkflowRunAttempt?
    [{id:13,name:'pack',conclusion:'success',steps:[{name:'Upload release files',conclusion:'success',started_at:'2026-11-17T10:00:00Z',completed_at:'2026-11-17T10:00:05Z'}]}]:
    args.workflow_id==='build.yml' && args.head_sha===B?[native]:[];
  const result=await findEvidence(api,'',repo,B,A,{unit:'x',target:'one',workflow:path,job:'pack',matrix:{},archive:'bin'},model,undefined,
    (...args)=>trialInventory(...args,async()=>({asset:{created_at:'2026-11-17T10:00:01Z'},data:[{path:'app.zip',size:100}]})));
  assert.equal(result.binding.sourceSha,B);assert.equal(result.head,A);assert.equal(result.files[0].size,100);
  assert.equal(result.binding.nativeEvent,'workflow_dispatch');
  const list=api.paginate;
  api.paginate=async(method,args)=>args.workflow_id==='build.yml' && args.head_sha===B?[native,{...native,id:3,head_branch:'v1'}]:list(method,args);
  await assert.rejects(findEvidence(api,'',repo,B,A,{unit:'x',target:'one',workflow:path,job:'pack',archive:'bin'},model),/多个分支或标签/);
  api.paginate=async(method,args)=>{
    const rows=await list(method,args);
    return method===api.rest.actions.listJobsForWorkflowRunAttempt?[...rows,{id:14,started_at:'2026-11-17T10:00:00Z',completed_at:'2026-11-17T10:00:05Z'}]:rows;
  };
  let logged=101;
  api.rest.actions.downloadJobLogsForWorkflowRun=async()=>response('2026-11-17T10:00:02.000Z Artifact bin has been successfully uploaded! Final size is 100 bytes. Artifact ID is '+logged);
  const concurrent=()=>trialInventory(api,'',repo,B,A,{workflow:path,archive:'bin',...result.binding},undefined,async()=>({
    asset:{id:101,name:'bin',size_in_bytes:100,created_at:'2026-11-17T10:00:02Z'},data:result.files}));
  assert.deepEqual(await concurrent(),result.files);
  logged=999;await assert.rejects(concurrent(),/bind the archive/);
  doc.on={workflow_dispatch:{inputs:{flavor:{type:'choice',options:['debug','release']}}}};
  const inputsModel=inspectRepository(new Map([[path,YAML.stringify(doc)]]));
  assert.equal(await findEvidence(api,'',repo,B,A,{unit:'x',target:'one',workflow:path,job:'pack',matrix:{},archive:'bin'},inputsModel),undefined);
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
  const pages={'run-name':"Pages build-only · ${{ inputs.source_mode || vars.STEWARD_DOCS_SOURCE || 'default-branch' }}",jobs:{select:{if:"vars.STEWARD_DOCS_SOURCE != ''"},build:{if:"!cancelled() && needs.select.outputs.ready == 'true'",steps:[]},
    deploy:{if:"vars.STEWARD_DOCS_SOURCE == 'default-branch' || vars.STEWARD_DOCS_SOURCE == 'release'"}}};
  const files=new Map([[versionsPath,JSON.stringify({packages:{'.':{'release-type':'node'}}})],['VERSION','1.2.3'],['CHANGELOG.md','notes'],[pagesPath,YAML.stringify(pages)]]);
  const plan={site:{source:'default-branch',build:true,deploy:false},versions:[{path:'.',versionFile:'VERSION',changelog:'CHANGELOG.md'}]};
  const first=await applySelection(inspectRepository(files),'configure',plan,{});
  assert.match(YAML.parse(first.get(pagesPath))['run-name'],/Pages build-only .*inputs\.source_mode \|\| 'default-branch'/);
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
    ['pack.sh','true'],['.github/workflows/steward-release-channels.yml',await readFile('templates/release/steward-release-channels.yml','utf8')],['.github/release-template.md.mustache','notes'],['.github/workflows/repository-configuration-trial.yml','protected']]);
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
  const changes=await applySelection(inspectRepository(files),'select',plan,{seed,channelEvidence:async()=>new Set(['submit/ghcr-assets/cli','verify/ghcr-assets/cli']),describe:m=>warnings.push(m),inventory:async t=>{
    if(t.target==='windows')throw Error('Expired artifact');return [{path:'linux.zip'}];
  }});
  const saved=JSON.parse(changes.get('.github/delivery.json')).units[0];
  assert.deepEqual(saved.channels.find(c=>c.id==='ghcr-assets').artifactIds,['linux']);
  assert.deepEqual(saved.assets.map(a=>a.id).sort(),['linux','windows']);
  assert.ok(warnings.some(m=>m.includes('windows') && m.includes('Expired artifact')));
  const clear=structuredClone(plan);
  clear.channels=[{unit:'cli',id:'ghcr-assets',required:false,artifactIds:[],metadata:[]}];
  const result=await applySelection(inspectRepository(files),'select',clear,{seed,inventory:async t=>[{path:t.target+'.zip'}]});
  const disabled=JSON.parse(result.get('.github/delivery.json')).units[0].channels.find(c=>c.id==='ghcr-assets');
  assert.equal(disabled.required,false);assert.equal(disabled.artifactIds,undefined);assert.deepEqual(disabled.metadata,[]);
});
test('both submit and verify must have a native receipt for the external target',async()=>{
  const product=YAML.parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  const targets=[{unitId:'layerscape',channelId:'ghcr-assets'}];
  const native=new Set(['submit/ghcr-assets/layerscape','verify/ghcr-assets/layerscape']);
  assert.doesNotThrow(()=>assertChannelWorkflow(product,targets,native));
  assert.throws(()=>assertChannelWorkflow(product,targets),/submit/);
  const wrongUnit=structuredClone(product);wrongUnit.jobs['ghcr-assets-submit'].strategy.matrix={include:[{unitId:'other',channelId:'ghcr-assets'}]};
  assert.throws(()=>assertChannelWorkflow(wrongUnit,targets,native),/submit\/ghcr-assets\/layerscape/);
  for(const jobs of [{package:{steps:[{run:'python pack.py'}]}},{...product.jobs,'ghcr-assets-verify':{steps:[]}}])
    assert.throws(()=>assertChannelWorkflow({...product,jobs},targets,native),/缺少唯一的渠道作业或原生回执/);
});
test('dynamic channel receipts require the selected job, repository, source and uploaded report',async()=>{
  const document=YAML.parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  const source={document,path:'.github/workflows/channels.yml'},key='d'.repeat(64),time='2026-11-17T10:00:00Z';
  const api=fake(new Map()),modes=['submit','verify'],targets=[{unitId:'other',channelId:'ghcr-assets'}];
  const listRuns=api.rest.actions.listWorkflowRuns=Symbol(),listJobs=api.rest.actions.listJobsForWorkflowRunAttempt=Symbol();
  let expectedUnit='other',archivePath='report.json',repositoryId=repo.id,head=A;
  const run=id=>({id,run_attempt:1,repository:repo,head_repository:repo,head_sha:head,event:'workflow_dispatch',path:source.path,
    display_title:'Channels '+modes[id-1]+' '+key,conclusion:'success'});
  const artifact=id=>({id:70+id,name:'channel-'+key+'-other-ghcr-assets-'+id+'-1',created_at:time,digest:'sha256:'+key,
    workflow_run:{id,head_sha:A,repository_id:repositoryId,head_repository_id:repo.id}});
  api.paginate=async(method,args)=>{
    if(method===listRuns)return [run(1),run(2)];
    const id=args.run_id,mode=modes[id-1];
    if(method!==listJobs)return [artifact(id)];
    const upload=document.jobs['ghcr-assets-'+mode].steps.find(s=>s.with?.path==='report.json' && s.with?.name?.startsWith('channel-'));
    return [{id:111+id,run_id:id,run_attempt:1,head_sha:A,conclusion:'success',name:mode+'/ghcr-assets/'+expectedUnit,
      steps:[{name:upload.name??'Run '+upload.uses,started_at:time,completed_at:time,conclusion:'success'}]}];
  };
  const inspect=async(api,token,repo,run)=>({asset:artifact(run.id),data:[{path:archivePath}]});
  const results=()=>nativeChannelJobs(api,repo,A,A,source,targets,'',inspect);
  assert.deepEqual(await results(),new Set(modes.map(m=>m+'/ghcr-assets/other')));
  archivePath='debug.txt';assert.equal((await results()).size,0);
  archivePath='report.json';expectedUnit='unrelated';assert.equal((await results()).size,0);
  expectedUnit='other';repositoryId=-1;assert.equal((await results()).size,0);
  repositoryId=repo.id;head=B;assert.equal((await results()).size,0);
});
test('configuration callers are governance files and product CI choices match native validation events',async()=>{
  const callers=['.github/workflows/repository-configuration.yml','.github/workflows/repository-configuration-trial.yml'];
  assert.ok(documentationOnly(['README.md',...callers]));
  const admin={workflow:'.github/workflows/settings-sync.yml'};
  assert.equal(requiresProductCI([...callers,admin.workflow],'private-administrator',admin),false);
  assert.equal(requiresProductCI([...callers,'src/product.py'],'public',undefined),true);
  const path='.github/workflows/pr-title.yml';
  for(const on of ['pull_request_target',['push','pull_request_target'],{push:{},pull_request:{types:['opened']}},'pull_request']) {
    const model=inspectRepository(new Map([[path,YAML.stringify({on,jobs:{}})]]));
    assert.equal(selectableProductCI(model.workflows[0]),false);
    await assert.rejects(applySelection(model,'configure',{ci:[path]},{}),/产品工作流/);
  }
  assert.equal(selectableProductCI({path,document:{on:['push','pull_request']}}),true);
});
test('form archive defaults resolve the selected static matrix row and include override',()=>{
  const path='.github/workflows/product.yml',doc={jobs:{pack:{'runs-on':'ubuntu-24.04',strategy:{matrix:{
    os:['linux','macos'],include:[{os:'linux',flavor:'small'}]}},steps:[{uses:'actions/checkout@'+'a'.repeat(40),with:{'persist-credentials':false}},{run:'echo ok'},{uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:'artifact-${{ matrix.os }}',path:'out'}}]}}};
  const bytes=YAML.stringify(doc),model=inspectRepository(new Map([[path,bytes]]));
  const entries=candidates(model,{}).filter(e=>e.workflow);
  assert.deepEqual(entries.map(e=>e.archive),['artifact-linux','artifact-macos']);
  for(const e of entries)assert.equal(selectWorkflow(bytes,e).output,'out');
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
  const native={...one,recipe:{runner:'ubuntu-24.04',native:{workflow:'.github/workflows/product.yml',job:'pack',archive:'dist'}}};
  const upgraded=YAML.parse(adaptBuild(YAML.stringify(adopted),seed,[native],A));
  assert.equal(upgraded.jobs.build.steps.find(s=>s.name==='Check out native archive reader').with.ref,A);
  assert.equal(upgraded.jobs.build.steps.find(s=>s.name==='Collect verified product workflow archive')['working-directory'],'configuration-controller');
  assert.deepEqual(upgraded.jobs.sign,adopted.jobs.sign);
  adopted.jobs.build.steps.find(s=>s.name==='Collect selected files').run+='\n./custom-inspection';
  assert.throws(()=>adaptBuild(YAML.stringify(adopted),seed,[one]),/jobs.build/);
});
