import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {withCycleEventProduct,validateEvent} from '../release-cycle-event.mjs';
import {withCandidateProduct} from '../bounded-candidate-contract.mjs';
import {nativeReleaseApp} from '../../packages/runner/dist/index.js';
import {validateManualCandidate,projectManualCandidate,manualManagedEntryMatches} from '../manual-candidate.mjs';
import {candidateObservationIdentity,manualCandidateFacts,decodeCandidateDocument} from '../../packages/runner/dist/index.js';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const H='a'.repeat(40),S='b'.repeat(40),G='c'.repeat(40),id='d'.repeat(64),repo=1187527897;
import {fixture} from './manual-candidate-fixture.mjs';
test('managed structure rejects deletion, symlink, changed mode and restored tombstone while permitting new prose bytes',()=>{
  const file={path:'CHANGELOG.md',mode:'100644',content:'old'},entry=mode=>`${mode} blob ${'a'.repeat(40)}\tCHANGELOG.md\0`;
  assert.equal(manualManagedEntryMatches(file,entry('100644')),true);
  for(const actual of ['',entry('120000'),entry('100755'),entry('100644')+entry('100644')])assert.equal(manualManagedEntryMatches(file,actual),false);
  assert.equal(manualManagedEntryMatches({...file,content:null},''),true);
  assert.equal(manualManagedEntryMatches({...file,content:null},entry('100644')),false);
});
test('manual validation requires native managed file structure before freezing',async()=>{
  const f=fixture();f.io.managedStructure=async()=>false;
  await assert.rejects(validateManualCandidate(f.session,f.producer,f.io),/MANUAL_MANAGED_STRUCTURE/);
  assert.equal(f.session.manualValidation,undefined);assert.deepEqual(f.calls,[]);
});
for(const path of ['source.ts','.github/workflows/build.yml','assets/extra.bin','release-please-config.json'])test(`manual validation rejects unapproved ${path} changes`,async()=>{
  const f=fixture();f.io.changedPaths=async()=>['.release-notes/layerscape.md',path];
  await assert.rejects(validateManualCandidate(f.session,f.producer,f.io),/MANUAL_UNMANAGED_CHANGES/);
  assert.equal(f.session.manualValidation,undefined);assert.deepEqual(f.calls,[]);
});
test('manual validation admits exact generated managed paths alongside notes',async()=>{
  const f=fixture();f.session.generated.files=[{path:'CHANGELOG.md',mode:'100644',content:'generated'}];
  f.io.changedPaths=async()=>['CHANGELOG.md','.release-notes/layerscape.md'];
  assert.equal((await validateManualCandidate(f.session,f.producer,f.io)).headSha,H);
});
test('unmerged manual head freezes actual inputs without changing generated facts or projecting',async()=>{
  const f=fixture(),before=JSON.stringify(f.session),files=JSON.stringify(f.files),cache=await validateManualCandidate(f.session,f.producer,f.io);
  assert.equal(JSON.stringify(f.session),before);assert.equal(JSON.stringify(f.files),files);assert.deepEqual(f.calls,[]);
  assert.equal(cache.sourceSha,S);assert.equal(cache.headSha,H);assert.equal(cache.files.find(x=>x.path==='VERSION').sha256,hash('1.0.0\n'));
  f.session.manualValidation=cache;const identity=candidateObservationIdentity(f.session);assert.equal(identity.sourceSha,S);assert.equal(f.session.generated.baseSha,G);
  assert.equal(identity.artifactDigest,'sha256:'+hash(manualCandidateFacts(cache)));
});
test('same fact keeps original producer, stable identity and completed projection on replay',async()=>{
  const f=fixture();f.session.manualValidation=await validateManualCandidate(f.session,f.producer,f.io);const identity=candidateObservationIdentity(f.session);
  const oldGenerated=JSON.stringify(f.session.generated),oldCandidate={...f.session.repository.candidate};
  const result=await projectManualCandidate(f.session,f.session.manualValidation,f.project);
  assert.equal(result.reason,'MANUAL_PROJECTION');assert.equal(result.projectionEvidence.bodyDigest,hash(f.comments[0].body));assert.deepEqual(f.calls,['comment','save']);
  const cache=await validateManualCandidate(f.session,{...f.producer,runId:43,attempt:2},f.io);assert.equal(cache,f.session.manualValidation);
  await projectManualCandidate(f.session,cache,f.project);assert.deepEqual(f.calls,['comment','save']);assert.deepEqual(candidateObservationIdentity(f.session),identity);
  assert.equal(JSON.stringify(f.session.generated),oldGenerated);for(const k of ['baseSha','publishedHead','generatedSnapshotPath'])assert.equal(f.session.repository.candidate[k],oldCandidate[k]);
});
for(const kind of ['editing','closed','merged','fork','pending','ancestry','version','manifest','notes','adapter','state','source-race'])test(`manual validation rejects ${kind}`,async()=>{
  const f=fixture();
  if(kind==='editing')f.pull.labels=[{name:'release:editing'}];if(kind==='closed')f.pull.state='closed';if(kind==='merged')f.pull.merged=true;
  if(kind==='fork')f.pull.head.repo.id=1;if(kind==='pending')f.session.pending={};if(kind==='ancestry')f.io.isAncestor=async()=>false;
  if(kind==='version')f.files.VERSION='2.0.0';if(kind==='manifest')f.files['.release-please-manifest.json']='{".":"2.0.0"}';
  if(kind==='notes')f.files['.release-notes/layerscape.md']='# incomplete';if(kind==='adapter')f.files['release-please-config.json']=JSON.stringify({packages:{'.':{'release-type':'node'}}});
  if(kind==='state')f.io.state=async()=>false;if(kind==='source-race'){let n=0;f.io.source=async()=>++n===1?S:G;}
  await assert.rejects(validateManualCandidate(f.session,f.producer,f.io));assert.deepEqual(f.calls,[]);
});
for(const kind of ['head','source','content','duplicate-comment','wrong-comment','lost-write'])test(`observer refuses ${kind} instead of fallback or false done`,async()=>{
  const f=fixture();f.session.manualValidation=await validateManualCandidate(f.session,f.producer,f.io);
  if(kind==='head')f.pull.head.sha=G;if(kind==='source')f.io.source=async()=>G;
  if(kind==='content')f.files.VERSION+='\n';if(kind==='duplicate-comment')f.comments.push({...f.comments[0],id:12});
  if(kind==='wrong-comment')f.comments[0].authorId=1;if(kind==='lost-write')f.project.updateComment=async()=>{};
  await assert.rejects(projectManualCandidate(f.session,f.session.manualValidation,f.project));
  assert.equal(f.session.preview,'旧冲突提示');assert.equal(f.session.generated.baseSha,G);
});
test('session decoder accepts legacy fields and strictly binds new manual owner',async()=>{
  const f=fixture(),decode=async value=>{const content=JSON.stringify(value);return decodeCandidateDocument([{schemaVersion:1,repositoryId:repo,candidateId:id,documentKind:'session',documentDigest:hash(content),index:0,count:1,content}]);};
  const {repository,...old}=f.session;await decode(old);const cache=await validateManualCandidate(f.session,f.producer,f.io);await decode({...old,manualValidation:cache});
  await assert.rejects(decode({...old,manualValidation:{...cache,candidateId:'0'.repeat(64)}}));
  await assert.rejects(decode({...old,manualValidation:{...cache,unknown:true}}));
});
test('canonical facts ignore object key order but not file bytes',async()=>{
  const f=fixture(),cache=await validateManualCandidate(f.session,f.producer,f.io),other=structuredClone(cache);
  other.units[0]=Object.fromEntries(Object.entries(other.units[0]).reverse());other.files=other.files.map(x=>({sha256:x.sha256,path:x.path}));
  assert.equal(hash(manualCandidateFacts(cache)),hash(manualCandidateFacts(other)));
  other.files[0].sha256='0'.repeat(64);assert.notEqual(hash(manualCandidateFacts(cache)),hash(manualCandidateFacts(other)));
});

