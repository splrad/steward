import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('registered native entry separates Pages writes from administrator policy reads and uses the product Git ledger',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'pages-native-entry-'));
  const remote=join(root,'product.git'),seed=join(root,'seed'),branch='steward/governance-state';
  const originalExec=child.execFile,exec=promisify(originalExec);
  const git=async(...args)=>(await exec('git',args,{cwd:root,encoding:'utf8',windowsHide:true})).stdout.trim();
  const repo={id:1187527897,full_name:'splrad/LayerScape',default_branch:'main',has_pages:true,private:false,fork:false,disabled:false,archived:false};
  const admin={id:1447987054,full_name:'splrad/steward-settings',default_branch:'main',private:true,
    disabled:false,archived:false,owner:{id:302208797}};
  const central=1296724484,bot=301115370,pin='b'.repeat(40),sha='a'.repeat(40),target='.github/workflows/pages.yml';
  const site={repositoryId:repo.id,repository:repo.full_name,workflowId:8};
  const wf=Buffer.from((await fs.readFile(new URL('../../templates/release/pages.yml',import.meta.url),'utf8'))
    .replace("STEWARD_DOCS_SOURCE: ${{ vars.STEWARD_DOCS_SOURCE || 'default-branch' }}",'STEWARD_DOCS_SOURCE: default-branch'));
  const productRun={id:12,run_attempt:1,status:'completed',conclusion:'cancelled',path:target,repository:repo,head_repository:repo,
    event:'push',head_branch:'main',head_sha:sha,workflow_id:8,display_title:'Pages default-branch '+sha+' 12',
    created_at:new Date(Date.now()-60000).toISOString(),updated_at:new Date(Date.now()-10000).toISOString()};
  const env={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:'99',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',
    GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:String(central),STEWARD_CONTROLLER_SHA:pin,
    BOUNDED_MODE:'pages',PAGES_POLICY_SHA:pin,PAGES_REPOSITORY_ID:String(site.repositoryId),PAGES_WORKFLOW_ID:'8',PAGES_RUN_ID:'12',PAGES_ATTEMPT:'1',
    STEWARD_CENTRAL_TOKEN:'offline-central',STEWARD_APP_PRIVATE_KEY:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
  const actions=[],tokenRequests=[];let ruleProblem='missing',revoked=0;
  try {
    await git('init','--bare',remote);await git('init','--initial-branch=main',seed);
    await git('-C',seed,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','Root');
    await git('-C',seed,'push',remote,'HEAD:refs/heads/'+branch);
    const head=()=>git('--git-dir='+remote,'rev-parse','refs/heads/'+branch);
    const original=await head();
    const read=fs.readFile.bind(fs);
    t.mock.method(fs,'readFile',async (file, ...args) => (file instanceof URL) && file.pathname.endsWith('/config/pages-completion.json')
      ?JSON.stringify({publicSites:[site]}):read(file,...args));
    // Replace only the native Git transport. Git state, claims, commits, readbacks and rules all use the production entry.
    const gitArgs=(cmd,args)=>{
      assert.equal(cmd,'git');
      const mapped=args.map(a=>a==='https://github.com/'+repo.full_name+'.git'?remote:a==='protocol.https.allow=always'?'protocol.file.allow=always':a);
      assert.ok(!mapped.some(a=>/^https?:/i.test(a)));
      return mapped;
    };
    const localGit=(cmd,args,options)=>exec(cmd,gitArgs(cmd,args),options);
    const shim=(cmd,args,options,callback)=>originalExec(cmd,gitArgs(cmd,args),options,callback);
    shim[promisify.custom]=localGit;
    child.execFile=shim;syncBuiltinESMExports();
    assert.equal(promisify((await import('node:child_process')).execFile),localGit);
    t.mock.method(globalThis,'fetch',async(input,init={})=>{
      const url=new URL(String(input)),p=decodeURIComponent(url.pathname),method=init.method??'GET';
      assert.equal(url.origin,'https://api.github.com');
      const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
      const botFact={id:bot,type:'Bot'},receiver='.github/workflows/pages-maintenance-event.yml';
      if(p==='/app')return json({id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'});
      if(p==='/orgs/splrad/installation')return json({id:145952003,app_id:4243096,account:{id:302208797}});
      if(p==='/users/splrad-steward[bot]')return json(botFact);
      if(p==='/app/installations/145952003/access_tokens'&&method==='POST'){
        const request=JSON.parse(init.body);tokenRequests.push(request);
        assert.ok([repo.id,admin.id].includes(request.repository_ids[0]));
        return json({token:'ghs_offline_'+tokenRequests.length,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:request.permissions});
      }
      const tokenIndex=/ghs_offline_([1-9][0-9]*)$/.exec(new Headers(init.headers).get('authorization')??'');
      const scope=tokenRequests[Number(tokenIndex?.[1])-1]?.repository_ids[0];
      if(p==='/installation/repositories')return json({total_count:1,repositories:[scope===admin.id?admin:repo]});
      if(p==='/installation/token'&&method==='DELETE'){revoked++;return new Response(null,{status:204});}
      if(p==='/repos/'+admin.full_name||p.startsWith('/repos/'+admin.full_name+'/')){
        assert.equal(scope,admin.id);assert.equal(method,'GET');
        if(p==='/repos/'+admin.full_name)return json(admin);
        if(p.endsWith('/branches/main'))return json({name:'main',protected:true,commit:{sha:pin}});
        if(p.endsWith('/git/trees/'+pin))return json({truncated:false,tree:[]});
      }
      if(p==='/repos/splrad/steward')return json({id:central,default_branch:'main'});
      if(p.startsWith('/repos/splrad/steward/')){
        const k=p.slice('/repos/splrad/steward'.length);
        if(k==='/git/ref/heads/main')return json({object:{sha:pin}});
        if(k==='/actions/runs/99/attempts/1')return json({id:99,run_attempt:1,path:receiver,event:'workflow_dispatch',head_branch:'main',
          head_sha:pin,repository:{id:central},head_repository:{id:central},actor:botFact,triggering_actor:botFact,workflow_id:7});
        if(k==='/actions/workflows/pages-maintenance-event.yml')return json({id:7,path:receiver,state:'active'});
      }
      if(p==='/graphql'){
        const body=JSON.parse(init.body);assert.match(body.query,/^query/);assert.equal(body.variables.id,'WRITER');
        return json({data:{node:{id:'WRITER',databaseId:51,rules:{nodes:[{type:'UPDATE',parameters:{updateAllowsFetchAndMerge:false}}],pageInfo:{hasNextPage:false}}}}});
      }
      const prefix='/repos/'+repo.full_name;assert.ok(p===prefix||p.startsWith(prefix+'/'));
      const k=p.slice(prefix.length);
      if(k==='')return json(repo);
      if(k==='/actions/variables/STEWARD_DOCS_SOURCE')return json({name:'STEWARD_DOCS_SOURCE',value:'default-branch'});
      if(k==='/actions/variables/STEWARD_PAGES_BUILD_ONLY')return json({},404);
      if(k==='/git/ref/heads/main')return json({ref:'refs/heads/main',object:{type:'commit',sha}});
      if(k==='/contents/.github/steward-central-policy')return json({},404);
      if(k==='/contents/'+target)return json({type:'file',path:target,encoding:'base64',size:wf.length,content:wf.toString('base64'),
        sha:createHash('sha1').update('blob '+wf.length+'\0').update(wf).digest('hex')});
      if(k==='/actions/workflows/pages.yml')return json({id:8,state:'active',path:target});
      if(k==='/deployments')return json([]);
      if(k==='/actions/workflows/8/runs'){const rows=url.searchParams.has('status')?[]:[productRun];return json({total_count:rows.length,workflow_runs:rows});}
      if(k==='/actions/runs/12')return json(productRun);
      if(k==='/actions/runs/12/rerun'&&method==='POST'){
        const claim=JSON.parse(await git('--git-dir='+remote,'show',branch+':maintenance/pages/12.json'));
        assert.equal(claim.requests.length,1);assert.equal(claim.requests[0].responseStatus,null);
        productRun.run_attempt++;productRun.status='queued';productRun.conclusion=null;actions.push(k);return json({},201);
      }
      if(k==='/rules/branches/'+branch)return json(['creation','update','non_fast_forward','deletion'].map((type,i)=>({type,ruleset_id:i<2?51:52})));
      if(k==='/rulesets/51'){
        const writers=[4243096,ruleProblem==='wrong'?77:5639432].map(actor_id=>({actor_type:'Integration',actor_id,bypass_mode:'always'}));
        return json({id:51,node_id:'WRITER',enforcement:'active',target:'branch',rules:[{type:'creation'},{type:'update'}],
          ...(ruleProblem==='missing'?{}:{bypass_actors:writers})});
      }
      if(k==='/rulesets/52')return json({id:52,enforcement:'active',target:'branch',rules:[{type:'non_fast_forward'},{type:'deletion'}],
        bypass_actors:ruleProblem==='integrity'?[{actor_id:5639432,actor_type:'Integration',bypass_mode:'always'}]:[]});
      if(k==='/git/ref/heads/'+branch)return json({ref:'refs/heads/'+branch,object:{type:'commit',sha:await head()}});
      throw Error('Unexpected native request '+method+' '+p);
    });
    const {main}=await import('../pages-completion-entry.mjs');
    for(ruleProblem of ['missing','wrong','integrity']){
      await assert.rejects(main(env),/QUALITY_(PROTECTION|INTEGRITY)/);
      assert.equal(await head(),original);assert.deepEqual(actions,[]);
    }
    ruleProblem='';await main(env);
    assert.deepEqual(actions,['/actions/runs/12/rerun']);assert.equal(revoked,tokenRequests.length);
    assert.equal(tokenRequests.filter(request=>request.repository_ids[0]===repo.id).length,4);
    assert.ok(tokenRequests.every(request=>request.repository_ids[0]!==admin.id));
    for(const request of tokenRequests)assert.deepEqual(request.permissions,{metadata:'read',contents:'write',actions:'write',administration:'read',
        actions_variables:'read',deployments:'read',attestations:'read',organization_administration:'write'});
    const record=JSON.parse(await git('--git-dir='+remote,'show',branch+':maintenance/pages/12.json'));
    assert.equal(record.runId,12);assert.equal(record.requests[0].responseStatus,201);
  }finally {child.execFile=originalExec;t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
});

test('a Windows TEMP ancestor junction is rejected before a Pages workspace is allocated',{skip:process.platform!=='win32'},async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'pages-temp-link-'));
  const previous=process.env.TEMP,physical=join(root,'physical'),link=join(root,'alias');
  try {
    await fs.mkdir(join(physical,'nested'),{recursive:true});
    await fs.symlink(physical,link,'junction');
    process.env.TEMP=join(link,'nested');
    const {main}=await import('../pages-completion-entry.mjs');
    await assert.rejects(main({}),/PAGES_TEMP_PARENT_LINK/);
    assert.deepEqual(await fs.readdir(join(physical,'nested')),[]);
  }finally {
    if(previous===undefined)delete process.env.TEMP;else process.env.TEMP=previous;
    await fs.rm(root,{recursive:true,force:true});
  }
});
