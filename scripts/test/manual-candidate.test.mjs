import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

test('two declared release units on trunk bind independent version files, notes and tags to one candidate',async()=>{
  const f=fixture(),p={id:72,name:'splrad/second',defaultBranch:'trunk'};
  f.session.repository.repositoryId=p.id;
  f.pull.head.repo.id=p.id;f.pull.base.repo.id=p.id;f.pull.base.ref=p.defaultBranch;
  f.delivery.units=['cli','ui'].map(id=>({...f.delivery.units[0],id,path:'packages/'+id,notesPath:'.release-notes/'+id+'.md'}));
  f.session.generated.units=f.delivery.units.map(({id,path},i)=>({id,path,version:(i+1)+'.0.0',tag:id+'-v'+(i+1)+'.0.0'}));
  f.files['.github/delivery.json']=JSON.stringify(f.delivery);
  const packages={},manifest={};
  for(const u of f.session.generated.units) {
    packages[u.path]={'release-type':'simple','version-file':'version.txt',component:u.id};
    manifest[u.path]=u.version;
    f.files[u.path+'/version.txt']=u.version;
    f.files['.release-notes/'+u.id+'.md']=f.files['.release-notes/layerscape.md'];
  }
  f.files['release-please-config.json']=JSON.stringify({packages});
  f.files['.release-please-manifest.json']=JSON.stringify(manifest);
  f.io.changedPaths=async()=>['.release-notes/ui.md'];
  const record=await validateManualCandidate(f.session,f.producer,f.io,[p]);
  assert.equal(record.schemaVersion,2);
  assert.deepEqual(record.units.map(u=>u.versionPath),['packages/cli/version.txt','packages/ui/version.txt']);
  const identity=candidateObservationIdentity({...f.session,manualValidation:record});
  assert.match(identity.version,/^units-[a-f0-9]{64}$/);
  f.files['packages/ui/version.txt']='1.0.0';
  await assert.rejects(validateManualCandidate(f.session,f.producer,f.io,[p]),/MANUAL_VERSION/);
});
