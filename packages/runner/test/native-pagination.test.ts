import type { PipelineSource } from '../src/release-pipeline-record.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import { nativePages, pipelineProducers } from '../src/release-pipeline.js';
const path = 'repos/example/product/actions/runs/42/artifacts?per_page=100';
afterEach(() => vi.unstubAllEnvs());

function client(pages: unknown[], options: { failPage?: number; next?: string } = {}) {
  const calls: string[] = [];
  const octokit = new Octokit({ auth: 'fixture-target', request: { fetch: async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    const index = calls.length - 1;
    if (options.failPage === index) throw new Error('fixture later page unavailable');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (index + 1 < pages.length) headers.link = `<${options.next ?? `https://api.github.com/${path}&page=${index + 2}`}>; rel="next"`;
    const response = new Response(JSON.stringify(pages[index]), { headers, status: 200 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  return { octokit, calls };
}

it('reads all native pages beyond the former 16 MiB aggregate stdout limit', async () => {
  const payload = 'x'.repeat(9 * 1024 * 1024);
  const f = client([{ total_count: 2, artifacts: [{ id: 1, payload }] }, { total_count: 2, artifacts: [{ id: 2, payload }] }]);
  const rows = await nativePages(path, 'artifacts', f.octokit);
  expect(rows.map(row => row.id)).toEqual([1, 2]);
  expect(rows.reduce((length, row) => length + row.payload.length, 0)).toBeGreaterThan(16 * 1024 * 1024);
  expect(f.calls).toHaveLength(2);
});

it.each(['duplicate', 'count-drift', 'partial', 'invalid-id', 'incomplete', 'wrong-collection', 'later-failure', 'foreign-link'])('rejects %s instead of accepting partial evidence', async kind => {
  const pages: any[] = [{ total_count: 2, artifacts: [{ id: 1 }] }, { total_count: 2, artifacts: [{ id: 2 }] }];
  if (kind === 'duplicate') pages[1].artifacts[0].id = 1;
  if (kind === 'count-drift') pages[1].total_count++;
  if (kind === 'partial') pages.pop();
  if (kind === 'invalid-id') pages[1].artifacts[0].id = 0;
  if (kind === 'incomplete') pages[1].incomplete_results = true;
  if (kind === 'wrong-collection') pages[1] = { total_count: 2, jobs: [{ id: 2 }] };
  const f = client(pages, kind === 'later-failure' ? { failPage: 1 } : kind === 'foreign-link' ? { next: 'https://other.invalid/leak' } : {});
  await expect(nativePages(path, 'artifacts', f.octokit)).rejects.toThrow();
  if (kind === 'foreign-link') expect(f.calls).toHaveLength(1);
});

it('accepts a positively observed empty collection and rejects an absent explicit credential', async () => {
  expect(await nativePages(path, 'artifacts', client([{ total_count: 0, artifacts: [] }]).octokit)).toEqual([]);
  vi.stubEnv('GH_TOKEN', ''); vi.stubEnv('GITHUB_TOKEN', 'sentinel-other');
  await expect(nativePages(path, 'artifacts')).rejects.toThrow('pagination credential');
});

it('rejects a run attempt change observed after the complete page traversal', async () => {
  const record: PipelineSource = { fullName: 'example/product', repositoryId: 1, runId: 42, attempt: 1, sourceSha: 'a'.repeat(40),
    controllerSha: 'b'.repeat(40), ref: 'refs/heads/steward/build/cycle', event: 'workflow_dispatch', inspectJob: 'inspect', toolLocks: { mise: 'c'.repeat(64) },
    unit: { id: 'app', version: '1.2.3', packageVersion: '1.2.3', tag: 'app/v1.2.3', deliverySha256: 'd'.repeat(64), templateSha256: 'e'.repeat(64),
      builds: [{ id: 'windows', jobName: 'build-windows', expectedArtifacts: ['app'] }], assets: [{ id: 'app', name: 'app.exe', build: 'windows' }] } };
  let reads = 0;
  const gh = async () => JSON.stringify({ id: 42, repository: { id: 1 }, head_repository: { id: 1 }, head_sha: record.sourceSha,
    event: 'workflow_dispatch', run_attempt: ++reads });
  await expect(pipelineProducers(record, gh, async () => [])).rejects.toThrow('run changed during pagination');
  expect(reads).toBe(2);
});

function numericClient(collection:'jobs'|'artifacts',options:{next?:(url:string)=>string;metadata?:{id:number;full_name:string}}={}) {
 const calls:string[]=[],repository='splrad/LayerScape',repositoryId=1187527897;
 const suffix=collection==='jobs'?'actions/runs/43423990877/attempts/1/jobs':'actions/runs/43423990877/artifacts';
 const named=`repos/${repository}/${suffix}?per_page=100`;
 const next=options.next?.(`https://api.github.com/repositories/${repositoryId}/${suffix}?per_page=100&page=2`)
  ??`https://api.github.com/repositories/${repositoryId}/${suffix}?per_page=100&page=2`;
 const octokit=new Octokit({auth:'fixture-target',request:{fetch:async(input:any,init:any)=>{
  const url=new URL(String(input));calls.push(url.href);
  expect(new Headers(init?.headers).get('authorization')).toBe('token fixture-target');
  let body:any,headers:Record<string,string>={'content-type':'application/json'};
  if(url.pathname===`/repos/${repository}`)body=options.metadata??{id:repositoryId,full_name:repository};
  else {
   expect(url.pathname).toBe(`/repos/${repository}/${suffix}`);
   const second=url.searchParams.get('page')==='2';body={total_count:101,[collection]:second?[{id:101}]:Array.from({length:100},(_,i)=>({id:i+1}))};
   if(!second)headers.link=`<${next}>; rel="next"`;
  }
  const response=Response.json(body,{headers});Object.defineProperty(response,'url',{value:url.href});return response;
 }},log:{debug(){},info(){},warn(){},error(){}}});
 return {octokit,calls,named};
}
it.each(['jobs','artifacts'] as const)('follows the verified native Actions numeric alias for %s beyond 100 items',async collection=>{
 const f=numericClient(collection),rows=await nativePages(f.named,collection,f.octokit);
 expect(rows).toHaveLength(101);expect(rows.at(-1)).toEqual({id:101});expect(new Set(rows.map(r=>r.id)).size).toBe(101);
 expect(f.calls).toEqual([`https://api.github.com/${f.named}`,'https://api.github.com/repos/splrad/LayerScape',`https://api.github.com/${f.named}&page=2`]);
});
it.each([
 (u:string)=>u.replace('/1187527897/','/9/'),(u:string)=>u.replace('/attempts/1/jobs','/attempts/2/jobs'),
 (u:string)=>u.replace('api.github.com','example.com'),(u:string)=>u.replace('https://','https://user@'),
 (u:string)=>u+'#fragment',(u:string)=>u.replace('per_page=100','per_page=1'),(u:string)=>u+'&extra=1',
 (u:string)=>u+'&per_page=1',
])('rejects altered Actions numeric links before reading another page',async next=>{
 const f=numericClient('jobs',{next});await expect(nativePages(f.named,'jobs',f.octokit)).rejects.toThrow('RELEASE_PIPELINE: pagination');
 expect(f.calls.filter(u=>u.includes('page=2'))).toHaveLength(0);
});
it.each([{id:9,full_name:'splrad/LayerScape'},{id:1187527897,full_name:'other/repository'},{id:0,full_name:'splrad/LayerScape'}])('rejects unverified Actions repository identity %j',async metadata=>{
 const f=numericClient('jobs',{metadata});await expect(nativePages(f.named,'jobs',f.octokit)).rejects.toThrow('pagination repository identity');expect(f.calls).toHaveLength(2);
});
