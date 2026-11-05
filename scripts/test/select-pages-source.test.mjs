import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeEvidenceReader,sealProductArtifacts} from '../../packages/runner/dist/index.js';
import {desiredPagesSource,selectPagesSource,admitPagesEvent,pagesInputDigest,pagesDispatchInputs,pagesRunName,verifyPagesRelease} from '../select-pages-source.mjs';
import {currentPagesSource} from '../pages-runtime.mjs';

const S='a'.repeat(40),R='b'.repeat(40),P='c'.repeat(40),hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'pages-source-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const state={head:R,corrupt:false,ref:S,changed:false,workflowAtSource:true};
  const repo={id:10,full_name:'fixture/product',default_branch:'trunk',archived:false,disabled:false,private:false};
  const delivery=Buffer.from(JSON.stringify({schemaVersion:1,repositoryAuthors:[{id:7,evidence:'fixture author'}],units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',
    assets:[{id:'app',name:'app.bin',mediaType:'application/octet-stream'}],channels:[]}]}));
  const base={schemaVersion:3,repositoryId:10,fullName:repo.full_name,cycleId:'pr-2-'+S,requestKey:'e'.repeat(64),unitId:'app',version:'1.2.3',
    packageVersion:'1.2.3',tag:'v1.2.3',sourceSha:S,controllerSha:P,buildRef:'refs/heads/steward/build/pr-2-'+S,
    deliverySha256:hash(delivery),templateSha256:'d'.repeat(64),runId:111,attempt:1,toolLocks:{'mise.lock':'e'.repeat(64)},
    producers:[{buildId:'app',jobId:113,artifactId:114,attempt:1}],
    artifacts:[{id:'app',path:'app.bin',mediaType:'application/octet-stream',size:3,sha256:hash('app')}],evidence:[]};
  await writeFile(join(root,'app.bin'),'app');
  await writeFile(join(root,'sbom.spdx.json'),JSON.stringify({spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',packages:[]}));
  await writeFile(join(root,'release-notes.md'),`1.2.3\n${S}\n${P}\n`);
  const manifest=await sealProductArtifacts(root,base);
  const names=['app.bin','sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'],assets=[];
  const bytes=new Map();
  for(const [i,name] of names.entries()){const b=await readFile(join(root,name));bytes.set(200+i,b);assets.push({id:200+i,name,size:b.length,state:'uploaded',digest:'sha256:'+hash(b)});}
  const release={id:20,author:{id:42},draft:false,prerelease:false,immutable:true,published_at:'2026-10-30T01:00:00Z',
    tag_name:'v1.2.3',target_commitish:S,body:(await readFile(join(root,'release-notes.md'))).toString(),html_url:'https://github.com/fixture/product/releases/tag/v1.2.3'};
  const releases=[release],calls=[],contentReads=[];
  async function readContent(reader,path,ref) {
    contentReads.push([path,ref]);
    if(path==='.github/delivery.json')return delivery;
    if(path==='release-please-config.json')return Buffer.from(JSON.stringify({'include-component-in-tag':false,'include-v-in-tag':true,packages:{'.':{'release-type':'simple'}}}));
    if(path==='.github/workflows/pages.yml'&&(state.workflowAtSource||ref!==S))return Buffer.from('name: Pages\n');
    throw Error('missing content');
  }
  const io={async request(method,path){
    calls.push([method,path]);assert.equal(method,'GET');
    const endpoint=path.replace('/repos/fixture/product','').split('?')[0];let value;
    if(!endpoint)value=repo;
    else if(endpoint==='/git/ref/heads/trunk')value={ref:'refs/heads/trunk',object:{type:'commit',sha:state.head}};
    else if(endpoint==='/git/ref/tags/v1.2.3')value={ref:'refs/tags/v1.2.3',object:{type:'commit',sha:state.ref}};
    else if(endpoint==='/releases')value=releases;
    else if(/^\/releases\/\d+$/.test(endpoint))value=releases.find(r=>r.id===Number(endpoint.split('/').at(-1)));
    else if(/^\/releases\/\d+\/assets$/.test(endpoint))value=assets;
    else if(endpoint.startsWith('/releases/assets/'))return {status:200,headers:new Headers(),bytes:bytes.get(Number(endpoint.split('/').at(-1)))};
    else throw Error('unexpected '+path);
    return {status:200,headers:new Headers(),bytes:Buffer.from(JSON.stringify(value))};
  }};
  const reader=new NativeEvidenceReader(io,repo.full_name);
  const gh=async args=>{
    calls.push(['gh',...args]);
    if(args[0]==='api') {
      const path=args.find(a=>a.startsWith('repos/'));
      const result=await io.request('GET','/'+path),data=JSON.parse(result.bytes);
      return JSON.stringify(args.includes('--slurp')?[data]:data);
    }
    if(args[0]==='attestation')return JSON.stringify([{verificationResult:{signature:{certificate:{
      runInvocationURI:'https://github.com/fixture/product/actions/runs/111/attempts/1',sourceRepositoryIdentifier:'10',buildTrigger:'workflow_dispatch'}}}}]);
    if(args[0]==='release'&&['verify','verify-asset'].includes(args[1]))return '{}';
    throw Error('unexpected gh');
  };
  const download=async(name,id,to)=>{assert.equal(name,repo.full_name);await writeFile(to,state.corrupt?Buffer.from('bad'):bytes.get(id),{flag:'wx'});};
  const options={reader,repositoryId:repo.id,mode:'release',unitId:'app',controllerSha:P,appBotId:42};
  const ports={readContent,verifyRelease:args=>verifyPagesRelease(args,{gh,download})};
  const event={name:'release',repositoryId:repo.id,repository:repo.full_name,ref:'refs/tags/v1.2.3',sha:S,payload:{action:'published',release:{id:20}}};
  return {options,ports,event,state,repo,release,releases,manifest,bytes,assets,calls,contentReads};
}
test('disabled site performs no native source lookup',async t=>{
  const f=await fixture(t);assert.equal((await desiredPagesSource({...f.options,mode:''},f.ports)).status,'DISABLED');assert.equal(f.calls.length,0);
});
test('default source uses actual non-main branch and needs neither VERSION nor release',async t=>{
  const f=await fixture(t),result=await desiredPagesSource({...f.options,mode:'default-branch'},f.ports);
  assert.equal(result.source.sourceSha,R);assert.equal(result.source.ref,'refs/heads/trunk');assert.equal(result.source.releaseId,null);
  assert.deepEqual(f.contentReads,[]);assert.ok(f.calls.every(c=>!c[1].includes('releases')));
});
test('push outside docs paths is admitted; old or non-default push is stale',async t=>{
  const f=await fixture(t),options={...f.options,mode:'default-branch'};
  const event={...f.event,name:'push',sha:R,ref:'refs/heads/trunk',payload:{after:R,commits:[{modified:['docs-site/package-lock.json']}]}};
  assert.equal((await selectPagesSource(options,event,f.ports)).status,'READY');
  assert.equal((await selectPagesSource(options,{...event,sha:S,payload:{after:S}},f.ports)).status,'STALE');
  assert.equal((await selectPagesSource(options,{...event,ref:'refs/heads/feature'},f.ports)).status,'STALE');
});
test('source digest binds tree, controller and mode; default has no release_id',async t=>{
  const f=await fixture(t),{source}=await desiredPagesSource({...f.options,mode:'default-branch'},f.ports);
  assert.equal(pagesDispatchInputs(source).release_id,'');assert.ok(pagesRunName(source).includes(source.inputDigest));
  assert.notEqual(pagesInputDigest({...source,sourceSha:S}),source.inputDigest);assert.notEqual(pagesInputDigest({...source,controllerSha:S}),source.inputDigest);
});
test('formal Release retains S after main advances; native final-byte verifier is used',async t=>{
  const f=await fixture(t),result=await selectPagesSource(f.options,f.event,f.ports);
  assert.equal(result.status,'READY');assert.equal(result.source.sourceSha,S);assert.equal(result.source.releaseId,20);
  assert.ok(f.contentReads.some(([p,s])=>p==='release-please-config.json'&&s===S));
  assert.ok(f.calls.some(c=>c[0]==='gh'&&c[1]==='attestation'));assert.ok(f.calls.some(c=>c[0]==='gh'&&c[2]==='verify-asset'));
});
test('wired release mode uses the workflow pin at S even when main and coordinator advanced',async t=>{
  const f=await fixture(t),yaml=await readFile(new URL('../../templates/release/pages.yml',import.meta.url));
  const readContent=async(reader,path,ref)=>path==='.github/workflows/pages.yml'?yaml:f.ports.readContent(reader,path,ref);
  const result=await currentPagesSource(f.options,{...f.ports,readContent});
  assert.equal(result.source.sourceSha,S);assert.equal(result.source.ref,'refs/tags/v1.2.3');assert.notEqual(result.source.controllerSha,P);
  assert.equal(admitPagesEvent(result.source,{...f.event,name:'workflow_dispatch',payload:{inputs:pagesDispatchInputs(result.source)}}).status,'READY');
  assert.ok(f.calls.some(c=>c[0]==='gh'&&c[1]==='attestation'));
});
test('release selection uses published_at then native ID, never list order or main head',async t=>{
  const f=await fixture(t);f.releases.unshift({...f.release,id:19});f.releases.push({...f.release,id:21});
  assert.equal((await desiredPagesSource(f.options,f.ports)).source.releaseId,21);
  f.releases[0].published_at='2026-10-31T01:00:00Z';assert.equal((await desiredPagesSource(f.options,f.ports)).source.releaseId,19);
});
for(const flag of ['draft','prerelease','immutable','author'])test('non-formal '+flag+' is not a Release source',async t=>{
  const f=await fixture(t);if(flag==='author')f.release.author.id=99;else f.release[flag]=flag!=='immutable';
  assert.equal((await desiredPagesSource(f.options,f.ports)).status,'WAIT');
});
for(const change of ['unit','tag','source','bytes','workflow'])test('rejects incorrect '+change+' before source admission',async t=>{
  const f=await fixture(t);
  if(change==='unit')f.options.unitId='missing';if(change==='tag')f.release.tag_name='v9.9.9';
  if(change==='source')f.state.ref=R;if(change==='bytes')f.state.corrupt=true;if(change==='workflow')f.state.workflowAtSource=false;
  const expected={unit:/PAGES_UNIT/,tag:/PAGES_MANIFEST_TAG/,source:/tag source changed/,bytes:/RELEASE_ARTIFACTS|GH_RELEASE/,workflow:/missing content/};
  await assert.rejects(selectPagesSource(f.options,f.event,f.ports),expected[change]);
});
test('closed dispatch inputs reject commands and altered digest, ref, SHA or release ID',async t=>{
  const f=await fixture(t),{source}=await desiredPagesSource(f.options,f.ports);
  const event={...f.event,name:'workflow_dispatch',payload:{inputs:pagesDispatchInputs(source)}};
  assert.equal(admitPagesEvent(source,event).status,'READY');
  const reversed=Object.fromEntries(Object.entries(event.payload.inputs).reverse());assert.equal(admitPagesEvent(source,{...event,payload:{inputs:reversed}}).status,'READY');
  assert.throws(()=>admitPagesEvent(source,{...event,payload:{inputs:{...event.payload.inputs,command:'echo surprise'}}}),/PAGES_DISPATCH_FIELDS/);
  for(const key of ['source_mode','source_sha','release_id','input_digest'])assert.equal(admitPagesEvent(source,{...event,payload:{inputs:{...event.payload.inputs,[key]:'changed'}}}).status,'STALE');
  assert.equal(admitPagesEvent(source,{...event,ref:'refs/heads/trunk'}).status,'STALE');
  assert.equal(admitPagesEvent(source,{...event,sha:R}).status,'STALE');
});
test('new desired source invalidates an old dispatch without selecting substitute bytes',async t=>{
  const f=await fixture(t),options={...f.options,mode:'default-branch'},old=(await desiredPagesSource(options,f.ports)).source;
  f.state.head=S;
  assert.equal((await selectPagesSource(options,{...f.event,name:'workflow_dispatch',ref:old.ref,sha:old.sourceSha,payload:{inputs:pagesDispatchInputs(old)}},f.ports)).status,'STALE');
});
test('unknown manifest schema and missing pages source do not silently fall back',async t=>{
  const f=await fixture(t),asset=f.assets.find(a=>a.name==='artifact-manifest.json'),raw={...f.manifest,schemaVersion:99};
  const bytes=Buffer.from(JSON.stringify(raw));f.bytes.set(asset.id,bytes);asset.size=bytes.length;asset.digest='sha256:'+hash(bytes);
  await assert.rejects(desiredPagesSource(f.options,f.ports),/manifest schema/);
});
test('incomplete or unavailable native facts remain errors, never disabled or empty success',async t=>{
  const f=await fixture(t);f.options.reader.io.request=async()=>({status:403,headers:new Headers(),bytes:Buffer.from('{}')});
  await assert.rejects(desiredPagesSource(f.options,f.ports),/PAGES_REPOSITORY_READ/);
});
