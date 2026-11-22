import {expect,it,vi} from 'vitest';
import {readFile,writeFile,mkdtemp,mkdir,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
const script=(name:string)=>import(pathToFileURL(resolve('scripts/'+name+'.mjs')).href);
const S='a'.repeat(40);
function checkRunsFor(run:{id:number,check_suite_id:number,repository:{full_name:string},head_sha:string,run_started_at:string},
  jobs:{id:number,name:string,status:string,conclusion:string|null}[]) {
  return jobs.map(({id,name,status,conclusion})=>({id,name,status,conclusion,head_sha:run.head_sha,
    check_suite:{id:run.check_suite_id},app:{id:15368},started_at:run.run_started_at,
    details_url:`https://github.com/${run.repository.full_name}/actions/runs/${run.id}/job/${id}`}));
}
it('private governance rejects product trees before publishing any build outputs',async()=>{
  const {main}=await script('validation-input'),root=await mkdtemp(join(tmpdir(),'governance-admission-'));registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'README.md'),'base\n');git('add','.');git('commit','--signoff','--no-gpg-sign','-m','base');
    const base=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',base);
    await writeFile(join(root,'README.md'),'head\n');git('add','.');git('commit','--signoff','--no-gpg-sign','-m','head');
    const event=join(root,'event.json'),output=join(root,'output.txt');
    const env={VALIDATION_WORKSPACE:root,GITHUB_OUTPUT:output,GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY_ID:'42',GITHUB_REPOSITORY:'splrad/fixture',WORKFLOW_REPOSITORY:'splrad/steward',WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',WORKFLOW_SHA:S,PRIVATE_GOVERNANCE_REPOSITORY_ID:'42'};
    const payload=()=>({repository:{id:42,full_name:'splrad/fixture',private:true,owner:{id:302208797}},pull_request:{base:{repo:{id:42},ref:'main',sha:base},head:{sha:git('rev-parse','HEAD')}}});
    await writeFile(event,JSON.stringify(payload()));expect(await main(env)).toMatchObject({productApplicable:false,dependencyMode:'private-governance'});
    await rm(output);
    for(const file of ['package.json','pyproject.toml','CADFontAutoReplace.slnx']){
      await writeFile(join(root,file),'{}');git('add',file);git('commit','--signoff','--no-gpg-sign','-m','product input');
      await writeFile(event,JSON.stringify(payload()));
      await expect(main(env)).rejects.toThrow('GOVERNANCE_INPUT_UNCOVERED');
      await expect(readFile(output)).rejects.toMatchObject({code:'ENOENT'});
      git('rm',file);git('commit','--signoff','--no-gpg-sign','-m','remove product input');
    }
  }finally{await rm(root,{recursive:true,force:true});}
},30000);
it('reads real complete Git base/head and detects stale base, wrong checkout and missing source',async()=>{
  const {validationInput}=await script('validation-input'),root=await mkdtemp(join(tmpdir(),'validation-git-'));registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    const contents=Array.from({length:64},(_,i)=>`unique line ${i}\n`).join('');
    await writeFile(join(root,'old name.md'),contents);git('add','.');git('commit','--signoff','--no-gpg-sign','-m','base');const base=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',base);
    await rename(join(root,'old name.md'),join(root,'new name.md'));await writeFile(join(root,'new name.md'),contents.replace('unique line 63','edited last line'));git('add','.');git('commit','--signoff','--no-gpg-sign','-m','rename');const head=git('rev-parse','HEAD');
    const event=join(root,'event.json');await writeFile(event,JSON.stringify({repository:{id:1,full_name:'splrad/fixture'},pull_request:{base:{repo:{id:1},ref:'main',sha:base},head:{sha:head}}}));
    const env={GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY_ID:'1',GITHUB_REPOSITORY:'splrad/fixture',WORKFLOW_REPOSITORY:'splrad/steward',WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',WORKFLOW_SHA:S};
    expect((await validationInput(root,env)).input.changedPaths).toEqual(['new name.md','old name.md']);
    await expect(validationInput(root,{...env,WORKFLOW_REPOSITORY:'fork/steward'})).rejects.toThrow('TRUSTED_SOURCE');
    git('update-ref','refs/remotes/origin/main',head);await expect(validationInput(root,env)).rejects.toThrow('BASE_MOVED');
    git('update-ref','refs/remotes/origin/main',base);git('checkout',base);await expect(validationInput(root,env)).rejects.toThrow('CHECKOUT');
    git('checkout',head);const payload=JSON.parse(await readFile(event,'utf8'));payload.pull_request.base.sha=S;await writeFile(event,JSON.stringify(payload));await expect(validationInput(root,env)).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
},30000);
it('keeps CI registered while scoping modified prose on both PR and single-parent promotion inputs',async()=>{
  const {validationInput}=await script('validation-input');
  const root=await mkdtemp(join(tmpdir(),'validation-diff-scope-'));
  registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    git('config','core.autocrlf','false');
    const workflowPath='.github/workflows/source.yml';
    const write=async(path:string,content:string)=>{
      await mkdir(resolve(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);
    };
    await write('.github/product-ci.json',JSON.stringify([workflowPath]));
    await write(workflowPath,'on: [push, pull_request]\njobs: {test: {}}\n');
    await write('README.md','guide\n');
    await write('SECURITY.md','policy\n');
    await write('config/review/security-common.md','public policy\n');
    await write('src/main.js','export const n = 1;\n');
    const commit=()=>{
      git('add','--all');git('commit','--signoff','--no-gpg-sign','-qm','fixture');return git('rev-parse','HEAD');
    };
    const base=commit();
    const event=join(root,'.git','event.json');
    const check=async(before:string,head:string,productApplicable:boolean,steward=true)=>{
      const repository={id:steward?1296724484:42,full_name:steward?'splrad/steward':'splrad/fixture',private:false,default_branch:'main'};
      git('update-ref','refs/remotes/origin/main',before);
      for(const type of ['pull_request','push']){
        const payload=type==='push'?{repository,before,after:head,ref:'refs/heads/main'}
          :{repository,pull_request:{base:{repo:{id:repository.id},ref:'main',sha:before},head:{sha:head}}};
        await writeFile(event,JSON.stringify(payload));
        const env={GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:type,GITHUB_REPOSITORY_ID:String(repository.id),
          GITHUB_REPOSITORY:repository.full_name,WORKFLOW_REPOSITORY:'splrad/steward',
          WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',WORKFLOW_SHA:S};
        await expect(validationInput(root,env)).resolves.toMatchObject({productApplicable,workflows:[workflowPath]});
      }
    };
    await write('README.md','revised guide\n');const guide=commit();
    await check(base,guide,false);
    await check(base,guide,true,false);
    await write('SECURITY.md','revised policy\n');const policy=commit();
    await check(guide,policy,true);
    await check(guide,policy,false,false);
    await write('config/review/security-common.md','revised public policy\n');const common=commit();
    await check(policy,common,true);
    await write('README.md','mixed with code\n');await write('src/main.js','export const n = 2;\n');const code=commit();
    await check(common,code,true);
    await write('docs/new.md','new file\n');const added=commit();
    await check(code,added,true);
  }finally{await rm(root,{recursive:true,force:true});}
},45000);
it.each([false,true])('uses the protected base repository marker for a fork (private=%s)',async privateRepository=>{
  const {main}=await script('validation-input'),root=await mkdtemp(join(tmpdir(),'validation-fork-'));
  registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await mkdir(join(root,'.github'));
    git('config','core.autocrlf','false');
    await writeFile(join(root,'AGENTS.md'),await readFile('templates/repository/AGENTS.md'));
    const marker='.github/steward-central-policy',bytes=Buffer.from('central\n');
    await writeFile(join(root,marker),bytes);
    git('add','.');git('commit','--signoff','--no-gpg-sign','-m','adopt');
    const base=git('rev-parse','HEAD'),tree=git('rev-parse',base+':.github'),blob=git('rev-parse',base+':'+marker);
    git('update-ref','refs/remotes/origin/main',base);
    git('rm',marker);git('commit','--signoff','--no-gpg-sign','-m','remove marker in fork');
    const repository={id:42,full_name:'splrad/fixture',default_branch:'main',private:privateRepository,has_issues:false,has_pages:false};
    const event=join(root,'event.json'),output=join(root,'output.txt');
    await writeFile(event,JSON.stringify({repository,pull_request:{base:{repo:{id:42},ref:'main',sha:base},
      head:{repo:{id:91,full_name:'contributor/fixture'},sha:git('rev-parse','HEAD')}}}));
    const responses=new Map<string,unknown>([
      ['',repository],['branches/main',{name:'main',protected:true,commit:{sha:base}}],
      ['git/trees/'+base,{truncated:false,tree:[{path:'.github',mode:'040000',type:'tree',sha:tree}]}],
      ['git/trees/'+tree,{truncated:false,tree:[{path:'steward-central-policy',mode:'100644',type:'blob',sha:blob}]}],
      ['contents/'+marker+'?ref='+base,{path:marker,type:'file',encoding:'base64',sha:blob,size:bytes.length,content:bytes.toString('base64')}],
      ['git/matching-refs/heads/steward/governance-state',[]],
    ]);
    const origin='https://api.github.com/repos/splrad/fixture';
    const requests:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,request:RequestInit)=>{
      expect(url.startsWith(origin)).toBe(true);
      expect(request.method).toBe('GET');
      expect(new Headers(request.headers).get('authorization')).toBe('Bearer workflow-read');
      const path=url.slice(origin.length).replace(/^\//,'');
      requests.push(path);
      if(path==='git/ref/heads/steward/governance-state')return new Response(null,{status:404});
      const value=responses.get(path);
      expect(value).toBeDefined();
      return Response.json(value);
    }));
    const env={VALIDATION_WORKSPACE:root,GITHUB_OUTPUT:output,GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'pull_request',
      GITHUB_REPOSITORY_ID:'42',GITHUB_REPOSITORY:repository.full_name,WORKFLOW_REPOSITORY:'splrad/steward',
      WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',WORKFLOW_SHA:S,GITHUB_ACTIONS:'true',
      REPOSITORY_POLICY_TOKEN:'workflow-read'};
    await expect(main(env)).rejects.toThrow('REPOSITORY_POLICY_PROJECTION_REQUIRED');
    expect(requests).toContain('git/ref/heads/steward/governance-state');
    await expect(readFile(output)).rejects.toMatchObject({code:'ENOENT'});
    responses.set('git/trees/'+tree,{truncated:true,tree:[]});
    await expect(main(env)).rejects.toThrow('REPOSITORY_POLICY_PROJECTION_UNAVAILABLE');
    responses.set('git/trees/'+tree,{truncated:false,tree:[]});
    requests.length=0;
    expect(await main(env)).toMatchObject({productApplicable:false,workflows:[]});
    expect(requests.some(path=>path.includes('steward/governance-state'))).toBe(privateRepository);
    const fileJobEnv:NodeJS.ProcessEnv={...process.env,...env};
    delete fileJobEnv.REPOSITORY_POLICY_TOKEN;
    const workflow=(await import('yaml')).parse(await readFile('.github/workflows/pr-validation-native.yml','utf8'));
    expect(workflow.jobs.scope.steps.find((step:{id?:string})=>step.id==='identity').env.REPOSITORY_POLICY_TOKEN).toBe('${{ github.token }}');
    for(const [job,name] of [['governance','validation-governance'],['docs','validation-docs']] as const){
      const definition=workflow.jobs[job];
      expect(definition.needs).toBe('scope');
      const step=definition.steps.find((step:{run?:string})=>step.run?.includes('/'+name+'.mjs'));
      expect(step).toBeDefined();
      expect(step.env?.REPOSITORY_POLICY_TOKEN).toBeUndefined();
      const {main:runFileJob}=await script(name);
      await expect(runFileJob(fileJobEnv,()=>S)).resolves.toBeUndefined();
    }
  }finally{vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});}
},30000);
it('private dependency entry binds candidate Git input using only its existing GH_TOKEN',async()=>{
  const {main}=await script('validation-private-dependencies'),root=await mkdtemp(join(tmpdir(),'validation-private-files-'));
  registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'README.md'),'private registry\n');git('add','.');git('commit','--signoff','--no-gpg-sign','-m','seed');
    const base=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',base);
    await mkdir(join(root,'.github'));await writeFile(join(root,'.github','steward-central-policy'),'central\n');
    git('add','.');git('commit','--signoff','--no-gpg-sign','-m','adopt');const head=git('rev-parse','HEAD');
    const repository={id:1447987054,full_name:'splrad/steward-settings',private:true,default_branch:'main',owner:{id:302208797}};
    const event=join(root,'event.json'),evidence=join(root,'scan');
    await writeFile(event,JSON.stringify({repository,pull_request:{base:{repo:{id:repository.id},ref:'main',sha:base},head:{sha:head}}}));
    const workflow=(await import('yaml')).parse(await readFile('.github/workflows/pr-validation-native.yml','utf8'));
    const dependency=workflow.jobs.dependency;
    expect(dependency.needs).toBe('scope');
    const scan=dependency.steps.find((step:{run?:string})=>step.run?.includes('scripts/validation-private-dependencies.mjs'));
    expect(scan.env).toMatchObject({GH_TOKEN:'${{ github.token }}'});
    expect(scan.env.REPOSITORY_POLICY_TOKEN).toBeUndefined();
    const supplier=vi.fn(async(url:string)=>{
      expect(url).toBe('https://nodejs.org/dist/index.json');
      throw Error('fixture stops at first supplier read');
    });
    vi.stubGlobal('fetch',supplier);
    await expect(main({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:event,
      GITHUB_REPOSITORY_ID:String(repository.id),GITHUB_REPOSITORY:repository.full_name,GH_TOKEN:'workflow-read',
      WORKFLOW_REPOSITORY:'splrad/steward',WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',
      WORKFLOW_SHA:S,VALIDATION_WORKSPACE:root,PRIVATE_DEPENDENCY_EVIDENCE:evidence},()=>S)).rejects.toThrow('fixture stops at first supplier read');
    expect(supplier).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(evidence,'summary.json'),'utf8')).identity).toMatchObject({repositoryId:repository.id,base,head});
  }finally{vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});}
},30000);
it('the private registration PR check rejects an unsupported edit and accepts its correction on the same pull',async()=>{
  const {main}=await script('validation-input'),root=await mkdtemp(join(tmpdir(),'registry-validation-'));
  registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'README.md'),'registry\n');git('add','.');git('commit','--signoff','--no-gpg-sign','-m','base');
    const base=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',base);
    const organization={id:302208797,login:'splrad'};
    const repository={id:1447987054,full_name:'splrad/steward-settings',private:true,default_branch:'main',owner:organization};
    const product={id:91,full_name:'splrad/fixture',private:false,default_branch:'main',owner:organization};
    const ci='.github/workflows/product-ci.yml',build='.github/workflows/steward-release-publish.yml';
    const source='b'.repeat(40),object='c'.repeat(40);
    const channel={id:'github-release',required:true,location:'https://github.com/splrad/fixture/releases',
      artifactIds:['bundle','extras'],metadata:['release-notes.md']};
    const asset=(id:string)=>({id,name:id+'.zip',mediaType:'application/zip'});
    const productFiles=new Map([
      ['.github/product-ci.json',JSON.stringify([ci])],[ci,'on: [push, pull_request]\njobs: {build: {}}'],
      ['release-please-config.json',JSON.stringify({packages:{'.':{}}})],
      ['.github/delivery.json',JSON.stringify({schemaVersion:2,repositoryAuthors:[{id:1,evidence:'fixture'}],
        units:[{id:'fixture',path:'.',notesPath:'.release-notes/fixture.md',assets:['bundle','extras'].map(asset),channels:[channel]}]})],
      [build,'jobs: {build: {strategy: {matrix: {include: [{unit: fixture, target: windows-x64}]}}}}'],
    ]);
    let publicReadable=true,scopeDenied=false,rateStatus=0,identityOnly=false;
    vi.stubGlobal('fetch',vi.fn(async(url:string,request:RequestInit)=>{
      const path=new URL(url).pathname;
      const authorization=new Headers(request.headers).get('authorization');
      if(path==='/repositories/91'){
        if(rateStatus)return new Response(null,{status:rateStatus,headers:{'x-ratelimit-remaining':'0'}});
        if(scopeDenied&&authorization)return new Response(null,{status:403});
        if(publicReadable)expect(authorization).toBe(scopeDenied?null:'Bearer workflow-read');
        return publicReadable?Response.json(product):new Response(null,{status:404});
      }
      if(path.startsWith('/repos/'+repository.full_name)) {
        const route=path.slice(('/repos/'+repository.full_name).length);
        if(route==='')return Response.json(repository);
        if(route==='/branches/main')return Response.json({name:'main',protected:true,commit:{sha:base}});
        if(route==='/git/trees/'+base)return Response.json({truncated:false,tree:[]});
        if(route==='/git/ref/heads/steward/governance-state')return new Response(null,{status:404});
        if(route==='/git/matching-refs/heads/steward/governance-state')return Response.json([]);
        throw Error(route);
      }
      expect(identityOnly).toBe(false);
      expect(authorization).toBe(scopeDenied?null:'Bearer workflow-read');
      const prefix='/repos/'+product.full_name;
      expect(path.startsWith(prefix)).toBe(true);
      const route=path.slice(prefix.length);
      if(route==='')return Response.json(product);
      if(route==='/branches/main')return Response.json({name:'main',protected:true,commit:{sha:source}});
      if(route==='/git/trees/'+source)return Response.json({truncated:false,tree:[...productFiles.keys()].map(path=>({path,type:'blob',sha:object}))});
      if(route==='/git/ref/heads/steward/governance-state')return new Response(null,{status:404});
      if(route==='/git/matching-refs/heads/steward/governance-state')return Response.json([]);
      const file=route.slice('/contents/'.length),bytes=productFiles.get(file);
      expect(bytes).toBeDefined();
      expect(new URL(url).searchParams.get('ref')).toBe(source);
      return Response.json({path:file,sha:object,type:'file',encoding:'base64',content:Buffer.from(bytes!).toString('base64')});
    }));
    const event=join(root,'event.json'),summary=join(root,'summary.md'),output=join(root,'outputs.txt');
    const env={VALIDATION_WORKSPACE:root,GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'pull_request',
      GITHUB_REPOSITORY_ID:String(repository.id),GITHUB_REPOSITORY:repository.full_name,GITHUB_ACTIONS:'true',
      WORKFLOW_REPOSITORY:'splrad/steward',WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',
      WORKFLOW_SHA:S,REPOSITORY_POLICY_TOKEN:'workflow-read',GITHUB_STEP_SUMMARY:summary,GITHUB_OUTPUT:output};
    const update=async(artifactIds:string[],name=product.full_name,adoption?:string)=>{
      await mkdir(join(root,'repositories'),{recursive:true});
      await writeFile(join(root,'repositories','91.json'),JSON.stringify({schemaVersion:1,repositoryId:91,
        repository:name,adoption,productCi:[ci],release:{buildWorkflow:build,units:[{id:'fixture',channels:[{...channel,artifactIds}]}]},site:null}));
      git('add','repositories/91.json');git('commit','--signoff','--no-gpg-sign','-m','adjust selection');
      await writeFile(event,JSON.stringify({repository,pull_request:{number:25,base:{repo:{id:repository.id},ref:'main',sha:base},
        head:{sha:git('rev-parse','HEAD')}}}));
    };
    await update(['bundle']);
    await expect(main(env)).rejects.toThrow('VALIDATION_REGISTRATION_PREVIEW_SELECTION');
    expect(await readFile(summary,'utf8')).toContain('先让产品声明体现计划发布的范围');
    await expect(readFile(output)).rejects.toMatchObject({code:'ENOENT'});
    for(const adoption of [undefined,'central','legacy','paused']){
      await update(channel.artifactIds,'splrad/misspelled-fixture',adoption);
      await expect(main(env)).rejects.toThrow('VALIDATION_REGISTRATION_PREVIEW_IDENTITY');
    }
    identityOnly=true;
    for(const adoption of ['legacy','paused']){
      await update(['bundle'],product.full_name,adoption);
      await expect(main(env)).resolves.toMatchObject({dependencyMode:'private-administrator'});
    }
    identityOnly=false;
    await rm(summary);
    await update(channel.artifactIds);
    await expect(main(env)).resolves.toMatchObject({dependencyMode:'private-administrator'});
    expect(await readFile(summary,'utf8')).toContain('的声明相符');
    await update(channel.artifactIds,product.full_name,'central');
    await expect(main(env)).resolves.toMatchObject({dependencyMode:'private-administrator'});
    for(const status of [403,429]){
      rateStatus=status;
      await expect(main(env)).rejects.toThrow('VALIDATION_REGISTRATION_PREVIEW_RETRY_RATE_LIMIT');
    }
    rateStatus=0;scopeDenied=true;
    await expect(main(env)).resolves.toMatchObject({dependencyMode:'private-administrator'});
    scopeDenied=false;
    publicReadable=false;await rm(summary);
    await main(env);
    expect(await readFile(summary,'utf8')).toContain('无法读取目标仓的公开声明');
    expect(await readFile(summary,'utf8')).not.toContain('的声明相符');
    git('checkout','--detach',base);
    await update(channel.artifactIds);
    const unadopted=git('rev-parse','HEAD');
    git('rm','repositories/91.json');git('commit','--signoff','--no-gpg-sign','-m','remove unadopted registration');
    git('update-ref','refs/remotes/origin/main',unadopted);
    await writeFile(event,JSON.stringify({repository,pull_request:{number:25,base:{repo:{id:repository.id},ref:'main',sha:unadopted},
      head:{sha:git('rev-parse','HEAD')}}}));
    await expect(main(env)).resolves.toMatchObject({dependencyMode:'private-administrator'});
    expect(await readFile(summary,'utf8')).toContain('登记历史中没有已采用的中央投影');
    git('checkout','--detach',unadopted);
    git('update-ref','refs/remotes/origin/main',base);
    await update(channel.artifactIds,product.full_name,'central');
    await update(channel.artifactIds,product.full_name,'legacy');
    const removalBase=git('rev-parse','HEAD');
    git('rm','repositories/91.json');git('commit','--signoff','--no-gpg-sign','-m','remove registration');
    git('update-ref','refs/remotes/origin/main',removalBase);
    await writeFile(event,JSON.stringify({repository,pull_request:{number:25,base:{repo:{id:repository.id},ref:'main',sha:removalBase},
      head:{sha:git('rev-parse','HEAD')}}}));
    await expect(main(env)).rejects.toThrow('VALIDATION_REGISTRATION_PREVIEW_SELECTION');
    expect(await readFile(summary,'utf8')).toContain('无法确认目标仓的撤回状态');
    publicReadable=true;
    await expect(main(env)).resolves.toMatchObject({dependencyMode:'private-administrator'});
  }finally{vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});}
},30000);
it('summary rejects failed, cancelled, missing and unexpectedly skipped required jobs',async()=>{
  const {validationSummary}=await script('validation-summary');
  const jobs=Object.fromEntries(['scope','source','governance','dependency','docs'].map(k=>[k,{result:'success'}])) as any;
  jobs.scope.outputs={source:'false',dependency:'false',docs:'true',governance:'false'};
  for(const key of ['source','governance','dependency'])jobs[key].result='skipped';
  expect(validationSummary(jobs)).toContain('docs: success');
  const selected=structuredClone(jobs);selected.scope.outputs.source='true';expect(()=>validationSummary(selected)).toThrow('REQUIRED_JOB_INCOMPLETE');
  for(const result of ['failure','cancelled','skipped',undefined]){const copy=structuredClone(jobs);copy.docs.result=result;expect(()=>validationSummary(copy)).toThrow('REQUIRED_JOB_INCOMPLETE');}
  delete jobs.scope.outputs.docs;expect(()=>validationSummary(jobs)).toThrow('SCOPE_MISSING');
});
it('selects changed docs and current references to deleted/moved image targets without a historical external crawl',async()=>{
  const {documentInputs}=await script('validation-docs'),root=await mkdtemp(join(tmpdir(),'doc-inputs-'));
  try{await mkdir(join(root,'docs'));await writeFile(join(root,'docs/new.md'),'# new\n');await writeFile(join(root,'docs/ref.md'),'![image](../old.png)\n');await writeFile(join(root,'docs/unrelated.md'),'# other\n');
    expect(await documentInputs(root,['docs/new.md','docs/ref.md','docs/unrelated.md'],['old.png','docs/new.md'])).toEqual(['docs/new.md','docs/ref.md']);
  }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['success','network-failure','check-failure','load-failure','already-owned'])('network execution requires native nft check/load and always cleans its own table: %s',async mode=>{
  const {guardedNetworkCheck}=await script('validation-docs'),calls:string[]=[],run=vi.fn(async()=>{if(mode==='network-failure')throw Error('NETWORK');return 'ok';});
  const nft=async(args:string[])=>{calls.push(args.join(' '));if(args.includes('tables'))return {nftables:mode==='already-owned'?[{table:{family:'inet',name:'splrad_linkcheck'}}]:[]};
    if(mode==='check-failure'&&args.includes('--check')||mode==='load-failure'&&args[0]==='--file')throw Error('FIREWALL');return {nftables:[]};};
  const operation=guardedNetworkCheck(run,nft,'trusted.nft',async()=>{});
  if(mode==='success')expect(await operation).toBe('ok');else await expect(operation).rejects.toThrow();
  if(['success','network-failure'].includes(mode)){expect(run).toHaveBeenCalledTimes(1);expect(calls.at(-1)).toBe('delete table inet splrad_linkcheck');}
  else expect(run).not.toHaveBeenCalled();expect(calls.join('\n')).not.toContain('flush');
});
it('lists external 404/410 repairs separately from authentication, throttling, server failures and timeouts',async()=>{
  const {externalResults}=await script('validation-docs');
  const rows=[404,410,401,403,429,503].map(code=>({url:`https://test.invalid/${code}`,status:{code}}));
  const result=externalResults({total:8,error_map:{'doc.md':rows},timeout_map:{'doc.md':[{url:'https://test.invalid/timeout',status:{text:'Timeout'}}]},success_map:{'doc.md':[{url:'https://test.invalid/ok',status:{code:200}}]}});
  expect(result.map((r:any)=>r.status)).toEqual(['REPAIR_REQUIRED','REPAIR_REQUIRED','UNKNOWN','UNKNOWN','UNKNOWN','UNKNOWN','UNKNOWN','OK']);
  expect(result[0]).toMatchObject({document:'doc.md',url:'https://test.invalid/404',nativeStatus:{code:404}});
});
it('uses declared product workflows for all source layouts',async()=>{
  const {documentationOnly,productWorkflows}=await script('validation-input');
  const workflows=['.github/workflows/client.yml','.github/workflows/server.yaml'];
  for(const files of [['CADFontAutoReplace.slnx','global.json'],['Example.slnx','global.json'],
    ['package.json','pyproject.toml'],['go.mod','cmd/tool/main.go'],['frontend/package.json'],['package.json']]){
    expect(documentationOnly(files)).toBe(false);
    expect(productWorkflows(workflows,[...files,...workflows])).toEqual(workflows);
  }
  expect(documentationOnly(['README.md','.github/CODEOWNERS','.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/bug.yaml','.github/workflows/pr-title.yml','.github/steward-central-policy'])).toBe(true);
  expect(documentationOnly(['index.html','.github/product-ci.json',...workflows])).toBe(false);
  for(const invalid of [[],[workflows[0],workflows[0]],['../ci.yml'],['.github/workflows/missing.yml']])
    expect(()=>productWorkflows(invalid,workflows)).toThrow();
});
it('binds all workflow and matrix results to this repository, PR pair, commit and attempt',async()=>{
  const {evidence}=await script('product-ci-evidence');
  const paths=['.github/workflows/one.yml','.github/workflows/two.yml'];
  const pr={number:4,base:{repo:{id:1},ref:'trunk',sha:S},head:{repo:{id:2},ref:'topic',sha:'b'.repeat(40)}};
  const event={repository:{id:1,full_name:'org/product'},pull_request:pr};
  const run={id:51,run_attempt:2,path:paths[0],repository:event.repository,head_repository:{id:2},head_sha:pr.head.sha,
    workflow_id:61,check_suite_id:71,run_started_at:'2026-11-21T21:07:30Z',
    event:'pull_request',pull_requests:[pr],status:'completed',conclusion:'success'};
  const job={id:58,name:'product CI',run_id:51,run_attempt:2,head_sha:run.head_sha,status:'completed',conclusion:'success',steps:[{status:'completed',conclusion:'success'}]};
  const check=(runs:any[],jobs:any[]=[job],source=run.head_sha)=>evidence(paths,runs.map(r=>({...r,node_id:r.path})),event,'pull_request',async()=>jobs,[],
    async(path:string)=>({path,repositoryFileUrl:`https://github.com/org/product/blob/${source}/${path}`}),new Set(),
    {wait:async()=>{},loadChecks:async(selected:typeof run)=>checkRunsFor(selected,jobs),loadAttemptHistory:async()=>jobs});
  await expect(check([run],[job],S)).rejects.toThrow('workflow source');
  expect(await check([run])).toHaveLength(1);
  expect(await check([run],[job,{...job,id:59,name:'optional',conclusion:'skipped'}])).toHaveLength(1);
  const caller={...job,name:'call product CI',steps:[]};
  const called={...job,id:59,name:'call product CI / build'};
  expect(await check([run],[caller,called])).toHaveLength(1);
  await expect(check([run],[caller,{...called,run_id:52}])).rejects.toThrow('incomplete job evidence');
  expect(await check([run,{...run,path:paths[1]}])).toHaveLength(2);
  for(const altered of [{event:'pull_request_target'},{head_sha:S},{repository:{id:9}},{head_repository:{id:9}},
    {pull_requests:[]},{pull_requests:[{...pr,number:8}]},{pull_requests:[{...pr,base:{...pr.base,sha:pr.head.sha}}]}])
    expect(await check([{...run,...altered}])).toEqual([]);
  expect(await check([run,{...run,id:52,status:'queued'}])).toEqual([]);
  await expect(check([{...run,conclusion:'failure'}])).rejects.toThrow('failure');
  for(const jobs of [[],[{...job,run_attempt:1}],[{...job,head_sha:S}],[{...job,conclusion:'skipped'}],[{...job,steps:[]}]])
    await expect(check([run],jobs)).rejects.toThrow('incomplete job evidence');
  await expect(evidence([],[],event,'pull_request',async()=>[])).rejects.toThrow('NOT_CONFIGURED');
});
it('re-reads only the chosen completed run attempt while its jobs reach a terminal snapshot',async()=>{
  const {evidence}=await script('product-ci-evidence'),path='.github/workflows/steward-source.yml';
  const head='de50c4a09e9e6261cb70275c591f2b81e47b72ca';
  const repository={id:1296724484,full_name:'splrad/steward'};
  const branch='dependabot/npm_and_yarn/workers/steward/cloudflare/workers-types-5.20261118.1';
  const pr={number:426,base:{ref:'main',sha:'0c4248e42578c59b960192a862d96d33b5f19ab0',repo:repository},
    head:{ref:branch,sha:head,repo:repository}};
  const event={repository,pull_request:pr};
  const run={id:44949882339,run_attempt:1,path,repository,head_repository:repository,head_sha:head,head_branch:branch,
    node_id:'WFR_kwLOTUpyBM8AAAAKdzjF4w',workflow_id:424176722,check_suite_id:121654399352,run_started_at:'2026-11-21T21:07:30Z',
    event:'pull_request',pull_requests:[pr],status:'completed',conclusion:'success'};
  const job=(id:number,name:string)=>({id,name,run_id:run.id,run_attempt:1,head_sha:head,status:'completed',conclusion:'success',
    steps:[{status:'completed',conclusion:'success'}]});
  const linux=job(136985250142,'test (ubuntu-24.04)'),windows=job(136985249960,'test (windows-2025)');
  const wait=vi.fn(async()=>{}),readRun=vi.fn(async()=>run);
  const file=async()=>({path,repositoryFileUrl:`https://github.com/splrad/steward/blob/${head}/${path}`});
  const loadChecks=vi.fn(async(selected:typeof run)=>checkRunsFor(selected,[linux,windows]));
  const check=(loadJobs:any,options:{readRun?:typeof readRun,loadChecks?:typeof loadChecks,
    loadAttemptHistory?:()=>Promise<(typeof linux)[]>}={},value=run)=>
    evidence([path],[value],event,'pull_request',loadJobs,[],file,new Set(),{wait,readRun,loadChecks,...options});
  const lagged=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([linux])
    .mockResolvedValueOnce([linux,{...windows,status:'in_progress',conclusion:null}])
    .mockResolvedValueOnce([linux,windows]).mockResolvedValueOnce([windows,linux]);
  await expect(check(lagged)).resolves.toEqual([{workflow:path,id:run.id,attempt:1,jobs:[
    {id:windows.id,name:windows.name,conclusion:'success'},{id:linux.id,name:linux.name,conclusion:'success'}]}]);
  expect(lagged.mock.calls).toEqual([[run],[run],[run],[run],[run]]);
  expect(wait.mock.calls).toEqual([[1000],[2000],[4000],[8000]]);
  expect(readRun).toHaveBeenCalledExactlyOnceWith(run.id);
  for(const bad of [{...windows,run_id:run.id+1},{...windows,run_attempt:2},{...windows,head_sha:S},{...windows,conclusion:'failure'}]){
    const load=vi.fn(async()=>[linux,bad]);
    await expect(check(load)).rejects.toThrow('incomplete job evidence');
    expect(load).toHaveBeenCalledOnce();
  }
  const missing=vi.fn(async()=>[]);
  await expect(check(missing)).rejects.toThrow('incomplete job evidence');
  expect(missing).toHaveBeenCalledTimes(5);
  const shrinking=vi.fn().mockResolvedValue([linux])
    .mockResolvedValueOnce([linux,{...windows,status:'in_progress',conclusion:null}]);
  await expect(check(shrinking)).rejects.toThrow('incomplete job evidence');
  const consistentlyPartial=vi.fn(async()=>[linux]);
  await expect(check(consistentlyPartial)).rejects.toThrow('incomplete job evidence');
  expect(consistentlyPartial).toHaveBeenCalledTimes(5);
  const shrinkingChecks=vi.fn(async()=>checkRunsFor(run,[linux]))
    .mockResolvedValueOnce(checkRunsFor(run,[linux,windows]));
  await expect(check(async()=>[linux],{loadChecks:shrinkingChecks})).rejects.toThrow('incomplete job evidence');
  expect(shrinkingChecks).toHaveBeenCalledTimes(5);
  const wrongSuite=vi.fn(async()=>checkRunsFor({...run,check_suite_id:run.check_suite_id+1},[linux,windows]));
  await expect(check(async()=>[linux,windows],{loadChecks:wrongSuite})).rejects.toThrow('check suite source mismatch');
  const rerun={...run,run_attempt:2,run_started_at:'2026-11-21T21:30:00Z'};
  const rerunJob={...windows,id:136985249961,run_attempt:2};
  const inheritedWithPriorStart=checkRunsFor({...rerun,run_started_at:run.run_started_at},[rerunJob]);
  const bothAttempts=vi.fn(async()=>[...checkRunsFor(run,[linux,windows]),...inheritedWithPriorStart]);
  const loadAttemptHistory=async()=>[linux,windows,rerunJob];
  await expect(check(async()=>[rerunJob],{loadChecks:bothAttempts,loadAttemptHistory,readRun:vi.fn(async()=>rerun)},rerun))
    .resolves.toMatchObject([{id:run.id,attempt:2,jobs:[{id:rerunJob.id}]}]);
  const incompleteHistory=vi.fn(async()=>[rerunJob]).mockResolvedValueOnce([
    rerunJob,{...linux,id:136985249962,run_attempt:2}
  ]);
  const latestChecks=vi.fn(async()=>inheritedWithPriorStart);
  await expect(check(async()=>[rerunJob],{loadChecks:latestChecks,loadAttemptHistory:incompleteHistory},rerun))
    .rejects.toThrow('incomplete job evidence');
  const lateHistory=vi.fn(loadAttemptHistory).mockResolvedValueOnce([rerunJob]);
  const disappearingOldChecks=vi.fn(async()=>inheritedWithPriorStart)
    .mockResolvedValueOnce([...checkRunsFor(run,[linux,windows]),...inheritedWithPriorStart]);
  await expect(check(async()=>[rerunJob],{loadChecks:disappearingOldChecks,loadAttemptHistory:lateHistory,
    readRun:vi.fn(async()=>rerun)},rerun)).resolves.toMatchObject([{attempt:2,jobs:[{id:rerunJob.id}]}]);
  expect(lateHistory).toHaveBeenCalledTimes(3);
  await expect(check(async()=>[linux,linux])).rejects.toThrow('incomplete job evidence');
  await expect(check(async()=>[linux,windows],{readRun:vi.fn(async()=>({...run,run_attempt:2}))})).rejects.toThrow('changed while reading');
  const noRead=vi.fn();
  await expect(check(noRead,{}, {...run,conclusion:'failure'})).rejects.toThrow('concluded failure');
  expect(noRead).not.toHaveBeenCalled();
});
it('keeps registered settings and supplier lock metadata in organizational checks',async()=>{
  const {requiresProductCI}=await script('validation-input');
  const admin={workflow:'.github/workflows/settings-sync.yml'};
  const files=[admin.workflow,'safe-settings/settings.yml','.mise/locks/npm/12.2.3/package.json'];
  expect(requiresProductCI(files,'private-administrator',admin)).toBe(false);
  expect(requiresProductCI([...files,'server/main.go'],'private-administrator',admin)).toBe(true);
});
it('accepts fork fallback only with the reviewed native run name and workflow source',async()=>{
  const {boundForkRun,workflowSource}=await script('product-ci-evidence');
  const path='.github/workflows/test.yml';
  const event={repository:{id:1,full_name:'org/tool'},pull_request:{number:7,base:{sha:S},
    head:{sha:'c'.repeat(40),ref:'topic',repo:{id:2,full_name:'contributor/tool'}}}};
  const head=event.pull_request.head.sha;
  const run={event:'pull_request',repository:{id:1},head_repository:{id:2},path,head_branch:'topic',
    head_sha:head,pull_requests:[],display_title:`Product CI 7 ${S} ${head}`};
  const file={path,repositoryFileUrl:`https://github.com/org/tool/blob/${head}/${path}`};
  const accepts=(r:any,paths:string[],f:any)=>boundForkRun(r,path,event,'pull_request',paths)&&workflowSource(f,path,event,head);
  expect(await accepts(run,[path],file)).toBe(true);
  expect(await accepts(run,[],file)).toBe(false);
  expect(await accepts({...run,display_title:run.display_title.replace('7','8')},[path],file)).toBe(false);
  expect(await accepts(run,[path],{...file,repositoryFileUrl:file.repositoryFileUrl.replace(head,S)})).toBe(false);
});
it('matches push evidence only for the named branch, repository and commit',async()=>{
  const {matchesRun}=await script('product-ci-evidence');
  const path='.github/workflows/server.yml',event={repository:{id:5},ref:'refs/heads/trunk',after:S};
  const run={repository:{id:5},head_repository:{id:5},event:'push',path,head_sha:S,head_branch:'trunk'};
  expect(matchesRun(run,path,event,'push')).toBe(true);
  for(const change of [{head_branch:'main'},{head_sha:'a different commit'},{repository:{id:6}},{head_repository:{id:6}},{event:'pull_request'}])
    expect(matchesRun({...run,...change},path,event,'push')).toBe(false);
});

it('retries transient evidence reads without accepting unsuccessful responses or exceeding the poll deadline',async()=>{
  const {readEvidenceResponse}=await script('product-ci-evidence');
  const deadline=Date.now()+60_000,wait=vi.fn(async()=>{});
  const read=vi.fn().mockResolvedValueOnce(new Response(null,{status:500})).mockResolvedValueOnce(new Response(null,{status:200}));
  expect((await readEvidenceResponse(read,deadline,wait)).status).toBe(200);
  expect(wait).toHaveBeenCalledWith(1000);
  const reset=new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
  const reconnect=vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce(new Response(null));
  expect((await readEvidenceResponse(reconnect,deadline,wait)).status).toBe(200);
  const offline=vi.fn().mockRejectedValue(reset);
  await expect(readEvidenceResponse(offline,Date.now(),wait)).rejects.toBe(reset);
  expect(offline).toHaveBeenCalledOnce();
  const throttle=vi.fn().mockResolvedValueOnce(new Response(null,{status:429,headers:{'retry-after':'7'}})).mockResolvedValueOnce(new Response(null));
  await readEvidenceResponse(throttle,deadline,wait);
  expect(wait).toHaveBeenCalledWith(7000);
  for(const response of [new Response(null,{status:403}),new Response(null,{status:404}),
    new Response(null,{status:503,headers:{'retry-after':'300'}})]) {
    const once=vi.fn(async()=>response);
    expect(await readEvidenceResponse(once,deadline,wait)).toBe(response);
    expect(once).toHaveBeenCalledTimes(1);
  }
  const down=vi.fn(async()=>new Response(null,{status:502}));
  expect((await readEvidenceResponse(down,deadline,wait)).status).toBe(502);
  expect(down).toHaveBeenCalledTimes(3);
});
