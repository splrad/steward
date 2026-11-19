import {expect,it,vi} from 'vitest';
import {forwardConfigurationCompletion} from '../src/index.js';

it('forwards only the locator of a successful same-repository default branch configuration attempt',async()=>{
  const sha='a'.repeat(40),org=302208797;
  const env={ORGANIZATION_ID:String(org),INSTALLATION_ID:'123',BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha};
  const repository={id:42,full_name:'splrad/new-product',private:false,owner:{id:org},archived:false,disabled:false,fork:false,default_branch:'trunk'};
  const run={event:'workflow_dispatch',id:334,run_attempt:2,repository,head_repository:repository,head_branch:'trunk',path:'.github/workflows/repository-configuration.yml',status:'completed',conclusion:'success'};
  const payload={action:'completed',installation:{id:123},organization:{id:org},repository,workflow_run:run};
  const config=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:sha}));
  const json=vi.fn(async(_id:number,path:string,method?:string)=>{
    if(method==='POST')return;
    if(path.includes('/git/ref/'))return {ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha}};
    if(path.includes('/contents/'))return {type:'file',path:'config/bounded-recheck.json',size:config.length,encoding:'base64',content:config.toString('base64')};
    return {state:'active',path:'.github/workflows/repository-configuration-event.yml'};
  });
  for(const delta of [{installation:{id:999}},{repository:{...repository,private:true}},{repository:{...repository,archived:true}},
    {repository:{...repository,fork:true}},{organization:{id:999}},{repository:{...repository,disabled:true}},
    ...[{head_branch:'feature'},{path:'.github/workflows/other.yml'},{conclusion:'failure'},{head_repository:{id:456}},{run_attempt:0}].map(change=>({workflow_run:{...run,...change}}))]){
    await forwardConfigurationCompletion(env as any,{...payload,...delta},{json} as any);
  }
  expect(json).not.toHaveBeenCalled();
  await forwardConfigurationCompletion(env as any,payload,{json} as any);
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event:'pull_request',head_branch:'steward/repository-configuration-42'}},{json} as any);
  await forwardConfigurationCompletion(env as any,{...payload,workflow_run:{...run,event:'pull_request_review',head_branch:'other-reviewed-config'}},{json} as any);
  expect(json.mock.calls.filter(([,path])=>path.endsWith('/dispatches'))).toHaveLength(3);
  expect(json).toHaveBeenLastCalledWith(1296724484,'/repos/splrad/steward/actions/workflows/repository-configuration-event.yml/dispatches','POST',
    {ref:'main',inputs:{repository_id:'42',run_id:'334',attempt:'2'}});
});
