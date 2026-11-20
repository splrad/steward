import {createHash} from 'node:crypto';
import {decodeRepositoryPolicyProjection,repositoryPolicyDigest,repositoryPolicyPath,repositoryPolicyBranch} from '../packages/runner/dist/index.js';

const ref='refs/heads/'+repositoryPolicyBranch;
export const repositoryPolicyAdoptionPath='.github/steward-central-policy';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const check=(condition,code='UNAVAILABLE')=>{if(!condition)throw Error('REPOSITORY_POLICY_PROJECTION_'+code);};

export function assertCentralProjection(projection,required) {
  check(!required||projection?.adoption==='central','REQUIRED');
}

export function assertRepositoryPolicyMarker(bytes) {
  const body=bytes.toString('utf8');
  check(body==='central\n'||body==='central\r\n','ADOPTION');
}

async function treeEntry(reader,treeSha,name) {
  const tree=await reader.json('git/trees/'+treeSha);
  check(tree.truncated===false&&Array.isArray(tree.tree));
  const matches=tree.tree.filter(row=>row.path===name);
  check(matches.length<=1);
  return matches[0];
}

async function verifiedFile(reader,path,commit,blob) {
  check(blob.mode==='100644'&&blob.type==='blob'&&sha(blob.sha));
  const file=await reader.json('contents/'+path+'?ref='+commit);
  check(file.path===path&&file.type==='file'&&file.encoding==='base64'&&file.sha===blob.sha);
  const bytes=Buffer.from(file.content,'base64');
  check(bytes.length===file.size&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===blob.sha);
  return bytes;
}

export async function readRequiredRepositoryProjection(reader,repositoryId) {
  const repo=await reader.json('');
  check(repo.id===repositoryId&&repo.full_name===reader.repository&&typeof repo.default_branch==='string'&&repo.default_branch);
  const branch=async()=>{
    const result=await reader.json('branches/'+encodeURIComponent(repo.default_branch));
    check(result.name===repo.default_branch&&result.protected===true&&sha(result.commit?.sha),'DEFAULT_BRANCH');
    return result.commit.sha;
  };
  const initial=await branch();
  const directory=await treeEntry(reader,initial,'.github');
  let required=false;
  if(directory) {
    check(directory.mode==='040000'&&directory.type==='tree'&&sha(directory.sha));
    const blob=await treeEntry(reader,directory.sha,'steward-central-policy');
    if(blob) {
      assertRepositoryPolicyMarker(await verifiedFile(reader,repositoryPolicyAdoptionPath,initial,blob));
      required=true;
    }
  }
  check(await branch()===initial,'MOVED');
  return required;
}

// No repository names, private repository positions, channels or comments enter product state.
export function projectionBytes(policy) {
  const selected={schemaVersion:1,repositoryId:policy.repositoryId,adoption:policy.adoption??'legacy',
    productCi:policy.productCi,site:policy.site};
  const content=JSON.stringify({...selected,sourceDigest:repositoryPolicyDigest(selected)},null,2)+'\n';
  decodeRepositoryPolicyProjection(Buffer.from(content),policy.repositoryId);
  return content;
}

export async function readRepositoryProjection(reader, repositoryId) {
  const head=async () => {
    const response=await reader.io.request('GET',reader.path('git/ref/heads/'+repositoryPolicyBranch));
    if(response.status===404) {
      const matches=await reader.json('git/matching-refs/heads/'+repositoryPolicyBranch);
      check(Array.isArray(matches)&&!matches.some(row=>row.ref===ref));
      return null;
    }
    check(response.status===200);
    const fact=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
    check(fact.ref===ref&&fact.object?.type==='commit'&&sha(fact.object.sha));
    return fact.object.sha;
  };
  const commit=await head();
  const absent=async()=>{
    check(await head()===commit,'MOVED');
    return null;
  };
  if(!commit)return absent();
  const directory=await treeEntry(reader,commit,'configuration');
  if(!directory)return absent();
  check(directory.mode==='040000'&&directory.type==='tree'&&sha(directory.sha));
  const blob=await treeEntry(reader,directory.sha,'repository.json');
  if(!blob)return absent();
  check(blob.mode==='100644'&&blob.type==='blob'&&sha(blob.sha));
  const rules=await reader.json('rules/branches/'+encodeURIComponent(repositoryPolicyBranch)+'?per_page=100');
  check(Array.isArray(rules),'PROTECTION');
  for(const [type,id] of [['creation',26678448],['update',26678448],['non_fast_forward',26678449],['deletion',26678449]])
    check(rules.some(rule=>rule.type===type&&rule.ruleset_id===id),'PROTECTION');
  const bytes=await verifiedFile(reader,repositoryPolicyPath,commit,blob);
  const value=decodeRepositoryPolicyProjection(bytes,repositoryId);
  check(await head()===commit,'MOVED');
  return value;
}
