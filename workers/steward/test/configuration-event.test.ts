import {expect,it,vi} from 'vitest';
import {forwardConfigurationComment,forwardConfigurationCompletion} from '../src/index.js';

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
    await forwardConfigurationCompletion(env as any,{...payload,...delta},{json} as any);
  }
  expect(json).not.toHaveBeenCalled();
  await forwardConfigurationCompletion(env as any,payload,{json} as any);
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event:'pull_request',head_branch:'steward/repository-configuration-42'}},{json} as any);
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event:'pull_request_review',head_branch:'other-reviewed-config'}},{json} as any);
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,path:trialPath}},{json} as any);
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
  ]) await forwardConfigurationComment(env as any,{...payload,...delta},{json} as any);
  expect(json).not.toHaveBeenCalled();
  await forwardConfigurationComment(env as any,payload,{json} as any);
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
    await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,...change}},{json} as any,jobs);
  }
  expect(jobs).not.toHaveBeenCalled();
  for(const result of [[],[job,job],[{...job,name:'unrelated'}],[{...job,run_attempt:1}],[{...job,run_id:335}],[{...job,head_sha:'b'.repeat(40)}],[{...job,conclusion:'skipped'}]]){
    await forwardConfigurationCompletion(env as any,payload,{json} as any,async()=>result);
  }
  expect(json).not.toHaveBeenCalled();
  for(const event of ['schedule','issues']){
    await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event}},{json} as any,jobs);
    expect(json).toHaveBeenLastCalledWith(1296724484,'/repos/splrad/steward/actions/workflows/repository-configuration-event.yml/dispatches','POST',
      {ref:'main',inputs:{repository_id:'42',run_id:'334',attempt:'2'}});
  }
});
