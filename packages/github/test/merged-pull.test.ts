import {expect,it,vi} from 'vitest';
import {completeMergedPull} from '../src/merged-pull.js';
import {GitHubClient} from '../src/client.js';
import {NativeEvidenceReader} from '../../runner/src/native-release-evidence.js';

const repo='splrad/fixture',root=`https://api.github.com/repos/${repo}`,sha='a'.repeat(40);
const pull=()=>({number:7,url:`${root}/pulls/7`,base:{repo:{id:42,full_name:repo}},state:'closed',merged:true,merged_at:'2026-11-01T01:38:24Z'});
const event=()=>({id:91,event:'merged',url:`${root}/issues/events/91`,commit_id:sha,commit_url:`${root}/commits/${sha}`,actor:{id:8},created_at:'2026-11-01T01:38:25Z'});
it('projects the exact native merge event without changing the raw PR or equating rounded timestamps',async()=>{
  const raw=pull(),value=await completeMergedPull(repo,7,raw,async()=>[event()]);
  expect(value.merge_commit_sha).toBe(sha);expect(value.merge_commit_evidence).toMatchObject({id:91,source:`${root}/issues/7/events`});
  expect(raw).not.toHaveProperty('merge_commit_sha');
});
it.each(['missing','duplicate','duplicate-id','foreign-commit','foreign-event','invalid-sha','invalid-actor','invalid-time','wrong-pr','wrong-repo','contradictory-state','bad-legacy'])('rejects unusable merged evidence: %s',async kind=>{
  const raw:any=pull(),events:any[]=[event()];
  if(kind==='missing')events.length=0;
  if(kind==='duplicate')events.push({...event(),id:92,url:`${root}/issues/events/92`});
  if(kind==='duplicate-id')events.push(event());
  if(kind==='foreign-commit')events[0].commit_url=events[0].commit_url.replace('fixture','other');
  if(kind==='foreign-event')events[0].url=events[0].url.replace('fixture','other');
  if(kind==='invalid-sha')events[0].commit_id='HEAD';
  if(kind==='invalid-actor')events[0].actor.id=0;
  if(kind==='invalid-time')events[0].created_at='unknown';
  if(kind==='wrong-pr')raw.number=8;
  if(kind==='wrong-repo')raw.base.repo.full_name='splrad/other';
  if(kind==='contradictory-state')raw.merged=false;
  if(kind==='bad-legacy')raw.merge_commit_sha=null;
  await expect(completeMergedPull(repo,7,raw,async()=>events)).rejects.toThrow('MERGED_PULL_EVIDENCE');
});
it('preserves unmerged and historical native responses and propagates unreadable event history',async()=>{
  const read=vi.fn(),open={number:7,merged:false,merged_at:null,merge_commit_sha:'b'.repeat(40)},old={...pull(),merge_commit_sha:sha};
  expect(await completeMergedPull(repo,7,open,read)).toBe(open);expect(await completeMergedPull(repo,7,old,read)).toBe(old);expect(read).not.toHaveBeenCalled();
  await expect(completeMergedPull(repo,7,pull(),async()=>{throw Error('HTTP_403');})).rejects.toThrow('HTTP_403');
});
it.each(['client-pull','client-association','evidence-reader'])('reads every event page through %s',async kind=>{
  const reads:string[]=[];
  const transport=async(input:any)=>{
    const url=new URL(String(input));reads.push(url.pathname+url.search);
    const events=url.pathname.endsWith('/events'),last=url.searchParams.get('page')==='2';
    const value=events?(last?[event()]:[{id:90,event:'closed'}]):kind==='client-association'?[pull()]:pull();
    const response=Response.json(value,{headers:events&&!last?{link:`<${root}/issues/7/events?per_page=100&page=2>; rel="next"`}:{}});
    Object.defineProperty(response,'url',{value:url.href});return response;
  };
  const client=new GitHubClient('fixture','https://api.github.com',transport as any);
  const reader=new NativeEvidenceReader({async request(_method,path){const response=await transport(`https://api.github.com${path}`);return {status:response.status,headers:response.headers,bytes:new Uint8Array(await response.arrayBuffer())};}},repo);
  const value=kind==='client-pull'?await client.getPullRequest('splrad','fixture',7):kind==='client-association'?(await client.listPullsForCommit('splrad','fixture',sha))[0]:await reader.json('pulls/7');
  expect(value.merge_commit_sha).toBe(sha);expect(reads.filter(path=>path.includes('/events'))).toHaveLength(2);
});
