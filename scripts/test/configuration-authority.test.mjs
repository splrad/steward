import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {documentationOnly,requiresProductCI,selectableProductCI} from '../validation-input.mjs';
import {parseReleasePauses,releasePausesPath} from '../release-pauses.mjs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authorizePull,checkEvent,protectedChanges,requestPath} from '../configuration-authorization.mjs';
import {findEvidence,nativeChannelJobs,trialInventory} from '../configuration-native.mjs';
import {inspectRepository} from '../configuration-view.mjs';
import {assertChannelWorkflow} from '../configuration-selection.mjs';
import YAML from 'yaml';
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),actor={id:12,login:'maintainer',type:'User'};
const repo={id:21,full_name:'splrad/sample',default_branch:'trunk',owner:{login:'splrad'}};
const response=data=>({data});
const validationPath='.github/workflows/pr-validation-native.yml';
const pull={number:1,changed_files:1,head:{sha:A,ref:'configured',repo},base:{ref:'trunk',repo},state:'open'};
const rule=pin=>({type:'workflows',ruleset_id:18883080,ruleset_source:'splrad',ruleset_source_type:'Organization',
  parameters:{workflows:[{repository_id:1296724484,path:validationPath,sha:pin}]}});
const validationRun=(id=88)=>({id,node_id:String(id),path:validationPath,event:'pull_request',repository:repo,
  head_repository:repo,head_branch:pull.head.ref,head_sha:A,display_title:`Native validation PR 1 / ${A} / trunk`,
  pull_requests:[],status:'completed',run_attempt:1});
