import {expect,it,vi} from 'vitest';
import {WorkflowEvent,submitConfiguration} from '../src/quality-event.js';
import {SqliteDurableStorage} from './bounded-storage.js';
import {forwardConfigurationComment,forwardConfigurationCompletion} from '../src/index.js';

function submitWith(json:ReturnType<typeof configurationApi>){
  return async(env:any,inputs:Record<string,string>)=>{
    const storage=new SqliteDurableStorage(),inboxStore=new SqliteDurableStorage();
    const object=new WorkflowEvent(storage as any,env,()=>({json} as any),'configurationEvent');
    const ns={idFromName:(key:string)=>key,get:()=>({fetch:async(r:Request)=>{
      if(new URL(r.url).pathname==='/configuration-comment'){
        const inbox=new WorkflowEvent(inboxStore as any,{...env,BOUNDED_RECHECK:ns});
        await inbox.registerComment(await r.json() as any);await inbox.flushComments();
      }else await object.register(await r.json() as any);return Response.json({});
    }})};
    await submitConfiguration({...env,BOUNDED_RECHECK:ns},inputs);
  };
}

function configurationApi(sha:string){
  const config=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:sha}));
  return vi.fn(async(_id:number,path:string,method?:string)=>{
    if(method==='POST')return;
    if(path.includes('/git/ref/'))return {ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha}};
    if(path.includes('/contents/'))return {type:'file',path:'config/bounded-recheck.json',size:config.length,encoding:'base64',content:config.toString('base64')};
    return {state:'active',path:'.github/workflows/repository-configuration-event.yml'};
  });
}

it('forwards only the locator of a successful same-repository default branch configuration attempt',async()=>{
  const sha='a'.repeat(40),org=302208797;
  const env={ORGANIZATION_ID:String(org),INSTALLATION_ID:'123',BOUNDED_RECHECK_ENABLED:'true',BOUNDED_DEPLOYMENT_SHA:sha};
  const repository={id:42,full_name:'splrad/new-product',private:false,owner:{id:org},archived:false,disabled:false,fork:false,default_branch:'trunk'};
  const run={event:'workflow_dispatch',id:334,run_attempt:2,repository,head_repository:repository,head_branch:'trunk',path:'.github/workflows/repository-configuration.yml',status:'completed',conclusion:'success'};
  const payload={action:'completed',installation:{id:123},organization:{id:org},repository,workflow_run:run};
  const json=configurationApi(sha);
  const trialPath='.github/workflows/repository-configuration-trial.yml';
  for(const delta of [{installation:{id:999}},{repository:{...repository,private:true}},{repository:{...repository,archived:true}},
    {repository:{...repository,fork:true}},{organization:{id:999}},{repository:{...repository,disabled:true}},
    ...[{event:'workflow_run'},{path:trialPath,event:'push'},{path:trialPath,head_branch:'other'},{path:trialPath,head_repository:{id:456}},{head_branch:'feature'},{path:'.github/workflows/other.yml'},{conclusion:'failure'},{head_repository:{id:456}},{run_attempt:0}].map(change=>({workflow_run:{...run,...change}}))]){
    await forwardConfigurationCompletion(env as any,{...payload,...delta},submitWith(json));
  }
  expect(json).not.toHaveBeenCalled();
  await forwardConfigurationCompletion(env as any,payload,submitWith(json));
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event:'pull_request',head_branch:'steward/repository-configuration-42'}},submitWith(json));
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event:'pull_request_review',head_branch:'other-reviewed-config'}},submitWith(json));
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,path:trialPath}},submitWith(json));
  expect(json.mock.calls.filter(([,path])=>path.endsWith('/dispatches'))).toHaveLength(4);
  expect(json).toHaveBeenLastCalledWith(1296724484,'/repos/splrad/steward/actions/workflows/repository-configuration-event.yml/dispatches','POST',
    {ref:'main',inputs:{repository_id:'42',run_id:'334',attempt:'2'}});
});

it('forwards dashboard comments from ordinary users using only the three verified locators',async()=>{
  const sha='b'.repeat(40), org=302208797;
  const env={ORGANIZATION_ID:String(org),INSTALLATION_ID:'123',BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha};
  const repository={id:42,full_name:'splrad/new-product',private:false,owner:{id:org},archived:false,disabled:false,fork:false,default_branch:'trunk'};
  const user={id:200,type:'User'};
  const issue={number:7,state:'open',title:'仓库配置',user:{id:301115370,type:'Bot'},body:'<!-- steward-configuration-dashboard 42 -->\r\n内容'};
  const comment={id:901,body:'/configure',user,issue_url:'https://api.github.com/repos/splrad/new-product/issues/7'};
  const payload={action:'created',organization:{id:org},installation:{id:123},repository,issue,comment,sender:user};
  const json=configurationApi(sha);
  for(const delta of [
    {action:'edited'}, {sender:{...user,id:99}}, {installation:{id:98}}, {repository:{...repository,private:true}},
    {issue:{...issue,pull_request:{}}}, {issue:{...issue,state:'closed'}}, {issue:{...issue,user:{...issue.user,id:1}}},
    {issue:{...issue,title:'Other'}}, {issue:{...issue,body:'<!-- steward-configuration-dashboard 2 -->'}},
    {comment:{...comment,body:'/configure extra'}}, {comment:{...comment,user:{...user,type:'Bot'}}},
    {comment:{...comment,issue_url:'https://api.github.com/repos/splrad/new-product/issues/8'}},
  ]) await forwardConfigurationComment(env as any,{...payload,...delta},submitWith(json));
  expect(json).not.toHaveBeenCalled();
  await forwardConfigurationComment(env as any,payload,submitWith(json));
  expect(json).toHaveBeenLastCalledWith(1296724484,'/repos/splrad/steward/actions/workflows/repository-configuration-event.yml/dispatches','POST',
    {ref:'main',inputs:{repository_id:'42',issue_number:'7',comment_id:'901'}});
});

