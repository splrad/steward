import {CENTRAL,BoundedGitHub,ensure,type BoundedEnv} from './bounded-recheck-github.js';

export class PendingPromotion extends Error {
  constructor(readonly sha:string){super('RELEASE_RELAY_PROMOTION');}
}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const key=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export async function promotionMessage(env:BoundedEnv,policy:string,action:'wait'|'promoted',body:object){
  const ns=env.BOUNDED_RECHECK;ensure(ns&&sha(policy),'PROMOTION_NAMESPACE');
  const stub=ns.get(ns.idFromName('release-promotion:v1:'+policy));
  const result=await stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',body:JSON.stringify(body)}));
  ensure(result.ok,'PROMOTION_MESSAGE');
}
export async function acceptReleasePromotion(env:BoundedEnv,event:string,p:any){
  const r=p.workflow_run;
  if(env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='workflow_run'||p.action!=='completed'||p.installation?.id!==Number(env.INSTALLATION_ID)||
    p.repository?.id!==CENTRAL.id||p.repository.full_name!==CENTRAL.name||r?.workflow_id!==408662199||
    r.path!=='.github/workflows/governance-promotion.yml'||r.head_repository?.id!==CENTRAL.id||r.head_branch!=='main'||
    r.status!=='completed'||r.conclusion!=='success'||!sha(r.head_sha))return;
  const g=new BoundedGitHub(env);
  const ref=await g.json(CENTRAL.id,'/repos/'+CENTRAL.name+'/git/ref/heads/steward/validated-controller');
  if(ref.ref!=='refs/heads/steward/validated-controller'||ref.object?.type!=='commit'||ref.object.sha!==r.head_sha)return;
  await promotionMessage(env,r.head_sha,'promoted',{policy:r.head_sha});
  const deployment=env.RELEASE_RELAY_DEPLOYMENT_SHA??env.BOUNDED_DEPLOYMENT_SHA;
  if(sha(deployment)){
    const path='config/bounded-recheck.json';
    const file=await g.json(CENTRAL.id,'/repos/'+CENTRAL.name+'/contents/'+path+'?ref='+r.head_sha);
    ensure(file.type==='file'&&file.path===path&&file.encoding==='base64'&&file.size>0&&file.size<4096,'PROMOTION_CONFIG');
    const bytes=Buffer.from(file.content,'base64');ensure(bytes.length===file.size,'PROMOTION_CONFIG_SIZE');
    const config=JSON.parse(bytes.toString('utf8'));
    if(config.schemaVersion===1&&config.enabled===true&&config.deploymentSha===deployment)
      await promotionMessage(env,deployment,'promoted',{policy:deployment});
  }
}
// This object is named by the awaited main SHA. It holds only release requests that actually observed promotion lag.
export class ReleasePromotion {
  constructor(private storage:DurableObjectStorage,private env:BoundedEnv){}
  async update(action:string,b:{policy:string;key?:string;kind?:'native'}){
    ensure(sha(b.policy),'PROMOTION_POLICY');
    await this.storage.transaction(async t=>{
      if(action==='/wait'){
        ensure(key(b.key),'PROMOTION_KEY');
        const name='wait:'+(b.kind==='native'?'native:':'cycle:')+b.key;
        if(await t.get(name)===undefined)await t.put(name,0);
      }else await t.put('promoted',true);
      await t.put('promotionPolicy',b.policy);
      if(await t.get('promoted') && (await t.list({prefix:'wait:',limit:1})).size)await t.setAlarm(Date.now());
    });
  }
  async alarm(){
    const policy=await this.storage.get<string>('promotionPolicy');
    if(!policy||!await this.storage.get('promoted'))return;
    const ns=this.env.BOUNDED_RECHECK;ensure(ns,'PROMOTION_NAMESPACE');
    const batch=await this.storage.list<number>({prefix:'wait:',limit:8});
    for(const [name,tries] of batch){
      // Claim a bounded delivery before cross-object IO. Waking only authorizes a fresh preflight.
      await this.storage.put(name,tries+1);
      if(tries<3){
        try{
          const [,kind,objectKey]=name.split(':');
          const stub=ns.get(ns.idFromName(kind+':v1:'+objectKey));
          const action=kind==='native'?'native-promoted':'release-promoted';
          const res=await stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',body:JSON.stringify({policy})}));
          ensure(res.ok,'PROMOTION_WAKE');
        }catch{continue;}
      }
      await this.storage.delete(name);
    }
    await this.storage.transaction(async t=>{
      if((await t.list({prefix:'wait:',limit:1})).size)await t.setAlarm(Date.now()+60000);
      else await t.deleteAlarm();
    });
  }
}
