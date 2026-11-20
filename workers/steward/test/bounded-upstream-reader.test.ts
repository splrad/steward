import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {BoundedGitHub,TARGET,CENTRAL} from '../src/bounded-recheck-github.js';
describe('fixed public upstream reader',()=>{
 it('uses injected transport with fixed URL, bounded signal and no App token',async()=>{const transport=vi.fn(async(_url:any,_init:any)=>Response.json({number:123}));const g=new BoundedGitHub({} as any,transport as typeof fetch);expect(await g.upstreamPull(123)).toEqual({number:123});const [url,init]=transport.mock.calls[0]!;expect(url).toBe('https://api.github.com/repos/microsoft/winget-pkgs/pulls/123');expect(init.redirect).toBe('manual');expect(init.signal).toBeInstanceOf(AbortSignal);expect(new Headers(init.headers).has('authorization')).toBe(false);});
 it('rejects overlarge streamed responses',async()=>{const g=new BoundedGitHub({} as any,vi.fn(async()=>new Response('x'.repeat(256*1024+1))) as typeof fetch);await expect(g.upstreamPull(1)).rejects.toThrow('RESPONSE_LIMIT');});
 it('shares the original reader deadline across upstream calls',async()=>{const start=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(start),transport=vi.fn(async()=>Response.json({}));try{const g=new BoundedGitHub({} as any,transport as typeof fetch);await g.upstreamPull(1);clock.mockReturnValue(start+30001);await expect(g.upstreamPull(1)).rejects.toThrow('ACTION_TIMEOUT');expect(transport).toHaveBeenCalledTimes(1);}finally{clock.mockRestore();}});
 it.each([429,503,403])('preserves upstream rate limit floor on HTTP %s',async status=>{const g=new BoundedGitHub({} as any,vi.fn(async()=>new Response('',{status,headers:{'retry-after':'3600','x-ratelimit-remaining':'0'}})) as typeof fetch);await expect(g.upstreamPull(1)).rejects.toThrow('RETRY_AFTER:3600');});
 it('uses reset header when exhausted public quota has no Retry-After',async()=>{const g=new BoundedGitHub({} as any,vi.fn(async()=>new Response('',{status:403,headers:{'x-ratelimit-reset':'1800000000','x-ratelimit-remaining':'0'}})) as typeof fetch);await expect(g.upstreamPull(1)).rejects.toThrow('RETRY_AFTER:'+new Date(1800000000000).toUTCString());});
 it.each([0,-1,1.5,NaN,'../other' as any])('rejects invalid pull locator %s before transport',async number=>{const transport=vi.fn(),g=new BoundedGitHub({} as any,transport);await expect(g.upstreamPull(number)).rejects.toThrow('UPSTREAM_NUMBER');expect(transport).not.toHaveBeenCalled();});
});

it.each(['retry','reset','permission'])('authenticated reader classifies HTTP403 %s without inventing permission retry',async scenario=>{const headers=scenario==='retry'?{'retry-after':'3600'}:scenario==='reset'?{'x-ratelimit-remaining':'0','x-ratelimit-reset':'1800000000'}:{'x-ratelimit-remaining':'100','x-ratelimit-reset':'1800000000'};const g=new BoundedGitHub({} as any,vi.fn(async()=>new Response('',{status:403,headers})) as typeof fetch);(g as any).tokens.set(String(TARGET.id)+'false',Promise.resolve('test-only-token'));await expect(g.json(TARGET.id,`/repos/${TARGET.name}/pulls/192`)).rejects.toThrow(scenario==='permission'?'GITHUB_HTTP_403':scenario==='retry'?'RETRY_AFTER:3600':'RETRY_AFTER:'+new Date(1800000000000).toUTCString());});

it('uses the Worker fetch receiver and refuses redirects during native prepare and dispatch',async()=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const env={APP_ID:'1',INSTALLATION_ID:'1',STEWARD_APP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})} as any;
 const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async function(this:unknown,url,init){
  expect(this).toBe(globalThis);
  expect(init?.redirect).toBe('manual');
  if(String(url).endsWith('/access_tokens'))return Response.json({token:'fixture-only'});
  return new Response(null,{status:307,headers:{location:'https://example.invalid/'}});
 });
 try{
  const g=new BoundedGitHub(env);
  await expect(g.json(TARGET.id,`/repos/${TARGET.name}/git/ref/heads/steward/release-state`)).rejects.toThrow('GITHUB_HTTP_307');
  await expect(g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/workflows/release-candidate-event.yml/dispatches`,'POST',{})).rejects.toThrow('GITHUB_HTTP_307');
  expect(transport).toHaveBeenCalledTimes(4);
 }finally{transport.mockRestore();}
});
