import {BoundedGitHub, TARGET, ensure, type BoundedEnv, type GitReader} from './bounded-recheck-github.js';
import {registerWingetRun} from './bounded-winget-evidence.js';
import {releaseHint} from './release-cycle-relay.js';

type Submit = {id:number; attempt:number; title:string; tries:number; next:number; state:'pending'|'finished'|'unknown'};
export async function acceptWingetSubmit(env:BoundedEnv,event:string,p:any) {
  if(env.BOUNDED_RECHECK_ENABLED!=='true')return;
  const hint=releaseHint(event,p,env.INSTALLATION_ID);
  if(hint?.kind!=='run'||p.workflow_run.workflow_id!==410998651||!/^Channels submit [a-f0-9]{64}$/.test(p.workflow_run.display_title))return;
  const ns=env.BOUNDED_RECHECK;ensure(ns,'CHANNEL_NAMESPACE');
  const stub=ns.get(ns.idFromName('winget-submit:v1:'+hint.runId+':'+hint.attempt));
  const response=await stub.fetch(new Request('https://bounded.internal/winget-submit',{method:'POST',
    body:JSON.stringify({id:hint.runId,attempt:hint.attempt,title:p.workflow_run.display_title})}));
  ensure(response.ok,'CHANNEL_SUBMIT_REGISTRATION');
}
export class WingetSubmit {
  constructor(private storage:DurableObjectStorage,private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env),private now=Date.now){}
  async register(hint:Pick<Submit,'id'|'attempt'|'title'>){
    await this.storage.transaction(async t=>{
      if(await t.get('wingetSubmit'))return;
      const r:Submit={...hint,tries:0,next:this.now(),state:'pending'};
      await t.put('wingetSubmit',r);await t.setAlarm(r.next);
    });
  }
  async alarm(){
    const r=await this.storage.transaction(async t=>{
      const r=await t.get<Submit>('wingetSubmit');
      if(!r||r.state!=='pending'||r.next>this.now())return;
      if(r.tries>=4){r.state='unknown';await t.put('wingetSubmit',r);await t.deleteAlarm();return;}
      r.tries++;r.next=this.now()+[60000,300000,900000,60000][r.tries-1]!;
      await t.put('wingetSubmit',r);await t.setAlarm(r.next);return r;
    });
    if(!r||this.env.BOUNDED_RECHECK_ENABLED!=='true')return;
    try{
      await registerWingetRun(this.env,'workflow_run',{action:'completed',repository:{id:TARGET.id},
        workflow_run:{id:r.id,run_attempt:r.attempt,display_title:r.title,path:'.github/workflows/steward-release-channels.yml'}},this.reader());
    }catch{return;} // Re-read only the same submit attempt; target registration is independently idempotent.
    await this.storage.transaction(async t=>{
      const latest=await t.get<Submit>('wingetSubmit');
      if(latest?.state==='pending'&&latest.tries===r.tries){latest.state='finished';await t.put('wingetSubmit',latest);await t.deleteAlarm();}
    });
  }
}
