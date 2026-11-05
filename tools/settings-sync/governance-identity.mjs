import {createAppAuth} from '@octokit/auth-app';
import {Octokit} from '@octokit/rest';

/** App facts use App authentication; the public bot endpoint has no installation context. */
export async function settingsGovernanceIdentity(appId,privateKey,transport=fetch){
  const log={debug(){},info(){},warn(){},error(){}};
  const nativeTransport=(input,init)=>{
    const headers=new Headers(init?.headers);headers.set('X-GitHub-Api-Version','2026-03-10');
    return transport(input,{...init,headers});
  };
  const app=new Octokit({authStrategy:createAppAuth,auth:{appId,privateKey},log,request:{fetch:nativeTransport}});
  const fact=(await app.request('GET /app')).data,installation=(await app.request('GET /orgs/splrad/installation')).data;
  if(fact.id!==appId||installation.app_id!==appId||installation.account?.id!==302208797||installation.suspended_at)throw Error('SETTINGS_APP_IDENTITY');
  const bot=(await new Octokit({log,request:{fetch:nativeTransport}}).request('GET /users/{username}',{username:fact.slug+'[bot]'})).data;
  if(bot.type!=='Bot'||!Number.isSafeInteger(bot.id)||bot.id<=0||bot.login!==fact.slug+'[bot]')throw Error('SETTINGS_BOT_IDENTITY');
  return {app,installation,identity:{name:bot.login,email:`${bot.id}+${bot.login}@users.noreply.github.com`}};
}
