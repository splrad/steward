import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {candidates,configurationForm,parseForm} from '../configuration-form.mjs';
import {inspectRepository} from '../configuration-view.mjs';
import {reconcile} from '../repository-configuration.mjs';
import {parseDeliveryConfig} from '../../packages/runner/dist/index.js';

const root=process.cwd();
const fixtureWorkflow=`name: Pack CLI
on: workflow_dispatch
permissions: {contents: read}
jobs:
  assemble:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with: {persist-credentials: false}
      - run: python build.py
        working-directory: tools/route
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9
        with: {name: route-output, path: tools/route/out/}
`;
const scripts={
  'tools/route/build.py':"from pathlib import Path\np=Path('out');p.mkdir(exist_ok=True)\n(p/'route-2.4.1.tar.gz').write_bytes(b'cli')\n(p/'build.log').write_text('debug only')",
  'maps/data/pack.py':"from pathlib import Path\nfrom zipfile import ZipFile\np=Path('out');p.mkdir(exist_ok=True)\nwith ZipFile(p/'stations-1.6.0.zip','w') as z: z.writestr('tiles.csv','a,b')",
  'tools/route/VERSION':'2.4.1','maps/data/VERSION':'1.6.0','.github/workflows/tool-archive.yml':fixtureWorkflow
};
const requestPath='.github/workflows/repository-configuration.yml',trialPath='.github/workflows/repository-configuration-trial.yml';

