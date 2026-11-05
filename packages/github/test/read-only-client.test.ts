import {expect,it,vi} from 'vitest';
import {GitHubClient} from '../src/client.js';
function response(url:string,value:unknown,headers:Record<string,string>={}){const result=Response.json(value,{headers});Object.defineProperty(result,'url',{value:url});return result;}
it.each(['POST','PUT','PATCH','DELETE'])('cannot issue %s through retained read adapter',async method=>{
  const transport=vi.fn(),client=new GitHubClient('fixture','https://api.github.com',transport);
  await expect(client.request(method,'/repos/splrad/fixture')).rejects.toThrow('READ_ONLY');expect(transport).not.toHaveBeenCalled();
});
it.each(['https://evil.invalid/data','https://api.github.com@evil.invalid/data','https://api.github.com/data#fragment'])('rejects foreign next link or ambiguous URL before credential forwarding: %s',async next=>{
  const calls:string[]=[],transport=async(url:any)=>{calls.push(String(url));return response(String(url),[{id:1}],{link:`<${next}>; rel="next"`});};
  await expect(new GitHubClient('fixture','https://api.github.com',transport as any).paginate('/repos/splrad/fixture/releases')).rejects.toThrow();expect(calls).toHaveLength(1);
});
it('rejects native pagination cycles, item limits and unreadable evidence without leaking response bodies',async()=>{
  for(const mode of ['cycle','limit','error']){
    const transport=async(url:any)=>mode==='error'?new Response('private fixture content',{status:403}):response(String(url),[{id:1},{id:2}],mode==='cycle'?{link:`<${url}>; rel="next"`}:{});
    await expect(new GitHubClient('fixture','https://api.github.com',transport as any).paginate('/repos/splrad/fixture/releases',v=>v as any[],{maxItems:mode==='limit'?1:10})).rejects.toThrow(/^GITHUB_EVIDENCE_PAGINATION_FAILED$/);
  }
});
it('uses official JSON API headers, keeps the selected token and removes obsolete policy headers',async()=>{
  const transport=async(url:any,init:any)=>{
    expect(init.method).toBe('GET');expect(init.redirect).toBe('error');const headers=new Headers(init.headers);
    expect(headers.get('authorization')).toContain('fixture');expect(headers.get('x-github-api-version')).toBe('2026-03-10');
    expect([...headers.keys()].join(' ')).not.toMatch(/policy/);return response(String(url),{id:42});
  };
  expect(await new GitHubClient('fixture','https://api.github.com',transport as any).getRepositoryById(42)).toEqual({id:42});
});
