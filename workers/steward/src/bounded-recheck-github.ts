import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createAppJwt } from '../support/github/index.js';
import { GITHUB_API_VERSION } from '../support/github/api-version.js';
import type { BodyWriteRuntimeEnv } from './pr-body-api.js';
export const TARGET = { id:1187527897, name:'splrad/LayerScape', defaultBranch:'main' } as const;
export const CENTRAL = { id:1296724484, name:'splrad/steward' } as const;
export function digest(bytes:Uint8Array|string){return 'sha256:'+createHash('sha256').update(bytes).digest('hex');}
export function ensure(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
export interface BoundedEnv extends BodyWriteRuntimeEnv {
 BOUNDED_ACCEPTANCE_SKIP_ONCE?:string; BOUNDED_RECHECK?:DurableObjectNamespace; BOUNDED_RECHECK_ENABLED?:string;
 RELEASE_RELAY_DEPLOYMENT_SHA?:string;
 BOUNDED_CONTROLLER_SHA?:string; BOUNDED_PRODUCT_SHA?:string; BOUNDED_DEPLOYMENT_SHA?:string;
}
export interface RunLocator { repositoryId:number;runId:number;attempt:number;requestKey:string }
export interface ProductTarget {id:number;name:string;defaultBranch:string;units?:{id:string;path:string}[]}
export interface GitReader {
 readonly target?: ProductTarget;
 forCandidate?(id:number):Promise<GitReader|undefined>;
 upstreamPull?(number:number):Promise<any>;
 json(repositoryId:number,path:string,method?:'GET'|'POST',body?:unknown):Promise<any>;
 artifact(repositoryId:number,runId:number,name:string,file:string):Promise<{value:any;artifactId:number;digest:string;createdAt?:string}>;
}
export async function candidateReader(g:GitReader,id:number):Promise<GitReader> {
 if(g.target?.id===id)return g;
 const scoped=g.forCandidate?await g.forCandidate(id):id===TARGET.id?g:undefined;
 ensure(scoped,'CANDIDATE_NOT_REGISTERED');return scoped;
}
function rateLimitError(res:Response){const retry=res.headers.get('retry-after'),rawReset=res.headers.get('x-ratelimit-reset'),reset=Number(rawReset);const validRetry=retry!==null&&(/^[0-9]+(?:\.[0-9]+)?$/.test(retry)||Number.isFinite(Date.parse(retry))),validReset=rawReset!==null&&Number.isFinite(reset)&&reset>0;const limited=res.status===429||res.status===503||res.status===403&&(res.headers.get('x-ratelimit-remaining')==='0'||validRetry);if(limited)throw Error('RETRY_AFTER:'+(validRetry?retry:validReset?new Date(reset*1000).toUTCString():'unknown'));}
async function limitedBytes(response:Response,max:number){
 rateLimitError(response);
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
 constructor(private env:BoundedEnv,private transport:typeof fetch=globalThis.fetch.bind(globalThis),readonly target?:ProductTarget){}
 private repo(id:number){
   if(id===CENTRAL.id)return CENTRAL;
   const target=this.target??TARGET;
   ensure(id===target.id,'FIXED_REPOSITORY');
   return target;
 }
 async forCandidate(id:number):Promise<GitReader|undefined>{
   ensure(Number.isSafeInteger(id)&&id>0,'CANDIDATE_REPOSITORY_ID');
   const token=await this.issueToken(id,false,true);
   const scope=await this.installationScope(token);
   ensure(scope.total_count===1&&scope.repositories?.length===1&&scope.repositories[0].id===id,'CANDIDATE_TOKEN_SCOPE');
   const repo=scope.repositories[0];
   if(repo.owner?.id!==302208797||repo.private!==false||repo.visibility!=='public'||repo.archived!==false||
      repo.disabled!==false||repo.fork!==false||!/^splrad\/[A-Za-z0-9_.-]+$/.test(repo.full_name)||!repo.default_branch)return;
   const target:ProductTarget={id,name:repo.full_name,defaultBranch:repo.default_branch};
   const scoped=new BoundedGitHub(this.env,this.transport,target);
   const base='/repos/'+target.name;
   const refPath=base+'/git/ref/heads/'+encodeURIComponent(target.defaultBranch);
   const ref=await scoped.json(id,refPath);
   ensure(ref.ref==='refs/heads/'+target.defaultBranch&&ref.object?.type==='commit'&&/^[0-9a-f]{40}$/.test(ref.object.sha),'CANDIDATE_SOURCE_REF');
   const tree=await scoped.json(id,base+'/git/trees/'+ref.object.sha+'?recursive=1');
   ensure(tree.truncated===false&&Array.isArray(tree.tree),'CANDIDATE_SOURCE_TREE');
   const read=async(path:string)=>{
     const entries=tree.tree.filter((entry:any)=>entry.path===path);
     if(!entries.length)return;
     ensure(entries.length===1&&entries[0].type==='blob'&&entries[0].mode==='100644','CANDIDATE_SOURCE_FILE');
     const file=await scoped.json(id,base+'/contents/'+path+'?ref='+ref.object.sha);
     ensure(file.type==='file'&&file.path===path&&file.sha===entries[0].sha&&file.encoding==='base64'&&file.size>0&&file.size<=512*1024,'CANDIDATE_DECLARATION');
     const bytes=Buffer.from(file.content,'base64');
     ensure(bytes.length===file.size&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===file.sha,'CANDIDATE_DECLARATION_BLOB');
     return JSON.parse(bytes.toString('utf8'));
   };
   try{
     const delivery=await read('.github/delivery.json'),settings=await read('release-please-config.json'),versions=await read('.release-please-manifest.json');
     if(!delivery||!settings||!versions)return;
     ensure(Array.isArray(delivery.units)&&delivery.units.length>0&&settings.packages&&versions,'CANDIDATE_DECLARATION');
     const roots=delivery.units.map((unit:any)=>unit.path).sort();
     ensure(settings['separate-pull-requests']===false&&new Set(roots).size===roots.length&&JSON.stringify(roots)===JSON.stringify(Object.keys(settings.packages).sort())&&
       Object.keys(versions).every(path=>roots.includes(path)),'CANDIDATE_UNIT_COVERAGE');
     target.units=delivery.units.map(({id,path}:any)=>({id,path}));
   }catch(error){if(error instanceof Error && error.message === 'GITHUB_HTTP_404')return;throw error;}
   ensure((await scoped.json(id,refPath)).object?.sha===ref.object.sha,'CANDIDATE_SOURCE_MOVED');
   return scoped;
 }
 private signal(){const remaining=this.deadline-Date.now();ensure(remaining>0,'ACTION_TIMEOUT');return AbortSignal.timeout(remaining);}
 private token(id:number,write=false){const key=String(id)+String(write);let token=this.tokens.get(key);if(!token){token=this.issueToken(id,write);this.tokens.set(key,token);}return token;}
 private async issueToken(id:number,write=false,metadataOnly=false){
   if(!metadataOnly)this.repo(id);
   ensure(this.env.STEWARD_APP_PRIVATE_KEY,'APP_KEY_MISSING');
   const jwt=await createAppJwt(this.env.APP_ID,this.env.STEWARD_APP_PRIVATE_KEY);
   const permissions:Record<string,string>=metadataOnly?{metadata:'read'}:{actions:write?'write':'read',contents:'read',metadata:'read'};
   if(!metadataOnly&&!write&&id===(this.target??TARGET).id)permissions.pull_requests='read';
   const response=await this.transport(`https://api.github.com/app/installations/${Number(this.env.INSTALLATION_ID)}/access_tokens`,{
     method:'POST',headers:{Authorization:`Bearer ${jwt}`,'X-GitHub-Api-Version':GITHUB_API_VERSION,'Content-Type':'application/json','User-Agent':'splrad-bounded-recheck'},
     body:JSON.stringify({repository_ids:[id],permissions}),signal:this.signal(),redirect:'manual'});
   const value=JSON.parse(new TextDecoder().decode(await limitedBytes(response,32*1024)));
   ensure(typeof value.token==='string'&&value.token.length>0,'INSTALLATION_TOKEN');
   if(metadataOnly||this.target){
     ensure(value.permissions&&Object.entries(permissions).every(([name,level])=>value.permissions[name]===level)&&
       Object.entries(value.permissions).every(([name,level])=>level==='none'||permissions[name]===level),'CANDIDATE_TOKEN_PERMISSIONS');
   }
   if(this.target&&id===this.target.id){
     const scope=await this.installationScope(value.token);
     ensure(scope.total_count===1&&scope.repositories?.length===1&&scope.repositories[0].id===id&&scope.repositories[0].full_name===this.target.name,'CANDIDATE_TOKEN_SCOPE');
   }
   return value.token;
 }
 private async installationScope(token:string){
   const response=await this.transport('https://api.github.com/installation/repositories?per_page=100',{headers:{
     Authorization:'Bearer '+token,'User-Agent':'splrad-bounded-recheck','X-GitHub-Api-Version':GITHUB_API_VERSION
   },redirect:'manual',signal:this.signal()});
   return JSON.parse(new TextDecoder().decode(await limitedBytes(response,256*1024)));
 }
 async upstreamPull(number:number){ensure(Number.isSafeInteger(number)&&number>0,'UPSTREAM_NUMBER');const res=await this.transport(`https://api.github.com/repos/microsoft/winget-pkgs/pulls/${number}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'splrad-bounded-recheck'},signal:this.signal(),redirect:'manual'});rateLimitError(res);ensure(res.ok,'UPSTREAM_READ');return JSON.parse(new TextDecoder().decode(await limitedBytes(res,256*1024)));}
 async json(id:number,path:string,method:'GET'|'POST'='GET',body?:unknown){
  const r=this.repo(id);ensure((path.startsWith(`/repos/${r.name}/`)||method==='GET'&&id===(this.target??TARGET).id&&path===`/repos/${r.name}`)&&!path.split('?')[0]!.split('/').includes('..'),'API_SCOPE');
  // Only fixed observation/bridge dispatches may write. No repository mutation APIs.
  if(method==='POST')ensure([`/repos/${CENTRAL.name}/actions/workflows/repository-configuration-event.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/quality-language-summary.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/release-cycle-event.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/pages-maintenance-event.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/release-candidate-event.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/release-observe.yml/dispatches`,`/repos/${CENTRAL.name}/actions/workflows/bounded-release-event.yml/dispatches`,`/repos/${TARGET.name}/actions/workflows/steward-release-channels.yml/dispatches`].includes(path),'FIXED_DISPATCH');
  const token=await this.token(id,method==='POST');const res=await this.transport('https://api.github.com'+path,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'splrad-bounded-recheck','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:this.signal(),redirect:'manual'});
  rateLimitError(res);
  ensure(res.ok,`GITHUB_HTTP_${res.status}`);if(res.status===204)return null;return JSON.parse(new TextDecoder().decode(await limitedBytes(res,2*1024*1024)));
 }
 async artifact(id:number,runId:number,name:string,file:string){
  const r=this.repo(id);const list=await this.json(id,`/repos/${r.name}/actions/runs/${runId}/artifacts?per_page=100`);ensure(Array.isArray(list.artifacts)&&list.total_count===list.artifacts.length,'ARTIFACT_PAGINATION');
  const matches=list.artifacts.filter((a:any)=>a.name===name&&!a.expired&&a.workflow_run?.id===runId);ensure(matches.length===1,'ARTIFACT_UNIQUE');const a=matches[0];ensure(/^sha256:[a-f0-9]{64}$/.test(a.digest)&&a.size_in_bytes<=2*1024*1024,'ARTIFACT_DIGEST');
  const token=await this.token(id);const redirect=await this.transport(`https://api.github.com/repos/${r.name}/actions/artifacts/${a.id}/zip`,{headers:{Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'splrad-bounded-recheck'},signal:this.signal(),redirect:'manual'});
  rateLimitError(redirect);ensure(redirect.status===302,'ARTIFACT_REDIRECT');const url=new URL(redirect.headers.get('location')??'');ensure(url.protocol==='https:'&&!url.username&&!url.password,'ARTIFACT_ORIGIN');
  // The API-issued signed URL gets no GitHub bearer token, and is never persisted/logged.
  const bytes=await limitedBytes(await this.transport(url,{signal:this.signal(),redirect:'manual'}),2*1024*1024);ensure(digest(bytes)===a.digest&&bytes.length===a.size_in_bytes,'ARTIFACT_BYTES');const current=await this.json(id,`/repos/${r.name}/actions/artifacts/${a.id}`);const fields=['id','name','digest','workflow_run','created_at','expired','size_in_bytes'];ensure(fields.every(k=>JSON.stringify(current[k])===JSON.stringify(a[k])),'ARTIFACT_CHANGED');return {value:readZipJson(bytes,file),artifactId:a.id,digest:a.digest,createdAt:a.created_at};
 }
}