it('requires a successful request job on the exact issues or schedule attempt before forwarding', async()=>{
  const sha='a'.repeat(40),org=302208797;
  const env={ORGANIZATION_ID:String(org),INSTALLATION_ID:'123',BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha};
  const repo={id:42,full_name:'splrad/new-product',private:false,owner:{id:org},archived:false,disabled:false,fork:false,default_branch:'trunk'};
  const run={event:'issues',id:334,head_sha:sha,run_attempt:2,repository:repo,head_repository:repo,head_branch:'trunk',path:'.github/workflows/repository-configuration.yml',status:'completed',conclusion:'success'};
  const payload={action:'completed',installation:{id:123},organization:{id:org},repository:repo,workflow_run:run};
  const job={name:'request',run_id:334,run_attempt:2,head_sha:sha,status:'completed',conclusion:'success'};
  const json=configurationApi(sha);
  const jobs=vi.fn(async()=>[job]);
  for(const change of [{event:'issue_comment'},{event:'schedule',head_branch:'other'},{path:'.github/workflows/repository-configuration-trial.yml'},{head_sha:'invalid'}]){
    await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,...change}},submitWith(json),jobs);
  }
  expect(jobs).not.toHaveBeenCalled();
  for(const result of [[],[job,job],[{...job,name:'unrelated'}],[{...job,run_attempt:1}],[{...job,run_id:335}],[{...job,head_sha:'b'.repeat(40)}],[{...job,conclusion:'skipped'}]]){
    await forwardConfigurationCompletion(env as any,payload,submitWith(json),async()=>result);
  }
  expect(json).not.toHaveBeenCalled();
  for(const event of ['schedule','issues']){
    await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event}},submitWith(json),jobs);
    expect(json).toHaveBeenLastCalledWith(1296724484,'/repos/splrad/steward/actions/workflows/repository-configuration-event.yml/dispatches','POST',
      {ref:'main',inputs:{repository_id:'42',run_id:'334',attempt:'2'}});
  }
});

it('retains the exact dashboard comment through promotion and consumes the wake once',async()=>{
  const sha='b'.repeat(40),storage=new SqliteDurableStorage(),waits:any[]=[],posts:any[]=[];
  let promoted=false,objectKey='';
  const ordinary=configurationApi(sha);
  const reader={json:async(id:number,path:string,method?:string,body?:unknown)=>{
    if(!promoted && path.endsWith('/steward/validated-controller')){
      return {ref:'refs/heads/steward/validated-controller',object:{type:'commit',sha:'a'.repeat(40)}};
    }
    if(method==='POST')posts.push(body);
    return ordinary(id,path,method);
  }};
  const inputs={repository_id:'42',issue_number:'7',comment_id:'901'};
  const env:any={BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha};
  const object=()=>new WorkflowEvent(storage as any,env,()=>reader as any,'configurationEvent');
  const inboxStore=new SqliteDurableStorage(),inbox=()=>new WorkflowEvent(inboxStore as any,env);
  env.BOUNDED_RECHECK={idFromName:(key:string)=>key,get:(key:string)=>({fetch:async(req:Request)=>{
    const action=new URL(req.url).pathname;
    if(action==='/configuration-comment'){await inbox().registerComment(await req.json() as any);return Response.json({});}
    if(action==='/generation')return Response.json({generation:3});
    if(action==='/wait'){waits.push(await req.json());return Response.json({});}
    objectKey=key;await object().register(await req.json() as any);return Response.json({});
  }})};
  await submitConfiguration(env,inputs);await submitConfiguration(env,inputs);
  await submitConfiguration(env,{...inputs,comment_id:'902'});await inbox().flushComments();expect(posts).toEqual([]);
  expect(waits).toEqual([{policy:sha,kind:'configuration',generation:3,key:objectKey.split(':')[2]}]);
  promoted=true;await object().forward();await object().forward();await submitConfiguration(env,inputs);
  expect(posts).toEqual([{ref:'main',inputs:{...inputs,comment_id:'901,902'}}]);
});

it.each([403,422])('releases a permanently rejected batch (%s) so the next comment can be delivered',async status=>{
 const sha='a'.repeat(40),env:any={BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha};
 const inbox=new WorkflowEvent(new SqliteDurableStorage() as any,env);
 const ordinary=configurationApi(sha),stores=new Map<string,SqliteDurableStorage>(),posts:string[]=[];
 const inputs={repository_id:'42',issue_number:'7',comment_id:'91'};
 const reader={json:async(id:number,path:string,method?:string,body?:any)=>{
   if(method==='POST'){
     posts.push(body.inputs.comment_id);
     if(body.inputs.comment_id==='91')throw Error('GITHUB_HTTP_'+status);
   }
   return ordinary(id,path,method);
 }};
 env.BOUNDED_RECHECK={idFromName:(key:string)=>key,get:(key:string)=>({fetch:async(req:Request)=>{
   const store=stores.get(key)??new SqliteDurableStorage();stores.set(key,store);
   const event=new WorkflowEvent(store as any,env,()=>reader as any,'configurationEvent');
   await event.register(await req.json() as any);return Response.json({});
 }})};
 await inbox.registerComment(inputs);await inbox.flushComments();
 expect(await [...stores.values()][0]!.get('configurationEvent')).toMatchObject({phase:'rejected',rejection:'GITHUB_HTTP_'+status});
 await inbox.registerComment({...inputs,comment_id:'92'});await inbox.flushComments();
 expect(posts).toEqual(['91','92']);
});
