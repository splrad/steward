import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { registrationEntry, registrationIds, registrationProposal, reconcileRegistration } from '../repository-registration.mjs';
import { requestFile } from '../repository-registration-request.mjs';
import { checkedRegistration } from '../repository-registration-policy.mjs';
import { assertInputScope, assertGovernanceOnlyScope } from '../private-dependency-policy.mjs';
import { requiresProductCI } from '../validation-input.mjs';

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
const propose = (repo, files = new Map()) => registrationProposal(repo, async path => files.get(path) ?? null);
const body = (event, action, repository_ids) => ({
  delivery:'12345678-1234-4321-8123-123456789012',body_sha256:'f'.repeat(64),event,action,
  ...(repository_ids === undefined ? {} : {repository_ids})
});
const event = payload => ({repository:admin,action:'settings-source-event',
  sender:{id:353238212,login:'splrad-governance[bot]',type:'Bot'},client_payload:payload});

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

function fake({ files = new Map(), open = [], closed = [], failCreate = false } = {}) {
  const state = { refs: new Map([['main',base]]), trees:new Map([[base,files]]), commits:new Map(),
    writes:[], open, closed, failCreate };
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
      pulls:{
        list:args => args.state==='open' ? open : closed.filter(pull=>args.head==='splrad:'+pull.head.ref),
        listFiles:({pull_number}) => open.find(pull=>pull.number===pull_number).files,
        async create({head,title,body,draft}) {
          assert.ok(draft);
          if (state.failCreate) throw Error('response ambiguous');
          state.writes.push(['pull',head]);
          const pull={number:42,head:{ref:head,repo:{id:admin.id}},user:bot,title,body};
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
    assert.equal((await reconcileRegistration(api,admin,repo,source,proposal,async()=>source)).result,'created');
    assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(repo))),proposal.policy);
    assert.match(state.open[0].body,new RegExp(source));
    assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull']);
    if(repo===governance) assert.deepEqual([proposal.policy.productCi,proposal.policy.release,proposal.pending],[[],null,[]]);
    else {
      assert.deepEqual(proposal.policy.productCi,[ci]);
      assert.deepEqual(proposal.policy.release,{buildWorkflow:publish,units:[{id:'layerscape',channels:[channel]}]});
      assert.equal(proposal.policy.site,null);
      assert.equal(proposal.pending.length,1);
    }
    state.open[0].body += '\n人工改稿';
    state.trees.get(candidate).set(registrationPath(repo),'人工正在编辑');
    assert.equal((await reconcileRegistration(api,admin,repo,source,proposal,async()=>source)).result,'reused');
    assert.equal(state.trees.get(candidate).get(registrationPath(repo)),'人工正在编辑');
    assert.match(state.open[0].body,/人工改稿/);
    assert.equal(state.writes.length,3);
  }
});

test('manual central PRs and merged choices keep authority over discovered differences', async () => {
  const proposal = await propose(product,productFiles);
  const manual={...proposal.policy,site:{workflow:pages,mode:'build-only',source:'default-branch'}};
  const files = new Map([[registrationPath(product),JSON.stringify(manual)]]);
  const draft={number:87,head:{ref:'manual-adjustment'},files:[{filename:registrationPath(product)}]};
  const {api,state}=fake({files,open:[draft]});
  assert.deepEqual(await reconcileRegistration(api,admin,product,source,proposal,async()=>source),
    {result:'reused',number:87,differences:['site'],pending:proposal.pending});
  state.open.pop();
  const review = await reconcileRegistration(api,admin,product,source,proposal,async()=>source);
  assert.equal(review.result,'review-required');
  assert.deepEqual(review.observations,[{field:'site',current:manual.site,observed:null}]);
  assert.equal(state.writes.length,0);
  const renamed={...product,name:'LayerScape-next',full_name:'splrad/LayerScape-next'};
  const renameProposal=await propose(renamed,productFiles);
  await reconcileRegistration(api,admin,renamed,source,renameProposal,async()=>source);
  assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(product))),
    {...manual,repository:renamed.full_name});
});

test('moved input and uncertain PR creation preserve the existing commit', async () => {
  const proposal = await propose(governance);
  const {api,state}=fake({failCreate:true});
  await assert.rejects(reconcileRegistration(api,admin,governance,source,proposal,async()=>base),/input moved/);
  assert.equal(state.writes.length,0);
  await assert.rejects(reconcileRegistration(api,admin,governance,source,proposal,async()=>source),/response ambiguous/);
  state.failCreate=false;
  assert.equal((await reconcileRegistration(api,admin,governance,source,proposal,async()=>source)).result,'created');
  assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull']);
  state.closed.push(state.open.pop());
  assert.equal((await reconcileRegistration(api,admin,governance,source,proposal,async()=>source)).result,'previously-reviewed');
});

test('a manual PR opened during draft assembly is reused before sending another PR', async () => {
  const proposal = await propose(governance);
  const {api,state}=fake();
  let sourceReads=0;
  const outcome=await reconcileRegistration(api,admin,governance,source,proposal,async()=>{
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
        async getTree({tree_sha}) {
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

test('private workflow to public controller replays both registration cases without exposing private results', async () => {
  const temp=resolve(tmpdir()),directory=await mkdtemp(join(temp,'registration-test-'));
  assert.equal(dirname(resolve(directory)),temp);
  try {
    for (const [repo,files,manual] of [[governance,new Map(),false],[product,productFiles,true]]) {
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
      let input, currentArtifact, request, protectedBranch=true, producerPath='.github/workflows/repository-registration.yml';
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
              return {data:{total_count:1,artifacts:[currentArtifact]}};
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
        openAdmin:async()=>async (purpose,operation)=>{
          scopes.push(purpose);
          return operation(purpose==='registration-read'?readApi:api,admin,purpose);
        },
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
          GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/sync-managed.yml@refs/heads/main'};
        assert.equal(await registrationEntry('consume',publicEnv,options),0);
        assert.deepEqual(JSON.parse(state.trees.get(candidate).get(registrationPath(repo))),(await propose(repo,files)).policy);
        state.open[0].body += '\n人工备注 Private case';
        state.trees.get(candidate).set(registrationPath(repo),'维护者正在编辑');
        assert.equal(await registrationEntry('consume',publicEnv,options),0);
        assert.deepEqual(state.writes.map(([kind])=>kind),['ref','commit','pull']);
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
        assert.deepEqual(errors,['REGISTRATION_UNAVAILABLE\n','REGISTRATION_UNAVAILABLE\n',
          'REGISTRATION_UNAVAILABLE\n','REGISTRATION_UNAVAILABLE\n']);
        assert.equal(state.writes.length,3);
      } finally {
        await rm(requestPath,{force:true});
        await rm(stepOutput,{force:true});
      }
    }
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