test('manual validation follows the template at the exact candidate head for optional notices', async () => {
  const f=fixture();
  f.files['.release-notes/layerscape.md']='## 概述\n\n新版。\n\n## 更新内容\n\n### 工具\n\n增加导出。';
  await validateManualCandidate(f.session,f.producer,f.io);
  f.files['.github/release-template.md.mustache']='{{{compatibility}}}';
  await assert.rejects(validateManualCandidate(f.session,f.producer,f.io), /missing heading/);
});

for(const schemaVersion of [1,2])test('two declared release units on trunk bind independent inputs for schema '+schemaVersion,async()=>{
  const f=fixture(),p={id:72,name:'splrad/second',defaultBranch:'trunk'};
  f.session.repository.repositoryId=p.id;
  f.pull.head.repo.id=p.id;f.pull.base.repo.id=p.id;f.pull.base.ref=p.defaultBranch;
  f.delivery.units=['cli','ui'].map(id=>({...f.delivery.units[0],id,path:'packages/'+id,notesPath:'.release-notes/'+id+'.md'}));
  f.delivery.schemaVersion=schemaVersion;
  if(schemaVersion===2)for(const unit of f.delivery.units){
    unit.assets=[{id:'archive',name:unit.id+'-${version}.zip',mediaType:'application/zip',inspection:'zip'}];
    unit.channels=[{id:'github-release',required:true,location:'github',artifactIds:['archive']}];
    unit.buildLocks=[unit.path+'/package-lock.json'];
  }
  f.session.generated.units=f.delivery.units.map(({id,path},i)=>({id,path,version:(i+1)+'.0.0',tag:id+'-v'+(i+1)+'.0.0'}));
  f.session.identity.units=f.session.generated.units.map(({id})=>({id}));
  f.files['.github/delivery.json']=JSON.stringify(f.delivery);
  const packages={},manifest={};
  for(const u of f.session.generated.units) {
    packages[u.path]={'release-type':'simple','version-file':'version.txt',component:u.id};
    manifest[u.path]=u.version;
    f.files[u.path+'/version.txt']=u.version;
    f.files['.release-notes/'+u.id+'.md']=f.files['.release-notes/layerscape.md'];
  }
  f.files['release-please-config.json']=JSON.stringify({packages,'separate-pull-requests':false});
  f.files['.release-please-manifest.json']=JSON.stringify(manifest);
  f.io.changedPaths=async()=>['.release-notes/ui.md'];
  const repository={id:p.id,full_name:p.name,default_branch:p.defaultBranch,archived:false,disabled:false,
    private:false,visibility:'public',fork:false,owner:{id:302208797}};
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  let scopedTokens=0;
  const fetcher=async(url,options={})=>{
    const path=new URL(url).pathname;
    let body;
    if(path==='/app')body={id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'};
    else if(path==='/orgs/splrad/installation')body={id:123,account:{id:302208797},app_id:4243096};
    else if(path.startsWith('/users/'))body={id:301115370,type:'Bot'};
    else if(path.endsWith('/access_tokens')){
      const request=JSON.parse(options.body);
      if(request.repository_ids)scopedTokens++;
      assert.ok(!request.repository_ids||JSON.stringify(request.repository_ids)===JSON.stringify([repository.id]));
      body={token:'ghs_offline_'+Object.keys(request.permissions).join('_'),expires_at:new Date(Date.now()+3600000).toISOString(),permissions:request.permissions};
    }else if(path==='/installation/repositories')body={total_count:1,repositories:[repository]};
    else if(path==='/installation/token')return new Response(null,{status:204});
    else assert.fail(path);
    return Response.json(body,{status:path.endsWith('/access_tokens')?201:200});
  };
  const app=await nativeReleaseApp(key,fetcher);
  const source='a'.repeat(40),files=['.github/delivery.json','release-please-config.json','.release-please-manifest.json'];
  const blob=path=>{const bytes=Buffer.from(f.files[path]);return {type:'file',path,encoding:'base64',size:bytes.length,content:bytes.toString('base64'),
    sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};
  const transport=()=>({request:async(method,url)=>{
    assert.equal(method,'GET');
    const prefix='/repos/'+repository.full_name;
    const path=url.slice(prefix.length);
    let result;
    if(!path)result=repository;
    else if(path==='/git/ref/heads/'+repository.default_branch)result={ref:'refs/heads/'+repository.default_branch,object:{type:'commit',sha:source}};
    else if(path==='/git/trees/'+source+'?recursive=1')result={truncated:false,tree:files.map(path=>({path,type:'blob',mode:'100644',sha:blob(path).sha}))};
    else if(path==='/git/matching-refs/heads/steward/release-state')result=[];
    else if(path.startsWith('/contents/')&&path.endsWith('?ref='+source))result=blob(path.slice(10).split('?')[0]);
    else assert.fail(path);
    return {status:200,bytes:Buffer.from(JSON.stringify(result))};
  }});
  const recover=()=>withCandidateProduct(app,p.id,async(product)=>{
    f.io.product=product;
    assert.deepEqual(product.units.map(u=>u.path),['packages/cli','packages/ui']);
    return validateManualCandidate(f.session,f.producer,f.io);
  },transport);
  for(const event of [
    {kind:'run',repositoryId:p.id,runId:1234,attempt:2},
    {kind:'publication',repositoryId:1296724484,runId:55,attempt:1,productRepositoryId:p.id}
  ]) {
    await withCycleEventProduct(app,event,product=>{
      assert.equal(product.id,p.id);
      assert.equal(product.defaultBranch,'trunk');
      const key=hash([event.repositoryId,event.kind,event.runId,event.attempt,...(event.productRepositoryId?[p.id]:[])]);
      validateEvent(event,key,[product]);
    },transport);
  }
  await assert.rejects(withCycleEventProduct(app,{kind:'publication',repositoryId:1296724484,productRepositoryId:99},()=>assert.fail(),transport),/BOUNDED_REPOSITORY/);
  Object.assign(repository,{id:repo,full_name:'splrad/LayerScape',default_branch:'main'});
  const oldEvent={kind:'publication',repositoryId:1296724484,runId:55,attempt:1};
  await withCycleEventProduct(app,oldEvent,product=>{
    assert.equal(product.id,repo);
    validateEvent(oldEvent,hash([oldEvent.repositoryId,'publication',55,1]),[product]);
  },transport);
  repository.default_branch='trunk';
  await assert.rejects(withCycleEventProduct(app,oldEvent,()=>assert.fail(),transport),/CYCLE_EVENT_KIND/);
  Object.assign(repository,{id:p.id,full_name:p.name,default_branch:p.defaultBranch});
  const missing=f.session.generated.units.pop();
  await assert.rejects(recover(),/MANUAL_UNIT_COVERAGE/);
  f.session.generated.units.push(missing);
  const record=await recover();
  assert.equal(record.schemaVersion,2);
  assert.deepEqual(record.units.map(u=>u.versionPath),['packages/cli/version.txt','packages/ui/version.txt']);
  const identity=candidateObservationIdentity({...f.session,manualValidation:record});
  assert.match(identity.version,/^units-[a-f0-9]{64}$/);
  const ui=f.session.generated.units.pop(),uiIdentity=f.session.identity.units.pop();
  delete manifest[ui.path];
  f.files['.release-please-manifest.json']=JSON.stringify(manifest);
  f.io.changedPaths=async()=>['.release-notes/cli.md'];
  assert.deepEqual((await recover()).units.map(unit=>unit.id),['cli']);
  f.session.generated.units.push(ui);f.session.identity.units.push(uiIdentity);
  await assert.rejects(recover(),/MANUAL_UNIT_COVERAGE/);
  manifest[ui.path]=ui.version;
  f.files['.release-please-manifest.json']=JSON.stringify(manifest);
  f.files['packages/ui/version.txt']='1.0.0';
  await assert.rejects(recover(),/MANUAL_VERSION/);
  files.pop();
  await assert.rejects(recover(),/RELEASE_CONFIGURATION_REQUIRED/);
  const issued=scopedTokens;
  for(const change of [{private:true},{visibility:'internal'},{fork:true},{owner:{id:1}}]){
    const saved={...repository};Object.assign(repository,change);
    await assert.rejects(recover(),/BOUNDED_REPOSITORY/);
    assert.equal(scopedTokens,issued);
    Object.assign(repository,saved);
  }
  await assert.rejects(withCandidateProduct(app,999,()=>assert.fail(),transport),/BOUNDED_REPOSITORY/);
});
