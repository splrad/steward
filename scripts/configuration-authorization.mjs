import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBotComment} from './configuration-session.mjs';
import {Octokit} from '@octokit/rest';

export const delegatesPath = '.github/configuration-delegates.json';
export const requestPath = '.github/workflows/repository-configuration.yml';
const configurationPaths = new Set([delegatesPath,requestPath,'.github/product-ci.json','.github/delivery.json',
  'release-please-config.json','.github/workflows/steward-release-publish.yml','.github/workflows/steward-release-channels.yml',
  '.github/workflows/pages.yml','.github/workflows/repository-configuration-trial.yml']);
const sha = /^[a-f0-9]{40}$/;

export async function fileText(api,path,ref) {
  const result = await api.rest.repos.getContent({...api.target,path,ref}).catch(error=>{
    if(error.status === 404) return null;
    throw error;
  });
  if (!result) return null;
  const value = result.data;
  if(value.type!=='file' || value.encoding!=='base64') throw Error('Cannot read configuration file '+path);
  return Buffer.from(value.content,'base64').toString('utf8');
}

export async function authorized(api, actor, base, adminOnly=false) {
  if(actor?.type!=='User' || !Number.isSafeInteger(actor.id) || !actor.login) return false;
  const {data} = await api.rest.repos.getCollaboratorPermissionLevel({...api.target,username:actor.login});
  if(data.user?.id !== actor.id) return false;
  if(data.permission==='admin') return true;
  if(adminOnly) return false;
  const bytes = await fileText(api,delegatesPath,base);
  if(!bytes) return false;
  const delegates = JSON.parse(bytes);
  if(!Array.isArray(delegates) || !delegates.every(id=>Number.isSafeInteger(id) && id>0))
    throw Error('Invalid administrator-managed configuration delegate IDs');
  return delegates.includes(actor.id);
}

export async function protectedChanges(api,files,base,head) {
  const paths=files.flatMap(f=>[f.filename,f.previous_filename].filter(Boolean));
  const ciPath='.github/product-ci.json';
  const old=await fileText(api,ciPath,base),next=await fileText(api,ciPath,head);
  const ci=new Set([ciPath,delegatesPath]);
  for(const bytes of [old,next]) {
    if(bytes===null) continue;
    const entries=JSON.parse(bytes);
    if(!Array.isArray(entries)||entries.some(p=>typeof p!=='string'||!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)))
      throw Error('Invalid repository CI workflow declaration');
    for(const path of entries) ci.add(path);
  }
  const adopted=paths.includes(requestPath)||Boolean(await fileText(api,requestPath,base));
  return new Set(paths.filter(path=>ci.has(path) || adopted && (configurationPaths.has(path)||path.startsWith('.github/actions/configuration/'))));
}

export async function authorizePull(api, number, expectedHead, defaultBranch, origin) {
  const {data:pr} = await api.rest.pulls.get({...api.target,pull_number:number});
  if(!sha.test(expectedHead) || pr.head.sha!==expectedHead || pr.state!=='open' || pr.base.ref!==defaultBranch)
    throw Error('Configuration approval must match the current open pull request');
  const files = await api.paginate(api.rest.pulls.listFiles,{...api.target,pull_number:number,per_page:100});
  if(files.length!==pr.changed_files) throw Error('Incomplete pull request file inventory');
  const base = (await api.rest.repos.getBranch({...api.target,branch:defaultBranch})).data.commit.sha;
  const protectedPaths=await protectedChanges(api,files,base,expectedHead);
  if(!protectedPaths.size) return false;
  const paths=[...protectedPaths];
  const adminOnly = paths.includes(delegatesPath) || paths.includes(requestPath) && !await fileText(api,requestPath,base)
    || paths.includes('.github/product-ci.json') && !await fileText(api,'.github/product-ci.json',base);
  if(origin?.number===number && origin.head===expectedHead && await authorized(api,origin.actor,base,adminOnly)) return true;
  const reviews = await api.paginate(api.rest.pulls.listReviews,{...api.target,pull_number:number,per_page:100});
  const decisions = new Map();
  for(const review of reviews) {
    if(['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state) || review.state==='COMMENTED' && review.body?.trim()==='/steward approve-configuration')
      decisions.set(review.user?.id,review);
  }
  for(const review of decisions.values()) {
    if((review.state==='APPROVED' || review.state==='COMMENTED') && review.commit_id===expectedHead && await authorized(api,review.user,base,adminOnly)) return true;
  }
  const comments = await api.paginate(api.rest.issues.listComments,{...api.target,issue_number:number,per_page:100});
  for(const comment of comments) {
    if(comment.user?.id!==301115370 || !comment.body?.startsWith('<!-- steward-config-approval ')) continue;
    const match = /^<!-- steward-config-approval ([a-f0-9]{40}) ([1-9][0-9]*) -->$/.exec((await readBotComment(api,comment))?.trim()??'');
    if(!match || match[1]!==expectedHead) continue;
    const actor=(await api.request('GET /user/{account_id}',{account_id:Number(match[2])})).data;
    if(await authorized(api,actor,base,adminOnly)) return true;
  }
  throw Error('Configuration approval is required for '+expectedHead);
}

export async function checkEvent(api,event) {
  if(event.pull_request) {
    const pr=event.pull_request;
    const currentActor=event.action==='opened' && pr.user.id===event.sender?.id || event.action==='synchronize' && event.after===pr.head.sha;
    const origin=currentActor?{number:pr.number,head:pr.head.sha,actor:event.sender}:undefined;
    return authorizePull(api,pr.number,pr.head.sha,event.repository.default_branch,origin);
  }
  if(!event.merge_group) return;
  const group=event.merge_group;
  const compare=(await api.rest.repos.compareCommitsWithBasehead({...api.target,basehead:group.base_sha+'...'+group.head_sha})).data;
  if(compare.files?.length>=300 || compare.commits.length!==compare.total_commits) throw Error('Incomplete merge group comparison');
  if(!Array.isArray(compare.files)) throw Error('Missing merge group diff');
  const protectedPaths=await protectedChanges(api,compare.files,group.base_sha,group.head_sha);
  if(!protectedPaths.size) return;
  const prs = new Map();
  for(const commit of compare.commits) {
    const associated=await api.paginate(api.rest.repos.listPullRequestsAssociatedWithCommit,{...api.target,commit_sha:commit.sha,per_page:100});
    for(const pr of associated.filter(p=>p.state==='open' && p.base.ref===event.repository.default_branch)) prs.set(pr.number,pr);
  }
  if(!prs.size) throw Error('Missing merge group pull requests');
  const covered=new Set();
  for(const pr of prs.values()) {
    if(!await authorizePull(api,pr.number,pr.head.sha,event.repository.default_branch)) continue;
    const files=await api.paginate(api.rest.pulls.listFiles,{...api.target,pull_number:pr.number,per_page:100});
    for(const change of compare.files) {
      if(files.some(f=>f.filename===change.filename && f.sha===change.sha && f.status===change.status
        && f.previous_filename===change.previous_filename)) {
        covered.add(change.filename);
        if(change.previous_filename) covered.add(change.previous_filename);
      }
    }
  }
  if([...protectedPaths].some(path=>!covered.has(path))) throw Error('Merge group contains configuration bytes without exact pull approval');
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const api=new Octokit({auth:process.env.GH_TOKEN});
  api.target={owner:event.repository.owner.login,repo:event.repository.name};
  await checkEvent(api,event);
}
