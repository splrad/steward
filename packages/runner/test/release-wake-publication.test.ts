import {afterEach,expect,it,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {productPipelineFixture} from './product-pipeline-fixture.js';
import {evidenceFixture,C,NOW} from './native-evidence-fixture.js';
import {recoverNativeCycle} from '../src/native-release-evidence.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
import {freezeReleaseAssets} from '../../core/src/release-asset-selection.js';
const {serviceReleaseWake}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
const {publishNativeCycle,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['failure','in_progress','second-failure'] as const)('services later cycles after real publication preparation sees %s',async kind=>{
  const f=productPipelineFixture(),native=evidenceFixture(kind==='second-failure'?2:1),cycle=f.context.cycle;
  Object.assign(f.runs.get(1),{status:kind==='in_progress'?'in_progress':'completed',conclusion:kind==='in_progress'?null:'failure'});
  if(kind==='in_progress')Object.assign(native.runs.get(1),{status:'in_progress',conclusion:null});
  native.setAccepted();
  const root=await mkdtemp(join(tmpdir(),'wake-publication-'));roots.push(root);registerOfflineFixtureRoot(root);
  const env=isolatedBuildEnvironment(process.env,root);
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:root,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=main');await git('config','user.name','Publication Fixture');await git('config','user.email','publication@example.invalid');
  const state={...f.input.state.repository,schemaVersion:3,releaseAdoption:{sourceSha:cycle.sourceSha,prNumber:1},candidate:null};
  await writeFile(join(root,'state.json'),JSON.stringify(state)+'\n');await mkdir(join(root,'cycles'));
  await writeFile(join(root,`cycles/${cycle.id}.json`),JSON.stringify(cycle)+'\n');
  await git('add','.');await git('commit','--signoff','-m','Registered cycle');await git('branch','steward/release-state');
  const head=await git('rev-parse','HEAD'),calls:string[]=[];
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.includes('/contents/')){
      const name=path.split('/contents/')[1]!.split('?')[0]!,text=path.startsWith('/repos/splrad/steward/')?'locked tools':f.source[name];
      if(text===undefined)throw Error('unregistered source '+name);
      const bytes=Buffer.from(text);return f.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
    }
    if(path.endsWith('/runs/100'))return f.response(f.runs.get(1));
    throw Error('unregistered publication read '+path);
  }};
  vi.stubGlobal('fetch',async(input:unknown)=>{const value=await io.request('GET',new URL(String(input)).pathname+new URL(String(input)).search);return new Response(Buffer.from(value.bytes).toString(),{status:value.status,headers:value.headers});});
  const snapshot=await readReleaseRecords({directory:root,targetRef:'steward/release-state',repositoryId:1});
  const later={...structuredClone(cycle),id:'pr-99-'+'e'.repeat(40),sourceSha:'e'.repeat(40),dispatches:[]};
  snapshot.cycles.push({value:later});
  const steps:string[]=[],results:any[]=[];
  await serviceReleaseWake({directory:root,repository:'example/product',repositoryId:1,appBotId:42,defaultBranch:'main'},async()=>snapshot,async(command:string,input:any)=>{
    steps.push(command+':'+input.cycleId);
    if(command==='publish'&&input.cycleId===cycle.id){
      const result=await publishNativeCycle(input,{token:'fixture',io,centralIo:io,centralInvocation:{runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'},controllerDirectory:process.cwd(),now:()=>NOW});
      expect(result).toMatchObject({status:'WAIT',reason:'BUILD_RUN_NOT_READY',publishInvoked:false});return result;
    }
    if(command==='rerun'&&input.cycleId===cycle.id){const result=await recoverNativeCycle(native.context,100,native.store,[],native.io,NOW);results.push(result);return result;}
    return {status:'WAIT',publishInvoked:false};
  });
  expect(steps).toContain('rerun:'+cycle.id);expect(steps).toContain('dispatch-build:'+later.id);expect(steps).toContain('publish:'+later.id);
  expect(native.calls.filter(call=>call.startsWith('POST'))).toHaveLength(kind==='failure'?1:0);
  expect(results[0]).toMatchObject(kind==='failure'?{status:'ACCEPTED',observedAttempt:2}:kind==='second-failure'?{status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'}:{status:'WAIT',reason:'RUN_IN_FLIGHT'});
  expect(await git('rev-parse','refs/heads/steward/release-state')).toBe(head);
  expect(calls.some(path=>path.includes('/artifacts')||path.includes('/releases'))).toBe(false);
},60_000);

it('re-observes a narrowed formal Release after the Actions archive expires',async()=>{
  const f=productPipelineFixture(), cycle=f.context.cycle, unit=cycle.units[0]!;
  const root=await mkdtemp(join(tmpdir(),'wake-frozen-assets-'));roots.push(root);registerOfflineFixtureRoot(root);
  const env=isolatedBuildEnvironment(process.env,root);
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:root,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=steward/release-state');
  await git('config','user.name','Publication Fixture');await git('config','user.email','publication@example.invalid');
  const digest=(bytes:string)=>createHash('sha256').update(bytes).digest('hex');
  const body='Reviewed notes', binary='sealed executable', name='app-1.0.0.exe';
  Object.assign(unit,{releaseId:20,notesDigest:digest(body),manifestDigest:digest('original private seal'),
    assets:[{id:'app',path:name,size:Buffer.byteLength(binary),sha256:digest(binary)}]});
  const state={...f.input.state.repository,schemaVersion:3,releaseAdoption:{sourceSha:cycle.sourceSha,prNumber:1},candidate:null};
  await writeFile(join(root,'state.json'),JSON.stringify(state)+'\n');await mkdir(join(root,'cycles'));
  await writeFile(join(root,`cycles/${cycle.id}.json`),JSON.stringify(cycle)+'\n');
  const [proof]=freezeReleaseAssets(1,cycle,[{unitId:'app',artifactIds:['app'],metadata:[]}]);
  await mkdir(join(root,'evidence','release-assets'),{recursive:true});
  await writeFile(join(root,proof!.path),proof!.content);
  await git('add','.');await git('commit','--signoff','-m','Registered narrowed cycle');
  const head=await git('rev-parse','HEAD'), calls:string[]=[];
  let assets=[{id:30,name,size:Buffer.byteLength(binary),state:'uploaded'}];
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.endsWith('/example/product'))return f.response({id:1,full_name:'example/product',private:false,archived:false,disabled:false});
    if(path.endsWith('/releases/20'))return f.response({id:20,tag_name:unit.tag,author:{id:42},draft:false,immutable:true,body});
    if(path.endsWith('/commits/'+unit.tag))return f.response({sha:cycle.sourceSha});
    if(path.includes('/releases/20/assets?'))return f.response(assets);
    if(path.endsWith('/releases/assets/30'))return {status:200,headers:new Headers(),bytes:Buffer.from(binary)};
    if(path.endsWith(`/contents/.github/delivery.json?ref=${cycle.sourceSha}`)) {
      const bytes=Buffer.from(f.source['.github/delivery.json']!);
      return f.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:cycle.deliveryConfigSha});
    }
    throw Error('Unexpected publication read '+path);
  }, anonymous:()=>({request:io.request})};
  const observe=()=>publishNativeCycle({...f.context,cycleId:cycle.id,directory:root,defaultBranch:'main'},
    {token:'fixture',io,centralIo:io,centralInvocation:{runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'},controllerDirectory:process.cwd()});
  await expect(observe()).resolves.toMatchObject({status:'OBSERVED',reason:'FORMAL_RELEASES_VERIFIED',publishInvoked:false});
  assets=[...assets,{id:31,name:'unexpected.zip',size:4,state:'uploaded'}];
  await expect(observe()).rejects.toThrow('formal release identity');
  expect(calls.some(path=>path.includes('/actions/')||path.includes('steward-settings'))).toBe(false);
  expect(await git('rev-parse','HEAD')).toBe(head);
},60_000);
