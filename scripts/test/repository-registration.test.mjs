import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {registrationProposal} from '../repository-registration-proposal.mjs';
import { checkedRegistration,parseRegistration } from '../repository-registration-policy.mjs';
import { assertInputScope, assertGovernanceOnlyScope } from '../private-dependency-policy.mjs';
import { requiresProductCI } from '../validation-input.mjs';
import {readRepositoryPolicy} from '../repository-policy-read.mjs';
import {projectionBytes,readRepositoryPolicySelection,readRepositoryProjection,repositoryPolicyAdoptionPath} from '../repository-policy-projection.mjs';
import {validateRegistrationPreview} from '../repository-registration-preview.mjs';
import {nativeTemporaryParent} from '../native-scratch.mjs';

const admin = { id:1447987054, full_name:'splrad/steward-settings', default_branch:'main', private:true };
const org = { id:302208797, login:'splrad' };
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
function compactProductFiles(siteSource='default-branch',unit='layerscape') {
  const workflow='.github/workflows/build-product.yml';
  return new Map([
    ['.github/product-ci.json',productFiles.get('.github/product-ci.json')],
    [ci,productFiles.get(ci)],
    ['.github/delivery.json',JSON.stringify({schemaVersion:3,buildWorkflow:workflow,
      repositoryAuthors:[{id:1,evidence:'fixture source'}]})],
    ['release-please-config.json',JSON.stringify({packages:{'.':{component:unit}}})],
    [workflow,'on: workflow_dispatch\njobs: {package: {}}'],
    [pages,`env: {STEWARD_DOCS_SOURCE: ${siteSource}, STEWARD_DOCS_UNIT: layerscape}\njobs: {build: {if: "(true && true) && (success())"}}`]
  ]);
}

test('checks identity, digest and branch protection when reading a repository projection',async()=>{
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
  assert.deepEqual(selection.productCi,[ci]);
  assert.deepEqual(selection.site,{workflow:pages,mode:'build-and-deploy',source:'default-branch'});
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
  await assert.rejects(readRepositoryPolicySelection(reader,product.id,{read:async()=>null}),/PROJECTION_REQUIRED/);
  await assert.rejects(readRepositoryPolicySelection(reader,product.id,{read:async()=>{
    present=false;moves=true;refs=1;return selected;
  }}),/PROJECTION_MOVED/);
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

test('initial .github and LayerScape declarations retain their observed selections', async () => {
  const plain=await propose(governance);
  assert.deepEqual([plain.policy.productCi,plain.policy.release,plain.pending],[[],null,[]]);
  const selected=await propose(product,productFiles);
  assert.deepEqual(selected.policy.productCi,[ci]);
  assert.deepEqual(selected.policy.release,{buildWorkflow:publish,units:[{id:'layerscape',channels:[channel]}]});
  assert.equal(selected.policy.site,null);
  assert.deepEqual(selected.pending,[]);
});

test('workflow-owned release units allow ordinary CI and Pages without a second release selection',async()=>{
  const repo={...product,private:false};
  const proposal=await propose(repo,compactProductFiles());
  assert.deepEqual(proposal.nativeReleaseUnits,['layerscape']);
  assert.deepEqual(proposal.pending,[]);
  assert.deepEqual(proposal.policy,{schemaVersion:1,repositoryId:repo.id,repository:repo.full_name,productCi:[ci],
    release:null,site:{workflow:pages,mode:'build-only',source:'default-branch'}});
  assert.equal((await propose(repo,compactProductFiles('release'))).policy.site,null);
});

test('public registration preview compares a workflow-owned product against the approved release field',async t=>{
  const files=compactProductFiles();
  const repository={...product,private:false},prefix='/repos/'+repository.full_name;
  t.mock.method(globalThis,'fetch',async (input,init)=>{
    const url=new URL(input);
    assert.equal(init.method,'GET');
    assert.equal(url.origin,'https://api.github.com');
    if(url.pathname==='/repositories/'+repository.id)return Response.json(repository);
    if(url.pathname===prefix+'/branches/main')return Response.json({protected:true,name:'main',commit:{sha:source}});
    if(url.pathname===prefix+'/git/trees/'+source) {
      assert.equal(url.search,'?recursive=1');
      return Response.json({truncated:false,tree:[...files.keys()].map(path=>({path,type:'blob',mode:'100644',sha:candidate}))});
    }
    const path=url.pathname.slice((prefix+'/contents/').length);
    assert.ok(url.pathname.startsWith(prefix+'/contents/')&&files.has(path));
    assert.equal(url.search,'?ref='+source);
    return Response.json({path,type:'file',sha:candidate,encoding:'base64',content:Buffer.from(files.get(path)).toString('base64')});
  });
  const workspace=await mkdtemp(join(await nativeTemporaryParent('REGISTRATION_FIXTURE_TEMP_LINK'),'registry-preview-'));
  const path=registrationPath(product),file=join(workspace,path);
  const runGit=(...args)=>execFileSync('git',['-c','core.hooksPath=','-c','user.name=Fixture',
    '-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],
  {cwd:workspace,encoding:'utf8',windowsHide:true}).trim();
  const validate=base=>validateRegistrationPreview(workspace,{input:{changedPaths:[path],base},files:[path]},{});
  try {
    const legacy={...(await propose(product,productFiles)).policy,adoption:'central'};
    runGit('init','--quiet','--initial-branch=main');
    runGit('commit','--quiet','--allow-empty','-m','initial');
    const before=runGit('rev-parse','HEAD');
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file,JSON.stringify({...legacy,release:null}));
    await validate(before);
    await writeFile(file,JSON.stringify(legacy));
    await assert.rejects(validate(before),/VALIDATION_REGISTRATION_PREVIEW_SELECTION/);
    runGit('add','--',path);
    runGit('commit','--quiet','-m','approved registration');
    const approved=runGit('rev-parse','HEAD');
    await validate(approved);
    await writeFile(file,JSON.stringify({...legacy,release:null}));
    await assert.rejects(validate(approved),/VALIDATION_REGISTRATION_PREVIEW_SELECTION/);
  } finally {
    await rm(workspace,{recursive:true,force:true});
  }
});

test('registration observes only selected channel assets',async()=>{
  const files=new Map(productFiles),delivery=JSON.parse(files.get('.github/delivery.json'));
  delivery.units[0].channels=[{...channel,id:'ghcr-assets',location:'ghcr.io/example/product'}];
  files.set('.github/delivery.json',JSON.stringify(delivery));
  const proposal=await propose(product,files);
  assert.ok(proposal.policy.release.units[0].channels.some(c=>c.id==='github-release' && !c.required));
  assert.ok(proposal.policy.release.units[0].channels.some(c=>c.id==='ghcr-assets'));
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
