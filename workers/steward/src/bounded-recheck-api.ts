import {createHash} from 'node:crypto';
import {authorizeSingleRepository} from './pr-body-api.js';
import {objectKey,validateRegistration,type Identity} from './bounded-recheck.js';
import {ensure,type BoundedEnv} from './bounded-recheck-github.js';
export async function handleBoundedRecheckRequest(request:Request,env:BoundedEnv):Promise<Response|null>{
 const u=new URL(request.url),prefix='/internal/bounded-rechecks/v1/';if(!u.pathname.startsWith(prefix))return null;
 const reply=(status:number,error:string)=>Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST'||u.search)return reply(400,'BOUNDED_REQUEST');const action=u.pathname.slice(prefix.length);
 if(action!=='status')return reply(404,'BOUNDED_ROUTE');
 if(!env.BOUNDED_RECHECK)return reply(503,'BOUNDED_NAMESPACE_UNAVAILABLE');
 try{
  ensure(Number(request.headers.get('content-length')??0)<=32*1024,'BODY_LIMIT');ensure(request.body,'BODY_REQUIRED');const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;ensure(length<=32*1024,'BODY_LIMIT');chunks.push(part.value);}}finally{await reader.cancel();}const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  ensure(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).join(',')==='identity','CLOSED_REQUEST');
  const identity:Identity=b.identity;
  validateRegistration({identity,t0:1,policySha:'0'.repeat(40),deploymentSha:'0'.repeat(40)},Date.now());
  const {repository}=await authorizeSingleRepository(request,env,identity.repositoryId);
  if(identity.stage==='candidate')ensure(repository.private===false&&repository.visibility==='public'&&
    repository.fork===false&&repository.archived===false&&repository.disabled===false,'CANDIDATE_REPOSITORY_SCOPE');
  const name='recheck:v1:'+createHash('sha256').update(objectKey(identity)).digest('hex');const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName(name));
  return await stub.fetch(new Request('https://bounded.internal/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}));
 }catch{return reply(403,'BOUNDED_IDENTITY_OR_EVIDENCE_REJECTED');}
}
