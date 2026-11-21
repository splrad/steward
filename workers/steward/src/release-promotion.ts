import {CENTRAL,BoundedGitHub,ensure,type BoundedEnv} from './bounded-recheck-github.js';

export class PendingPromotion extends Error {
  constructor(readonly sha:string,readonly generation?:number){super('RELEASE_RELAY_PROMOTION');}
}
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const key=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export async function promotionMessage(env:BoundedEnv,policy:string,action:'wait'|'promoted'|'generation',body:object){
  const ns=env.BOUNDED_RECHECK;ensure(ns&&sha(policy),'PROMOTION_NAMESPACE');
  const stub=ns.get(ns.idFromName('release-promotion:v1:'+policy));
  const result=await stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',body:JSON.stringify(body)}));
  ensure(result.ok,'PROMOTION_MESSAGE');
  if(action==='generation'){const value=await result.json() as {generation:number};ensure(Number.isSafeInteger(value.generation)&&value.generation>=0,'PROMOTION_GENERATION');return value.generation;}
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

  const deployment=env.RELEASE_RELAY_DEPLOYMENT_SHA??env.BOUNDED_DEPLOYMENT_SHA;
  if(sha(deployment)){
    const path='config/bounded-recheck.json';
    const file=await g.json(CENTRAL.id,'/repos/'+CENTRAL.name+'/contents/'+path+'?ref='+r.head_sha);
    ensure(file.type==='file'&&file.path===path&&file.encoding==='base64'&&file.size>0&&file.size<4096,'PROMOTION_CONFIG');
    const bytes=Buffer.from(file.content,'base64');ensure(bytes.length===file.size,'PROMOTION_CONFIG_SIZE');
    const config=JSON.parse(bytes.toString('utf8'));
    if(config.schemaVersion===1&&config.enabled===true&&config.deploymentSha===deployment)
      await promotionMessage(env,deployment,'promoted',{policy:deployment,controller:r.head_sha});
  }
}

// Each deployment has a monotonic promotion generation. Waiters record the generation
// before reading GitHub, so a concurrent promotion remains visible after enrollment.
type PromotionKind = 'cycle'|'native'|'quality'|'configuration';
const bucket=(generation:number)=>'wait:'+String(generation).padStart(16,'0')+':';
export class ReleasePromotion {
  constructor(private storage:DurableObjectStorage,private env:BoundedEnv){}
  async update(action:string,b:{policy:string;key?:string;kind?:PromotionKind;controller?:string;generation?:number}){
    ensure(sha(b.policy),'PROMOTION_POLICY');
    await this.storage.transaction(async t=>{
      let generation=(await t.get<number>('generation'))??0;
      if(action==='/wait'){
        ensure(key(b.key)&&['cycle','native','quality','configuration'].includes(b.kind!)&&Number.isSafeInteger(b.generation)&&b.generation!>=0&&b.generation!<=generation,'PROMOTION_WAIT');
        const name=bucket(b.generation!)+b.kind+':'+b.key;
        if(await t.get(name)===undefined)await t.put(name,0);
      }else{
        ensure(sha(b.controller),'PROMOTION_CONTROLLER');
        if(await t.get('controller')!==b.controller||await t.get('notifiedPolicy')!==b.policy){
          await t.put('notifiedPolicy',b.policy);
          await t.put('promotionPolicy',b.policy);
          await t.put('controller',b.controller);
          await t.put('generation',++generation);
        }
      }
      if((await t.list({start:'wait:',end:bucket(generation),limit:1})).size)await t.setAlarm(Date.now());
    });
  }
  async alarm(){
    const generation=(await this.storage.get<number>('generation'))??0;
    const policy=await this.storage.get<string>('promotionPolicy'),controller=await this.storage.get<string>('controller');
    if(!policy||!controller)return;
    if(this.env.BOUNDED_RECHECK_ENABLED!=='true'){
      await this.storage.transaction(async t=>{
        const current=(await t.get<number>('generation'))??0;
        if((await t.list({start:'wait:',end:bucket(current),limit:1})).size)await t.setAlarm(Date.now()+60_000);
        else await t.deleteAlarm();
      });
      return;
    }
    const ns=this.env.BOUNDED_RECHECK;ensure(ns,'PROMOTION_NAMESPACE');
    const range={start:'wait:',end:bucket(generation)};
    for(const [name,tries] of await this.storage.list<number>({...range,limit:8})){
      await this.storage.put(name,tries+1);
      if(tries<3){
        try{
          const [,,kind,objectKey]=name.split(':');
          const stub=ns.get(ns.idFromName(kind+':v1:'+objectKey));
          const action=kind==='cycle'?'release-promoted':kind+'-promoted';
          const res=await stub.fetch(new Request('https://bounded.internal/'+action,{method:'POST',body:JSON.stringify({policy,controller})}));
          ensure(res.ok,'PROMOTION_WAKE');
        }catch{continue;}
      }
      await this.storage.delete(name);
    }
    await this.storage.transaction(async t=>{
      const current=(await t.get<number>('generation'))??0;
      if((await t.list({start:'wait:',end:bucket(current),limit:1})).size)await t.setAlarm(Date.now()+60000);
      else await t.deleteAlarm();
    });
  }
}
