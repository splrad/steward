import {afterEach,expect,it,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {mergedCandidateFixture,productPipelineFixture} from './product-pipeline-fixture.js';
import {evidenceFixture,C,NOW,START,END,digest,zipResult} from './native-evidence-fixture.js';
import {archiveFile,nativeRequestIdentity,nativeRunFact,recoverNativeCycle} from '../src/native-release-evidence.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {permitOfflineScript,registerOfflineFixtureRoot} from './offline-fixtures.js';
import {releaseProtectionFixture} from './fixtures/release-protection.js';
const {observeReleaseChannels,publishNativeCycle,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['failure','in_progress','second-failure','formal-asset-404','wrong-delivery-format','wrong-delivery-version',
  'excluded-delivery-file','excluded-extensionless-file','freeze-original-attempt','freeze-attempt-incomplete',
  'freeze-recover-original','freeze-unproven-original','external-only-waits'] as const)('handles %s in the bounded native publication entry',async kind=>{
  const f=productPipelineFixture(),native=evidenceFixture(kind==='second-failure'?2:1),cycle=f.context.cycle;
  const excluded=kind==='excluded-delivery-file'||kind==='excluded-extensionless-file';
  const rejectDelivery=kind==='wrong-delivery-format'||kind==='wrong-delivery-version'||excluded;
  const assetName=kind==='excluded-extensionless-file'?'app':excluded?'extra.json':kind==='wrong-delivery-version'?'package.json':'app.exe';
  const archive=zipResult({name:'app',version:'2.0.0'},assetName);
  const artifact={id:800,name:`delivery-github-release-1-app-${cycle.sourceSha}-100-1`,digest:'sha256:'+digest(archive),
    expired:false,size_in_bytes:archive.length,workflow_run:{id:100,head_sha:cycle.sourceSha},created_at:'2026-10-26T00:00:30.000Z'};
  const externalOnly=kind==='external-only-waits';
  const historicalFreeze=kind==='freeze-recover-original'||kind==='freeze-unproven-original';
  const freeze=kind==='freeze-original-attempt'||kind==='freeze-attempt-incomplete'||historicalFreeze||externalOnly;
  if(kind==='formal-asset-404'||rejectDelivery||freeze) {
    const workflow='.github/workflows/steward-release-publish.yml';
    const compact=JSON.stringify({schemaVersion:3,repositoryAuthors:f.delivery.repositoryAuthors});
    f.source['.github/delivery.json']=compact;
    f.source[workflow]=JSON.stringify({jobs:{delivery:{name:'delivery/app',steps:[{
      id:'upload-github-release',name:'Upload GitHub release delivery',uses:'actions/upload-artifact@'+'a'.repeat(40),
      with:{name:'delivery-github-release-${{ github.repository_id }}-app-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
        path:excluded?'dist/*\n!dist/'+assetName:assetName},
    }]}}});
    if(freeze)f.source[workflow]=JSON.stringify({jobs:{build:{steps:[{run:'echo build'}]}}});
    if(externalOnly) {
      cycle.requiredChannels=[{unitId:'app',channelId:'ghcr-assets'}];
      f.source[workflow]=JSON.stringify({jobs:{delivery:{name:'delivery/app',steps:[{
        id:'upload-ghcr-assets',name:'Upload GHCR assets delivery',uses:'actions/upload-artifact@'+'a'.repeat(40),
        env:{STEWARD_CHANNEL_LOCATION:'ghcr.io/example/product'},with:{path:'dist/*.tgz',
          name:'delivery-ghcr-assets-${{ github.repository_id }}-app-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'},
      }]}}});
    }
    const settings=JSON.parse(f.source['release-please-config.json']!);
    settings.packages['.'].component='app';
    f.source['release-please-config.json']=JSON.stringify(settings);
    Object.assign(cycle,{workflowDelivery:true,buildWorkflow:workflow,
      deliveryConfigSha:createHash('sha1').update('blob '+Buffer.byteLength(compact)+'\0').update(compact).digest('hex')});
    f.request.buildWorkflow=workflow;
    Object.assign(f.request,nativeRequestIdentity(1,cycle,f.request));
    f.request.inputs.operation_key=f.request.operationKey;
    if(freeze)cycle.units[0]!.githubDisabled=true;
    else if(!rejectDelivery)Object.assign(cycle.units[0]!,{releaseId:50,assets:[{id:'app',path:'app.exe',size:3,sha256:digest('EXE')}],
      notesDigest:digest('approved body'),manifestDigest:digest('approved manifest'),
      githubDelivery:{runId:100,attempt:1,artifactId:800,digest:'sha256:'+digest('frozen archive')}});
  }
  Object.assign(f.runs.get(1),{status:kind==='in_progress'?'in_progress':'completed',
    conclusion:kind==='in_progress'?null:rejectDelivery||freeze?'success':'failure',display_title:'Build '+f.request.operationKey});
  if(historicalFreeze)cycle.freezeCompletedAt=END;
  if(kind==='in_progress')Object.assign(native.runs.get(1),{status:'in_progress',conclusion:null});
  native.setAccepted();
  const root=await mkdtemp(join(tmpdir(),'wake-publication-'));roots.push(root);registerOfflineFixtureRoot(root);
  const env=isolatedBuildEnvironment(process.env,root);
  const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:root,env,encoding:'utf8',windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=main');await git('config','user.name','Publication Fixture');await git('config','user.email','publication@example.invalid');
  const state={...f.input.state.repository,schemaVersion:3,releaseAdoption:{sourceSha:cycle.sourceSha,prNumber:1},candidate:null};
  await writeFile(join(root,'state.json'),JSON.stringify(state)+'\n');await mkdir(join(root,'cycles'));
  await writeFile(join(root,`cycles/${cycle.id}.json`),JSON.stringify(cycle)+'\n');
  if(kind==='freeze-recover-original') {
    const workflow=f.source[cycle.buildWorkflow!]!;
    const fact=archiveFile({schemaVersion:1,repositoryId:1,repository:f.context.repository,cycleId:cycle.id,sourceSha:cycle.sourceSha,
      requestKey:f.request.requestKey,inputDigest:f.request.inputDigest,executorControllerSha:C,
      workflowBlobSha:createHash('sha1').update('blob '+Buffer.byteLength(workflow)+'\0'+workflow).digest('hex'),
      sourceBlobs:[],observedAt:END,run:nativeRunFact(f.runs.get(1)),jobs:[],producers:[],logs:[],objects:[],missingNativeKeys:[]});
    const path=join(root,fact.path);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,fact.content);
  }
  if(rejectDelivery||freeze) {
    const candidate=mergedCandidateFixture(f.input);
    await mkdir(join(root,'generated',candidate.value.candidateId,'cycles'),{recursive:true});
    await writeFile(join(root,candidate.path),JSON.stringify(candidate.value)+'\n');
  }
  await git('add','.');await git('commit','--signoff','-m','Registered cycle');await git('branch','steward/release-state');
  const head=await git('rev-parse','HEAD'),calls:string[]=[];
  const io={anonymous:()=>io,request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.includes('/contents/')){
      const name=path.split('/contents/')[1]!.split('?')[0]!;
      const text=path.startsWith('/repos/splrad/steward/')&&name==='mise.lock'?'locked tools':
        name.endsWith('/release-template.md.mustache')?f.source['.github/release-template.md.mustache']:f.source[name];
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
    if(rejectDelivery) {
      if(path.includes('/runs/100/artifacts?'))return f.response({total_count:1,artifacts:[artifact]});
      if(path.includes('/runs/100/attempts/1/jobs?'))return f.response({total_count:1,jobs:[{id:1100,name:'delivery/app',
        run_id:100,run_attempt:1,head_sha:cycle.sourceSha,status:'completed',conclusion:'success',
        steps:[{name:'Upload GitHub release delivery',status:'completed',conclusion:'success',started_at:START,completed_at:END}]}]});
      if(path.endsWith('/actions/artifacts/800'))return f.response(artifact);
    }
    if(freeze) {
      if(path.endsWith('/git/ref/heads/steward/release-state'))
        return f.response({object:{sha:await git('rev-parse','refs/heads/steward/release-state')}});
      const protection=releaseProtectionFixture(path);
      if(protection)return f.response(protection);
      if(path.endsWith('/runs/100/attempts/1'))return f.response({...f.runs.get(1),
        conclusion:kind==='freeze-original-attempt'||kind==='freeze-recover-original'?'success':'failure'});
    }
    if(path.endsWith('/runs/100'))return f.response(f.runs.get(1));
    throw Error('unregistered publication read '+path);
  }};
  vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{
    const url=new URL(String(input)),path=url.pathname+url.search;
    expect(init?.method??'GET').toBe('GET');
    if(rejectDelivery&&path.endsWith('/actions/artifacts/800/zip'))
      return new Response(null,{status:302,headers:{location:'https://deliver.blob.core.windows.net/artifact.zip'}});
    if(rejectDelivery&&url.hostname==='deliver.blob.core.windows.net')
      return new Response(new Uint8Array(archive));
    const value=await io.request('GET',path);
    return new Response(Buffer.from(value.bytes).toString(),{status:value.status,headers:value.headers});
  });
  const publicationPorts={token:'fixture',io,centralIo:io,centralInvocation:{runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'},controllerDirectory:process.cwd(),now:()=>NOW};
  const registration={directory:root,repository:'example/product',repositoryId:1,appBotId:42,defaultBranch:'main'};
  if(freeze) {
    const input={...registration,cycleId:cycle.id,remote:root,writeDirectory:join(root,'writes'),
      identity:{name:'Publication Fixture',email:'publication@example.invalid'}};
    const result=await (historicalFreeze?observeReleaseChannels:publishNativeCycle)(input,publicationPorts);
    const finalHead=await git('rev-parse','refs/heads/steward/release-state');
    const attempt='/repos/example/product/actions/runs/100/attempts/1';
    expect(calls.filter(path=>path.includes('/actions/runs/'))).toEqual(kind==='freeze-recover-original'?[attempt]:
      externalOnly||kind==='freeze-unproven-original'?[]:['/repos/example/product/actions/runs/100',attempt]);
    expect(calls.some(path=>path.includes('/releases')||path.includes('/git/refs/tags')||path.includes('/artifacts'))).toBe(false);
    if(kind==='freeze-original-attempt'||kind==='freeze-recover-original') {
      expect(result).toMatchObject({status:'FROZEN',reason:'NO_PUBLICATION_CHANNELS',archiveHead:finalHead,publishInvoked:false});
      expect(finalHead).not.toBe(head);
      const saved=await readReleaseRecords({directory:root,targetRef:'steward/release-state',repositoryId:1});
      expect(saved.cycles[0]!.value).toMatchObject({id:cycle.id,freezeBuildAttempt:1,freezeCompletedAt:historicalFreeze?END:NOW});
      if(historicalFreeze) {
        const previousCalls=calls.length;
        await expect(observeReleaseChannels(input,publicationPorts)).resolves.toEqual(result);
        expect(calls.slice(previousCalls).some(path=>path.includes('/actions/runs/'))).toBe(false);
        expect(await git('rev-parse','refs/heads/steward/release-state')).toBe(finalHead);
      }
    } else if(kind==='freeze-unproven-original') {
      expect(result).toMatchObject({status:'UNKNOWN',reason:'FROZEN_BUILD_SOURCE_UNAVAILABLE',publishInvoked:false});
      expect(finalHead).toBe(head);
    } else {
      expect(result).toMatchObject({status:'WAIT',reason:externalOnly?'FORMAL_RELEASE_REQUIRED':'BUILD_RUN_NOT_READY',publishInvoked:false});
      expect(finalHead).toBe(head);
    }
    return;
  }
  if(kind==='formal-asset-404') {
    await expect(publishNativeCycle({...registration,cycleId:cycle.id},publicationPorts)).rejects.toMatchObject({status:404});
    expect(calls.some(path=>path.endsWith('/releases/assets/51'))).toBe(true);
    expect(calls.some(path=>path.includes('/actions/'))).toBe(false);
    expect(await git('rev-parse','refs/heads/steward/release-state')).toBe(head);
    return;
  }
  if(rejectDelivery) {
    const scratch=join(root,'scratch');await mkdir(scratch);
    for(const name of ['TMPDIR','TEMP','TMP'])vi.stubEnv(name,scratch);
    for(const script of ['expand-release-artifact.ps1','inspect-python-release.py'])permitOfflineScript(resolve('scripts',script));
    const reason=excluded?'RN_DELIVERY_SELECTION: workflow delivery file selection':
      (kind==='wrong-delivery-version'?'RN_DELIVERY_VERSION':'RN_DELIVERY_FORMAT')+': '+assetName;
    await expect(publishNativeCycle({...registration,cycleId:cycle.id},publicationPorts)).resolves.toMatchObject({
      status:'BLOCKED',reason:'WORKFLOW_GITHUB_DELIVERY_INVALID',publishInvoked:false,
      rejected:[{unitId:'app',channelId:'github-release',reason}],
    });
    expect(calls).toContain('/repos/example/product/actions/artifacts/800');
    expect(calls.some(path=>path.includes('/releases')||path.includes('/git/refs/tags'))).toBe(false);
    expect(await git('rev-parse','refs/heads/steward/release-state')).toBe(head);
    return;
  }
  await expect(publishNativeCycle({...registration,cycleId:cycle.id},publicationPorts)).resolves.toMatchObject({
    status:'WAIT',reason:'BUILD_RUN_NOT_READY',publishInvoked:false,
  });
  const result=await recoverNativeCycle(native.context,100,native.store,[],native.io,NOW);
  expect(native.calls.filter(call=>call.startsWith('POST'))).toHaveLength(kind==='failure'?1:0);
  expect(result).toMatchObject(kind==='failure'?{status:'ACCEPTED',observedAttempt:2}:kind==='second-failure'
    ?{status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED'}:{status:'WAIT',reason:'RUN_IN_FLIGHT'});
  expect(await git('rev-parse','refs/heads/steward/release-state')).toBe(head);
  expect(calls.some(path=>path.includes('/artifacts')||path.includes('/releases'))).toBe(false);
},60_000);
