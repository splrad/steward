import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {fetchState,releaseParticipation}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
const {validateReleaseConfiguration}=await import(pathToFileURL(resolve('scripts/release-adoption.mjs')).href);
const repository={id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false};
const sha='a'.repeat(40),head='b'.repeat(40);
it('shares adopted config validation while retaining an empty first-release manifest',()=>{
  const d={units:[{path:'.'}]},c={'separate-pull-requests':false,packages:{'.':{'release-type':'simple'}}};
  expect(()=>validateReleaseConfiguration(d,c,{})).not.toThrow();
  expect(()=>validateReleaseConfiguration(d,c,{'.':'0.0.0'})).not.toThrow();
  expect(()=>validateReleaseConfiguration(d,{...c,'separate-pull-requests':true},{})).not.toThrow();
  expect(()=>validateReleaseConfiguration(d,{...c,'separate-pull-requests':'true'},{})).toThrow('adopted configuration');
  for(const version of [null,7,{},'bad','v1.0.0',''])expect(()=>validateReleaseConfiguration(d,c,{'.':version})).toThrow('adopted configuration');
});
it('allows only protected fixed central missing refs, never product 404 or forbidden reads',async()=>{
  let status=404,protectedWriter=true,confirmationStatus=200,confirmed:any=[];
  const fetcher=async(input:any)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname);
    if(path.endsWith('/splrad/steward'))return new Response(JSON.stringify(repository));
    if(path.includes('/git/matching-refs/'))return new Response(JSON.stringify(confirmed),{status:confirmationStatus});
    if(path.includes('/git/ref/'))return new Response('{}',{status});
    const data=path.includes('/rules/branches/')?[
      {type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}
    ]:{id:path.endsWith('/1')?1:2,target:'branch',enforcement:'active',bypass_actors:path.endsWith('/1')&&protectedWriter?[{actor_id:4243096,actor_type:'Integration',bypass_mode:'always'}]:[],
      rules:path.endsWith('/1')?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}]};
    return new Response(JSON.stringify(data));
  };
  expect((await fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).snapshot.head).toBeNull();
  await expect(fetchState('',repository,'fixture','steward/automation-health',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_CENTRAL_STATE_IDENTITY');
  await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher})).rejects.toThrow('RELEASE_BOOTSTRAP_REQUIRED');
  await expect(fetchState('',{...repository,id:7},'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_CENTRAL_STATE_IDENTITY');
  status=403;await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_UNAVAILABLE');
  status=404;confirmationStatus=403;await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_UNAVAILABLE');
  confirmationStatus=200;confirmed=[null];await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_IDENTITY');
  confirmed=[{}];await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_IDENTITY');
  confirmed=[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha}}];await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_MOVED');confirmed=[];
  status=404;protectedWriter=false;await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow();
});
it('excludes proven unconfigured governance repositories while retaining missing or damaged product obligations',async()=>{
  const candidateRef='refs/heads/release-please--branches--main';
  let productState=false,centralMaintenance=false,partial=false,truncated=false,status=200,oldRelease=false,candidateBranch='';
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path===`/repos/${repository.full_name}`)value=repository;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:'commit',sha}};
    else if(path.includes('matching-refs/heads/steward/release-state'))value=productState||centralMaintenance?[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:head}}]:[];
    else if(path.includes(`git/trees/${head}`))value={truncated:false,tree:centralMaintenance?[
      {path:'maintenance',type:'tree',mode:'040000',sha},
      {path:'maintenance/12.json',type:'blob',mode:'100644',sha},
      {path:`maintenance/candidate-draft-17-${sha}.json`,type:'blob',mode:'100644',sha},
    ]:[{path:'state.json',type:'blob',mode:'100644',sha}]};
    else if(path.includes('git/trees/'))value={truncated,tree:partial?[{path:'release-please-config.json',type:'blob',mode:'100644',sha}]:[]};
    else if(path.includes('matching-refs/heads/release-please--branches--main'))value=candidateBranch?[{ref:candidateBranch,object:{type:'commit',sha}}]:[];
    else if(path.includes('matching-refs'))value=[];
    else if(path.includes('releases?'))value=oldRelease?[{id:1}]:[];
    else throw Error('unexpected read');
    return {status,bytes:Buffer.from(JSON.stringify(value))};
  }};
  expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');
  centralMaintenance=true;expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');centralMaintenance=false;
  productState=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');productState=false;
  partial=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');partial=false;
  oldRelease=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');oldRelease=false;
  candidateBranch=candidateRef+'--components--app';expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');
  candidateBranch=candidateRef;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');candidateBranch='';
  truncated=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('INCOMPLETE');truncated=false;
  status=403;await expect(releaseParticipation(repository,io)).rejects.toThrow('UNAVAILABLE');
});
it.each([
  {path:'maintenance/12.json',type:'blob',mode:'120000'},
  {path:'maintenance/12.json',type:'commit',mode:'160000'},
  {path:'maintenance/12.json',type:'blob',mode:'100755'},
  {path:'maintenance/nested',type:'tree',mode:'040000'},
  {path:'foreign',type:'tree',mode:'040000'},
])('retains malformed central state obligations: $path $mode',async entry=>{
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path===`/repos/${repository.full_name}`)value=repository;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:'commit',sha}};
    else if(path.includes('matching-refs/heads/steward/release-state'))value=[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:head}}];
    else if(path.includes(`git/trees/${head}`))value={truncated:false,tree:[{path:'maintenance',type:'tree',mode:'040000',sha},{...entry,sha}]};
    else if(path.includes('git/trees/'))value={truncated:false,tree:[]};
    else throw Error('unexpected read');
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_CONFIGURATION_REQUIRED');
});
it.each([
  [null], [{}], [{ref:'refs/heads/foreign',object:{type:'commit',sha}}],
  [{ref:'refs/heads/steward/release-state',object:{type:'tree',sha}}],
  [{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:'bad'}}],
  [{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:[sha]}}],
  [1,2].map(()=>({ref:'refs/heads/steward/release-state-other',object:{type:'commit',sha}})),
])('refuses malformed state matching-ref evidence %#',async (...refs)=>{
  const io={request:async(_method:string,path:string)=>{
    const value=path===`/repos/${repository.full_name}`?repository
      :path.includes('git/ref/heads/main')?{ref:'refs/heads/main',object:{type:'commit',sha}}
      :path.includes('git/trees/')?{truncated:false,tree:[]}:refs;
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_PARTICIPATION_IDENTITY');
});
it('does not mistake a valid prefix-suffix ref for the exact state ref',async()=>{
  const io={request:async(_method:string,path:string)=>{
    const value=path===`/repos/${repository.full_name}`?repository
      :path.includes('git/ref/heads/main')?{ref:'refs/heads/main',object:{type:'commit',sha}}
      :path.includes('git/trees/')?{truncated:false,tree:[]}
      :path.includes('matching-refs/heads/steward/release-state')?[{ref:'refs/heads/steward/release-state-other',object:{type:'commit',sha}}]:[];
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');
});
it.each([
  [null], [{}], [{path:'README',type:'blob',mode:'100644',sha:'bad'}],
  [{path:'README',type:'tree',mode:'100644',sha}],
  [{path:'README',type:'blob',mode:'100644',sha:[sha]}],
  [{path:'../README',type:'blob',mode:'100644',sha}],
  [{path:'bad\0path',type:'blob',mode:'100644',sha}],
  [1,2].map(()=>({path:'README',type:'blob',mode:'100644',sha})),
])('rejects malformed default tree before classifying absence %#',async (...tree)=>{
  const io={request:async(_method:string,path:string)=>{
    const value=path===`/repos/${repository.full_name}`?repository
      :path.includes('git/ref/heads/main')?{ref:'refs/heads/main',object:{type:'commit',sha}}
      :path.includes('git/trees/')?{truncated:false,tree}:[];
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_PARTICIPATION_IDENTITY');
});
it('accepts valid source tree kinds and rejects a malformed final default ref',async()=>{
  let reads=0,badFinal=false;
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path===`/repos/${repository.full_name}`)value=repository;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:++reads>1&&badFinal?'tree':'commit',sha}};
    else if(path.includes('git/trees/'))value={truncated:false,tree:[
      {path:'src',type:'tree',mode:'040000',sha},{path:'src/file',type:'blob',mode:'100644',sha},
      {path:'executable',type:'blob',mode:'100755',sha},{path:'link',type:'blob',mode:'120000',sha},
      {path:'module',type:'commit',mode:'160000',sha}]};
    else value=[];
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');
  reads=0;badFinal=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_PARTICIPATION_IDENTITY');
});
it('rejects an array SHA in the default ref before reading trees',async()=>{
  const io={request:async(_method:string,path:string)=>{
    const value=path===`/repos/${repository.full_name}`?repository:{ref:'refs/heads/main',object:{type:'commit',sha:[sha]}};
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_PARTICIPATION_IDENTITY');
});
it.each(['release-please--branches--main','build/','releases'])('rejects changed absence evidence for %s',async changed=>{
  const counts=new Map<string,number>();
  const io={request:async(_method:string,path:string)=>{
    let v:any;
    if(path===`/repos/${repository.full_name}`)v=repository;
    else if(path.includes('git/ref/heads/main'))v={ref:'refs/heads/main',object:{type:'commit',sha}};
    else if(path.includes('git/trees/'))v={truncated:false,tree:[]};
    else {
      const n=(counts.get(path)??0)+1;counts.set(path,n);
      v=n>1&&path.includes(changed)?[changed==='release-please--branches--main'?{ref:'refs/heads/'+changed,object:{type:'commit',sha}}:{id:1}]:[];
    }
    return {status:200,bytes:Buffer.from(JSON.stringify(v))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_PARTICIPATION_CHANGED');
});
it('validates exact product blobs, retains bootstrap requirements and rejects head/state drift',async()=>{
  const product={...repository,id:7,full_name:'test/product'};
  const values:Record<string,unknown>={
    '.github/delivery.json':{schemaVersion:1,repositoryAuthors:[{id:7,evidence:'Offline authorship'}],units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',assets:[{id:'app',name:'app-${version}.zip',mediaType:'application/zip'}],channels:[]}]},
    'release-please-config.json':{'separate-pull-requests':false,packages:{'.':{'release-type':'simple','version-file':'VERSION'}}},'.release-please-manifest.json':{'.':'0.0.0'}};
  let heads=0,states=0,moveHead=false,moveState=false,badBlob=false;
  const blob=(path:string,value:unknown)=>{
    const b=Buffer.from(JSON.stringify(value));
    return {type:'file',path,encoding:'base64',size:b.length,sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),content:b.toString('base64')};
  };
  const blobs=Object.fromEntries(Object.entries(values).map(([path,value])=>[path,blob(path,value)]));
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path==='/repos/test/product')value=product;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:'commit',sha:++heads>1&&moveHead?head:sha}};
    else if(path.includes('matching-refs/heads/steward/release-state'))value=++states>1&&moveState?[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:head}}]:[];
    else if(path.includes('git/trees/'))value={truncated:false,tree:Object.values(blobs).map(b=>({path:b.path,sha:b.sha,type:'blob',mode:'100644'}))};
    else if(path.includes('/contents/')){const name=path.split('/contents/')[1]!.split('?')[0]!;value={...blobs[name],...(badBlob?{content:Buffer.from('{}').toString('base64')}:{})};}
    else throw Error('unexpected read');
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  expect((await releaseParticipation(product,io)).status).toBe('APPLICABLE');
  heads=states=0;moveHead=true;await expect(releaseParticipation(product,io)).rejects.toThrow('PARTICIPATION_CHANGED');
  heads=states=0;moveHead=false;moveState=true;await expect(releaseParticipation(product,io)).rejects.toThrow('PARTICIPATION_CHANGED');
  heads=states=0;moveState=false;badBlob=true;await expect(releaseParticipation(product,io)).rejects.toThrow('CONFIGURATION_INVALID');
  badBlob=false;
  const official={requireWorkflowGitHubDelivery:true};
  await expect(releaseParticipation(product,io,official)).rejects.toThrow('OFFICIAL_CANDIDATE_GITHUB_DELIVERY');
  const build='.github/workflows/steward-release-publish.yml';
  const flow={
    'run-name':'Build ${{ inputs.operation_key }}',
    on:{workflow_dispatch:{inputs:Object.fromEntries(['cycle_id','operation_key','source_sha','controller_sha']
      .map(key=>[key,{type:'string',required:true}]))}},
    jobs:{deliver:{name:'delivery/root',steps:[{
      id:'upload-github-release',name:'Upload GitHub release delivery',uses:'actions/upload-artifact@'+'a'.repeat(40),
      with:{name:'delivery-github-release-${{ github.repository_id }}-root-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
        path:'out/*'},
    }]}},
  };
  blobs['.github/delivery.json']=blob('.github/delivery.json',{schemaVersion:3});
  blobs[build]=blob(build,flow);
  expect((await releaseParticipation(product,io,official)).status).toBe('APPLICABLE');
  blobs[build]=blob(build,{...flow,jobs:{build:{steps:[{run:'exit 0'}]}}});
  await expect(releaseParticipation(product,io,official)).rejects.toThrow('OFFICIAL_CANDIDATE_GITHUB_DELIVERY');
});
