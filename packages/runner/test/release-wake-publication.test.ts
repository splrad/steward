import {afterEach,expect,it,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {productPipelineFixture} from './product-pipeline-fixture.js';
import {evidenceFixture,C,NOW,digest} from './native-evidence-fixture.js';
import {nativeRequestIdentity,recoverNativeCycle} from '../src/native-release-evidence.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
const {serviceReleaseWake}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
const {publishNativeCycle,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['failure','in_progress','second-failure','formal-asset-404'] as const)('handles %s in the bounded native publication entry',async kind=>{
  const f=productPipelineFixture(),native=evidenceFixture(kind==='second-failure'?2:1),cycle=f.context.cycle;
  if(kind==='formal-asset-404') {
    const workflow='.github/workflows/steward-release-publish.yml';
    const compact=JSON.stringify({schemaVersion:3,repositoryAuthors:f.delivery.repositoryAuthors});
    f.source['.github/delivery.json']=compact;
    f.source[workflow]=JSON.stringify({jobs:{delivery:{name:'delivery/app',steps:[{
      id:'upload-github-release',name:'Upload GitHub release delivery',uses:'actions/upload-artifact@'+'a'.repeat(40),
      with:{name:'delivery-github-release-${{ github.repository_id }}-app-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',path:'app.exe'},
    }]}}});
    const settings=JSON.parse(f.source['release-please-config.json']!);
    settings.packages['.'].component='app';
    f.source['release-please-config.json']=JSON.stringify(settings);
    Object.assign(cycle,{workflowDelivery:true,buildWorkflow:workflow,
      deliveryConfigSha:createHash('sha1').update('blob '+Buffer.byteLength(compact)+'\0').update(compact).digest('hex')});
    f.request.buildWorkflow=workflow;
    Object.assign(f.request,nativeRequestIdentity(1,cycle,f.request));
    f.request.inputs.operation_key=f.request.operationKey;
    Object.assign(cycle.units[0]!,{releaseId:50,assets:[{id:'app',path:'app.exe',size:3,sha256:digest('EXE')}],
      notesDigest:digest('approved body'),manifestDigest:digest('approved manifest'),
      githubDelivery:{runId:100,attempt:1,artifactId:800,digest:'sha256:'+digest('frozen archive')}});
  }
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
  const io={anonymous:()=>io,request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.includes('/contents/')){
      const name=path.split('/contents/')[1]!.split('?')[0]!,text=path.startsWith('/repos/splrad/steward/')?'locked tools':f.source[name];
      if(text===undefined)throw Error('unregistered source '+name);
      const bytes=Buffer.from(text);return f.response({type:'file',path:name,encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
    }
    if(kind==='formal-asset-404') {
      if(path==='/repos/example/product')return f.response({id:1,full_name:'example/product',private:false,archived:false,disabled:false});
      if(path.endsWith('/releases/50'))return f.response({id:50,tag_name:'v1.0.0',author:{id:42},body:'approved body',draft:false,immutable:true});
      if(path.includes('/releases/50/assets?'))return f.response([{id:51,name:'app.exe',size:3,state:'uploaded'}]);
      if(path.endsWith('/commits/v1.0.0'))return f.response({sha:cycle.sourceSha});
      if(path.endsWith('/releases/assets/51'))return f.response({},404);
    }
    if(path.endsWith('/runs/100'))return f.response(f.runs.get(1));
    throw Error('unregistered publication read '+path);
  }};
  vi.stubGlobal('fetch',async(input:unknown)=>{const value=await io.request('GET',new URL(String(input)).pathname+new URL(String(input)).search);return new Response(Buffer.from(value.bytes).toString(),{status:value.status,headers:value.headers});});
  const publicationPorts={token:'fixture',io,centralIo:io,centralInvocation:{runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'},controllerDirectory:process.cwd(),now:()=>NOW};
  const registration={directory:root,repository:'example/product',repositoryId:1,appBotId:42,defaultBranch:'main'};
  if(kind==='formal-asset-404') {
    await expect(publishNativeCycle({...registration,cycleId:cycle.id},publicationPorts)).rejects.toMatchObject({status:404});
    expect(calls.some(path=>path.endsWith('/releases/assets/51'))).toBe(true);
    expect(calls.some(path=>path.includes('/actions/'))).toBe(false);
    expect(await git('rev-parse','refs/heads/steward/release-state')).toBe(head);
    return;
  }
  const snapshot=await readReleaseRecords({directory:root,targetRef:'steward/release-state',repositoryId:1});
  const later={...structuredClone(cycle),id:'pr-99-'+'e'.repeat(40),sourceSha:'e'.repeat(40),dispatches:[]};
  snapshot.cycles.push({value:later});
  const steps:string[]=[],results:any[]=[];
  await serviceReleaseWake(registration,async()=>snapshot,async(command:string,input:any)=>{
    steps.push(command+':'+input.cycleId);
    if(command==='publish'&&input.cycleId===cycle.id){
      const result=await publishNativeCycle(input,publicationPorts);
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
