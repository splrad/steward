import {createHash} from 'node:crypto';
import {decodeRepositoryPolicyProjection,repositoryPolicyDigest,repositoryPolicyPath,repositoryPolicyBranch} from '../packages/runner/dist/index.js';

const ref='refs/heads/'+repositoryPolicyBranch;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const check=(condition,code='UNAVAILABLE')=>{if(!condition)throw Error('REPOSITORY_POLICY_PROJECTION_'+code);};

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
  if(!commit)return null;
  const entry=async(treeSha,name)=>{
    const tree=await reader.json('git/trees/'+treeSha);
    check(tree.truncated===false&&Array.isArray(tree.tree));
    const matches=tree.tree.filter(row=>row.path===name);
    check(matches.length<=1);
    return matches[0];
  };
  const directory=await entry(commit,'configuration');
  if(!directory)return null;
  check(directory.mode==='040000'&&directory.type==='tree'&&sha(directory.sha));
  const blob=await entry(directory.sha,'repository.json');
  if(!blob)return null;
  check(blob.mode==='100644'&&blob.type==='blob'&&sha(blob.sha));
  const rules=await reader.json('rules/branches/'+encodeURIComponent(repositoryPolicyBranch)+'?per_page=100');
  check(Array.isArray(rules),'PROTECTION');
  for(const [type,id] of [['creation',26678448],['update',26678448],['non_fast_forward',26678449],['deletion',26678449]])
    check(rules.some(rule=>rule.type===type&&rule.ruleset_id===id),'PROTECTION');
  const file=await reader.json('contents/'+repositoryPolicyPath+'?ref='+commit);
  check(file.path===repositoryPolicyPath&&file.type==='file'&&file.encoding==='base64'&&file.sha===blob.sha);
  const bytes=Buffer.from(file.content,'base64');
  check(bytes.length===file.size&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===blob.sha);
  const value=decodeRepositoryPolicyProjection(bytes,repositoryId);
  check(await head()===commit,'MOVED');
  return value;
}