test('same configuration PR prepares two native entries, binds trials to their head and selects individual files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'steward-config-test-')), product=join(dir,'product');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=','-C',product,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const put=async(path,bytes)=>{await mkdir(dirname(join(product,path)),{recursive:true});await writeFile(join(product,path),bytes);};
  if(process.env.CONFIGURATION_PRODUCT_FIXTURE) execFileSync('git',['clone','--quiet','--no-local',resolve(process.env.CONFIGURATION_PRODUCT_FIXTURE),product]);
  else {
    await mkdir(product);git('init','-b','trunk');
    for(const [path,bytes] of Object.entries(scripts)) await put(path,bytes);
  }
  git('config','user.name','Configuration fixture');git('config','user.email','config@example.invalid');git('config','core.autocrlf','false');
  for(const path of [requestPath,trialPath]) await put(path,await readFile('templates/repository/'+path));
  for(const path of ['tools/route/CHANGELOG.md','maps/data/CHANGELOG.md','.release-notes/route.md','.release-notes/maps.md']) await put(path,['概述','更新内容','兼容性','升级与迁移','安装说明','已知问题','恢复'].map(h=>'## '+h+'\n\nFixture notes.\n').join('\n'));
  await put('.github/release-template.md.mustache','{{{upgradeNotices}}}');
  git('add','-A');git('-c','commit.gpgsign=false','commit','-m','Adopt protected trial and declare product documentation');
  const base=git('rev-parse','HEAD'),repo={id:15,name:'map-tools',full_name:'splrad/map-tools',owner:{login:'splrad'},default_branch:'trunk'};
  const load=async(api,ref)=>{
    const paths=git('ls-tree','-r','--name-only',ref).split('\n').filter(Boolean),files=new Map();
    for(const p of paths)files.set(p,execFileSync('git',['-C',product,'show',ref+':'+p],{encoding:'utf8'}));
    return inspectRepository(files);
  };
  const actor={id:12,login:'maintainer',type:'User'}, bot={id:301115370,type:'Bot'};
  let pr=null,ref=null,state={values:{},evidence:{}},sequence=100;
  const response=data=>({data});
  const api={target:{},rest:{git:{
    getRef:async()=>{if(!ref)throw Object.assign(Error('Missing'),{status:404});return response({object:{sha:ref}});},
    createRef:async({ref:name,sha})=>{assert.equal(ref,null);git('switch','-c',name.slice(11),sha);ref=sha;}
  },repos:{getCommit:async()=>response({author:bot,commit:{verification:{verified:true},message:git('log','-1','--format=%B')}}),
    compareCommitsWithBasehead:async()=>response({behind_by:0})},pulls:{
    list:async()=>{},get:async()=>response(structuredClone(pr)),create:async input=>{assert.equal(pr,null);pr={...input,number:9,user:bot,head:{ref:input.head,repo,sha:ref}};},
    update:async({body})=>{pr.body=body;}
  }},paginate:async()=>pr?[structuredClone(pr)]:[],graphql:async(q,{input})=>{
    assert.equal(input.expectedHeadOid,ref);
    for(const f of input.fileChanges.additions)await put(f.path,Buffer.from(f.contents,'base64'));
    if(input.fileChanges.additions.length)git('add','--',...input.fileChanges.additions.map(f=>f.path));git('-c','commit.gpgsign=false','commit','--allow-empty','-m',input.message.headline,'-m',input.message.body);
    ref=git('rev-parse','HEAD');if(pr)pr.head.sha=ref;return {createCommitOnBranch:{commit:{oid:ref}}};
  }};
  const evidence=new Map();
  const hasV2=(await readFile('schema/delivery.schema.json','utf8')).includes('"inspection"');
  let integrationRunner=process.env.CONFIGURATION_INTEGRATION_RUNNER;
  if(!hasV2 && !integrationRunner && process.env.GITHUB_ACTIONS==='true') {
    // Test the full save against the pinned upstream implementation until v2 lands.
    const upstream=join(dir,'schema-runner');
    const revision='8f39099ce6e83ff4af5b68c99c6d0103ee9f2a70';
    execFileSync('git',['init','--quiet',upstream]);
    execFileSync('git',['-C',upstream,'fetch','--quiet','--depth=1','https://github.com/splrad/steward.git',revision]);
    execFileSync('git',['-C',upstream,'checkout','--quiet',revision,'--','packages/runner/dist']);
    integrationRunner=join(upstream,'packages/runner/dist/index.js');
  }
  const validator=integrationRunner?
    (await import(pathToFileURL(resolve(integrationRunner)))).parseDeliveryConfig:parseDeliveryConfig;
  const ctx={repo,base,api,write:api,actions:api,load,lock:async()=>{},validateDelivery:validator,sessions:{
    read:async()=>structuredClone(state),write:async(api,n,s)=>{assert.equal(n,9);state=structuredClone(s);}
  },find:async(api,token,repo,base,head,target)=>evidence.get(head+'/'+target.unit),
  dispatch:async(api,actions,repo,base,head,target,recipe)=>{
    const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TMP:dir,TEMP:dir,HOME:dir};
    if(process.platform==='win32') env.PATH=dirname(dirname(execFileSync('where.exe',['git.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]))+'\\bin;'+env.PATH;
    execFileSync(process.execPath,[join(product,'.github/actions/configuration',target.unit,target.target,'run.mjs')],{cwd:dir,env});
    const archive=join(dir,target.unit+'.zip');
    execFileSync('python',['-c',"import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(f,f.relative_to(p)) for f in p.rglob('*') if f.is_file()]; z.close()",join(product,recipe.output),archive],{env});
    const files=JSON.parse(execFileSync('python',[resolve(root,'tools/template/configuration_archive.py'),archive],{env,encoding:'utf8'}));
    evidence.set(head+'/'+target.unit,{head,files,binding:{run:target.unit==='route'?81:82,attempt:1},url:'https://github.com/splrad/map-tools/actions/runs/81'});
  },inventory:async(api,token,repo,base,head,target)=>evidence.get(head+'/'+target.unit).files};
  const run=(event,data)=>reconcile({...ctx,run:{id:sequence++,run_attempt:1,event,triggering_actor:actor},data});
  await run('workflow_dispatch',{});
  assert.equal(pr.number,9);
  const refresh=()=>run('workflow_dispatch',{});
  const edit=async fields=>{
    const previous=pr.body;
    for(const [id,value] of Object.entries(fields)) {
      const lines=pr.body.split('\n');const start=lines.findIndex(l=>l.endsWith('<!-- cfg '+id+' -->'));
      assert.ok(start>=0,'Missing control '+id);
      if(typeof value==='boolean') lines[start]=lines[start].replace(/^- \[[ x]\]/,value?'- [x]':'- [ ]');
      else {const fence=lines[start+1].slice(0,-4),end=lines.indexOf(fence,start+2);lines.splice(start+2,end-start-2,...value.split('\n'));}
      pr.body=lines.join('\n');
    }
    return run('pull_request',{pull:{number:9,head:ref,previous,body:pr.body}});
  };
  const native=candidates(await load(api,ref),{}).find(e=>e.job==='assemble').id;
  await edit({[native+'.use']:true,'s1.use':true});
  const first={};
  for(const [id,unit,path] of [[native,'route','tools/route'],['s1','maps','maps/data']]) {
    for(const [k,v] of Object.entries({unit,target:'hosted',path,notes:'.release-notes/'+unit+'.md',version:'VERSION',changelog:'CHANGELOG.md',locks:'[]'})) first[id+'.'+k]=v;
  }
  await edit({...first,'s1.entry':'pack.py','s1.runner':'ubuntu-24.04','s1.shell':'bash','s1.directory':'maps/data',
    's1.prepare':'','s1.command':'python pack.py','s1.output':'out','author.id':'12','author.evidence':'Confirmed fixture maintainer','signing':true,'operation.configure':true});
  const preparedHead=ref;
  assert.match(git('diff','--name-only',base,ref),/\.github\/actions\/configuration\/maps\/hosted\/run.mjs/);
  await refresh();assert.equal(ref,preparedHead);
  await edit({'operation.trial':true});assert.equal(evidence.size,2);
  await run('workflow_run',{trial:{id:81,attempt:1}});
  const items=configurationForm(await load(api,ref),ref,state).items;
  const asset=(id,name)=>items.find(i=>i.id.startsWith(id+'.f') && i.id.endsWith('.use') && pr.body.split('\n').some(l=>l.includes(name) && l.includes('cfg '+i.id+' '))).id.slice(0,-4);
  const a=asset(native,'route-2.4.1.tar.gz'),b=asset('s1','stations-1.6.0.zip');
  assert.match(pr.body,/build.log/);
  await edit({[a+'.use']:true,[b+'.use']:true});
  await edit({[a+'.id']:'cli',[a+'.name']:'route-${version}.tar.gz',[a+'.type']:'application/gzip',[a+'.inspection']:'tar-gzip',
    [a+'.members']:'text bin/route',[a+'.github-release']:true,[b+'.id']:'stations',[b+'.name']:'stations-${version}.zip',
    [b+'.type']:'application/zip',[b+'.inspection']:'zip',[b+'.members']:'text tiles.csv',[b+'.ghcr-assets']:true});
  const final={[native+'.dest.github-release']:'github','s1.dest.ghcr-assets':'ghcr.io/splrad/map-tools','operation.select':true};
  if(!hasV2 && !integrationRunner) {
    await edit(final);assert.match(pr.body,/待调整：.*DELIVERY/);
    assert.equal(ref,preparedHead);return;
  }
  await edit(final);
  assert.equal(pr.number,9);assert.notEqual(ref,preparedHead);
  const selected=validator(JSON.parse(git('show',ref+':.github/delivery.json')));
  assert.deepEqual(selected.units.map(u=>u.assets.map(a=>a.id)),[['cli'],['stations']]);
  assert.equal(selected.units[0].channels.find(c=>c.id==='github-release').required,true);
  const workflow=YAML.parse(git('show',ref+':.github/workflows/steward-release-publish.yml'));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(r=>r.unit),['route','maps']);
  if(process.env.CONFIGURATION_CANDIDATE_MODULE) {
    const {validateManualCandidate}=await import(pathToFileURL(resolve(process.env.CONFIGURATION_CANDIDATE_MODULE)));
    const {fixture}=await import(new URL('./test/manual-candidate-fixture.mjs',pathToFileURL(resolve(process.env.CONFIGURATION_CANDIDATE_MODULE))));
    const {session,producer,pull,io}=fixture();
    io.product={id:repo.id,name:repo.full_name,defaultBranch:repo.default_branch};
    session.repository.repositoryId=repo.id;
    pull.head.repo.id=repo.id;pull.base.repo.id=repo.id;pull.base.ref=repo.default_branch;
    session.generated.units=selected.units.map(u=>{
      const version=git('show',ref+':'+u.path+'/VERSION');
      return {id:u.id,path:u.path,version,tag:u.id+'-v'+version};
    });
    session.identity.units=session.generated.units.map(u=>({id:u.id,actors:[],contributors:{contributors:[],unresolved:0}}));
    const source=ref;
    await put('.release-notes/maps.md',git('show',source+':.release-notes/maps.md')+'\nReviewed prose.\n');
    git('add','.release-notes/maps.md');git('-c','commit.gpgsign=false','commit','-m','Adjust candidate release notes');
    const h=git('rev-parse','HEAD');
    io.source=async()=>source;pull.head.sha=h;
    io.isAncestor=async(a,b)=>{git('merge-base','--is-ancestor',a,b);return true;};
    io.read=async(sha,path)=>git('show',sha+':'+path);
    io.changedPaths=async(a,b)=>git('diff','--name-only',a,b).split('\n');
    const record=await validateManualCandidate(session,producer,io);
    assert.deepEqual(record.units.map(u=>u.versionPath),['tools/route/VERSION','maps/data/VERSION']);
  }
  const finalHead=ref;await refresh();assert.equal(ref,finalHead);
  assert.doesNotMatch(git('diff','--name-only',base,ref),/build\.log/);
});

test('rejects edits that change the head, labels or locked controls',()=>{
  const model=inspectRepository(new Map()),head='a'.repeat(40),form=configurationForm(model,head);
  assert.throws(()=>parseForm(form.body,form.body.replace(head,'b'.repeat(40)),form.items),/marked/);
  assert.match(form.body,/🔒 Windows 构建/);
  assert.throws(()=>parseForm(form.body,form.body.replace('🔒 Windows 构建','[x] Windows 构建'),form.items),/marked/);
});
