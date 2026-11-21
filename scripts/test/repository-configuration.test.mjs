import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {candidates,configurationForm,parseForm,planFromForm} from '../configuration-form.mjs';
import {applySelection} from '../configuration-selection.mjs';
import {inspectRepository,pagesPath,publishPath,renderConfiguration} from '../configuration-view.mjs';
import {dynamicBuildInputs,findEvidence,trialInventory} from '../configuration-native.mjs';
import {stageNativeProducer} from '../configuration-native-artifact.mjs';
import {reconcile} from '../repository-configuration.mjs';
import {parseDeliveryConfig} from '../../packages/runner/dist/index.js';

const root=process.cwd();
const reviewedChannel='.github/workflows/map-channel.yml';
const channelFixture=YAML.stringify({name:'Map distribution','run-name':'Channels ${{ inputs.mode }} ${{ inputs.request_key }}',
  on:{workflow_dispatch:{inputs:Object.fromEntries(['cycle_id','source_sha','execution_sha','controller_sha','targets_json','mode','operation_key','request_key']
    .map(k=>[k,{type:'string',required:true}]))}},
  jobs:Object.fromEntries(['submit','verify'].map(mode=>[mode,{name:mode+'/ghcr-assets/maps','runs-on':'ubuntu-24.04',
    if:"inputs.mode == '"+mode+"'",steps:[{run:'python maps/data/channel.py '+mode},{uses:'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
      with:{name:'channel-${{ inputs.request_key }}-maps-ghcr-assets-${{ github.run_id }}-${{ github.run_attempt }}',path:'report.json'}}]}]))});
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

