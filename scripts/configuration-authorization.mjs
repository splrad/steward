import YAML from 'yaml';
import {readFile} from 'node:fs/promises';
import {posix,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBotComment} from './configuration-session.mjs';
import {Octokit} from '@octokit/rest';

export const delegatesPath = '.github/configuration-delegates.json';
export const requestPath = '.github/workflows/repository-configuration.yml';
const configurationPaths = new Set([delegatesPath,requestPath,'.github/product-ci.json','.github/delivery.json',
  '.github/repository-configuration.md','.release-please-manifest.json','release-please-config.json','.github/workflows/steward-release-publish.yml','.github/workflows/steward-release-channels.yml',
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

export async function configurationAccess(api,base) {
  const bytes=await fileText(api,delegatesPath,base);
  const value=bytes===null?[]:JSON.parse(bytes);
  const policy=Array.isArray(value)?{delegates:value,requestAccess:'administrators'}:value;
  if(!policy || !Array.isArray(policy.delegates) || !policy.delegates.every(id=>Number.isSafeInteger(id) && id>0) ||
     !['administrators','public'].includes(policy.requestAccess) || Object.keys(policy).some(k=>!['delegates','requestAccess'].includes(k)))
    throw Error('Invalid administrator-managed configuration access');
  return policy;
}

export async function authorized(api, actor, base, adminOnly=false) {
  if(actor?.type!=='User' || !Number.isSafeInteger(actor.id) || !actor.login) return false;
  const {data} = await api.rest.repos.getCollaboratorPermissionLevel({...api.target,username:actor.login});
  if(data.user?.id !== actor.id) return false;
  if(data.permission==='admin') return true;
  if(adminOnly) return false;
  const {delegates}=await configurationAccess(api,base);
  return delegates.includes(actor.id);
}

const workflowPath=/^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const receiver='.github/workflows/repository-configuration-event.yml';
const central=api=>api.target.owner==='splrad' && api.target.repo==='steward';

// Walk immutable native directory trees. Missing paths share the same cached directory lookup.
function revisionReader(api,ref) {
  const trees=new Map(),contents=new Map();
  async function directory(oid) {
    if(!trees.has(oid)) {
      const {data}=await api.rest.git.getTree({...api.target,tree_sha:oid});
      if(data.truncated || !Array.isArray(data.tree))throw Error('Incomplete configuration directory');
      trees.set(oid,new Map(data.tree.map(entry=>[entry.path,entry])));
    }
    return trees.get(oid);
  }
  return async path=>{
    let entry={type:'tree',sha:ref};
    for(const part of path.split('/')) {
      if(entry?.type!=='tree')return null;
      entry=(await directory(entry.sha)).get(part);
    }
    if(!entry)return null;
    if(entry.type!=='blob' || !['100644','100755'].includes(entry.mode))throw Error('Invalid configuration file '+path);
    if(!contents.has(entry.sha)) {
      const bytes=await fileText(api,path,ref);
      if(bytes===null)throw Error('Missing indexed configuration file '+path);
      contents.set(entry.sha,bytes);
    }
    return contents.get(entry.sha);
  };
}

async function referencedFiles(api,roots,ref,changed) {
  const seen=new Set(roots),actions=new Map(),read=revisionReader(api,ref);
  const addAction=(uses,mounts)=>{
    if(typeof uses!=='string' || !uses.startsWith('./'))return;
    let directory=posix.normalize(uses).replace(/\/$/,'');
    const mount=mounts.find(m=>directory===m.path || directory.startsWith(m.path+'/'));
    if(mount && !mount.local)return;
    if(mount) directory=directory.slice(mount.path.length).replace(/^\//,'');
    if(directory==='..' || directory.startsWith('../'))throw Error('Local action outside repository');
    directory=directory||'.';
    actions.set(JSON.stringify([directory,mounts]),{directory,mounts});
  };
  for(const path of seen) {
    const bytes=await read(path);
    if(!bytes)continue;
    const jobs=YAML.parse(bytes)?.jobs??{};
    for(const job of Object.values(jobs)) {
      if(job?.uses?.startsWith('./') && workflowPath.test(job.uses.slice(2)))seen.add(job.uses.slice(2));
      const mounts=[];
      for(const step of job?.steps??[]) {
        if(/^actions\/checkout@/.test(step.uses??'') && typeof step.with?.path==='string') {
          const path=posix.normalize(step.with.path).replace(/\/$/,'');
          const repository=step.with.repository;
          mounts.push({path,local:!repository || repository==='${{ github.repository }}' || repository===api.target.owner+'/'+api.target.repo});
          mounts.sort((a,b)=>b.path.length-a.path.length);
        }
        addAction(step.uses,[...mounts]);
        if(step.run!=='node scripts/configuration-native-artifact.mjs' ||
          !['controller','configuration-controller'].includes(step['working-directory']))continue;
        const producer=JSON.parse(Buffer.from(step.env.PRODUCER,'base64url'));
        if(!workflowPath.test(producer.workflow))throw Error('Invalid formal product workflow reference');
        seen.add(producer.workflow);
      }
    }
  }
  for(const {directory,mounts} of actions.values()) {
    if(directory!=='.')for(const path of changed)if(path.startsWith(directory+'/'))seen.add(path);
    for(const filename of ['action.yml','action.yaml']) {
      const path=posix.join(directory,filename);
      seen.add(path);
      const bytes=await read(path);
      if(!bytes)continue;
      const runs=YAML.parse(bytes)?.runs??{};
      for(const file of [runs.main,runs.pre,runs.post,runs.image]) {
        if(typeof file!=='string' || file.startsWith('docker://'))continue;
        const entry=posix.join(directory,file);
        if(entry.startsWith('../') || entry==='..')throw Error('Local action entry outside repository');
        seen.add(entry);
      }
      for(const step of runs.steps??[])addAction(step.uses,mounts);
    }
  }
  return seen;
}

export async function protectedChanges(api,files,base,head,decisionOnly=false) {
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
  if(central(api))ci.add(receiver);
  const matches=()=>new Set(paths.filter(path=>ci.has(path) || adopted && (configurationPaths.has(path)||path.startsWith('.github/actions/configuration/'))));
  for(const [ref,bytes] of [[base,old],[head,next]]) {
      // The complete PR diff already establishes the authorization requirement. The manifest alone has a separate exception.
      if(decisionOnly) {
        const known=matches();
        if([...known].some(path=>path!==manifestPath))return known;
      }
      const roots=bytes?JSON.parse(bytes):[];
      if(adopted)roots.push('.github/workflows/steward-release-publish.yml','.github/workflows/steward-release-channels.yml','.github/workflows/pages.yml');
      if(central(api))roots.push(receiver);
      for(const path of await referencedFiles(api,roots,ref,paths)) ci.add(path);
  }
  return matches();
}

const manifestPath='.release-please-manifest.json';

async function generatedCandidateManifest(api,pr,base,head) {
  if(pr.head.repo?.id!==pr.base.repo?.id || !pr.base.repo?.id || pr.user?.id!==301115370) return false;
  const stateHead=(await api.rest.git.getRef({...api.target,ref:'heads/steward/release-state'}).catch(error=>{
    if(error.status===404) return {data:null};
    throw error;
  })).data?.object?.sha;
  if(!sha.test(stateHead)) return false;
  const state=JSON.parse(await fileText(api,'state.json',stateHead));
  const candidate=state?.candidate;
  if(state?.repositoryId!==pr.base.repo.id || candidate?.prNumber!==pr.number || candidate.branch!==pr.head.ref ||
    !sha.test(candidate.publishedHead) || !candidate.generatedSnapshotPath || candidate.pendingWrite) return false;
  const [prior,generated,current]=await Promise.all([base,candidate.publishedHead,head].map(ref=>fileText(api,manifestPath,ref)));
  if(!prior || !current || generated!==current) return false;
  return JSON.stringify(Object.keys(JSON.parse(prior)).sort())===JSON.stringify(Object.keys(JSON.parse(current)).sort());
}

export async function authorizePull(api, number, expectedHead, defaultBranch, origin) {
  const {data:pr} = await api.rest.pulls.get({...api.target,pull_number:number});
  if(!sha.test(expectedHead) || pr.head.sha!==expectedHead || pr.state!=='open' || !pr.base.ref)
    throw Error('Configuration approval must match the current open pull request');
  const files = await api.paginate(api.rest.pulls.listFiles,{...api.target,pull_number:number,per_page:100});
  if(files.length!==pr.changed_files) throw Error('Incomplete pull request file inventory');
  const base = (await api.rest.repos.getBranch({...api.target,branch:defaultBranch})).data.commit.sha;
  const comparisonBase=pr.base.ref===defaultBranch?base:pr.base.sha;
  if(!sha.test(comparisonBase)) throw Error('Missing native pull request base commit');
  const protectedPaths=await protectedChanges(api,files,comparisonBase,expectedHead,true);
  if(!protectedPaths.size) return false;
  if(pr.base.ref===defaultBranch && protectedPaths.has(manifestPath) && await generatedCandidateManifest(api,pr,base,expectedHead)) {
    protectedPaths.delete(manifestPath);
    if(!protectedPaths.size) return true;
  }
  const paths=[...protectedPaths];
  const adminOnly = central(api) && paths.includes(receiver) || paths.includes(delegatesPath) || paths.includes(requestPath) && !await fileText(api,requestPath,base)
    || paths.includes('.github/product-ci.json') && !await fileText(api,'.github/product-ci.json',base);
  if(origin?.number===number && origin.head===expectedHead && await authorized(api,origin.actor,base,adminOnly)) return true;
  const reviews = await api.paginate(api.rest.pulls.listReviews,{...api.target,pull_number:number,per_page:100});
  const decisions = new Map();
  for(const review of reviews) {
    if(['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state) || review.state==='COMMENTED' && review.body?.trim()==='/steward approve-configuration')
      decisions.set(review.user?.id,review);
  }
  for(const review of decisions.values()) {
    if(review.state==='COMMENTED') {
      const {node}=await api.graphql('query($id:ID!){node(id:$id){... on PullRequestReview{body lastEditedAt editor{login} author{login}}}}',{id:review.node_id});
      if(node?.author?.login!==review.user?.login || node.body.trim()!=='/steward approve-configuration' ||
        node.lastEditedAt && node.editor?.login!==node.author.login) continue;
    }
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
  throw Object.assign(Error('Configuration approval is required for '+expectedHead),{code:'CONFIGURATION_APPROVAL_REQUIRED'});
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
