import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createAppJwt } from '../../github/src/index.js';
import { GITHUB_API_VERSION } from '../../github/src/api-version.js';
import type { BodyWriteRuntimeEnv } from './pr-body-api.js';
export const TARGET = { id:1187527897, name:'splrad/LayerScape' } as const;
export const CENTRAL = { id:1296724484, name:'splrad/steward' } as const;
export function digest(bytes:Uint8Array|string){return 'sha256:'+createHash('sha256').update(bytes).digest('hex');}
export function ensure(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
export interface BoundedEnv extends BodyWriteRuntimeEnv {
 BOUNDED_ACCEPTANCE_SKIP_ONCE?:string; BOUNDED_RECHECK?:DurableObjectNamespace; BOUNDED_RECHECK_ENABLED?:string;
 BOUNDED_CONTROLLER_SHA?:string; BOUNDED_PRODUCT_SHA?:string; BOUNDED_DEPLOYMENT_SHA?:string;
}
export interface RunLocator { repositoryId:number;runId:number;attempt:number;requestKey:string }
export interface GitReader {
 upstreamPull?(number:number):Promise<any>;
 json(repositoryId:number,path:string,method?:'GET'|'POST',body?:unknown):Promise<any>;
 artifact(repositoryId:number,runId:number,name:string,file:string):Promise<{value:any;artifactId:number;digest:string;createdAt?:string}>;
}
function repo(id:number){ensure(id===TARGET.id||id===CENTRAL.id,'FIXED_REPOSITORY');return id===TARGET.id?TARGET:CENTRAL;}
async function limitedBytes(response:Response,max:number){
 ensure(response.ok&&response.body,'HTTP_READ_FAILED');const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;ensure(size<=max,'RESPONSE_LIMIT');chunks.push(value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
/** Decode only the named, small JSON member; no extraction to disk and no executable archive paths. */
export function readZipJson(bytes:Uint8Array,name:string):unknown{
 const b=Buffer.from(bytes);ensure(b.length>=22,'ZIP_HEADER');let eocd=-1;
 for(let n=b.length-22;n>=Math.max(0,b.length-65557);n--)if(b.readUInt32LE(n)===0x06054b50){eocd=n;break;}
 ensure(eocd>=0,'ZIP_DIRECTORY');ensure(b.readUInt16LE(eocd+4)===0&&b.readUInt16LE(eocd+6)===0,'ZIP_MULTIDISK');
 let at=b.readUInt32LE(eocd+16),match:Buffer|null=null;const count=b.readUInt16LE(eocd+10);ensure(count<=32,'ZIP_ENTRIES');
 for(let n=0;n<count;n++){
  ensure(at+46<=b.length&&b.readUInt32LE(at)===0x02014b50,'ZIP_ENTRY');const flags=b.readUInt16LE(at+8),method=b.readUInt16LE(at+10),compressed=b.readUInt32LE(at+20),size=b.readUInt32LE(at+24),len=b.readUInt16LE(at+28),extra=b.readUInt16LE(at+30),comment=b.readUInt16LE(at+32),local=b.readUInt32LE(at+42);
  ensure(at+46+len+extra+comment<=b.length,'ZIP_BOUNDS');const path=b.subarray(at+46,at+46+len).toString('utf8');
  if(path===name){ensure(!match&&!(flags&1)&&size<=256*1024&&local+30<=b.length&&b.readUInt32LE(local)===0x04034b50,'ZIP_MEMBER');const start=local+30+b.readUInt16LE(local+26)+b.readUInt16LE(local+28);ensure(start+compressed<=b.length,'ZIP_MEMBER_BOUNDS');const raw=b.subarray(start,start+compressed);ensure(method===0||method===8,'ZIP_METHOD');match=method===0?raw:inflateRawSync(raw,{maxOutputLength:256*1024});ensure(match!.length===size,'ZIP_SIZE');}
  at+=46+len+extra+comment;
 }
 ensure(match,'ARTIFACT_MEMBER_MISSING');return JSON.parse(match.toString('utf8'));
}
export class BoundedGitHub implements GitReader {
 private deadline=Date.now()+30_000;
 private tokens=new Map<string,Promise<string>>();
 constructor(private env:BoundedEnv,private transport:typeof fetch=fetch){}
 private signal(){const remaining=this.deadline-Date.now();ensure(remaining>0,'ACTION_TIMEOUT');return AbortSignal.timeout(remaining);}
 private token(id:number,write=false){const key=String(id)+String(write);let token=this.tokens.get(key);if(!token){token=this.issueToken(id,write);this.tokens.set(key,token);}return token;}
 private async issueToken(id:number,write=false){repo(id);ensure(this.env.STEWARD_APP_PRIVATE_KEY,'APP_KEY_MISSING');const jwt=await createAppJwt(this.env.APP_ID,this.env.STEWARD_APP_PRIVATE_KEY);const response=await this.transport(`https://api.github.com/app/installations/${Number(this.env.INSTALLATION_ID)}/access_tokens`,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,'X-GitHub-Api-Version':GITHUB_API_VERSION,'Content-Type':'application/json','User-Agent':'splrad-bounded-recheck'},body:JSON.stringify({repository_ids:[id],permissions:{actions:write?'write':'read',contents:'read',metadata:'read',...(!write&&id===TARGET.id?{pull_requests:'read'}:{})}}),signal:this.signal(),redirect:'error'});const value=JSON.parse(new TextDecoder().decode(await limitedBytes(response,32*1024)));ensure(typeof value.token==='string','INSTALLATION_TOKEN');return value.token;}
 async upstreamPull(number:number){ensure(Number.isSafeInteger(number)&&number>0,'UPSTREAM_NUMBER');const res=await this.transport(`https://api.github.com/repos/microsoft/winget-pkgs/pulls/${number}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'splrad-bounded-recheck'},signal:this.signal(),redirect:'error'});if(res.status===429||res.status===503||res.status===403&&res.headers.get('x-ratelimit-remaining')==='0'){const reset=Number(res.headers.get('x-ratelimit-reset')),retry=res.headers.get('retry-after')??(Number.isFinite(reset)&&reset>0?new Date(reset*1000).toUTCString():'unknown');throw Error('RETRY_AFTER:'+retry);}ensure(res.ok,'UPSTREAM_READ');return JSON.parse(new TextDecoder().decode(await limitedBytes(res,256*1024)));}
 async json(id:number,path:string,method:'GET'|'POST'='GET',body?:unknown){
  const r=repo(id);ensure(path.startsWith(`/repos/${r.name}/`)&&!path.split('?')[0]!.split('/').includes('..'),'API_SCOPE');
  // Only fixed observation/bridge dispatches may write. No repository mutation APIs.
  if(method==='POST')ensure([`/repos/${CENTRAL.name}/actions/workflows/release-candidate-event.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/release-observe.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/bounded-release-event.yml/dispatches`,`/repos/${TARGET.name}/actions/workflows/steward-release-channels.yml/dispatches`].includes(path),'FIXED_DISPATCH');
  const token=await this.token(id,method==='POST');const res=await this.transport('https://api.github.com'+path,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'splrad-bounded-recheck','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:this.signal(),redirect:'error'});
  if(res.status===429||res.status===503){const retry=res.headers.get('retry-after');throw new Error(`RETRY_AFTER:${retry??'unknown'}`);}
  ensure(res.ok,`GITHUB_HTTP_${res.status}`);if(res.status===204)return null;return JSON.parse(new TextDecoder().decode(await limitedBytes(res,2*1024*1024)));
 }
 async artifact(id:number,runId:number,name:string,file:string){
  const r=repo(id);const list=await this.json(id,`/repos/${r.name}/actions/runs/${runId}/artifacts?per_page=100`);ensure(Array.isArray(list.artifacts)&&list.total_count===list.artifacts.length,'ARTIFACT_PAGINATION');
  const matches=list.artifacts.filter((a:any)=>a.name===name&&!a.expired&&a.workflow_run?.id===runId);ensure(matches.length===1,'ARTIFACT_UNIQUE');const a=matches[0];ensure(/^sha256:[a-f0-9]{64}$/.test(a.digest)&&a.size_in_bytes<=2*1024*1024,'ARTIFACT_DIGEST');
  const token=await this.token(id);const redirect=await this.transport(`https://api.github.com/repos/${r.name}/actions/artifacts/${a.id}/zip`,{headers:{Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'splrad-bounded-recheck'},signal:this.signal(),redirect:'manual'});
  ensure(redirect.status===302,'ARTIFACT_REDIRECT');const url=new URL(redirect.headers.get('location')??'');ensure(url.protocol==='https:'&&!url.username&&!url.password,'ARTIFACT_ORIGIN');
  // The API-issued signed URL gets no GitHub bearer token, and is never persisted/logged.
  const bytes=await limitedBytes(await this.transport(url,{signal:this.signal(),redirect:'error'}),2*1024*1024);ensure(digest(bytes)===a.digest&&bytes.length===a.size_in_bytes,'ARTIFACT_BYTES');const current=await this.json(id,`/repos/${r.name}/actions/artifacts/${a.id}`);const fields=['id','name','digest','workflow_run','created_at','expired','size_in_bytes'];ensure(fields.every(k=>JSON.stringify(current[k])===JSON.stringify(a[k])),'ARTIFACT_CHANGED');return {value:readZipJson(bytes,file),artifactId:a.id,digest:a.digest,createdAt:a.created_at};
 }
}