for(const mode of ['reviewed scripts','native container, service and dynamic matrix','native archive bound anew for each run']) test('same configuration PR binds two entries and selects individual files · '+mode,async t=>{
  const complex=mode!=='reviewed scripts',runNamed=mode==='native archive bound anew for each run';
  const dir=await mkdtemp(join(tmpdir(),'steward-config-test-')), product=join(dir,'product');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=','-C',product,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const put=async(path,bytes)=>{await mkdir(dirname(join(product,path)),{recursive:true});await writeFile(join(product,path),bytes);};
  if(process.env.CONFIGURATION_PRODUCT_FIXTURE) execFileSync('git',['clone','--quiet','--no-local',resolve(process.env.CONFIGURATION_PRODUCT_FIXTURE),product]);
  else {
    await mkdir(product);git('init','-b','trunk');
    for(const [path,bytes] of Object.entries(scripts)) await put(path,bytes);
  }
  const productWorkflow='.github/workflows/tool-archive.yml';
  if(complex) {
    const doc=YAML.parse(await readFile(join(product,productWorkflow),'utf8')),job=doc.jobs.assemble;
    doc.on={push:{},workflow_dispatch:{}};
    doc.jobs.targets={'runs-on':'ubuntu-24.04',outputs:{matrix:'${{ steps.emit.outputs.matrix }}'},steps:[{id:'emit',run:'echo \'matrix={"os":["linux"]}\' >> "$GITHUB_OUTPUT"'}]};
    Object.assign(job,{name:'route-${{ matrix.os }}',needs:'targets',strategy:{matrix:'${{ fromJSON(needs.targets.outputs.matrix) }}'},
      container:{image:'python:3.12'},services:{db:{image:'postgres:16'}}});
    job.steps.at(-1).name='Archive route';job.steps.at(-1).with.name=runNamed?'route-${{ matrix.os }}-${{ github.run_id }}':'route-${{ matrix.os }}';
    await put(productWorkflow,YAML.stringify(doc));
  }
  git('config','user.name','Configuration fixture');git('config','user.email','config@example.invalid');git('config','core.autocrlf','false');
  for(const path of [requestPath,trialPath]) await put(path,await readFile('templates/repository/'+path));
  for(const path of ['tools/route/CHANGELOG.md','maps/data/CHANGELOG.md','.release-notes/route.md','.release-notes/maps.md']) await put(path,['概述','更新内容','兼容性','升级与迁移','安装说明','已知问题','恢复'].map(h=>'## '+h+'\n\nFixture notes.\n').join('\n'));
  await put('.github/workflows/steward-release-publish.yml',await readFile('templates/release/steward-release-publish.yml'));
  await put(reviewedChannel,channelFixture);
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
  let interruptBeforeCommit=complex;
  const response=data=>({data});
  const api={target:{},rest:{git:{
    getRef:async()=>{if(!ref)throw Object.assign(Error('Missing'),{status:404});return response({object:{sha:ref}});},
    createRef:async({ref:name,sha})=>{assert.equal(ref,null);git('switch','-c',name.slice(11),sha);ref=sha;}
  },repos:{getCommit:async()=>response({author:bot,commit:{verification:{verified:true},message:git('log','-1','--format=%B')}}),
    compareCommitsWithBasehead:async()=>response({behind_by:0})},pulls:{
    list:async()=>{},get:async()=>response(structuredClone(pr)),create:async input=>{assert.equal(pr,null);pr={...input,number:9,user:bot,head:{ref:input.head,repo,sha:ref}};},
    update:async({body})=>{pr.body=body;}
  }},paginate:async()=>pr?[structuredClone(pr)]:[],graphql:async(q,{input})=>{
    // CommittableBranch uses the unqualified branchName, while REST createRef takes refs/heads/...
    assert.deepEqual(input.branch,{repositoryNameWithOwner:repo.full_name,branchName:git('branch','--show-current')});
    assert.equal(input.expectedHeadOid,ref);
    if(interruptBeforeCommit){interruptBeforeCommit=false;throw Error('fixture: interrupted before commit');}
    for(const f of input.fileChanges.additions)await put(f.path,Buffer.from(f.contents,'base64'));
    if(input.fileChanges.additions.length)git('add','--',...input.fileChanges.additions.map(f=>f.path));git('-c','commit.gpgsign=false','commit','--allow-empty','-m',input.message.headline,'-m',input.message.body);
    ref=git('rev-parse','HEAD');if(pr)pr.head.sha=ref;return {createCommitOnBranch:{commit:{oid:ref}}};
  }};
  const evidence=new Map();
  const ctx={repo,base,api,write:api,actions:api,load,lock:async()=>{},sessions:{
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
  const nativeRuns=new Map(),nativeArchive=join(dir,'product-native.zip');
  const archivedAt='2026-01-01T00:00:10Z';
  const actionNames=['listWorkflowRuns','listWorkflowRunArtifacts','listJobsForWorkflowRunAttempt'];
  const actionsApi=Object.fromEntries(actionNames.map(k=>[k,k]));
  const actionsRead={target:{},rest:{actions:{...actionsApi,getWorkflowRun:async({run_id})=>response(nativeRuns.get(run_id))},
    repos:{getCommit:async({ref})=>response({commit:{tree:{sha:git('rev-parse',ref+'^{tree}')}}}),
      getContent:async({path,ref})=>response({type:'file',encoding:'base64',content:Buffer.from(git('show',ref+':'+path)).toString('base64')})}},
    paginate:async(method,params)=>{
      if(method==='listWorkflowRuns')return [...nativeRuns.values()].filter(r=>r.head_sha===params.head_sha && params.workflow_id===r.path.split('/').at(-1));
      const run=nativeRuns.get(params.run_id);
      if(method==='listWorkflowRunArtifacts')return [artifact(run)];
      return [{id:901,name:'route-linux',conclusion:'success',steps:[{name:'Archive route',conclusion:'success',started_at:archivedAt,completed_at:archivedAt}]}];
    }};
  function artifact(run){return {id:882,name:runNamed?'route-linux-'+run.id:'route-linux',created_at:archivedAt,workflow_run:{id:run.id,repository_id:repo.id,head_repository_id:repo.id,head_sha:run.head_sha}};}
  function productRun(source,branch=repo.default_branch){
    execFileSync('python',['build.py'],{cwd:join(product,'tools/route')});
    execFileSync('python',['-c',"import sys,pathlib,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(f,f.relative_to(p)) for f in p.rglob('*') if f.is_file()]; z.close()",join(product,'tools/route/out'),nativeArchive]);
    const id=300+nativeRuns.size;
    nativeRuns.set(id,{id,run_attempt:1,repository:repo,head_repository:repo,head_sha:source,head_branch:branch,event:'push',path:productWorkflow,status:'completed',conclusion:'success'});
  }
  async function archive(api,token,repo,run,name,request,stage){
    assert.equal(name,artifact(run).name);
    const args=stage?['--stage',stage.directory,'--files',JSON.stringify(stage.paths)]:[];
    return {asset:artifact(run),data:JSON.parse(execFileSync('python',['tools/template/configuration_archive.py',nativeArchive,...args],{encoding:'utf8'}))};
  }
  if(complex){
    productRun(base);
    ctx.discover=(api,repo,head,base,model)=>dynamicBuildInputs(actionsRead,repo,head,base,model);
    const priorFind=ctx.find,priorInventory=ctx.inventory;
    ctx.find=(api,token,repo,base,head,target,model,callback)=>target.unit==='route'?
      findEvidence(actionsRead,token,repo,base,head,target,model,undefined,(...args)=>trialInventory(...args,archive)):
      priorFind(api,token,repo,base,head,target);
    ctx.inventory=(api,token,repo,base,head,target,recipe)=>target.unit==='route'?
      trialInventory(actionsRead,token,repo,base,head,target,recipe,archive):priorInventory(api,token,repo,base,head,target);
  } else ctx.discover=async()=>[];
  const formModel=async()=>Object.assign(await load(api,ref),{nativeVariants:state.nativeVariants});
  const run=(event,data)=>reconcile({...ctx,run:{id:sequence++,run_attempt:1,event,triggering_actor:actor},data});
  const firstRequest={id:sequence++,run_attempt:1,event:'workflow_dispatch',triggering_actor:actor};
  const deliver=()=>reconcile({...ctx,run:firstRequest,data:{}});
  if(complex) {
    await assert.rejects(deliver(),/fixture: interrupted before commit/);
    assert.equal(ref,base);
    assert.equal(pr,null);
    assert.equal(git('branch','--show-current'),'steward/repository-configuration-'+base);
  }
  await deliver();
  assert.equal(pr.number,9);
  const openedHead=ref;
  assert.equal(git('rev-list','--count',base+'..'+openedHead),'1');
  await deliver();
  assert.equal(pr.head.sha,openedHead);
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
  const native=candidates(await formModel(),{}).find(e=>e.job==='assemble').id;
  await edit({[native+'.use']:true,'s1.use':true});
  const first={};
  for(const [id,unit,path] of [[native,'route','tools/route'],['s1','maps','maps/data']]) {
    for(const [k,v] of Object.entries({unit,target:'hosted',path,notes:'.release-notes/'+unit+'.md',version:'VERSION',changelog:'CHANGELOG.md',locks:'[]'})) first[id+'.'+k]=v;
  }
  await edit({...first,'s1.entry':'pack.py','s1.runner':'ubuntu-24.04','s1.shell':'bash','s1.directory':'maps/data',
    's1.prepare':'','s1.command':'python pack.py','s1.output':'out','signing':true,'operation.configure':true});
  const preparedHead=ref;
  assert.match(git('diff','--name-only',base,ref),/\.github\/actions\/configuration\/maps\/hosted\/run.mjs/);
  if(complex)productRun(preparedHead,pr.head.ref);
  await refresh();assert.equal(ref,preparedHead);
  await edit({'operation.trial':true});assert.equal(evidence.size,complex?1:2);
  await run('workflow_run',{trial:{id:81,attempt:1}});
  const items=configurationForm(await formModel(),ref,state).items;
  const asset=(id,name)=>items.find(i=>i.id.startsWith(id+'.f') && i.id.endsWith('.use') && pr.body.split('\n').some(l=>l.includes(name) && l.includes('cfg '+i.id+' '))).id.slice(0,-4);
  const a=asset(native,'route-2.4.1.tar.gz'),b=asset('s1','stations-1.6.0.zip');
  assert.match(pr.body,/build.log/);
  await edit({[a+'.use']:true,[b+'.use']:true});
  await edit({[a+'.id']:'cli',[a+'.name']:'route-${version}.tar.gz',[a+'.type']:'application/gzip',[a+'.inspection']:'tar-gzip',
    [a+'.members']:'text bin/route',[a+'.github-release']:true,[b+'.id']:'stations',[b+'.name']:'stations-${version}.zip',
    [b+'.type']:'application/zip',[b+'.inspection']:'zip',[b+'.members']:'text tiles.csv',[b+'.ghcr-assets']:true});
  const final={'channel.workflow':reviewedChannel,[native+'.dest.github-release']:'github','s1.dest.ghcr-assets':'ghcr.io/splrad/map-tools','operation.select':true};
  await edit({...final,'channel.workflow':''});
  assert.equal(ref,preparedHead);
  assert.match(pr.body,/请选择已审阅的本仓渠道工作流/);
  const savedPlan=planFromForm(await formModel(),{...state,values:{...state.values,...final}},'select');
  await edit(final);
  assert.equal(pr.number,9);assert.notEqual(ref,preparedHead);
  assert.equal(git('show',ref+':.github/workflows/steward-release-channels.yml'),channelFixture.trim());
  const selected=parseDeliveryConfig(JSON.parse(git('show',ref+':.github/delivery.json')));
  assert.deepEqual(selected.repositoryAuthors,[]);
  assert.deepEqual(selected.units.map(u=>u.assets.map(a=>a.id)),[['cli'],['stations']]);
  assert.equal(selected.units[0].channels.find(c=>c.id==='github-release').required,true);
  const workflow=YAML.parse(git('show',ref+':.github/workflows/steward-release-publish.yml'));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(r=>r.unit),['route','maps']);
  if(complex) {
    assert.equal(git('show',ref+':'+productWorkflow),git('show',base+':'+productWorkflow));
    const collect=workflow.jobs.build.steps.find(s=>s.name==='Collect verified product workflow archive');
    const producer=JSON.parse(Buffer.from(collect.env.PRODUCER,'base64url'));
    assert.equal(producer.nativeJobName,'route-linux');
    assert.equal(producer.archive,runNamed?'route-linux-${{ github.run_id }}':'route-linux');
    const args={api:actionsRead,repo,source:ref,producer,unit:'route',target:'hosted',directory:dir,
      selected:JSON.parse(collect.env.SELECTED_FILES),record:{sourceSha:ref,repositoryId:repo.id,units:[{id:'route',assets:[{id:'cli',name:'route-2.4.1.tar.gz'}]}]}};
    await assert.rejects(stageNativeProducer(args,archive),/Complete .*route-linux/);
    productRun(ref);
    await stageNativeProducer(args,archive);
    assert.deepEqual(await readFile(join(dir,'delivery-files','route-2.4.1.tar.gz')),await readFile(join(product,'tools/route/out/route-2.4.1.tar.gz')));
    return;
  }
  const adopted=await load(api,ref), warnings=[];
  const scenario=structuredClone(savedPlan);
  scenario.targets[0].files[0].description='Reviewed CLI package';
  const options={seed:await readFile('templates/release/steward-release-publish.yml','utf8'),
    describe:message=>warnings.push(message),inventory:async target=>{
      if(target.unit==='maps') throw Error('Expired artifact');
      return evidence.get(preparedHead+'/'+target.unit).files;
    }};
  const partial=await applySelection(adopted,'select',scenario,options);
  const result=JSON.parse(partial.get('.github/delivery.json'));
  assert.equal(result.units[0].assets[0].description,'Reviewed CLI package');
  assert.deepEqual(result.units[1],adopted.delivery.units[1]);
  assert.ok(!partial.has('release-please-config.json'));
  assert.ok(!partial.has('.github/workflows/steward-release-publish.yml'));
  assert.ok(warnings.some(message=>message.includes('maps/hosted') && message.includes('Expired artifact')));
  const broken=structuredClone(savedPlan);broken.targets[1].entry='absent.py';
  broken.versions=broken.units.map(u=>({path:u.path,versionFile:u.id==='maps'?'absent-version':'VERSION',changelog:'CHANGELOG.md'}));
  const configured=await applySelection(adopted,'configure',broken,options);
  assert.ok(!configured.has('release-please-config.json'));
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
  assert.doesNotMatch(form.body,/### (版本管理|构建与打包|发布渠道|文档站|原生入口)/);
  assert.throws(()=>parseForm(form.body,form.body.replace('### 调整配置','### 替换标题'),form.items),/marked/);
});

test('routes compact delivery file changes to the reviewed workflow while preserving other configuration',async()=>{
  const model={delivery:{schemaVersion:3,repositoryAuthors:[{id:12,evidence:'Confirmed repository authorship'}]}};
  await assert.rejects(applySelection(model,'select',{},{}),/受审产品工作流/);
  await assert.rejects(applySelection(model,'configure',{channels:[{unit:'desktop',id:'github-release'}]},{}),/受审产品工作流/);
  assert.deepEqual(await applySelection(model,'configure',{},{}),new Map());
  assert.deepEqual(await applySelection(model,'trial',{channels:[{unit:'desktop',id:'github-release'}]},{}),new Map());
});

test('reports only declared product platforms and keeps operational Pages conditions out of selections',async()=>{
  const unit={id:'cli',path:'.',assets:[],channels:[]};
  const pages={env:{STEWARD_DOCS_SOURCE:'${{ vars.STEWARD_DOCS_SOURCE }}',STEWARD_DOCS_UNIT:'${{ vars.STEWARD_DOCS_UNIT }}'},jobs:{
    build:{if:'always()',steps:[]},deploy:{'runs-on':'ubuntu-24.04',if:'vars.PUBLIC_ENABLED',steps:[{uses:'actions/upload-artifact@v4'}]}}};
  const validation={jobs:{receipt:{'runs-on':'macos-15',steps:[{uses:'actions/upload-artifact@v4'}]}}};
  const build={'runs-on':'windows-2025',strategy:{matrix:{include:[{unit:'cli',target:'x64'}]}}};
  const files=new Map([[pagesPath,YAML.stringify(pages)],[publishPath,YAML.stringify({jobs:{build}})],
    ['.github/workflows/independent.yml',YAML.stringify(validation)],['.github/delivery.json',JSON.stringify({schemaVersion:2,units:[unit]})]]);
  const model=inspectRepository(files),head='a'.repeat(40);
  const summary=renderConfiguration(model,head),form=configurationForm(model,head);
  assert.match(summary,/\[x\] Windows 构建 .*cli\/x64/);
  assert.doesNotMatch(summary,/Linux 构建待选择|macOS 构建待选择|\[x\].*GitHub Pages|\$\{\{/);
  assert.doesNotMatch(summary,/### 文档站|站点来源|Linux 构建|macOS 构建/);
  const fields=Object.fromEntries(form.items.filter(i=>i.id.startsWith('site.')).map(i=>[i.id,i.value]));
  assert.deepEqual(fields,{'site.build':false,'site.deploy':false,'site.source':'','site.unit':''});
  assert.equal(planFromForm(model,{values:fields},'configure').site,undefined);
  const choice={source:'release',unit:'cli',build:true,deploy:false};
  const saved=await applySelection(model,'configure',{site:choice},{});
  files.set(pagesPath,saved.get(pagesPath));
  const adopted=inspectRepository(files),confirmed=renderConfiguration(adopted,head);
  assert.match(confirmed,/\[x\] 仅构建/);assert.doesNotMatch(confirmed,/公开部署/);
  assert.match(confirmed,/站点来源 · `release`/);assert.match(confirmed,/来源单元 · `cli`/);
  const draft=configurationForm(adopted,head,{values:{'site.deploy':true}});
  assert.equal(draft.items.find(i=>i.id==='site.deploy').value,true);
  build['runs-on']='ubuntu-24.04';
  build.steps=[{run:'node scripts/configuration-native-artifact.mjs',env:{UNIT:'cli',TARGET:'x64',
    PRODUCER:Buffer.from(JSON.stringify({workflow:'.github/workflows/independent.yml',job:'receipt'})).toString('base64url')}}];
  files.set(publishPath,YAML.stringify({jobs:{build}}));
  const native=renderConfiguration(inspectRepository(files),head);
  assert.match(native,/\[x\] macOS 构建/);assert.doesNotMatch(native,/\[x\] Linux 构建/);
});

test('repository configuration can select a release entry without author fields',()=>{
  const model=inspectRepository(new Map());
  for(const values of [{'ci.example':true},{'site.build':true},{'site.deploy':true},{'s1.use':true}]) {
    const form=configurationForm(model,'a'.repeat(40),{values});
    assert.ok(!form.items.some(item=>item.id.startsWith('author.')));
  }
});
