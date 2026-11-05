import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { registerOfflineFixtureRoot, permitOfflineScript, offlineProcessArguments } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { decodeStateFile } from '../../core/src/release-observation.js';
import { decodeCandidateDocument } from '../../core/src/release-candidate-record.js';
import { splitContentText } from '../../core/src/release-content.js';

// Real Git processes on Windows exceed the unit-test default for concurrent
// transactions; each process still retains the production 30-second bound.
vi.setConfig({testTimeout:30_000});

const script=resolve('scripts/release-record.mjs');
const {writeReleaseRecords,readReleaseRecords,main}=await import(pathToFileURL(script).href);
const roots:string[]=[],S='a'.repeat(40),C='b'.repeat(40),H='c'.repeat(64);
const identity={name:'Offline State Writer',email:'state@example.invalid'};
const repository={schemaVersion:3,releaseAdoption:{sourceSha:'a'.repeat(40),prNumber:1},repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const file=(path:string,value:unknown,previousSha256:string|null=null)=>{
  const content=typeof value==='string'?value:JSON.stringify(value)+'\n';return {path,content,sha256:hash(content),previousSha256};
};
const original=(execFile as any)[promisify.custom] as (...args:any[])=>Promise<{stdout:Buffer;stderr:Buffer}>;
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'state-write-'));roots.push(root);registerOfflineFixtureRoot(root);
  const seed=join(root,'seed'),remote=join(root,'remote.git'),profile=join(root,'profile');await mkdir(seed);await mkdir(profile);
  const env=isolatedBuildEnvironment(process.env,profile);
  const git=async(...args:string[])=>(await original('git',args,{cwd:seed,env,encoding:'utf8',windowsHide:true})).stdout.toString().trim();
  await git('init','--initial-branch=main');await git('config','user.name',identity.name);await git('config','user.email',identity.email);
  await writeFile(join(seed,'README.md'),'Offline fixture\n');await git('add','--','README.md');await git('commit','--signoff','-m','Offline initial source');
  await git('init','--bare',remote);await git('push','--porcelain',remote,'HEAD:refs/heads/main');
  const request=(name:string,changes:ReturnType<typeof file>[],expectedHead:string|null=null,writer='release')=>({directory:join(root,name),remote,repositoryId:1,defaultBranch:'main',
    targetRef:writer==='health'?'steward/automation-health':['quality','settings','bootstrap','pages'].includes(writer)?'steward/governance-state':'steward/release-state',
    writer,expectedHead,allowedPaths:changes.map(item=>item.path),changes,identity});
  const head=async(targetRef='steward/release-state')=>{
    const result=await git('ls-remote','--heads','--refs',remote,`refs/heads/${targetRef}`);return result?result.split('\t')[0]!:null;
  };
  const show=async(commit:string,path:string)=>git('-C',remote,'show',`${commit}:${path}`);
  return {root,seed,remote,env,git,request,head,show};
}
function intercept(fn:(args:string[],options:any,run:()=>Promise<any>)=>Promise<any>){
  return vi.spyOn(execFile as any,promisify.custom).mockImplementation(async(command:any,args:any,options:any)=>fn(args,options,()=>original(command,args,options)));
}
it('creates an isolated root state commit, verifies signoff and repeats without a second commit',async()=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]),calls:string[][]=[];
  intercept(async(args,_options,run)=>{calls.push(args);return run();});
  const first=await writeReleaseRecords(request),second=await writeReleaseRecords(request);
  expect(first.status).toBe('APPLIED');expect(second).toEqual(first);expect(await f.head()).toBe(first.proposedCommit);
  expect(await f.git('-C',f.remote,'show','-s','--format=%P',first.head)).toBe('');
  const message=await f.git('-C',f.remote,'show','-s','--format=%B',first.head);
  expect(message.match(/^Signed-off-by:/gm)).toHaveLength(1);expect(message).toContain(`Signed-off-by: ${identity.name} <${identity.email}>`);
  expect(calls.filter(args=>args.includes('push'))).toHaveLength(1);
  expect(calls.filter(args=>args.includes('push')).every(args=>args.at(-1)==='HEAD:refs/heads/steward/release-state'&&!args.some(arg=>arg.includes('force')))).toBe(true);
  expect(await f.git('status','--porcelain')).toBe('');
});
it('rejects all new v2 repository writes and changes to an adopted A/P',async()=>{
  const f=await fixture(),{releaseAdoption:_,...historical}=repository;
  await expect(writeReleaseRecords(f.request('old',[file('state.json',{...historical,schemaVersion:2})]))).rejects.toThrow();
  const state=file('state.json',repository),first=await writeReleaseRecords(f.request('current',[state]));
  await expect(writeReleaseRecords(f.request('changed',[file('state.json',{...repository,revision:1,releaseAdoption:{sourceSha:C,prNumber:1}},state.sha256)],first.head))).rejects.toThrow();
  expect(await f.head()).toBe(first.head);
});
it('preserves the complete existing tree and uses the observed ref as the only parent',async()=>{
  const f=await fixture(),state=file('state.json',repository),a=await writeReleaseRecords(f.request('a',[state,file('generated/old.md','Earlier\n')]));
  const b=await writeReleaseRecords(f.request('b',[file('state.json',{...repository,revision:1},state.sha256)],a.head));
  expect(b.status).toBe('APPLIED');expect(await f.show(b.head,'generated/old.md')).toBe('Earlier');
  expect(await f.git('-C',f.remote,'show','-s','--format=%P',b.head)).toBe(a.head);
});
it('reconciles two concurrent App-owned directories without replaying the losing full tree',async()=>{
  const f=await fixture(),path=`quality/1/${S}.md`,initial=await writeReleaseRecords(f.request('seed-state',[file(path,'Original\n')],null,'quality'));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let arrivals=0;
  const pushes:string[][]=[];
  intercept(async(args,_options,run)=>{
    if(args.includes('push')){pushes.push(args);if(++arrivals<=2){if(arrivals===2)release();await gate;}}
    return run();
  });
  const [a,b]=await Promise.all([
    writeReleaseRecords(f.request('quality',[file(`quality/2/${S}.md`,'Chinese findings\n')],initial.head,'quality')),
    writeReleaseRecords(f.request('settings',[file('settings/50-1.md','Native settings details\n')],initial.head,'settings')),
  ]);
  expect([a.status,b.status]).toEqual(['APPLIED','APPLIED']);
  const head=(await f.head('steward/governance-state'))!;
  expect(await f.show(head,path)).toBe('Original');expect(await f.show(head,`quality/2/${S}.md`)).toBe('Chinese findings');expect(await f.show(head,'settings/50-1.md')).toBe('Native settings details');
  expect(await f.git('-C',f.remote,'rev-list','--count',head)).toBe('3');
  expect(pushes.length).toBeGreaterThanOrEqual(3);expect(pushes.every(args=>!args.some(arg=>arg.includes('force')))).toBe(true);
});
it('stops on a same-path conflict and preserves the other writer value',async()=>{
  const f=await fixture(),path=`quality/1/${S}.md`,old=file(path,'Original\n'),a=await writeReleaseRecords(f.request('a',[old],null,'quality'));
  let raced=false;
  intercept(async(args,_options,run)=>{
    if(args.includes('push')&&!raced){raced=true;await writeReleaseRecords(f.request('other',[file(path,'Other writer\n',old.sha256)],a.head,'quality'));}
    return run();
  });
  const result=await writeReleaseRecords(f.request('mine',[file(path,'My writer\n',old.sha256)],a.head,'quality'));
  expect(result).toMatchObject({status:'CONFLICT',reason:'OWN_PATH_CHANGED'});
  expect(await f.show((await f.head('steward/governance-state'))!,path)).toBe('Other writer');
});
it.each(['accepted','not-accepted'])('recovers %s lost push response using the exact proposed commit',async disposition=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]),commits:string[]=[];let lost=false;
  intercept(async(args,options,run)=>{
    if(args.includes('push')){
      commits.push((await original('git',['rev-parse','HEAD'],{...options,encoding:'utf8'})).stdout.toString().trim());
      if(!lost){lost=true;if(disposition==='accepted')await run();throw new Error('fixture response loss');}
    }
    return run();
  });
  const result=await writeReleaseRecords(request);expect(result.status).toBe('APPLIED');expect(new Set(commits).size).toBe(1);
  expect(commits).toHaveLength(disposition==='accepted'?1:2);expect(await f.head()).toBe(result.proposedCommit);
});
it.each(['accepted','not-accepted'])('resumes %s unknown response in a new Node process without another prepared commit',async disposition=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]);let afterPush=false;
  const spy=intercept(async(args,_options,run)=>{
    if(args.includes('push')){afterPush=true;if(disposition==='accepted')await run();throw new Error('fixture lost response');}
    if(afterPush && args.includes('ls-remote'))throw new Error('fixture read unavailable');return run();
  });
  const unknown=await writeReleaseRecords(request);expect(unknown).toMatchObject({status:'UNKNOWN',reason:'REMOTE_READ_UNAVAILABLE'});expect(unknown.proposedCommit).toMatch(/^[a-f0-9]{40}$/);
  spy.mockRestore();const input=join(f.root,'input.json'),output=join(f.root,'output.json');await writeFile(input,JSON.stringify(request));permitOfflineScript(script);
  await promisify(execFile)(process.execPath,[script,'write','--input',input,'--output',output],{env:f.env,cwd:process.cwd(),windowsHide:true});
  const resumed=JSON.parse(await readFile(output,'utf8'));expect(resumed).toMatchObject({status:'APPLIED',proposedCommit:unknown.proposedCommit});
  expect(await f.git('-C',f.remote,'rev-list','--count',resumed.head)).toBe('1');
});
it('does not turn an unavailable remote read into an absent branch or perform a push',async()=>{
  const f=await fixture(),calls:string[][]=[];
  intercept(async(args,_options,run)=>{calls.push(args);if(args.includes('ls-remote'))throw new Error('fixture auth unknown');return run();});
  expect(await writeReleaseRecords(f.request('write',[file('state.json',repository)]))).toMatchObject({status:'UNKNOWN',reason:'REMOTE_READ_UNAVAILABLE',proposedCommit:null});
  expect(calls.some(args=>args.includes('push'))).toBe(false);
});
it('requires an existing real default branch before the first state ref',async()=>{
  const f=await fixture(),request={...f.request('write',[file('state.json',repository)]),defaultBranch:'absent'};
  expect(await writeReleaseRecords(request)).toMatchObject({status:'CONFLICT',reason:'DEFAULT_BRANCH_REQUIRED'});expect(await f.head()).toBeNull();
});
it.each(['wrong-owner','wrong-ref','path-escape','foreign-path','wrong-digest','wrong-base','future-field','unknown-schema','arbitrary-json'])('rejects %s before changing the remote',async kind=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]) as any;
  if(kind==='wrong-owner')request.writer='settings';if(kind==='wrong-ref')request.targetRef='main';
  if(kind==='path-escape'){request.changes[0].path='../state.json';request.allowedPaths=['../state.json'];}
  if(kind==='foreign-path'){request.changes=[file('.github/workflows/run.yml','commands')];request.allowedPaths=request.changes.map((x:any)=>x.path);}
  if(kind==='wrong-digest')request.changes[0].sha256=H;
  if(kind==='wrong-base')request.changes[0].previousSha256=H;
  if(kind==='future-field')request.changes=[file('state.json',{...repository,allowedJobs:['publish']})];
  if(kind==='unknown-schema')request.changes=[file('state.json',{...repository,schemaVersion:4})];
  if(kind==='arbitrary-json'){request.writer='settings';request.targetRef='steward/governance-state';request.changes=[file('settings/1-1.json',{command:'arbitrary'})];request.allowedPaths=['settings/1-1.json'];}
  await expect(writeReleaseRecords(request)).rejects.toThrow();expect(await f.head()).toBeNull();expect(await f.head('steward/governance-state')).toBeNull();
});
it('rejects a pre-existing user checkout and a linked workspace without overwriting either',async()=>{
  const f=await fixture(),before=await readFile(join(f.seed,'.git','config'));
  await expect(writeReleaseRecords({...f.request('write',[file('state.json',repository)]),directory:f.seed})).rejects.toThrow('workspace ownership');
  expect(await readFile(join(f.seed,'.git','config'))).toEqual(before);
  const link=join(f.root,'link');await symlink(f.seed,link,process.platform==='win32'?'junction':'dir');
  await expect(writeReleaseRecords({...f.request('other',[file('state.json',repository)]),directory:link})).rejects.toThrow('workspace path');
  expect(await f.head()).toBeNull();
});
it.each(['unknown-version','unreadable-extension'])('refuses existing %s instead of overwriting it with a supported record',async kind=>{
  const f=await fixture();await f.git('switch','--orphan','steward/release-state');await writeFile(join(f.seed,'state.json'),JSON.stringify(kind==='unknown-version'?{...repository,schemaVersion:4}:{...repository,newOptionalFact:'retained'}));
  await f.git('add','--','state.json');await f.git('commit','--signoff','-m','Offline unsupported state');await f.git('push','--porcelain',f.remote,'HEAD:refs/heads/steward/release-state');
  const head=await f.head();
  await expect(writeReleaseRecords(f.request('write',[file('generated/new.md','New\n')],head))).rejects.toThrow();expect(await f.head()).toBe(head);
  const independent=await fixture();expect((await writeReleaseRecords(independent.request('other',[file('state.json',repository)]))).status).toBe('APPLIED');
});
it('writes and reads closed health and bootstrap facts while rejecting private identifiers in public health',async()=>{
  const f=await fixture(),observedAt='2026-10-27T00:00:00Z';
  const health={schemaVersion:1,workflowId:1,runId:50,runAttempt:1,controllerSha:C,observedAt,scanCompletedAt:null,errorCodes:['SCAN_FAILED'],counts:{scanned:2,completed:1,waiting:0,failed:1,unknown:0}};
  const bootstrap={schemaVersion:1,repositoryId:1,defaultBranch:'main',workflowId:2,runId:60,runAttempt:1,controllerSha:C,firstCommitSha:S,phase:'RESTORED',affectedRules:[]};
  const h=await writeReleaseRecords(f.request('health',[file('health.json',health)],null,'health'));
  const b=await writeReleaseRecords(f.request('bootstrap',[file('bootstrap/60-1.json',bootstrap)],null,'bootstrap'));
  expect([h.status,b.status]).toEqual(['APPLIED','APPLIED']);
  expect((await readReleaseRecords({directory:join(f.root,'health'),targetRef:'steward/automation-health',repositoryId:1})).domainRecords).toHaveLength(1);
  expect(()=>decodeStateFile('steward/automation-health','health.json',Buffer.from(JSON.stringify({...health,privateRepository:'private-canary'})),1)).toThrow();
  expect(()=>decodeStateFile('steward/governance-state','bootstrap/60-1.json',Buffer.from(JSON.stringify({...bootstrap,repositoryId:2})),1)).toThrow();
});
it('reserves CLI output before any mutation and rejects duplicate request keys',async()=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]),input=join(f.root,'input.json'),output=join(f.root,'output.json');
  await writeFile(input,JSON.stringify(request));await writeFile(output,'Keep\n');
  await expect(main(['write','--input',input,'--output',output])).rejects.toMatchObject({code:'EEXIST'});expect(await f.head()).toBeNull();
  await writeFile(input,JSON.stringify(request).replace('{','{"writer":"settings",'));
  await expect(main(['write','--input',input,'--output',join(f.root,'new.json')])).rejects.toThrow();expect(await f.head()).toBeNull();
});
it('limits the offline Git transport to local registered roots and ordinary explicit ref pushes',async()=>{
  const f=await fixture();
  expect(offlineProcessArguments('git',['push','--porcelain',f.remote,'HEAD:refs/heads/steward/release-state'],{cwd:f.seed})).not.toBeNull();
  for(const remote of ['https://github.com/example/repo.git',tmpdir(),'ext::command'])expect(offlineProcessArguments('git',['push','--porcelain',remote,'HEAD:refs/heads/main'],{cwd:f.seed})).toBeNull();
  for(const flag of ['--force','--force-with-lease','--mirror','--delete'])expect(offlineProcessArguments('git',['push',flag,f.remote,'HEAD:refs/heads/main'],{cwd:f.seed})).toBeNull();
});
it('preserves a state branch created concurrently with the initial root proposal',async()=>{
  const f=await fixture();let raced=false;
  intercept(async(args,_options,run)=>{
    if(args.includes('push')&&!raced){raced=true;await writeReleaseRecords(f.request('settings',[file('settings/1-1.md','Concurrent root\n')],null,'settings'));}
    return run();
  });
  const result=await writeReleaseRecords(f.request('quality',[file(`quality/1/${S}.md`,'Own fact\n')],null,'quality'));
  expect(result.status).toBe('APPLIED');expect(await f.show(result.head,'settings/1-1.md')).toBe('Concurrent root');
  expect(await f.git('-C',f.remote,'rev-list','--count',result.head)).toBe('2');
});
it('reports adopted bytes changed instead of replaying an already adopted proposal',async()=>{
  const f=await fixture(),path=`quality/1/${S}.md`,desired=file(path,'Own fact\n');let raced=false;let pushes=0;
  intercept(async(args,options,run)=>{
    if(args.includes('push')){
      pushes++;const value=await run();
      if(!raced){raced=true;const head=(await original('git',['rev-parse','HEAD'],{...options,encoding:'utf8'})).stdout.toString().trim();
        await writeReleaseRecords(f.request('other',[file(path,'Later fact\n',desired.sha256)],head,'quality'));}
      return value;
    }return run();
  });
  const result=await writeReleaseRecords(f.request('mine',[desired],null,'quality'));
  expect(result).toMatchObject({status:'CONFLICT',reason:'ADOPTED_BYTES_CHANGED'});expect(pushes).toBe(2);
  expect(await f.show(result.head,path)).toBe('Later fact');
});
it.each(['deleted','rewritten'])('does not recreate or overwrite a %s expected state ref',async kind=>{
  const f=await fixture(),state=file('state.json',repository),a=await writeReleaseRecords(f.request('a',[state]));
  if(kind==='deleted')await f.git('-C',f.remote,'update-ref','-d','refs/heads/steward/release-state');
  else await f.git('-C',f.remote,'update-ref','refs/heads/steward/release-state',await f.git('rev-parse','main'));
  const head=await f.head();const result=await writeReleaseRecords(f.request('b',[file('state.json',{...repository,revision:1},state.sha256)],a.head));
  expect(result).toMatchObject({status:'CONFLICT',reason:kind==='deleted'?'STATE_REF_DISAPPEARED':'STATE_HISTORY_CHANGED'});expect(await f.head()).toBe(head);
});
it('refuses a truly empty repository and never creates its first ref',async()=>{
  const f=await fixture(),remote=join(f.root,'empty.git');await f.git('init','--bare',remote);
  const result=await writeReleaseRecords({...f.request('empty-write',[file('state.json',repository)]),remote});
  expect(result).toMatchObject({status:'CONFLICT',reason:'DEFAULT_BRANCH_REQUIRED'});
  expect(await f.git('-C',remote,'for-each-ref','--format=%(refname)')).toBe('');
});
it('verifies the prepared commit contains no staged foreign path before pushing it',async()=>{
  const f=await fixture();let injected=false;
  intercept(async(args,options,run)=>{
    if(args.includes('commit')&&!injected){injected=true;await mkdir(join(options.cwd,'settings'));await writeFile(join(options.cwd,'settings','1-1.md'),'Foreign\n');
      await original('git',['add','--','settings/1-1.md'],options);}
    return run();
  });
  await expect(writeReleaseRecords(f.request('quality',[file(`quality/1/${S}.md`,'Own\n')],null,'quality'))).rejects.toThrow('prepared path conflict');
  expect(await f.head('steward/governance-state')).toBeNull();
});
it('binds recovery to the original prepared bytes instead of accepting changed retry input',async()=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]);let pending=false;
  const spy=intercept(async(args,_options,run)=>{
    if(args.includes('push')){pending=true;throw new Error('fixture offline');}
    if(pending&&args.includes('ls-remote'))throw new Error('fixture offline');return run();
  });
  expect((await writeReleaseRecords(request)).status).toBe('UNKNOWN');spy.mockRestore();
  await expect(writeReleaseRecords({...request,changes:[file('state.json',{...repository,revision:2})]})).rejects.toThrow('prepared bytes conflict');
  expect(await f.head()).toBeNull();
});
it('passes only the selected credential in child environment and leaves no credential in Git config, args or errors',async()=>{
  const f=await fixture(),token='offline-credential-canary',calls:{args:string[];env:Record<string,string>}[]=[];
  const old=process.env.GH_TOKEN;process.env.GH_TOKEN='unrelated-token-canary';
  try {
    intercept(async(args,options,run)=>{calls.push({args,env:options.env});if(args.includes('ls-remote'))throw new Error(token);return run();});
    const result=await writeReleaseRecords({...f.request('write',[file('state.json',repository)]),remote:'https://github.com/example/product.git'},{token});
    expect(result.status).toBe('UNKNOWN');expect(JSON.stringify(result)).not.toContain(token);
    const call=calls.find(value=>value.args.includes('ls-remote'))!;expect(call.env.GH_TOKEN).toBeUndefined();
    expect(call.env.GIT_CONFIG_VALUE_0).toBe('AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64'));
    expect(call.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/example/product.git.extraheader');
    expect(JSON.stringify(calls.map(value=>value.args))).not.toContain(token);
    expect(await readFile(join(f.root,'write','.git','config'),'utf8')).not.toContain(token);
  } finally { if(old===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=old; }
});
it.each(['generated/con.md','content/AUX/note.md'])('rejects portable device path %s before any local transaction',async path=>{
  const f=await fixture();await expect(writeReleaseRecords(f.request('write',[file(path,'Unsafe\n')]))).rejects.toThrow();expect(await f.head()).toBeNull();
});
it('does not reuse a prepared workspace for another remote or state ref',async()=>{
  const f=await fixture(),request=f.request('write',[file('state.json',repository)]);let pending=false;
  const spy=intercept(async(args,_options,run)=>{
    if(args.includes('push')){pending=true;throw new Error('fixture offline');}
    if(pending&&args.includes('ls-remote'))throw new Error('fixture offline');return run();
  });
  expect((await writeReleaseRecords(request)).status).toBe('UNKNOWN');spy.mockRestore();
  const other=join(f.root,'other.git');await f.git('init','--bare',other);
  await expect(writeReleaseRecords({...request,remote:other})).rejects.toThrow('workspace ownership');
  await expect(writeReleaseRecords({...request,repositoryId:2,changes:[file('state.json',{...repository,repositoryId:2})]})).rejects.toThrow('workspace ownership');
  const changed={...f.request('write',[file(`quality/1/${S}.md`,'Own\n')],null,'quality')};
  await expect(writeReleaseRecords(changed)).rejects.toThrow('workspace ownership');
  expect(await f.head()).toBeNull();
});
// The 39 MiB source collector runs on both platforms. This additional many-file
// archive transaction runs on the production Linux platform to bound Windows Git process overhead.
it.runIf(process.platform !== 'win32')('archives a complete candidate document beyond the old aggregate state limit',async()=>{
  const f=await fixture();
  const document={schemaVersion:1,baseSha:S,configDigest:H,sourceDigest:H,units:[{id:'app',path:'.',version:'1.0.0',tag:'v1.0.0'}],
    files:Array.from({length:140},(_,i)=>({path:`.release-notes/unit-${i}.md`,mode:'100644',content:'中'.repeat(45000)}))};
  const text=JSON.stringify(document),documentDigest=hash(text),parts=splitContentText(text,120*1024);
  expect(Buffer.byteLength(text)).toBeGreaterThan(16*1024*1024);
  const chunks=parts.map((part,index)=>({schemaVersion:1 as const,repositoryId:1,candidateId:H,documentKind:'generated' as const,documentDigest,index,count:parts.length,content:part.text}));
  const files=chunks.map((chunk,index)=>file(`generated/${H}/large-${index}.json`,chunk));
  const result=await writeReleaseRecords(f.request('large',[file('state.json',repository),...files]));
  expect(result.status).toBe('APPLIED');
  const snapshot=await readReleaseRecords({directory:join(f.root,'large'),targetRef:'steward/release-state',repositoryId:1});
  const recovered=snapshot.domainRecords.filter((r:any)=>r.path.startsWith(`generated/${H}/large-`)).map((r:any)=>r.value);
  expect((await decodeCandidateDocument(recovered)).files).toHaveLength(140);
},120_000);
