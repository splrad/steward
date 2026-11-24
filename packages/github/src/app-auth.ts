import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { completeNativeRuleParameters } from './native-rule-parameters.js';
import { GITHUB_API_VERSION } from './api-version.js';
/** Repository access is scoped per call. Organization administration remains organization-wide. */
export async function nativeReleaseApp(privateKey: string, transport: typeof fetch = fetch, onFailure: (error: unknown) => void = () => {}) {
  const versionedFetch:typeof fetch=(url,init)=>{
    const headers=new Headers(init?.headers);headers.set('X-GitHub-Api-Version',GITHUB_API_VERSION);
    return transport(url,{...init,headers});
  };
  const options={request:{fetch:versionedFetch},log:{debug(){},info(){},warn(){},error(){}}};
  const app=new Octokit({...options,authStrategy:createAppAuth,auth:{appId:4243096,clientId:'Iv23liuSr0qd4WLJdZhH',privateKey:privateKey.replace(/\\n/g,'\n')},
    userAgent:'splrad-steward-release',request:{...options.request,headers:{'x-github-api-version':GITHUB_API_VERSION}}});
  const appFact=(await app.request('GET /app')).data;
  if(appFact?.id!==4243096 || appFact.client_id!=='Iv23liuSr0qd4WLJdZhH')throw new Error('RELEASE_APP_IDENTITY');
  const installation=(await app.request('GET /orgs/{org}/installation',{org:'splrad'})).data;
  if(installation.account?.id!==302208797 || installation.app_id!==4243096 || installation.suspended_at)throw new Error('RELEASE_INSTALLATION_IDENTITY');
  const bot=(await new Octokit(options).request('GET /users/{username}',{username:`${appFact.slug}[bot]`})).data;
  if(bot.id!==301115370 || bot.type!=='Bot')throw new Error('RELEASE_APP_BOT_IDENTITY');
  const token=async(repositoryId?:number,kind:'release'|'candidate'|'candidate-read'|'quality'|'template'|'template-read'|'pages'|'maintenance'|'maintenance-rules'|'configuration-actions'|'configuration-read'|'configuration-issues'|'registration-read'|'registration-write'|'registry-read'|'registry-projection'|'validator-revalidation'|'release-label'='release')=>{
    // GitHub exposes organization ruleset bypass actors only to organization rule managers.
    // Trusted rule readers request that capability explicitly; discovery and generation do not.
    const permissions=kind==='maintenance-rules'?{metadata:'read',organization_administration:'write'}
      :kind==='registration-read'?{metadata:'read',contents:'read',actions:'read'}
      :kind==='registry-read'?{metadata:'read',contents:'read'}
      :kind==='registry-projection'?{metadata:'read',contents:'write'}
      :kind==='registration-write'?{metadata:'read',contents:'write',pull_requests:'write'}
      :kind==='release-label'?{metadata:'read',contents:'read',pull_requests:'write'}
      :kind==='configuration-read'?{metadata:'read',contents:'read',pull_requests:'read',actions:'read'}
      :kind==='validator-revalidation'?{metadata:'read',pull_requests:'write',actions:'read'}
      :kind==='configuration-actions'?{metadata:'read',actions:'write'}
      :kind==='configuration-issues'?{metadata:'read',issues:'write'}
      :kind==='maintenance'?{metadata:'read',contents:'write',actions:'write'}
      :kind==='pages'?{metadata:'read',contents:'write',actions:'write',administration:'read',actions_variables:'read',deployments:'read',attestations:'read',organization_administration:'write'}
      :kind==='quality'?{metadata:'read',contents:'write',checks:'write',pull_requests:'read',actions:'read',organization_administration:'write'}
      :kind==='template'?{metadata:'read',contents:'write',pull_requests:'write',workflows:'write'}
      :kind==='template-read'?{metadata:'read',contents:'read',pull_requests:'read',actions_variables:'read',actions:'read',organization_administration:'write'}
      :kind==='candidate-read'?{metadata:'read',contents:'read',pull_requests:'read',issues:'read'}
      :kind==='candidate'?{metadata:'read',contents:'write',pull_requests:'write',issues:'write',administration:'read',actions:'read',organization_administration:'write'}
      :{metadata:'read',contents:'write',actions:'write',checks:'read',administration:'read',organization_administration:'write'};
    const value=await app.auth({type:'installation',installationId:installation.id,refresh:true,
      ...(repositoryId===undefined?{permissions:{metadata:'read'}}:{repositoryIds:[repositoryId],permissions})}) as {token:string};
    if(!value.token)throw new Error('RELEASE_INSTALLATION_TOKEN');
    const client=new Octokit({...options,auth:value.token,request:{...options.request,headers:{'x-github-api-version':GITHUB_API_VERSION}}});
    return {token:value.token,client,revoke:async()=>{await client.request('DELETE /installation/token');}};
  };
  return {appBotId:bot.id,appBotLogin:`${appFact.slug}[bot]`,async readCentralMaintenanceRules(){
    const credential=await token(1296724484,'maintenance-rules');
    try {
      const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
      if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==1296724484)throw Error('MAINTENANCE_RULE_SCOPE');
      const rules=[];
      for(const id of [26678449,26678450]){
        const {data}=await credential.client.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',{
          owner:'splrad',repo:'steward',ruleset_id:id});
        if(data.id!==id||data.source_type!=='Organization'||data.source!=='splrad'||!Array.isArray(data.bypass_actors))
          throw Error('MAINTENANCE_RULE_IDENTITY');
        rules.push(await completeNativeRuleParameters(credential.client,data));
      }
      return rules;
    } finally {await credential.revoke();}
  },async forPagesRepository<T>(repositoryId:number,operation:(token:string)=>Promise<T>):Promise<T>{
    if(!Number.isSafeInteger(repositoryId)||repositoryId<1)throw new Error('PAGES_REPOSITORY_ID');
    const credential=await token(repositoryId,'pages');
    try {
      const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
      if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==repositoryId)throw new Error('PAGES_TOKEN_SCOPE');
      return await operation(credential.token);
    }finally{await credential.revoke();}
  },async forTemplateRepository<T>(repositoryId:number,operation:(writeToken:string,readToken:string)=>Promise<T>,reader:'template-read'|'configuration-read'='template-read'):Promise<T>{
    if(!Number.isSafeInteger(repositoryId)||repositoryId<1)throw new Error('TEMPLATE_REPOSITORY_ID');
    const write=await token(repositoryId,'template');
    try {
      const read=await token(repositoryId,reader);
      try {
        for(const credential of [write,read]) {
          const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
          if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==repositoryId)throw new Error('TEMPLATE_TOKEN_SCOPE');
        }
        return await operation(write.token,read.token);
      }finally{await read.revoke();}
    }finally{await write.revoke();}
  },async forQualityRepository<T>(repositoryId:number,operation:(token:string)=>Promise<T>):Promise<T>{
    if(!Number.isSafeInteger(repositoryId)||repositoryId<1)throw new Error('QUALITY_REPOSITORY_ID');
    const credential=await token(repositoryId,'quality');
    try {
      const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
      if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==repositoryId)throw new Error('QUALITY_TOKEN_SCOPE');
      return await operation(credential.token);
    }finally{await credential.revoke();}
  },async forCandidateReadRepository<T>(repositoryId:number,operation:(readToken:string)=>Promise<T>):Promise<T>{
    if(!Number.isSafeInteger(repositoryId)||repositoryId<1)throw new Error('RELEASE_REPOSITORY_ID');
    const credential=await token(repositoryId,'candidate-read');
    try {
      const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
      if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==repositoryId)throw new Error('RELEASE_TOKEN_SCOPE');
      return await operation(credential.token);
    }catch(error){onFailure(error);throw error;}finally{await credential.revoke();}
  },async forCandidateRepository<T>(repositoryId:number,operation:(writeToken:string,readToken:string)=>Promise<T>):Promise<T>{
    if(!Number.isSafeInteger(repositoryId)||repositoryId<1)throw new Error('RELEASE_REPOSITORY_ID');
    const write=await token(repositoryId,'candidate');
    try {
      const read=await token(repositoryId,'candidate-read');
      try {
        for(const credential of [write,read]) {
          const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
          if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==repositoryId)throw new Error('RELEASE_TOKEN_SCOPE');
        }
        return await operation(write.token,read.token);
      } finally {await read.revoke();}
    } finally {await write.revoke();}
  },async discover({publicCandidatesOnly=false}={}){
    const credential=await token();
    try {
      const repositories: {id:number;full_name:string;default_branch:string;archived:boolean;disabled:boolean;publicCandidate:boolean}[]=[];let total:number|null=null;
      for(let page=1;page<=100;page++) {
        const response=await credential.client.request('GET /installation/repositories',{per_page:100,page});
        if(total!==null && total!==response.data.total_count)throw new Error('RELEASE_INSTALLATION_CHANGED');total=response.data.total_count;
        for(const repo of response.data.repositories) {
          if(!Number.isSafeInteger(Number(repo.id)) || Number(repo.id)<1)throw new Error('RELEASE_REPOSITORY_ID');
          repositories.push({id:Number(repo.id),full_name:repo.full_name,default_branch:repo.default_branch,archived:repo.archived,disabled:repo.disabled??false,
            publicCandidate:repo.owner?.id===302208797&&repo.private===false&&repo.visibility==='public'&&repo.fork===false});
        }
        if(repositories.length===total) {
          if(new Set(repositories.map(repo=>repo.id)).size!==repositories.length)throw new Error('RELEASE_INSTALLATION_DUPLICATE');
          return repositories.filter(repo=>!publicCandidatesOnly||repo.publicCandidate).map(({publicCandidate,...repository})=>repository);
        }
        if(response.data.repositories.length<100)break;
      }
      throw new Error('RELEASE_INSTALLATION_INCOMPLETE');
    }finally {await credential.revoke();}
  },async readPullDelivery(guid:string){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(guid))throw Error('PULL_DELIVERY_GUID');
    for await(const page of app.paginate.iterator('GET /app/hook/deliveries',{per_page:100})){
      const entry=page.data.find(row=>row.guid===guid && row.event==='pull_request' && row.installation_id===installation.id);
      if(!entry)continue;
      const {data}=await app.request('GET /app/hook/deliveries/{delivery_id}',{delivery_id:entry.id});
      const payload=data.request.payload as {action?:string;repository?:{id?:number};installation?:{id?:number}}|null;
      if(data.guid!==guid||data.event!=='pull_request'||data.installation_id!==installation.id||
        data.repository_id!==entry.repository_id||data.action!==entry.action||!entry.repository_id||
        payload?.repository?.id!==entry.repository_id||payload.installation?.id!==installation.id||
        payload.action!==entry.action)throw Error('PULL_DELIVERY_IDENTITY');
      return payload;
    }
    throw Error('PULL_DELIVERY_UNAVAILABLE');
  },async forRepository<T>(repositoryId:number,operation:(token:string)=>Promise<T>,purpose:'release'|'maintenance'|'maintenance-rules'|'configuration-actions'|'configuration-issues'|'registration-read'|'registration-write'|'registry-read'|'registry-projection'|'validator-revalidation'|'release-label'='release'):Promise<T>{
    if(!Number.isSafeInteger(repositoryId)||repositoryId<1)throw new Error('RELEASE_REPOSITORY_ID');
    if(purpose==='maintenance'&&repositoryId!==1296724484)throw new Error('MAINTENANCE_REPOSITORY_ID');
    if((purpose==='registration-read'||purpose==='registration-write'||purpose==='registry-read')&&repositoryId!==1447987054)
      throw new Error('REGISTRATION_ADMIN_REPOSITORY_ID');
    const credential=await token(repositoryId,purpose);
    try {
      const scope=(await credential.client.request('GET /installation/repositories',{per_page:100})).data;
      if(scope.total_count!==1||scope.repositories.length!==1||scope.repositories[0]?.id!==repositoryId)throw new Error('RELEASE_TOKEN_SCOPE');
      return await operation(credential.token);
    }catch(error){onFailure(error);throw error;}finally {await credential.revoke();}
  }};
}
