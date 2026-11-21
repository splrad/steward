import {expect,it} from 'vitest';
import {ReleasePromotion} from '../src/release-promotion.js';
import {SqliteDurableStorage} from './bounded-storage.js';

class PromotionStorage extends SqliteDurableStorage {
  async delete(key:string){this.db.prepare('DELETE FROM kv WHERE key=?').run(key);}
  async list({start,end,limit}:{start:string;end:string;limit:number}){
    const rows=this.db.prepare('SELECT key,value FROM kv WHERE key>=? AND key<? ORDER BY key LIMIT ?').all(start,end,limit);
    return new Map(rows.map(r=>[String(r.key),JSON.parse(String(r.value))]));
  }
}
it('wakes original requests for a superseding controller including registration across promotion',async()=>{
  const storage=new PromotionStorage(),policy='d'.repeat(40),controller='2'.repeat(40);
  const wakes:{id:string;policy:string;controller:string}[]=[];
  const ns={idFromName:(key:string)=>key,get:(id:string)=>({fetch:async(r:Request)=>{
    wakes.push({id,...await r.json() as {policy:string;controller:string}});return new Response();
  }})};
  const env={BOUNDED_RECHECK:ns,BOUNDED_RECHECK_ENABLED:'false'};
  const broker=new ReleasePromotion(storage as any,env as any);
  const wait=(kind:'native'|'cycle'|'quality',key:string,generation:number)=>broker.update('/wait',{kind,key:key.repeat(64),policy,generation});
  await wait('native','a',0);await wait('cycle','b',0);
  expect(await storage.get('__alarm')).toBeUndefined();
  await broker.update('/promoted',{policy,controller});
  await wait('quality','c',0);await wait('native','f',1);
  for(let i=0;i<5;i++)await broker.alarm();
  expect(wakes).toHaveLength(0);
  expect(await storage.get('__alarm')).toBeDefined();
  env.BOUNDED_RECHECK_ENABLED='true';
  await broker.alarm();await broker.update('/promoted',{policy,controller});await broker.alarm();
  expect(wakes.map(x=>x.id).sort()).toEqual(['cycle:v1:'+'b'.repeat(64),'native:v1:'+'a'.repeat(64),'quality:v1:'+'c'.repeat(64)]);
  expect(wakes.every(x=>x.controller===controller&&x.policy===policy)).toBe(true);
  expect(await storage.get('__alarm')).toBeUndefined();
  await broker.update('/promoted',{policy,controller:'3'.repeat(40)});
  await broker.alarm();
  expect(wakes.at(-1)).toEqual({id:'native:v1:'+'f'.repeat(64),policy,controller:'3'.repeat(40)});
});