const validationFile=pin=>({node:{file:{path:validationPath,repositoryFileUrl:`https://github.com/splrad/steward/blob/${pin}/${validationPath}`}}});
function fake(contents) {
  const getTree=async({tree_sha})=>{
    const [ref,...parts]=tree_sha.split('/'),prefix=[ref,...parts,''].join('/');
    const entries=new Map();
    for(const key of contents.keys())if(key.startsWith(prefix)) {
      const [path,...rest]=key.slice(prefix.length).split('/');
      entries.set(path,{path,type:rest.length?'tree':'blob',mode:rest.length?'040000':'100644',sha:prefix+path});
    }
    return response({truncated:false,tree:[...entries.values()]});
  };
  return {target:{},rest:{git:{getTree},repos:{getContent:async({ref,path})=>{
    const value=contents.get(ref+'/'+path);
    if(value===undefined) throw Object.assign(Error('Missing'),{status:404});
    return response({type:'file',encoding:'base64',content:Buffer.from(value).toString('base64')});
  },getBranch:async()=>response({commit:{sha:B}}),getCollaboratorPermissionLevel:async()=>response({permission:'admin',user:actor}),getBranchRules:()=>{}},
  pulls:{get:async()=>response(structuredClone(pull)),listFiles:()=>{},listReviews:()=>{}},
  issues:{listComments:()=>{}},actions:{getWorkflowRun:async()=>{},listWorkflowRuns:()=>{},listJobsForWorkflowRunAttempt:()=>{}}}};
}
test('first CI adoption, prior and proposed inputs, renames and exact heads are protected',async()=>{
  const old='.github/workflows/old.yml',next='.github/workflows/next.yml',ci='.github/product-ci.json';
  const api=fake(new Map([[A+'/'+ci,JSON.stringify([next])],[B+'/'+ci,JSON.stringify([old])]]));
  const changed={filename:next,previous_filename:old,status:'renamed',sha:C};
  const review={state:'APPROVED',commit_id:A,user:actor};
  api.paginate=async method=>method===api.rest.pulls.listFiles?[changed]:method===api.rest.pulls.listReviews?[review]:[];
  assert.deepEqual([...(await protectedChanges(api,[changed],B,A))].sort(),[next,old].sort());
  assert.equal(await authorizePull(api,1,A,'trunk'),true);
  review.commit_id=B;
  await assert.rejects(authorizePull(api,1,A,'trunk'),/required/);
  const first=fake(new Map([[A+'/'+ci,JSON.stringify([next])]]));
  assert.ok((await protectedChanges(first,[{filename:ci}],B,A)).has(ci));
});
test('authorization reads native directories once for missing declarations and stops on a protected change',async()=>{
  const ci='.github/product-ci.json',paths=['one','two','three'].map(name=>'.github/workflows/'+name+'.yml');
  const api=fake(new Map([[A+'/'+ci,JSON.stringify(paths)],[A+'/.github/workflows/real.yml','on: push']]));
  const contents=[],directories=[],read=api.rest.repos.getContent,tree=api.rest.git.getTree;
  api.rest.repos.getContent=args=>{contents.push(args.path);return read(args);};
  api.rest.git.getTree=args=>{directories.push(args.tree_sha);return tree(args);};
  assert.deepEqual(await protectedChanges(api,[{filename:ci}],B,A,true),new Set([ci]));
  assert.deepEqual(directories,[]);
  await protectedChanges(api,[{filename:ci}],B,A);
  assert.deepEqual(directories,[A,A+'/.github',A+'/.github/workflows']);
  assert.ok(paths.every(path=>!contents.includes(path)));
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
test('title workflow edits, removals and renames use exact-head authorization without configuration adoption',async()=>{
  const path='.github/workflows/pr-title.yml',other='.github/workflows/other.yml';
  const bot={id:301115370,login:'splrad-steward[bot]',type:'Bot'};
  const api=fake(new Map());
  const cases=[
    {filename:path,status:'added'}, {filename:path,status:'modified'}, {filename:path,status:'removed'},
    {filename:other,previous_filename:path,status:'renamed'}, {filename:path,previous_filename:other,status:'renamed'},
  ];
  for(const file of cases)
    assert.deepEqual(await protectedChanges(api,[file],B,A,true),new Set([path]));
  assert.equal((await protectedChanges(api,[{filename:other}],B,A,true)).size,0);

  const pullRequest={...pull,user:bot};
  api.rest.pulls.get=async()=>response(pullRequest);
  const approval={state:'COMMENTED',body:'/steward approve-configuration',commit_id:B,user:actor,node_id:'review'};
  let reviews=[];
  api.paginate=async method=>method===api.rest.pulls.listFiles?[cases[1]]:reviews;
  api.graphql=async()=>({node:{author:{login:actor.login},body:approval.body,lastEditedAt:null}});
  const event={repository:repo,pull_request:pullRequest,action:'opened',sender:bot};
  await assert.rejects(checkEvent(api,event),/Configuration approval is required/);
  reviews=[approval];
  await assert.rejects(checkEvent(api,event),/Configuration approval is required/);
  approval.commit_id=A;
  assert.equal(await checkEvent(api,event),true);
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
  api.rest.git={...api.rest.git,getRef:async()=>response({object:{sha:C}})};
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
test('selected local actions follow both reviewed revisions',async()=>{
  const ci='.github/product-ci.json',build='.github/workflows/product.yml';
  const files=new Map([[B+'/'+ci,JSON.stringify([build])],[A+'/'+ci,JSON.stringify([build])],
    [B+'/'+build,YAML.stringify({jobs:{build:{steps:[{uses:'./.github/actions/old'}]}}})],
    [A+'/'+build,YAML.stringify({jobs:{build:{steps:[{uses:'actions/checkout@v4',with:{path:'product'}},{uses:'./product/.github/actions/new'}]}}})],
    [A+'/.github/actions/new/action.yml',YAML.stringify({runs:{using:'composite',steps:[{uses:'./product/adapters/build'}]}})],
    [A+'/adapters/build/action.yaml',YAML.stringify({runs:{using:'node24',main:'../shared/entry.js'}})],
    [B+'/.github/configuration-delegates.json',JSON.stringify([actor.id])]]);
  const api=fake(files),changed=['.github/actions/old/bin.js','.github/actions/new/action.yml','adapters/build/tool.js','adapters/shared/entry.js','.github/actions/unselected/a.js'];
  assert.deepEqual(await protectedChanges(api,changed.map(filename=>({filename})),B,A),new Set(changed.slice(0,4)));

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
  const concurrent=()=>trialInventory(api,'',repo,B,A,{workflow:path,archive:'bin',...result.binding},async()=>({
    asset:{id:101,name:'bin',size_in_bytes:100,created_at:'2026-11-17T10:00:02Z'},data:result.files}));
  assert.deepEqual(await concurrent(),result.files);
  logged=999;await assert.rejects(concurrent(),/bind the archive/);
  doc.on={workflow_dispatch:{inputs:{flavor:{type:'choice',options:['debug','release']}}}};
  const inputsModel=inspectRepository(new Map([[path,YAML.stringify(doc)]]));
  assert.equal(await findEvidence(api,'',repo,B,A,{unit:'x',target:'one',workflow:path,job:'pack',matrix:{},archive:'bin'},inputsModel),undefined);
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
  }
  assert.equal(selectableProductCI({path,document:{on:['push','pull_request']}}),true);
});
test('only the administrator pause list is managed and repository IDs must be unique positive integers',()=>{
  const administrator={workflow:'.github/workflows/settings-sync.yml'};
  assert.equal(requiresProductCI([releasePausesPath],'private-administrator',administrator),false);
  assert.equal(requiresProductCI([releasePausesPath],'native'),true);
  assert.equal(requiresProductCI(['other/'+releasePausesPath],'private-administrator',administrator),true);
  assert.equal(requiresProductCI([releasePausesPath,'src/product.py'],'private-administrator',administrator),true);
  assert.deepEqual(parseReleasePauses(Buffer.from('[]\n')),[]);
  assert.deepEqual(parseReleasePauses(Buffer.from('[1187527897,1296724484]')),[1187527897,1296724484]);
  for(const invalid of ['{}','[0]','[-1]','[1.5]','["1187527897"]','[9007199254740992]','[1,1]','[1,]'])
    assert.throws(()=>parseReleasePauses(Buffer.from(invalid)),/^Error: RELEASE_PAUSES_INVALID$/);
  assert.throws(()=>parseReleasePauses(Buffer.from([0xff])),/^Error: RELEASE_PAUSES_INVALID$/);
});
test('selects entries covering all PR bases and files and the actual default branch push',()=>{
  const choice=(push,pull_request={})=>selectableProductCI({path:'.github/workflows/build.yml',document:{on:{push,pull_request}}},'stable/v2');
  const path='.github/workflows/build.yml',doc={on:{push:{branches:['trunk']},pull_request:{}},jobs:{}};
  const model=inspectRepository(new Map([[path,YAML.stringify(doc)]]));
  model.defaultBranch='stable/v2';

  assert.ok(choice({branches:['stable/v2']}));
  assert.ok(choice({branches:['stable/**']}));
  assert.ok(choice({branches:['**','!stable/**','stable/v2']}));
  assert.ok(choice({'branches-ignore':['trunk']},{branches:['**']}));
  for(const push of [{branches:['trunk']},{branches:['**','!stable/v2']},{tags:['v*']},{'branches-ignore':['stable/**']},{paths:['src/**']}])
    assert.equal(choice(push),false);
  for(const pr of [{branches:['trunk']},{paths:['**','!docs/**']},{'paths-ignore':['docs/**']}])
    assert.equal(choice({},pr),false);
});

test('retains the product signing job and untouched release units when changing one managed producer',async()=>{
  const {renderBuild,adaptBuild}=await import('./fixtures/legacy-build-workflow.mjs');
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
