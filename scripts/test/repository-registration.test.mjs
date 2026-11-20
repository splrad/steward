import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { registrationEntry, registrationIds, pushRegistrationIds, selectRegistrationTargets, registrationProposal, reconcileRegistration, renderRegistrationPull } from '../repository-registration.mjs';
import { requestFile } from '../repository-registration-request.mjs';
import { checkedRegistration,parseRegistration } from '../repository-registration-policy.mjs';
import { assertInputScope, assertGovernanceOnlyScope } from '../private-dependency-policy.mjs';
import { requiresProductCI, selectedProductWorkflows } from '../validation-input.mjs';
import {readRepositoryPolicy} from '../repository-policy-read.mjs';
import {main as runLegacyConfiguration} from '../repository-configuration.mjs';
import {releasePolicyGuard} from '../release-repository-policy.mjs';
import {servicePages} from '../pages-maintenance.mjs';
import {projectionBytes,readRepositoryPolicySelection,readRepositoryProjection,repositoryPolicyAdoptionPath} from '../repository-policy-projection.mjs';
import {projectMergedRepositoryPolicy} from '../repository-policy-publish.mjs';
import {workflowPagesOptions} from '../select-pages-source.mjs';
import {writeReleaseRecords} from '../release-record.mjs';
import {nativeTemporaryParent} from '../native-scratch.mjs';

const admin = { id:1447987054, full_name:'splrad/steward-settings', default_branch:'main', private:true };
const org = { id:302208797, login:'splrad' };
const bot = { id:301115370 };
const governance = { id:1296725317, full_name:'splrad/.github', name:'.github', default_branch:'main', owner:org };
const product = { id:1187527897, full_name:'splrad/LayerScape', name:'LayerScape', default_branch:'main', owner:org };
const source = 'a'.repeat(40), base = 'b'.repeat(40), candidate = 'c'.repeat(40);
const ci = '.github/workflows/product-ci.yml';
const publish = '.github/workflows/steward-release-publish.yml';
const pages = '.github/workflows/pages.yml';
const registrationPath = repo => 'repositories/' + repo.id + '.json';
const assets = [
  {id:'deployer',name:'AFR-Deployer_v${version}.exe',mediaType:'application/vnd.microsoft.portable-executable'},
  {id:'plugins',name:'AFR-DLL_v${version}.zip',mediaType:'application/zip'},
  {id:'fonts',name:'Fonts.zip',mediaType:'application/zip'}
];
const metadata = ['sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'];
const channel = {id:'github-release',required:true,location:'https://github.com/splrad/LayerScape/releases',
  artifactIds:assets.map(asset=>asset.id),metadata};
const productFiles = new Map([
  ['.github/product-ci.json',JSON.stringify([ci])],
  [ci,'on: [push, pull_request]\njobs: {build: {}}'],
  ['release-please-config.json',JSON.stringify({packages:{'.':{}}})],
  ['.github/delivery.json',JSON.stringify({schemaVersion:2, repositoryAuthors:[{id:1,evidence:'fixture source'}],
    units:[{id:'layerscape',path:'.',notesPath:'.release-notes/layerscape.md',assets,channels:[channel]}]})],
  [publish,'jobs: {build: {strategy: {matrix: {include: [{unit: layerscape, target: windows-x64}]}}}}'],
  [pages,'env: {STEWARD_DOCS_SOURCE: "${{ vars.STEWARD_DOCS_SOURCE }}"}\njobs: {build: {}, deploy: {}}']
]);
const propose = (repo, files = new Map()) => registrationProposal(repo, async path => files.get(path) ?? null,[...files.keys()]);
const body = (event, action, repository_ids) => ({
  delivery:'12345678-1234-4321-8123-123456789012',body_sha256:'f'.repeat(64),event,action,
  ...(repository_ids === undefined ? {} : {repository_ids})
});
const event = payload => ({repository:admin,action:'settings-source-event',
  sender:{id:353238212,login:'splrad-governance[bot]',type:'Bot'},client_payload:payload});

test('a trusted GitHub push publishes only changed merged settings records by exact Git tree',async()=>{
  const payload={repository:admin,ref:'refs/heads/main',before:base,after:source,created:false,deleted:false,forced:false,
    commits:[{modified:['repositories/99.json']}]};
  const newTree='d'.repeat(40);
  const leaves=(id,sha)=>({path:id+'.json',mode:'100644',type:'blob',sha});
  const trees=new Map([[base,[{path:'repositories',type:'tree',mode:'040000',sha:candidate}]],
    [source,[{path:'repositories',type:'tree',mode:'040000',sha:newTree}]],
    [candidate,[leaves(product.id,candidate),leaves(governance.id,base),leaves(999,base)]],
    [newTree,[leaves(product.id,source),leaves(governance.id,base),leaves(123,base)]]]);
  const api={rest:{git:{getTree:async({tree_sha})=>({data:{truncated:false,tree:trees.get(tree_sha)}})}}};
  assert.deepEqual(await pushRegistrationIds(payload,{GITHUB_SHA:source},api),[123,999,product.id]);
  assert.deepEqual(selectRegistrationTargets([123,product.id],String(product.id)),[product.id]);
  assert.deepEqual(selectRegistrationTargets([123],String(product.id)),[]);
  for(const scope of [undefined,''])assert.throws(()=>selectRegistrationTargets([product.id],scope),/scope is required/);
  assert.throws(()=>selectRegistrationTargets([product.id],'bad'),/Invalid numeric identity/);
  await assert.rejects(pushRegistrationIds({...payload,forced:true},{GITHUB_SHA:source},api),/Untrusted registration/);
});

test('product reads only selected CI and Pages from protected state, with digest and native approval checks',async()=>{
  const {policy}=await propose(product,productFiles);
  const content=projectionBytes({...policy,adoption:'central',site:{workflow:pages,mode:'build-and-deploy',source:'default-branch'}});
  assert.ok(!content.includes('splrad/')&&!content.includes('github-release')&&!content.includes('channels'));
  const bytes=Buffer.from(content),path='configuration/repository.json';
  const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  let protectedRules=true,reads=0,drift=false;
  const reader={repository:product.full_name,path:value=>value,io:{request:async()=>({status:200,bytes:Buffer.from(JSON.stringify({
    ref:'refs/heads/steward/governance-state',object:{type:'commit',sha:drift&&reads++?source:base}
  }))})},json:async route=>{
    if(route==='git/commits/'+base)return {sha:base,tree:{sha:source}};
    if(route==='git/trees/'+source)return {truncated:false,tree:[{path:'configuration',type:'tree',mode:'040000',sha:candidate}]};
    if(route==='git/trees/'+candidate)return {truncated:false,tree:[{path:'repository.json',type:'blob',mode:'100644',sha:blob}]};
    if(route.startsWith('rules/'))return protectedRules?
      [['creation',26678448],['update',26678448],['non_fast_forward',26678449],['deletion',26678449]]
        .map(([type,ruleset_id])=>({type,ruleset_id})):[];
    assert.equal(route,'contents/'+path+'?ref='+base);
    return {type:'file',path,encoding:'base64',sha:blob,size:bytes.length,content:bytes.toString('base64')};
  }};
  const selection=await readRepositoryProjection(reader,product.id);
  assert.deepEqual(selectedProductWorkflows(selection,[ci,'.github/workflows/unselected.yml'],true),[ci]);
  assert.throws(()=>selectedProductWorkflows(selection,[],true),/PRODUCT_CI_REPOSITORY_POLICY/);
  assert.deepEqual(selectedProductWorkflows({...selection,adoption:'paused'},[ci,'draft'],true),[ci,'draft']);
  const env={STEWARD_REPOSITORY_POLICY:'true',GITHUB_REPOSITORY_ID:String(product.id)};
  const options=(env,read,required=false)=>workflowPagesOptions(reader,env,read,async()=>({required,assertCurrent:async()=>{}}));
  const built=await options(env,async()=>selection);
  assert.equal(built.options.mode,'default-branch');
  assert.equal(built.publicAllowed,false);
  assert.equal(built.options.buildOnly,true);
  assert.equal((await options({...env,STEWARD_DOCS_SOURCE:'default-branch'},async()=>selection)).publicAllowed,true);
  assert.equal((await options({...env,STEWARD_DOCS_SOURCE:'default-branch',
    STEWARD_DOCS_APPROVED_SOURCE:''},async()=>selection)).publicAllowed,false);
  assert.equal((await options({...env,STEWARD_DOCS_SOURCE:'default-branch'},async()=>({...selection,site:null}))).options.mode,'');
  const required={...env,STEWARD_DOCS_SOURCE:'default-branch'};
  for(const pending of [null,{...selection,adoption:'paused'},{...selection,adoption:'legacy'}]) {
    await assert.rejects(options(required,async()=>pending,true),/PROJECTION_REQUIRED/);
  }
  await assert.rejects(options(required,async()=>{throw Error('PROJECTION_READ_DENIED');},true),/PROJECTION_READ_DENIED/);
  const revised={...selection,site:null};
  assert.equal((await options(required,async()=>selection,true)).publicAllowed,true);
  assert.deepEqual(selectedProductWorkflows(selection,[ci,'.github/workflows/unselected.yml'],true),[ci]);
  assert.equal((await options(required,async()=>revised,true)).publicAllowed,false);
  const restored={...selection,adoption:'legacy',productCi:[],site:null};
  assert.equal((await options(required,async()=>restored)).publicAllowed,true);
  assert.deepEqual(selectedProductWorkflows(restored,[ci],true),[ci]);
  await assert.rejects(readRepositoryProjection(reader,1),/PROJECTION_INVALID/);
  protectedRules=false;
  await assert.rejects(readRepositoryProjection(reader,product.id),/PROJECTION_PROTECTION/);
  protectedRules=true;drift=true;
  await assert.rejects(readRepositoryProjection(reader,product.id),/PROJECTION_MOVED/);
});

