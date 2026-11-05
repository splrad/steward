import {expect,it,vi} from 'vitest';
import {readFile,writeFile,mkdtemp,mkdir,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
const script=(name:string)=>import(pathToFileURL(resolve('scripts/'+name+'.mjs')).href);
const S='a'.repeat(40),H='b'.repeat(40);
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
it('summary rejects failed, cancelled, missing and unexpectedly skipped required jobs',async()=>{
  const {validationSummary}=await script('validation-summary');
  const jobs=Object.fromEntries(['scope','source-linux','source-windows','governance','dependency','docs'].map(k=>[k,{result:'success'}])) as any;
  jobs.scope.outputs={source:'false',dependency:'false',docs:'true',governance:'false'};
  for(const key of ['source-linux','source-windows','governance','dependency'])jobs[key].result='skipped';
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
it('admits the hash-locked Python build interface and rejects incomplete or ambiguous projects',async()=>{
  const {buildMode}=await script('validation-input');
  expect(buildMode(['pyproject.toml','requirements-build.txt','src/product/__init__.py'])).toBe('python');
  expect(()=>buildMode(['pyproject.toml','src/product/__init__.py'])).toThrow('PYTHON_BUILD_LOCK_MISSING');
  expect(()=>buildMode(['src/product/__init__.py'])).toThrow('UNSUPPORTED_BUILD');
  for(const other of [['package.json'],['CADFontAutoReplace.slnx','global.json']])
    expect(()=>buildMode(['pyproject.toml','requirements-build.txt',...other])).toThrow('AMBIGUOUS_BUILD');
  expect(buildMode(['package.json','tools/script.py'])).toBe('node');
  expect(buildMode(['README.md'])).toBe('none');
});
