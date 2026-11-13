import {expect,it} from 'vitest';
import {NativeEvidenceReader} from '../src/native-release-evidence.js';
// @ts-expect-error JavaScript transport helper.
import {adoptionTransport} from '../../../scripts/release-state-initialize.mjs';
// @ts-expect-error JavaScript diagnostic helper.
import {initializationDiagnostics} from '../../../scripts/initialization-diagnostics.mjs';
const repo='splrad/LayerScape',id=1187527897;
const query='state=closed&sort=created&direction=asc&per_page=100';
const path='/repos/'+repo+'/pulls';
const canonical=`https://api.github.com/repositories/${id}/pulls?${query}&page=2`;
function fixture(next=canonical,identity={id,full_name:repo},duplicate=false) {
 const calls:Array<{path:string;authorization:string|null}>=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push({path:url.pathname+url.search,authorization:new Headers(init?.headers).get('authorization')});
  if(url.pathname==='/repos/'+repo)return Response.json(identity);
  expect(url.pathname).toBe(path);
  const second=url.searchParams.get('page')==='2';
  return Response.json(second?[{id:duplicate?1:101}]:Array.from({length:100},(_,i)=>({id:i+1})),{headers:second?{}:{link:`<${next}>; rel="next"`}});
 };
 const io=adoptionTransport({repository:{full_name:repo}},{token:'write-fixture',readToken:'read-fixture',fetcher});
 return {reader:new NativeEvidenceReader(io,repo),calls};
}
it('follows actual GitHub numeric repository aliases past 100 PRs while preserving read credential routing',async()=>{
 const f=fixture();const result=await f.reader.pages('pulls?state=closed&sort=created&direction=asc','');
 expect(result).toHaveLength(101);expect(result.at(-1)).toEqual({id:101});
 expect(f.calls.map(x=>x.path)).toEqual([`${path}?${query}`,'/repos/'+repo,`${path}?${query}&page=2`]);
 expect(f.calls.map(x=>x.authorization)).toEqual(['Bearer read-fixture','Bearer write-fixture','Bearer read-fixture']);
});
it('keeps ordinary same-path pagination without adding a metadata lookup',async()=>{
 const f=fixture(`https://api.github.com${path}?${query}&page=2`);expect(await f.reader.pages('pulls?state=closed&sort=created&direction=asc','')).toHaveLength(101);expect(f.calls).toHaveLength(2);
});
it.each([
 canonical.replace('/1187527897/','/9/'),canonical.replace('/pulls?','/issues?'),canonical.replace('api.github.com','example.com'),
 canonical.replace('https://','https://user@'),canonical+'#fragment',canonical.replace('state=closed','state=open'),canonical+'&extra=1',canonical+'&state=open',
])('rejects an unrelated or altered pagination link %s',async next=>{
 const f=fixture(next);await expect(f.reader.pages('pulls?state=closed&sort=created&direction=asc','')).rejects.toThrow('NATIVE_EVIDENCE: pagination');
 expect(f.calls.filter(x=>x.path.includes('page=2'))).toHaveLength(0);
});
it.each([{id:9,full_name:repo},{id,full_name:'other/repository'},{id:0,full_name:repo}])('rejects unverified repository identity %j',async identity=>{
 const f=fixture(canonical,identity);await expect(f.reader.pages('pulls?state=closed&sort=created&direction=asc','')).rejects.toThrow('pagination repository identity');expect(f.calls).toHaveLength(2);
});
it('retains duplicate-item completeness checks across canonical pages',async()=>{
 const f=fixture(canonical,undefined,true);await expect(f.reader.pages('pulls?state=closed&sort=created&direction=asc','')).rejects.toThrow('incomplete pagination');
});
it('maps only exact local pagination assertions to safe initializer codes',()=>{
 const d=initializationDiagnostics();d.stage('adoption-reconcile');expect(d.failure(new Error('NATIVE_EVIDENCE: pagination origin')).failureCode).toBe('PAGINATION_01');
 expect(d.failure(new Error('NATIVE_EVIDENCE: pagination origin PRIVATE_URL')).failureCode).toBeNull();
});