test('only the pinned governance commit can establish an empty root',async()=>{
  const empty=createHash('sha1').update('tree 0\0').digest('hex');
  let fact={sha:base,tree:{sha:empty}},heads=[base,base];
  const reader={path:route=>route,io:{request:async()=>({status:200,bytes:Buffer.from(JSON.stringify({
    ref:'refs/heads/steward/governance-state',object:{type:'commit',sha:heads.shift()}
  }))})},json:async route=>{
    if(route==='git/commits/'+base)return fact;
    assert.equal(route,'git/trees/'+candidate);
    throw Error('NATIVE_HTTP_404');
  }};
  assert.equal(await readRepositoryProjection(reader,product.id),null);
  assert.deepEqual(heads,[]);
  heads=[base,source];
  await assert.rejects(readRepositoryProjection(reader,product.id),/PROJECTION_MOVED/);
  heads=[base,base];
  await assert.rejects(readRepositoryPolicySelection(reader,product.id,{
    readAdoption:async()=>({required:true,assertCurrent:async()=>{}})
  }),/PROJECTION_REQUIRED/);
  for(const invalid of [{sha:source,tree:{sha:empty}},{sha:base,tree:{}}]){
    heads=[base];
    fact=invalid;
    await assert.rejects(readRepositoryProjection(reader,product.id),/PROJECTION_UNAVAILABLE/);
  }
  heads=[base];
  fact={sha:base,tree:{sha:candidate}};
  await assert.rejects(readRepositoryProjection(reader,product.id),/NATIVE_HTTP_404/);
  for(const status of [403,404]){
    heads=[base];
    const denied={...reader,json:async()=>{throw Error('NATIVE_HTTP_'+status);}};
    await assert.rejects(readRepositoryProjection(denied,product.id),{message:'NATIVE_HTTP_'+status});
  }
});

test('the adoption marker is independent of Pages and Issues and comes only from protected default Git bytes',async()=>{
  const adopted=Buffer.from('central\n');
  const digest=createHash('sha1').update(`blob ${adopted.length}\0`).update(adopted).digest('hex');
  let present=true,protectedBranch=true,moves=false,refs=0,defaultBranch='main';
  const reader={repository:product.full_name,json:async route=>{
    if(route==='')return {...product,default_branch:defaultBranch,has_issues:false,has_pages:false};
    if(route==='branches/main')return {name:'main',protected:protectedBranch,commit:{sha:moves&&refs++?source:base}};
    if(route==='git/trees/'+base)return {truncated:false,tree:[{path:'.github',type:'tree',mode:'040000',sha:candidate}]};
    if(route==='git/trees/'+candidate)return {truncated:false,tree:present?
      [{path:'steward-central-policy',mode:'100644',type:'blob',sha:digest}]:[]};
    assert.equal(route,`contents/${repositoryPolicyAdoptionPath}?ref=${base}`);
    return {path:repositoryPolicyAdoptionPath,type:'file',encoding:'base64',sha:digest,size:adopted.length,content:adopted.toString('base64')};
  }};
  const selected={adoption:'central',site:null};
  const read=async()=>selected;
  assert.equal(await readRepositoryPolicySelection(reader,product.id,{read}),selected);
  await assert.rejects(workflowPagesOptions(reader,{GITHUB_REPOSITORY_ID:String(product.id)},async()=>null),/PROJECTION_REQUIRED/);
  await assert.rejects(workflowPagesOptions(reader,{GITHUB_REPOSITORY_ID:String(product.id)},async()=>{
    present=false;moves=true;refs=1;return selected;
  }),/PROJECTION_MOVED/);
  moves=false;
  present=false;
  assert.equal(await readRepositoryPolicySelection(reader,product.id,{read:async()=>assert.fail('Unexpected optional projection')}),null);
  await assert.rejects(readRepositoryPolicySelection(reader,product.id,{useOptionalProjection:true,read:async()=>{
    present=true;moves=true;refs=1;return null;
  }}),/PROJECTION_MOVED/);
  moves=false;
  await assert.rejects(readRepositoryPolicySelection(reader,product.id,{read:async()=>{
    defaultBranch='develop';return selected;
  }}),/PROJECTION_MOVED/);
  defaultBranch='main';
  protectedBranch=false;
  await assert.rejects(readRepositoryPolicySelection(reader,product.id,{read}),/DEFAULT_BRANCH/);
});

