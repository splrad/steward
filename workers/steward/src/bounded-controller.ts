import {PendingPromotion,promotionMessage} from './release-promotion.js';
import {CENTRAL, ensure, type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
const base='/repos/'+CENTRAL.name;
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{40}$/.test(v);

/** Moving main can execute only after promotion and an explicit contract for this D revision. */
export async function promotedController(g:GitReader, deployment:string|undefined, prior?:string,waitEnv?:BoundedEnv){
  try{return await verifiedController(g,deployment,prior);}
  catch(error){
    if(!(error instanceof PendingPromotion)||!waitEnv?.BOUNDED_RECHECK||!deployment)throw error;
    const generation=await promotionMessage(waitEnv,deployment,'generation',{});
    // Re-read after sampling the broker. A promotion before the sample is already
    // effective, and one after the sample wakes this exact generation.
    try{return await verifiedController(g,deployment,prior);}
    catch(pending){if(pending instanceof PendingPromotion)throw new PendingPromotion(deployment,generation);throw pending;}
  }
}
async function verifiedController(g:GitReader,deployment:string|undefined,prior?:string){
  const main=await g.json(CENTRAL.id,base+'/git/ref/heads/main');
  const policy=main.object?.sha;
  ensure(sha(policy),'RELEASE_RELAY_MAIN');
  if(policy===prior)return policy;
  const promoted=await g.json(CENTRAL.id,base+'/git/ref/heads/steward/validated-controller');
  ensure(main.ref==='refs/heads/main'&&main.object.type==='commit'&&promoted.ref==='refs/heads/steward/validated-controller'&&
    promoted.object?.type==='commit','RELEASE_RELAY_PROMOTION_REF');
  if(promoted.object.sha!==policy)throw new PendingPromotion(policy);
  const path='config/bounded-recheck.json',file=await g.json(CENTRAL.id,base+'/contents/'+path+'?ref='+policy);
  ensure(file.type==='file'&&file.path===path&&file.encoding==='base64'&&Number.isSafeInteger(file.size)&&file.size>0&&file.size<4096,'RELEASE_RELAY_CONFIG');
  const bytes=Buffer.from(file.content,'base64');ensure(bytes.length===file.size,'RELEASE_RELAY_CONFIG_SIZE');
  const config=JSON.parse(bytes.toString('utf8'));
  ensure(config.schemaVersion===1&&config.enabled===true&&sha(config.deploymentSha)&&sha(deployment),'RELEASE_RELAY_ADOPTION');
  if(config.deploymentSha!==deployment)throw new PendingPromotion(deployment);
  return policy;
}
