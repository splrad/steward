import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
const module=()=>import(pathToFileURL(resolve('scripts/dependency-targets.mjs')).href);
const source='a'.repeat(40);
const repository={id:12,name:'fixture',full_name:'splrad/fixture',owner:{id:302208797},default_branch:'main',archived:false,disabled:false};
function fixture(config:any={enabledManagers:['mise','github-actions']}) {
  const bytes=Buffer.from(typeof config==='string'?config:JSON.stringify(config));
  const file={type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64'),sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
  const calls:string[]=[];
  const get=async(path:string,absent=false):Promise<any>=>{
    calls.push(path);
    if(path.endsWith('/contents/.github/renovate.json?ref='+source)){expect(absent).toBe(true);return file;}
    if(path.includes('/commits/'))return {sha:source};
    if(path==='/repos/'+repository.full_name)return repository;
    throw Error('unregistered');
  };
  return {get,file,calls};
}
it('reads only the target native config at a verified current default-branch commit',async()=>{
  const {readUpdateTarget}=await module(),f=fixture();
  expect(await readUpdateTarget(repository,f.get)).toEqual({id:12,fullName:repository.full_name,repository:'fixture',sourceSha:source});
  expect(f.calls).toHaveLength(4);expect(f.calls.join(' ')).not.toMatch(/config\/repositories|policySha|managedSync/);
});
it.each([{enabled:false},{enabledManagers:[]}])('disabled native scope is a NOP: %j',async(config)=>{
  const {readUpdateTarget}=await module();expect(await readUpdateTarget(repository,fixture(config).get)).toBeNull();
});
it.each([{enabled:true},{enabled:'false',enabledManagers:['mise']},{enabledManagers:['npm']},{enabledManagers:['mise','mise']},[],null,'{invalid'])('invalid configuration fails closed: %j',async(config)=>{
  const {readUpdateTarget}=await module();await expect(readUpdateTarget(repository,fixture(config).get)).rejects.toThrow();
});
it('config absence differs from unreadable bytes, identity drift and source movement',async()=>{
  const {readUpdateTarget}=await module();
  const f=fixture();expect(await readUpdateTarget(repository,async(p:string,a:boolean)=>a?null:f.get(p))).toBeNull();
  for(const change of [(v:any)=>({...v,id:99}),(v:any)=>({...v,owner:{id:99}}),(v:any)=>({...v,name:'other'})])
    await expect(readUpdateTarget(repository,async(p:string,a:boolean)=>change(await f.get(p,a)))).rejects.toThrow('IDENTITY');
  for(const change of [(v:any)=>({...v,size:v.size+1}),(v:any)=>({...v,sha:'b'.repeat(40)}),(v:any)=>({...v,type:'symlink'})])
    await expect(readUpdateTarget(repository,async(p:string,a:boolean)=>a?change(f.file):f.get(p,a))).rejects.toThrow();
  let heads=0;await expect(readUpdateTarget(repository,async(p:string,a:boolean)=>p.includes('/commits/')?{sha:++heads===1?source:'b'.repeat(40)}:f.get(p,a))).rejects.toThrow('SOURCE_MOVED');
});
it('isolates repository read failures, emits only opaque per-run slots and never substitutes a removed target',async()=>{
  const {discoverUpdateTargets,updateSlot}=await module(),f=fixture(),scopes:number[]=[];
  const app={discover:async()=>[{...repository,id:13,full_name:'splrad/private-canary'},repository],
    forUpdateReadRepository:async(id:number,fn:any)=>{scopes.push(id);if(id===13)throw Error('private-canary');return fn('fixture-token');}};
  const result=await discoverUpdateTargets(app,45,undefined,()=>f.get);
  expect(result).toEqual({include:[{slot:updateSlot(45,12)}],failed:1});expect(scopes).toEqual([13,12]);
  expect(JSON.stringify(result)).not.toMatch(/private|fixture|repositoryId|full_name/);
  expect(updateSlot(45,12)).not.toBe(updateSlot(46,12));
  expect(await discoverUpdateTargets(app,45,updateSlot(45,99),()=>f.get)).toBeNull();
  await expect(discoverUpdateTargets(app,45,updateSlot(45,13),()=>f.get)).rejects.toThrow();
  await expect(discoverUpdateTargets({...app,discover:async()=>[repository,repository]},45,undefined,()=>f.get)).rejects.toThrow('DUPLICATE');
});
it('rejects an untrusted run before acquiring an App credential',async()=>{
  const {main}=await module();let acquired=0;
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ID:'45',STEWARD_CONTROLLER_SHA:source,GITHUB_OUTPUT:'unused'};
  const transport=async()=>new Response(JSON.stringify({id:45,workflow_id:8,repository:{id:99}}));
  await expect(main(env,transport,async()=>{acquired++;})).rejects.toThrow('RUN');expect(acquired).toBe(0);
  await expect(main({...env,GITHUB_REF:'refs/heads/feature'},transport)).rejects.toThrow('ENTRY');
});
it('rechecks the write token repository ID after name selection and handles 404 versus 403',async()=>{
  const {main,updateSlot}=await module(),f=fixture(),root=await mkdtemp(join(tmpdir(),'update-entry-'));
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ID:'45',STEWARD_CONTROLLER_SHA:source,GITHUB_OUTPUT:join(root,'output'),GITHUB_TOKEN:'read',UPDATE_SLOT:updateSlot(45,12),UPDATE_WRITE_TOKEN:'write'};
  let boundId=99,configStatus=200;
  const factory=async()=>({discover:async()=>[repository],forUpdateReadRepository:async(_id:number,fn:any)=>fn('target-read')});
  const transport=async(url:any,options:any)=>{
    expect(options.redirect).toBe('error');const path=String(url).replace('https://api.github.com','');let value:any;
    if(path.endsWith('/actions/runs/45'))value={id:45,workflow_id:8,repository:{id:1296724484},head_repository:{id:1296724484},head_branch:'main',head_sha:source,event:'schedule'};
    else if(path.endsWith('/actions/workflows/update-dependencies.yml'))value={id:8,path:'.github/workflows/update-dependencies.yml',state:'active'};
    else if(path.endsWith('/commits/main')&&path.includes('/steward/'))value={sha:source};
    else if(path.includes('/compare/'))value={status:'identical',merge_base_commit:{sha:source}};
    else if(path.startsWith('/installation/repositories')){expect(options.headers.authorization).toBe('Bearer write');value={total_count:1,repositories:[{id:boundId,full_name:repository.full_name}]};}
    else if(path.includes('/contents/')&&configStatus!==200)return new Response('{}',{status:configStatus});
    else value=await f.get(path,path.includes('/contents/'));
    return new Response(JSON.stringify(value));
  };
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  try {
    await expect(main(env,transport,factory)).rejects.toThrow('WRITE_SCOPE');
    boundId=12;await main(env,transport,factory);expect(await readFile(env.GITHUB_OUTPUT,'utf8')).toContain('enabled=true');
    expect(output.mock.calls.map(c=>c[0]).join('')).toContain('::add-mask::splrad/fixture');
    configStatus=403;await expect(main(env,transport,factory)).rejects.toThrow('READ_UNAVAILABLE');
    configStatus=404;await main(env,transport,factory);expect(await readFile(env.GITHUB_OUTPUT,'utf8')).toContain('enabled=false');
  }finally{output.mockRestore();await rm(root,{recursive:true,force:true});}
});
it('workflow keeps isolated failure, bounded jobs and minimal scoped write credentials',async()=>{
  const raw=await readFile('.github/workflows/update-dependencies.yml','utf8'),w=YAML.parse(raw),{targets,update}=w.jobs;
  expect(w.on.workflow_dispatch?.inputs).toBeUndefined();expect(w.on.schedule).toEqual([{cron:'11 1 * * *'}]);
  expect(targets.if).toContain("vars.STEWARD_UPDATES_APPLY == 'true'");expect(update.if).toContain('!cancelled()');
  expect(update.strategy['fail-fast']).toBe(false);expect(update.strategy['max-parallel']).toBe(1);expect(update['timeout-minutes']).toBe(45);
  const token=update.steps.find((s:any)=>s.id==='target-token'),check=update.steps.find((s:any)=>s.id==='write-check'),run=update.steps.find((s:any)=>s.id==='renovate');
  expect(token.with.repositories).toBe('${{ steps.before.outputs.repository }}');expect(token.with['permission-administration']).toBeUndefined();
  expect(check.env.UPDATE_WRITE_TOKEN).toBe('${{ steps.target-token.outputs.token }}');expect(run.if).toContain('steps.write-check.outputs.enabled');
  expect(run.env.RENOVATE_REPOSITORIES).toContain('steps.write-check.outputs.full_name');
  expect(w.jobs['automation-health']).toBeUndefined();expect(raw).not.toMatch(/dependency-updates (targets|preflight)|docker\.sock|policySha/);
});