test('projection writer uses one path, scoped credentials and reads back only approved bytes',async()=>{
  const {policy}=await propose(product,productFiles);
  const selected={...policy,adoption:'paused'};
  let rulesActive=false;
  const app={forRepository:async(id,operation,purpose)=>{
    assert.equal(id,product.id);
    if(purpose==='maintenance-rules') {
      rulesActive=true;
      try {return await operation('test-rules');} finally {rulesActive=false;}
    }
    assert.equal(purpose,'registry-projection');
    return operation('test-writer');
  }};
  let bytes=null,writes=0,head=base;
  const path='configuration/repository.json',unrelated='quality/1/'+source+'.md';
  const ports={
    currentSource:async()=>source,getPolicy:async()=>({commit:head,policy:selected}),
    getState:async(_dir,_repo,token,_branch,{withGovernanceRules})=>{
      assert.equal(token,'test-writer');
      await withGovernanceRules(async token=>{
        assert.equal(token,'test-rules');
        assert.equal(rulesActive,true);
      });
      return {remote:'/fixture',snapshot:{head:base,currentPaths:bytes?[unrelated,path]:[unrelated]},
        readBytes:async selectedPath=>{assert.equal(selectedPath,path);return bytes;}};
    },
    write:async(request,{token})=>{
      assert.equal(token,'test-writer');assert.equal(request.writer,'configuration');
      assert.equal(rulesActive,false);
      assert.deepEqual(request.allowedPaths,[path]);
      assert.equal(request.changes[0].previousSha256,null);
      writes++;bytes=Buffer.from(request.changes[0].content);return {status:'APPLIED'};
    }
  };
  const run=override=>projectMergedRepositoryPolicy(app,product,source,async()=>({policy}),path=>productFiles.get(path),{...ports,...override});
  assert.equal(await run(),'APPLIED');
  assert.equal(await run(),'UNCHANGED');
  assert.equal(writes,1);
  assert.equal(JSON.parse(bytes).adoption,'paused');
  let reads=0;
  await assert.rejects(run({getPolicy:async()=>reads++===0?{commit:base,policy:selected}:
    {commit:candidate,policy:{...selected,adoption:'central'}}}),/PROJECTION_MOVED/);
  assert.equal(writes,1);
  assert.equal(await run({getPolicy:async()=>({commit:base,policy:{...selected,repository:'splrad/OldName'}})}),undefined);
  assert.equal(writes,1);
  bytes=null;
  await assert.rejects(run({currentSource:async()=>candidate}),/PROJECTION_MOVED/);
  const absent={hasResidualProjection:async()=>true,getPolicy:async()=>({commit:base,policy:null})};
  assert.equal(await run(absent),'UNCHANGED');
  reads=0;
  await assert.rejects(run({...absent,getPolicy:async()=>reads++===0?{commit:base,policy:null}:
    {commit:candidate,policy:selected}}),/PROJECTION_MOVED/);
  await assert.rejects(run({...absent,currentSource:async()=>candidate}),/PROJECTION_MOVED/);
  reads=0;
  await assert.rejects(run({...absent,getState:async()=>({snapshot:{currentPaths:reads++?[path]:[]}})}),/PROJECTION_MOVED/);
  assert.equal(writes,1);
  assert.equal(await run({...absent,revokeMissing:true}),'APPLIED');
  assert.equal(JSON.parse(bytes).adoption,'legacy');
  assert.equal(writes,2);
});

test('an approved rollback replaces the central projection when product declarations drift',async()=>{
  const {policy}=await propose(product,productFiles);
  const selected={...policy,adoption:'central',site:{workflow:pages,mode:'build-only',source:'default-branch'}};
  const app={forRepository:(_id,operation)=>operation('fixture')};
  const path='configuration/repository.json';
  let bytes=Buffer.from(projectionBytes(selected));
  const publish=(adoption,observe,change={})=>projectMergedRepositoryPolicy(app,product,source,observe,async()=>null,{
    getPolicy:async()=>({commit:base,policy:{...selected,adoption,...change}}),currentSource:async()=>source,
    getState:async()=>({remote:'/fixture',snapshot:{head:base,currentPaths:[path]},readBytes:async()=>bytes}),
    write:async request=>{
      assert.equal(request.changes[0].previousSha256,createHash('sha256').update(bytes).digest('hex'));
      bytes=Buffer.from(request.changes[0].content);
      return {status:'APPLIED'};
    }
  });
  await assert.rejects(publish('central',async()=>({policy:{...policy,productCi:[]}})),/PROJECTION_PRODUCT_CI/);
  await assert.rejects(publish('central',async()=>({policy}),{productCi:[]}),/PROJECTION_PRODUCT_CI/);
  await assert.rejects(publish('central',async()=>({policy:{...policy,productCi:[]},productCiApplicable:true}),{productCi:[]}),/PROJECTION_PRODUCT_CI/);
  const missingDeclaration=await propose(product,new Map([['src/main.ts','export {};']]));
  assert.equal(missingDeclaration.productCiApplicable,true);
  assert.deepEqual(missingDeclaration.pending,['复核产品 CI 工作流或触发条件']);
  assert.match(renderRegistrationPull(product,source,missingDeclaration).body,/待补产品原生 CI 入口/);
  await assert.rejects(publish('central',async()=>missingDeclaration,{productCi:[],release:null}),/PROJECTION_PRODUCT_CI/);
  const invalidRelease=structuredClone(policy.release);
  invalidRelease.units[0].channels[0].artifactIds=['unknown-asset'];
  await assert.rejects(publish('central',async()=>({policy}),{release:invalidRelease}),/PROJECTION_RELEASE/);
  await assert.rejects(publish('central',async()=>({policy,releaseIncomplete:true})),/PROJECTION_RELEASE/);
  await assert.rejects(publish('central',async()=>({policy})),/PROJECTION_PAGES/);
  assert.equal(JSON.parse(bytes).adoption,'central');
  for(const adoption of ['paused','legacy']) {
    assert.equal(await publish(adoption,async()=>assert.fail('Rollback read product declarations')),'APPLIED');
    assert.equal(JSON.parse(bytes).adoption,adoption);
  }
});

test('registry rejects workflow selections the native consumers cannot execute',async()=>{
  const {policy}=await propose(product,productFiles);
  const wrong='.github/workflows/other.yml';
  const attempts=[
    {...policy,productCi:['.github/workflows/pr-validation-native.yml']},
    {...policy,release:{...policy.release,buildWorkflow:wrong}},
    {...policy,site:{workflow:wrong,mode:'build-only',source:'default-branch'}}
  ];
  for(const attempted of attempts)
    assert.throws(()=>checkedRegistration(attempted,product.id),/Invalid central repository registration/);
  assert.throws(()=>parseRegistration('{"adoption":"central","adoption":"legacy",'+JSON.stringify(policy).slice(1),product.id),
    /RN_BUILD_INVALID/);
});

