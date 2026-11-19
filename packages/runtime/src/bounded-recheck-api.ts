import {createHash} from 'node:crypto';
import {authorizeSingleRepository} from './pr-body-api.js';
import {identityKey,objectKey,validateRegistration,type Identity} from './bounded-recheck.js';
import {BoundedGitHub,candidateReader,TARGET,CENTRAL,ensure,type BoundedEnv} from './bounded-recheck-github.js';
import {verifiedProducer} from './bounded-candidate-evidence.js';
function exact(b:any,keys:string[]){ensure(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).sort().join(',')===keys.sort().join(','),'CLOSED_REQUEST');}
export async function handleBoundedRecheckRequest(request:Request,env:BoundedEnv):Promise<Response|null>{
 const u=new URL(request.url),prefix='/internal/bounded-rechecks/v1/';if(!u.pathname.startsWith(prefix))return null;
 const reply=(status:number,error:string)=>Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST'||u.search)return reply(400,'BOUNDED_REQUEST');const action=u.pathname.slice(prefix.length);
 if(!['register','pause','resume','cancel','receipt','status'].includes(action))return reply(404,'BOUNDED_ROUTE');
 if(!env.BOUNDED_RECHECK)return reply(503,'BOUNDED_NAMESPACE_UNAVAILABLE');
 if(['register','resume'].includes(action)&&env.BOUNDED_RECHECK_ENABLED!=='true')return reply(503,'BOUNDED_QUIESCED');
 try{
  ensure(Number(request.headers.get('content-length')??0)<=32*1024,'BODY_LIMIT');ensure(request.body,'BODY_REQUIRED');const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;ensure(length<=32*1024,'BODY_LIMIT');chunks.push(part.value);}}finally{await reader.cancel();}const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const identity:Identity=action==='register'?b.registration?.identity:b.identity;
  validateRegistration({identity,t0:1,policySha:'0'.repeat(40),deploymentSha:'0'.repeat(40)},Date.now());
  await authorizeSingleRepository(request,env,identity.repositoryId);
  const github=identity.stage==='candidate'?await candidateReader(new BoundedGitHub(env),identity.repositoryId):new BoundedGitHub(env);
  if(action==='register'){exact(b,['registration','producer']);await verifiedProducer(github,env,b);}
  else if(action==='receipt'){
   ensure(identity.stage==='candidate','PRODUCT_RECEIPT_USES_BOUNDED_GET');exact(b,['identity','requestKey','runId','attempt']);ensure(/^[a-f0-9]{64}$/.test(b.requestKey)&&Number.isSafeInteger(b.runId)&&b.runId>0&&b.attempt===1,'RECEIPT_LOCATOR');
   const id=identity.stage==='candidate'?CENTRAL.id:TARGET.id,name=id===CENTRAL.id?CENTRAL.name:TARGET.name;
   const run=await github.json(id,`/repos/${name}/actions/runs/${b.runId}`);
   ensure(run.id===b.runId&&run.run_attempt===b.attempt&&run.repository?.id===id&&run.head_repository?.id===id&&run.event==='workflow_dispatch'&&run.head_sha===(id===CENTRAL.id?env.BOUNDED_CONTROLLER_SHA:env.BOUNDED_PRODUCT_SHA)&&run.path===`.github/workflows/${id===CENTRAL.id?'release-observe.yml':'steward-release-channels.yml'}`&&run.display_title===(id===CENTRAL.id?'Observe candidate ':'Channels observe ')+b.requestKey,'RECEIPT_RUN');
  }else if(action==='pause'||action==='resume'){exact(b,['identity','expectedGeneration','producer']);ensure(Number.isSafeInteger(b.expectedGeneration)&&b.expectedGeneration>0,'GENERATION');const verified=await verifiedProducer(github,env,{producer:b.producer});ensure(identityKey(verified.registration.identity)===identityKey(identity)&&verified.editing===(action==='pause'),'CONTROL_EVENT');}else if(action==='status')exact(b,['identity']);else{exact(b,['identity','expectedGeneration']);ensure(Number.isSafeInteger(b.expectedGeneration)&&b.expectedGeneration>0,'GENERATION');}
  const name='recheck:v1:'+createHash('sha256').update(objectKey(identity)).digest('hex');const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName(name));
  return stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}));
 }catch{return reply(403,'BOUNDED_IDENTITY_OR_EVIDENCE_REJECTED');}
}