test('native projection writer preserves concurrent state and retries revocation after an approved record is removed',async()=>{
  const root=await mkdtemp(join(await nativeTemporaryParent('PROJECTION_FIXTURE_TEMP_LINK'),'registry-projection-git-'));
  const remote=join(root,'payload.git'),checkout=join(root,'setup'),branch='steward/governance-state';
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  const state=(...args)=>git('--git-dir='+remote,...args);
  const local=(...args)=>git('-C',checkout,...args);
  const commit=message=>local('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m',message);
  try {
    git('init','--bare',remote);
    git('init','--initial-branch=main',checkout);
    local('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','seed');
    local('push',remote,'HEAD:refs/heads/main','HEAD:refs/heads/'+branch);
    const old=local('rev-parse','HEAD');
    const {policy}=await propose(product,productFiles);
    const app={forRepository:(_id,operation)=>operation('fixture')};
    const getState=async()=>{
      const head=state('rev-parse','refs/heads/'+branch);
      const paths=state('ls-tree','-r','--name-only',head).split(/\r?\n/).filter(Boolean);
      return {remote,snapshot:{head,currentPaths:paths},readBytes:async path=>Buffer.from(
        execFileSync('git',['--git-dir='+remote,'show',head+':'+path]))};
    };
    const result=await projectMergedRepositoryPolicy(app,product,source,async()=>({policy}),path=>productFiles.get(path),{
      getPolicy:async()=>({commit:base,policy:{...policy,adoption:'central'}}),currentSource:async()=>source,getState,
      write:async request=>{
        assert.equal(request.expectedHead,old);
        const path='quality/1/'+source+'.md';
        const file=join(checkout,path);
        await mkdir(dirname(file),{recursive:true});
        await writeFile(file,'existing quality result\n');
        local('add','--',path);commit('independent quality update');
        local('push',remote,'HEAD:refs/heads/'+branch);
        return writeReleaseRecords(request);
      }
    });
    assert.equal(result,'APPLIED');
    const projection=()=>JSON.parse(state('show',branch+':configuration/repository.json'));
    assert.equal(projection().adoption,'central');
    const revoke=write=>projectMergedRepositoryPolicy(app,product,source,async()=>assert.fail('Removal read product declarations'),
      async()=>assert.fail('Removal read product workflows'),{
        getPolicy:async()=>({commit:candidate,policy:null}),currentSource:async()=>source,getState,revokeMissing:true,write
      });
    await assert.rejects(revoke(async()=>{throw Error('write interrupted');}),/write interrupted/);
    assert.equal(projection().adoption,'central');
    assert.equal(await revoke(request=>writeReleaseRecords(request)),'APPLIED');
    assert.deepEqual({...projection(),sourceDigest:undefined},
      {schemaVersion:1,repositoryId:product.id,adoption:'legacy',productCi:[],site:null,sourceDigest:undefined});
    assert.equal(await revoke(async()=>assert.fail('Already revoked')), 'UNCHANGED');
    assert.equal(state('show',branch+':quality/1/'+source+'.md'),'existing quality result');

    local('fetch',remote,'refs/heads/'+branch);
    local('checkout','--detach','FETCH_HEAD');
    local('rm','configuration/repository.json');commit('fixture without a projection');
    local('push',remote,'HEAD:refs/heads/'+branch);
    const stale=projectMergedRepositoryPolicy(app,product,source,async()=>({policy}),path=>productFiles.get(path),{
      getPolicy:async()=>({commit:base,policy:{...policy,adoption:'central'}}),currentSource:async()=>source,getState,
      write:async request=>{
        assert.equal(request.changes[0].previousSha256,null);
        assert.equal(await revoke(writeReleaseRecords),'APPLIED');
        const blocked=await writeReleaseRecords(request);
        assert.equal(blocked.status,'CONFLICT');
        return blocked;
      }
    });
    await assert.rejects(stale,/PROJECTION_WRITE/);
    assert.equal(projection().adoption,'legacy');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('reads policy only from a stable protected administrator main and proves missing entries',async()=>{
  const {policy}=await propose(product,productFiles);
  const bytes=Buffer.from(JSON.stringify({...policy,adoption:'paused'}));
  const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  let head=base,protectedBranch=true,listings=0,missing=false,finalRef=base,directoryMode='040000';
  const api={rest:{
    repos:{
      get:async()=>({data:{...admin,owner:org,archived:false,disabled:false}}),
      getBranch:async()=>({data:{name:'main',protected:protectedBranch,commit:{sha:listings>0?finalRef:head}}}),
      getContent:async({ref,path})=>{
        assert.equal(ref,head);
        assert.equal(path,registrationPath(product));
        return {data:{path,sha:blob,type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length}};
      }
    },
    git:{getTree:async({tree_sha})=>{
      listings++;
      const tree=tree_sha===base?[{path:'repositories',type:'tree',mode:directoryMode,sha:candidate}]:
        missing?[]:[{path:product.id+'.json',type:'blob',mode:'100644',sha:blob}];
      return {data:{truncated:false,tree}};
    }}
  }};
  assert.deepEqual(await readRepositoryPolicy(api,product),{commit:base,policy:{...policy,adoption:'paused'},adoption:'paused'});
  await assert.rejects(readRepositoryPolicy(api,{...product,full_name:'splrad/Renamed'}),/REPOSITORY_POLICY_UNAVAILABLE/);
  assert.equal((await readRepositoryPolicy(api,{...product,full_name:'splrad/Renamed'},{allowRegisteredRename:true})).policy.repository,
    product.full_name);
  missing=true;
  assert.deepEqual(await readRepositoryPolicy(api,product),{commit:base,policy:null,adoption:'legacy'});
  directoryMode='100644';
  await assert.rejects(readRepositoryPolicy(api,product),/REPOSITORY_POLICY_UNAVAILABLE/);
  directoryMode='040000';
  listings=0;finalRef=source;
  await assert.rejects(readRepositoryPolicy(api,product),/REPOSITORY_POLICY_UNAVAILABLE/);
  protectedBranch=false;
  await assert.rejects(readRepositoryPolicy(api,product),/REPOSITORY_POLICY_UNAVAILABLE/);
});

test('an actual Octokit policy read failure emits no private details to process stderr',()=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {mergedRepositoryPolicy} from './scripts/repository-policy-read.mjs';
    globalThis.fetch=async (url,init)=>{
      assert.equal(new URL(url).pathname,'/repos/splrad/steward-settings');
      assert.equal(init.method,'GET');
      return new Response(JSON.stringify({message:'Private fixture response'}),{
        status:403,headers:{'content-type':'application/json','x-github-request-id':'private-fixture-id',
          deprecation:'true',link:'<https://api.github.com/example>; rel="deprecation"'}
      });
    };
    const app={forRepository:(_id,operation)=>operation('fixture-read')};
    await assert.rejects(mergedRepositoryPolicy(app,{full_name:'splrad/fixture-product',id:73}),
      error=>error.message==='REPOSITORY_POLICY_UNAVAILABLE');
  `],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stderr,'');
  assert.equal(child.stdout,'');
});

test('legacy workflow stops before acquiring product write credentials for paused and central targets',async()=>{
  const env={REPOSITORY_ID:String(product.id),GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',
    GITHUB_EVENT_NAME:'workflow_dispatch'};
  let writes=0;
  const app={discover:async()=>[product],forTemplateRepository:async()=>{writes++;}};
  for(const adoption of ['paused','central','legacy'])
    await runLegacyConfiguration(env,{openApp:async()=>app,readPolicy:async(_app,repo)=>{
      assert.equal(repo.id,product.id);
      return {adoption};
    }});
  assert.equal(writes,1);
  await assert.rejects(runLegacyConfiguration(env,{openApp:async()=>app,readPolicy:async()=>{throw Error('Unavailable');}}),/Unavailable/);
  assert.equal(writes,1);
});

test('new release candidates consume the approved release selections and preserve native product changes',async()=>{
  const {policy}=await propose(product,productFiles);
  let adoption='central',selection=policy,commit=base;
  const guard=releasePolicyGuard({},product,async()=>({adoption,policy:selection,commit}));
  await guard(async path=>productFiles.get(path));
  await guard(async path=>{
    commit=candidate;return productFiles.get(path);
  });
  await guard(async path=>{
    selection={...policy,site:{workflow:pages,mode:'build-only',source:'default-branch'}};
    return productFiles.get(path);
  });
  await assert.rejects(guard(async path=>{
    selection={...policy,release:null};return productFiles.get(path);
  }),/CANDIDATE_REPOSITORY_POLICY_MOVED/);
  selection=policy;
  await assert.rejects(guard(async path=>{
    adoption='paused';return productFiles.get(path);
  }),/CANDIDATE_REPOSITORY_POLICY_MOVED/);
  adoption='central';
  const customized=new Map(productFiles);
  customized.set(publish,productFiles.get(publish).replace('windows-x64','custom-runner-target'));
  await guard(async path=>customized.get(path));
  const modified=structuredClone(policy);
  modified.release.units[0].channels[0].artifactIds.pop();
  selection=modified;
  await assert.rejects(guard(async path=>productFiles.get(path)),/CANDIDATE_REPOSITORY_POLICY_CONFLICT/);
  const declaredDelivery=JSON.parse(productFiles.get('.github/delivery.json'));
  declaredDelivery.units[0].channels[0].artifactIds=modified.release.units[0].channels[0].artifactIds;
  customized.set('.github/delivery.json',JSON.stringify(declaredDelivery));
  await guard(async path=>customized.get(path));
  selection={...policy,release:null};
  await assert.rejects(guard(async()=>assert.fail('Disabled release should not load product inputs')),/CANDIDATE_REPOSITORY_POLICY_DISABLED/);
  adoption='legacy';
  await guard(async()=>assert.fail('Legacy release should continue from native inputs'));
});

test('central Pages consumer blocks recovery for disabled and build-only sites and checks native source',async()=>{
  const preventWrite=()=>assert.fail('unexpected Pages mutation');
  const readPolicy=async site=>({adoption:'central',policy:{site}});
  const args={repository:product,coordinator:{controllerSha:base},store:{save:preventWrite}};
  for(const site of [null,{workflow:pages,mode:'build-only',source:'default-branch'}]) {
    assert.deepEqual(await servicePages({...args,readPolicy:()=>readPolicy(site),io:{request:preventWrite}}),{status:'DISABLED'});
  }
  await assert.rejects(servicePages({...args,readPolicy:()=>readPolicy({workflow:pages,mode:'build-and-deploy',source:'default-branch'}),
    io:{request:async method=>{assert.equal(method,'GET');return {status:404};}}}),/PAGES_REPOSITORY_POLICY_CONFLICT/);
});

test('private receiver accepts verified metadata and one ID for recovery', () => {
  assert.deepEqual(registrationIds(event(body('repository','created',[governance.id])),'repository_dispatch'),[governance.id]);
  assert.deepEqual(registrationIds(event(body('installation_repositories','added',[governance.id,product.id])),
    'repository_dispatch'),[governance.id,product.id]);
  assert.deepEqual(registrationIds(event(body('label','edited')),'repository_dispatch'),[]);
  assert.deepEqual(registrationIds(event(body('repository','created')),'repository_dispatch'),[]);
  assert.deepEqual(registrationIds({repository:admin,inputs:{repository_id:String(product.id)}},'workflow_dispatch'),[product.id]);
  for (const payload of [body('label','edited',[product.id]),body('installation_repositories','removed',[product.id]),
    body('create','default_branch_created',[product.id,governance.id]),body('repository','created',['1']),
    body('installation_repositories','added',[product.id,product.id])]) {
    assert.throws(()=>registrationIds(event(payload),'repository_dispatch'),/Invalid registration targets/);
  }
  assert.throws(()=>registrationIds({...event(body('repository','created',[product.id])),sender:{id:1}},'repository_dispatch'),
    /Untrusted registration event/);
});

test('an accepted event without registration targets completes without an artifact',async()=>{
  const root=await mkdtemp(join(tmpdir(),'registry-no-target-'));
  try {
    const eventPath=join(root,'event.json');
    await writeFile(eventPath,JSON.stringify(event(body('label','edited'))));
    const errors=[];
    assert.equal(await registrationEntry('prepare',{GITHUB_EVENT_PATH:eventPath,GITHUB_EVENT_NAME:'repository_dispatch'},
      {errorOutput:{write:line=>errors.push(line)}}),0);
    assert.deepEqual(errors,[]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

function fake({ files = new Map(), open = [], closed = [], failCreate = false } = {}) {
  const state = { refs: new Map([['main',base]]), trees:new Map([[base,files]]), commits:new Map(),
    writes:[],comments:[],open,closed,failCreate };
  const ref = name => name.replace(/^heads\//,'');
  const ok = data => ({data});
  const missing = () => { throw Object.assign(Error('missing'),{status:404}); };
  const api = {
    target:{owner:'splrad',repo:'steward-settings'},
    rest:{
      git:{
        async getRef({ref:name}) {
          const sha = state.refs.get(ref(name));
          return sha ? ok({ref:'refs/heads/'+ref(name),object:{type:'commit',sha}}) : missing();
        },
        async createRef({ref:name,sha}) {
          const branch = name.replace(/^refs\/heads\//,'');
          assert.equal(state.refs.has(branch),false);
          state.refs.set(branch,sha);
          state.writes.push(['ref',branch]);
        },
        async getTree({tree_sha}) {
          const directory = tree_sha.startsWith('dir-');
          const entries = state.trees.get(directory ? tree_sha.slice(4) : tree_sha);
          assert.ok(entries);
          const tree = directory ? [...entries.keys()].map(path => ({path:path.split('/').at(-1),type:'blob',
            mode:'100644',sha:'file-'+path})) : entries.size ? [{path:'repositories',type:'tree',sha:'dir-'+tree_sha}] : [];
          return ok({tree,truncated:false});
        }
      },
      repos:{
        async getContent({path,ref}) {
          const bytes = state.trees.get(ref).get(path);
          return bytes !== undefined ? ok({type:'file',encoding:'base64',content:Buffer.from(bytes).toString('base64')}) : missing();
        },
        async getCommit({ref}) { return ok(state.commits.get(ref)); }
      },
      issues:{
        listComments:({issue_number})=>state.comments.filter(comment=>comment.issue_number===issue_number),
        async createComment({issue_number,body}) {
          state.comments.push({id:state.comments.length+1,issue_number,user:bot,body});
          state.writes.push(['comment',issue_number]);
        },
        async updateComment({comment_id,body}) {
          const comment=state.comments.find(row=>row.id===comment_id);
          assert.equal(comment.user.id,bot.id);
          comment.body=body;
          state.writes.push(['update-comment',comment.issue_number]);
        }
      },
      pulls:{
        list:args=>args.state==='open'?open:closed.filter(pull=>!args.head||args.head==='splrad:'+pull.head.ref),
        listFiles:({pull_number})=>[...open,...closed].find(pull=>pull.number===pull_number).files??[],
        async get({pull_number}) { return ok([...open,...closed].find(pull=>pull.number===pull_number)); },
        async create({head,title,body,draft}) {
          assert.ok(draft);
          if (state.failCreate) throw Error('response ambiguous');
          state.writes.push(['pull',head]);
          const pull={number:42,state:'open',base:{ref:'main',repo:{id:admin.id}},
            head:{ref:head,sha:state.refs.get(head),repo:{id:admin.id}},user:bot,title,body};
          open.push(pull);
          return ok(pull);
        }
      }
    },
    async graphql(_, {input}) {
      assert.equal(input.branch.repositoryNameWithOwner,admin.full_name);
      assert.equal(state.refs.get(input.branch.branchName),input.expectedHeadOid);
      assert.equal(input.fileChanges.additions.length,1);
      const [{path,contents}] = input.fileChanges.additions;
      state.trees.set(candidate,new Map([...files,[path,Buffer.from(contents,'base64').toString()]]));
      state.commits.set(candidate,{parents:[{sha:input.expectedHeadOid}],author:bot,committer:{id:19864447},
        commit:{verification:{verified:true}},files:[{filename:path}]});
      state.refs.set(input.branch.branchName,candidate);
      state.writes.push(['commit',path]);
      return {createCommitOnBranch:{commit:{oid:candidate}}};
    },
    async paginate(method,args) { return method(args); }
  };
  return {api,state};
}

test('initial .github and LayerScape drafts contain their actual selection shapes', async () => {
  for (const [repo,files] of [[governance,new Map()],[product,productFiles]]) {
    const proposal = await propose(repo,files);
    const {api,state}=fake();
    assert.equal((await reconcileRegistration(api,admin,repo,source,async()=>proposal,async()=>source)).result,'created');
    assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(repo))),proposal.policy);
    const pull=state.open[0];
    assert.equal(pull.title,'chore: 登记 '+repo.name+' 逐仓配置');
    assert.match(pull.body,new RegExp(source));
    assert.ok(pull.body.includes('在 PR 分支编辑 `'+registrationPath(repo)+'` 并提交修改'));
    assert.match(pull.body,/本次登记未启用站点/);
    assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull']);
    if(repo===governance) {
      assert.deepEqual([proposal.policy.productCi,proposal.policy.release,proposal.pending],[[],null,[]]);
      assert.match(pull.body,/沿用组织公共检查/);
      assert.match(pull.body,/发行渠道未配置/);
      assert.ok(!pull.body.includes('LayerScape')&&!pull.body.includes('构建目标'));
    }
    else {
      assert.deepEqual(proposal.policy.productCi,[ci]);
      assert.deepEqual(proposal.policy.release,{buildWorkflow:publish,units:[{id:'layerscape',channels:[channel]}]});
      assert.equal(proposal.policy.site,null);
      assert.deepEqual(proposal.pending,[]);
      assert.ok(pull.body.includes('正式构建入口 `'+publish+'`'));
      assert.ok(pull.body.includes('构建目标 `windows-x64`'));
      assert.ok(pull.body.includes('`github-release`（必需）'));
      for(const asset of assets)assert.ok(pull.body.includes('`'+asset.id+'`（`'+asset.name+'`）'));
      for(const file of metadata)assert.ok(pull.body.includes('`'+file+'`'));
      assert.ok(!pull.body.includes('待确认\n'));
    }
    state.open[0].body += '\n人工改稿';
    state.trees.get(candidate).set(registrationPath(repo),'人工正在编辑');
    assert.equal((await reconcileRegistration(api,admin,repo,source,async()=>proposal,async()=>source)).result,'reused');
    assert.equal(state.trees.get(candidate).get(registrationPath(repo)),'人工正在编辑');
    assert.match(state.open[0].body,/人工改稿/);
    assert.deepEqual(state.writes.at(-1),['comment',42]);
    assert.match(state.comments[0].body,/未通过结构校验/);
  }
});

test('only selected Pages operations prompt for their missing inputs',async()=>{
  const selected=async(sourceMode,build,deploy)=>{
    const files=new Map(productFiles);
    const mode=sourceMode?'    STEWARD_DOCS_SOURCE: '+sourceMode+'\n':'';
    files.set(pages,(mode?'env:\n'+mode:'')+'jobs:\n  build:\n    if: ('+build+' && true) && (true)\n'+
      '  deploy:\n    if: ('+deploy+' && true) && (true)\n');
    return propose(product,files);
  };
  assert.deepEqual((await selected('',false,false)).pending,[]);
  assert.deepEqual((await selected('',true,false)).pending,['确认站点构建来源']);
  assert.deepEqual((await selected('release',true,false)).pending,['确认站点的正式 Release 单元']);
  const local=await selected('default-branch',true,false);
  assert.equal(local.policy.site.mode,'build-only');
  assert.deepEqual(local.pending,[]);
  const requested=await selected('default-branch',true,true);
  assert.equal(requested.policy.site.mode,'build-only');
  assert.deepEqual(requested.pending,['确认公开部署授权']);
});

test('manual central PRs and merged choices keep authority over discovered differences', async () => {
  const proposal = await propose(product,productFiles);
  const manual={...proposal.policy,site:{workflow:pages,mode:'build-only',source:'default-branch'}};
  const files = new Map([[registrationPath(product),JSON.stringify(manual)]]);
  const draft={number:87,head:{ref:'manual-adjustment'},files:[{filename:registrationPath(product)}],body:'人工内容'};
  const prior={...draft,number:55};
  const {api,state}=fake({files,open:[draft],closed:[prior]});
  state.comments.push({id:1,issue_number:draft.number,user:{id:7},body:'<!-- steward-registration-review 1187527897 人工备注'});
  const run=(commit=source)=>reconcileRegistration(api,admin,product,commit,async()=>proposal,async()=>commit);
  assert.deepEqual(await run(),
    {result:'reused',number:87,differences:['site'],pending:proposal.pending});
  await run(candidate);
  assert.equal(draft.body,'人工内容');
  assert.deepEqual(state.writes,[['comment',87]]);
  assert.match(state.comments[1].body,/实际读回.*null/);
  assert.match(state.comments[0].body,/人工备注/);
  await reconcileRegistration(api,admin,product,source,
    async()=>({...proposal,policy:{...proposal.policy,site:manual.site}}),async()=>source);
  assert.match(state.comments[1].body,/核对完成/);
  assert.doesNotMatch(state.comments[1].body,/待确认/);
  assert.equal(draft.body,'人工内容');
  state.open.pop();
  const review=await run();
  assert.deepEqual(review,{result:'review-required',number:55,differences:['site'],pending:[]});
  assert.deepEqual(state.writes,[['comment',87],['update-comment',87],['comment',55]]);
  assert.equal(state.comments[2].issue_number,55);
  assert.equal(state.trees.get(base).get(registrationPath(product)),JSON.stringify(manual));
  const renamed={...product,name:'LayerScape-next',full_name:'splrad/LayerScape-next'};
  const renameProposal=await propose(renamed,productFiles);
  await reconcileRegistration(api,admin,renamed,source,async()=>renameProposal,async()=>source);
  assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(product))),
    {...manual,repository:renamed.full_name});
});

test('an adjustment draft changes only compatible selections and preserves the existing authorization',async()=>{
  const proposal=await propose(product,productFiles);
  const current={...proposal.policy,adoption:'central',productCi:[ci,'.github/workflows/obsolete.yml'],
    site:{workflow:pages,mode:'build-and-deploy',source:'default-branch'}};
  const {api,state}=fake({files:new Map([[registrationPath(product),JSON.stringify(current)]])});
  const reconcile=commit=>reconcileRegistration(api,admin,product,commit,async()=>proposal,async()=>commit);
  assert.equal((await reconcile(source)).result,'created');
  assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(product))),{...current,productCi:[ci]});
  assert.match(state.open[0].title,/调整/);
  assert.match(state.open[0].body,/- 本次修改 `productCi`\r?\n/);
  assert.match(state.open[0].body,/已批准值、读回值及建议/);
  assert.match(state.open[0].body,/obsolete\.yml/);
  assert.equal((await reconcile(base)).result,'reused');
  assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull']);
  const withAnotherSource={...proposal,policy:{...proposal.policy,site:{workflow:pages,mode:'build-only',source:'default-branch'}}};
  await reconcileRegistration(api,admin,product,candidate,async()=>withAnotherSource,async()=>candidate);
  assert.match(state.comments[0].body,/"实际读回": \{/);
  await reconcile(source);
  assert.match(state.comments[0].body,/"实际读回": null/);
  assert.deepEqual(state.writes.slice(-2),[['comment',42],['update-comment',42]]);
  assert.equal(state.comments.length,1);
});

test('an empty registered CI selection receives the actual available workflows in an adjustment draft',async()=>{
  const proposal=await propose(product,productFiles);
  const current={...proposal.policy,adoption:'central',productCi:[]};
  const {api,state}=fake({files:new Map([[registrationPath(product),JSON.stringify(current)]])});
  const outcome=await reconcileRegistration(api,admin,product,source,async()=>proposal,async()=>source);
  assert.equal(outcome.result,'created');
  assert.deepEqual(outcome.differences,['productCi']);
  assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(product))),{...current,productCi:[ci]});
});

test('an edited private draft reports unsupported choices against its current head',async()=>{
  const proposal=await propose(product,productFiles),path=registrationPath(product);
  const {api,state}=fake();
  const reconcile=()=>reconcileRegistration(api,admin,product,source,async()=>proposal,async()=>source);
  assert.equal((await reconcile()).result,'created');
  const pull=state.open[0],edited='d'.repeat(40),corrected='e'.repeat(40);
  const selection=structuredClone(proposal.policy);
  selection.release.units[0].channels[0].artifactIds.pop();
  pull.head.sha=edited;
  state.trees.set(edited,new Map([[path,JSON.stringify(selection)]]));
  const get=api.rest.pulls.get;
  api.rest.pulls.get=async()=>({data:{...pull,head:{...pull.head,sha:corrected}}});
  await assert.rejects(reconcile(),/Registration review pull moved/);
  assert.deepEqual(state.comments,[]);
  api.rest.pulls.get=get;
  assert.equal((await reconcile()).result,'reused');
  assert.match(state.comments[0].body,/产品默认分支的已审声明/);
  assert.match(state.comments[0].body,new RegExp(edited));
  pull.head.sha=corrected;
  state.trees.set(corrected,new Map([[path,JSON.stringify(proposal.policy)]]));
  await reconcile();
  assert.equal(state.comments.length,1);
  assert.match(state.comments[0].body,/当前配置 PR 的选择与产品声明相符/);
});

test('a merged registry removal cannot create a replacement registration draft',async()=>{
  const {api,state}=fake();
  const result=await reconcileRegistration(api,admin,product,source,
    async()=>assert.fail('A removal read product declarations'),async()=>source,{registryPush:true});
  assert.deepEqual(result,{result:'removed'});
  assert.deepEqual(state.writes,[]);
});

test('moved input and uncertain PR creation preserve the existing commit', async () => {
  const proposal = await propose(governance);
  const {api,state}=fake({failCreate:true});
  await assert.rejects(reconcileRegistration(api,admin,governance,source,async()=>proposal,async()=>base),/input moved/);
  assert.equal(state.writes.length,0);
  await assert.rejects(reconcileRegistration(api,admin,governance,source,async()=>proposal,async()=>source),/response ambiguous/);
  state.failCreate=false;
  assert.equal((await reconcileRegistration(api,admin,governance,source,async()=>proposal,async()=>source)).result,'created');
  assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull']);
  state.closed.push(state.open.pop());
  assert.equal((await reconcileRegistration(api,admin,governance,source,async()=>proposal,async()=>source)).result,'previously-reviewed');
});

test('a manual PR opened during draft assembly is reused before sending another PR', async () => {
  const proposal = await propose(governance);
  const {api,state}=fake();
  let sourceReads=0;
  const outcome=await reconcileRegistration(api,admin,governance,source,async()=>proposal,async()=>{
    if(++sourceReads===2)state.open.push({number:15,head:{ref:'manual-registration'},
      files:[{filename:registrationPath(governance)}]});
    return source;
  });
  assert.equal(outcome.result,'reused');
  assert.equal(outcome.number,15);
  assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit']);
});

test('administrator validation checks the ID and keeps the existing private scopes narrow', async () => {
  const {policy}=await propose(governance);
  const path=registrationPath(governance), workflow='.github/workflows/repository-registration.yml';
  assertInputScope([path,workflow]);
  assertInputScope([repositoryPolicyAdoptionPath]);
  assertGovernanceOnlyScope([repositoryPolicyAdoptionPath]);
  for(const assertScope of [assertInputScope,assertGovernanceOnlyScope])
    assert.throws(()=>assertScope([repositoryPolicyAdoptionPath+'.bak']),/INPUT_UNCOVERED/);
  assert.equal(requiresProductCI([path,workflow],'private-administrator',{}),false);
  assert.throws(()=>assertInputScope(['repositories/not-an-id.json']),/INPUT_UNCOVERED/);
  assert.throws(()=>assertGovernanceOnlyScope([path]),/GOVERNANCE_INPUT_UNCOVERED/);
  assert.throws(()=>checkedRegistration(policy,product.id),/Invalid central repository registration/);
});

function productApi(repo, files) {
  const target={owner:'splrad',repo:repo.name};
  return {
    target,
    async request(route,{id}) {
      assert.equal(route,'GET /repositories/{id}');
      assert.equal(id,repo.id);
      return {data:repo};
    },
    rest:{
      git:{
        async getRef({ref}) {return {data:{ref:'refs/'+ref,object:{type:'commit',sha:source}}};},
        async getTree({tree_sha,recursive}) {
          if(recursive==='1')return {data:{tree:[...files.keys()].map(path=>({path,type:'blob',sha:'blob:'+path})),truncated:false}};
          const prefix=tree_sha===source?'':tree_sha.slice('tree:'.length);
          const entries=new Map();
          for(const path of files.keys()) {
            if(!path.startsWith(prefix))continue;
            const [name,...rest]=path.slice(prefix.length).split('/');
            entries.set(name,rest.length?{path:name,type:'tree',sha:'tree:'+prefix+name+'/'}:
              {path:name,type:'blob',mode:'100644',sha:'blob:'+path});
          }
          return {data:{tree:[...entries.values()],truncated:false}};
        }
      },
      repos:{
        async getContent({path,ref}) {
          assert.equal(ref,source);
          assert.ok(files.has(path));
          return {data:{type:'file',encoding:'base64',content:Buffer.from(files.get(path)).toString('base64')}};
        }
      }
    }
  };
}

test('private workflow to public controller replays registration without exposing private results', async t => {
  const temp=resolve(tmpdir()),directory=await mkdtemp(join(temp,'registration-test-'));
  assert.equal(dirname(resolve(directory)),temp);
  try {
    const privateProduct={id:781,name:'private-project',full_name:'splrad/private-project',default_branch:'main',private:true,owner:org};
    for (const [repo,files,manual] of [[governance,new Map(),false],[product,productFiles,true],[privateProduct,new Map(),false]]) {
      const privateSha='d'.repeat(40),publicSha='e'.repeat(40);
      const privatePath=join(directory,'private-event.json'),publicPath=join(directory,'public-event.json');
      const requestPath=join(directory,requestFile),stepOutput=join(directory,'step-output');
      const central={id:1296724484,private:false,full_name:'splrad/steward',default_branch:'main'};
      const privateEvent=event(body('repository','created',[repo.id]));
      const nativeEvent=manual?{repository:admin,inputs:{repository_id:String(repo.id)}}:privateEvent;
      await writeFile(privatePath,JSON.stringify(nativeEvent));
      const env={GITHUB_EVENT_PATH:privatePath,GITHUB_EVENT_NAME:manual?'workflow_dispatch':'repository_dispatch',
        GITHUB_REF:'refs/heads/main',GITHUB_SHA:privateSha,REGISTRATION_WORKFLOW_SHA:privateSha,
        GITHUB_WORKFLOW_REF:'splrad/steward-settings/.github/workflows/repository-registration.yml@refs/heads/main',
        GITHUB_RUN_ID:'8788',GITHUB_RUN_ATTEMPT:'1',REGISTRATION_REQUEST_PATH:requestPath,GITHUB_OUTPUT:stepOutput};
      const {api,state}=fake();
      const {rest:sourceRest,...sourceClient}=productApi(repo,files);
      let input, currentArtifact, request, protectedBranch=true, artifactAvailable=true;
      let producerPath='.github/workflows/repository-registration.yml';
      const scopes=[], logs=[], errors=[];
      const withGovernance=async (id,permissions,operation)=>{
        if(id===repo.id) {
          assert.deepEqual(permissions,{metadata:'read',contents:'read'});
          return operation({...sourceClient,rest:sourceRest},repo);
        }
        assert.equal(id,central.id);
        assert.deepEqual(permissions,{metadata:'read',contents:'write'});
        return operation({target:{owner:'splrad',repo:'steward'},rest:{repos:{createDispatchEvent:async args=>{
          assert.equal(args.event_type,'steward-registration-request');
          input=args.client_payload;
        }}}},central);
      };
      const readApi={
        target:api.target,
        rest:{
          actions:{
            async listArtifactsForRepo(args) {
              assert.deepEqual(args,{...api.target,name:currentArtifact.name,per_page:100});
              return {data:artifactAvailable?{total_count:1,artifacts:[currentArtifact]}:{total_count:0,artifacts:[]}};
            },
            async getWorkflow({workflow_id}) {
              assert.equal(workflow_id,'repository-registration.yml');
              return {data:{id:11,path:'.github/workflows/repository-registration.yml',state:'active'}};
            },
            async getWorkflowRunAttempt({run_id,attempt_number}) {
              assert.equal(run_id,8788);
              assert.equal(attempt_number,1);
              return {data:{id:8788,run_attempt:1,workflow_id:11,path:producerPath,head_branch:'main',head_sha:privateSha,
                event:request.event,repository:{id:admin.id},head_repository:{id:admin.id},
                actor:manual?{id:21,type:'User'}:privateEvent.sender}};
            }
          },
          repos:{getBranch:async()=>({data:{name:'main',protected:protectedBranch,commit:{sha:privateSha}}})}
        }
      };
      const options={
        withGovernance,
        openAdmin:async()=>({withAdmin:async (purpose,operation)=>{
          scopes.push(purpose);
          return operation(purpose==='registration-read'?readApi:api,admin,purpose);
        }}),
        extract:async (artifact,destination,token)=>{
          assert.deepEqual(artifact,currentArtifact);
          assert.equal(destination.id,admin.id);
          assert.equal(token,'registration-read');
          return JSON.parse(await readFile(requestPath,'utf8'));
        },
        output:{write:value=>logs.push(value)},
        errorOutput:{write:value=>errors.push(value)}
      };
      try {
        assert.equal(await registrationEntry('prepare',env,options),0);
        request=JSON.parse(await readFile(requestPath,'utf8'));
        assert.deepEqual(request.repositoryIds,[repo.id]);
        assert.match(await readFile(stepOutput,'utf8'),new RegExp('^id='+request.requestId+'\n$'));
        assert.equal(await registrationEntry('notify',{...env,REGISTRATION_REQUEST_ID:request.requestId},options),0);
        assert.deepEqual(input,{schemaVersion:1,requestId:request.requestId});
        currentArtifact={id:71,name:'repository-registration-'+request.requestId,expired:false,size_in_bytes:400,
          digest:'sha256:'+'b'.repeat(64),workflow_run:{id:8788,repository_id:admin.id,head_repository_id:admin.id,
            head_branch:'main',head_sha:privateSha}};
        const wake={repository:central,action:'steward-registration-request',sender:privateEvent.sender,client_payload:input};
        await writeFile(publicPath,JSON.stringify(wake));
        const publicEnv={...env,GITHUB_EVENT_PATH:publicPath,GITHUB_EVENT_NAME:'repository_dispatch',
          GITHUB_SHA:publicSha,REGISTRATION_WORKFLOW_SHA:publicSha,
          GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/sync-managed.yml@refs/heads/main',
          REGISTRATION_ALLOWED_IDS:String(repo.id)};
        let residualReads=0,revocations=0;
        if(repo.private) {
          publicEnv.GOVERNANCE_APP_PRIVATE_KEY=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey
            .export({type:'pkcs8',format:'pem'}).toString();
          const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
          const scopeToken='offline-private-read',prefix='/repos/'+repo.full_name;
          t.mock.method(globalThis,'fetch',async (input,init)=>{
            const url=new URL(input),path=decodeURIComponent(url.pathname),method=init?.method;
            assert.equal(url.origin,'https://api.github.com');
            if(path==='/orgs/splrad/installation')
              return response({id:179184801,app_id:5639432,account:{id:org.id},suspended_at:null});
            if(path==='/app/installations/179184801/access_tokens') {
              assert.equal(method,'POST');
              assert.deepEqual(JSON.parse(init.body),{repository_ids:[repo.id],permissions:{metadata:'read',contents:'read'}});
              return response({token:scopeToken,expires_at:new Date(Date.now()+3600000).toISOString()});
            }
            if(new Headers(init?.headers).get('authorization')?.split(' ').at(-1)!==scopeToken)return response({},404);
            if(path==='/installation/repositories')return response({total_count:1,repositories:[repo]});
            if(path==='/installation/token'&&method==='DELETE') {
              revocations++;
              return new Response(null,{status:204});
            }
            if(path==='/repositories/'+repo.id)return response(repo);
            if(path===prefix+'/git/ref/heads/main')
              return response({ref:'refs/heads/main',object:{type:'commit',sha:source}});
            if(path===prefix+'/git/ref/heads/steward/governance-state')return response({},404);
            if(path===prefix+'/git/matching-refs/heads/steward/governance-state') {
              residualReads++;
              return response([]);
            }
            if(path===prefix+'/git/trees/'+source)return response({truncated:false,tree:[]});
            assert.fail('Unexpected private repository request '+path);
          });
          delete options.withGovernance;
          const originalAdmin=options.openAdmin;
          options.openAdmin=async()=>({...await originalAdmin(),
            project:(repo,source,observe,read,ports)=>projectMergedRepositoryPolicy({},repo,source,observe,read,{
              ...ports,getPolicy:async()=>({commit:base,policy:null})
            })
          });
        }
        assert.equal(await registrationEntry('consume',publicEnv,options),0);
        if(repo.private)assert.deepEqual({residualReads,revocations},{residualReads:2,revocations:1});
        assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(repo))),(await propose(repo,files)).policy);
        state.open[0].body += '\n人工备注 Private case';
        state.trees.get(candidate).set(registrationPath(repo),'维护者正在编辑');
        assert.equal(await registrationEntry('consume',publicEnv,options),0);
        if(repo.private)assert.deepEqual({residualReads,revocations},{residualReads:4,revocations:2});
        assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull','comment']);
        assert.match(state.open[0].body,/人工备注/);
        assert.equal(state.trees.get(candidate).get(registrationPath(repo)),'维护者正在编辑');

        protectedBranch=false;
        assert.equal(await registrationEntry('consume',publicEnv,options),1);
        protectedBranch=true;
        producerPath='.github/workflows/another-producer.yml';
        assert.equal(await registrationEntry('consume',publicEnv,options),1);
        await writeFile(publicPath,JSON.stringify({...wake,client_payload:{...input,repositoryIds:[repo.id]}}));
        assert.equal(await registrationEntry('consume',publicEnv,options),1);
        await writeFile(publicPath,JSON.stringify(wake));
        assert.equal(await registrationEntry('consume',{...publicEnv,
          GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/other.yml@refs/heads/main'},options),1);
        assert.deepEqual(scopes,['registration-read','registration-write','registration-read','registration-write',
          'registration-read','registration-read']);
        assert.deepEqual(logs,['REGISTRATION_PROCESSED\n','REGISTRATION_PROCESSED\n']);
        assert.deepEqual(errors,['REGISTRATION_UNAVAILABLE producer_source\n','REGISTRATION_UNAVAILABLE producer_run\n',
          'REGISTRATION_UNAVAILABLE event\n','REGISTRATION_UNAVAILABLE event\n']);
        assert.equal(state.writes.length,4);
        if(manual) {
          await writeFile(publicPath,JSON.stringify(wake));
          producerPath='.github/workflows/repository-registration.yml';
          const originalAdmin=options.openAdmin;
          const privateError=()=>{throw Error('Private fixture exception with repository and credential details');};
          const expectFailure=async(stage,overrides={})=>{
            assert.equal(await registrationEntry('consume',publicEnv,{...options,...overrides}),1);
            assert.equal(errors.at(-1),'REGISTRATION_UNAVAILABLE '+stage+'\n');
          };
          await expectFailure('credential',{openAdmin:privateError});
          artifactAvailable=false;
          await expectFailure('artifact_lookup');
          artifactAvailable=true;
          currentArtifact.workflow_run.head_branch='untrusted';
          await expectFailure('producer_source');
          currentArtifact.workflow_run.head_branch='main';
          await expectFailure('artifact_content',{extract:privateError});
          await expectFailure('artifact_content',{extract:async(...args)=>({
            ...await options.extract(...args),repositoryIds:[repo.id,repo.id]
          })});
          const merged={...(await propose(repo,files)).policy,adoption:'central',productCi:[ci,'.github/workflows/stale.yml']};
          const registry=state.trees.get(base);
          registry.set(registrationPath(repo),JSON.stringify(merged));
          const conflictOptions={...options,openAdmin:async()=>({...await originalAdmin(),
            project:async()=>{throw Error('REPOSITORY_POLICY_PROJECTION_PRODUCT_CI');}})};
          assert.equal(await registrationEntry('consume',publicEnv,conflictOptions),1);
          assert.deepEqual(state.writes.at(-1),['update-comment',42]);
          assert.match(state.comments[0].body,/stale\.yml/);
          assert.equal(errors.at(-1),'REGISTRATION_UNAVAILABLE apply\n');
          assert.doesNotMatch(logs.join('')+errors.join(''),/LayerScape|stale\.yml|待确认/);
          assert.equal(await registrationEntry('consume',{...publicEnv,REGISTRATION_ALLOWED_IDS:''},conflictOptions),1);
          assert.equal(state.writes.length,5);

          registry.delete(registrationPath(repo));
          request={...request,event:'push'};
          await writeFile(requestPath,JSON.stringify(request));
          let revoked=0;
          const removalOptions={...options,openAdmin:async()=>({...await originalAdmin(),
            project:async(_repo,_source,_observe,_read,ports)=>{
              assert.equal(ports.revokeMissing,true);
              revoked++;
            }})};
          assert.equal(await registrationEntry('consume',publicEnv,removalOptions),0);
          assert.equal(revoked,1);
          assert.equal(state.writes.length,5);
        }
      } finally {
        await rm(requestPath,{force:true});
        await rm(stepOutput,{force:true});
      }
    }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
