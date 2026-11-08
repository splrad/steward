import {expect,it} from 'vitest';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {permitOfflineCommand} from './offline-fixtures.js';

// Execute each adopted workflow's actual shell against an isolated native API
// fixture. A write can take effect before its response is lost.
const service=String.raw`
import fs from 'node:fs';
const [file,mode,...args]=process.argv.slice(2);
let state=JSON.parse(fs.readFileSync('state.json','utf8'));
const now=state.observedAt, self=file==='release.yml'?311600220:311600221, other=self===311600220?311600221:311600220;
const names={311600220:'release.yml',311600221:'sync-managed.yml'};
const path=args.find(x=>x.startsWith('repos/')||x.startsWith('users/'));
const method=args.includes('--method')?args[args.indexOf('--method')+1]:args[0]==='run'?'LIST':'DISPATCH';
const apiVersion=JSON.parse(fs.readFileSync('api-version.json','utf8')).version;
if(args[0]==='api'&&!args.includes('X-GitHub-Api-Version: '+apiVersion))throw Error('Missing reviewed API version');
const input=args.includes('--input')?fs.readFileSync(0,'utf8'):'';
fs.appendFileSync('requests.jsonl',JSON.stringify({method,path,args,input})+'\n');
const save=()=>fs.writeFileSync('state.json',JSON.stringify(state));
const out=x=>{process.stdout.write(JSON.stringify(x));process.exit(0);};
const lost=()=>{save();process.exit(1);};
const workflow=id=>({id,path:'.github/workflows/'+names[id],state:((id===other&&['manual-disable','wrong-pause-id','expected-other-paused'].includes(mode))||(id===311600220&&mode==='expected-pause'))?'disabled_manually':id===other&&mode==='unknown-state'?'unknown':id===other&&mode==='inactivity'&&!state.enabled?'disabled_inactivity':'active'});
const recent=(createdAt=now)=>({databaseId:2,createdAt,status:mode==='old-running'?'in_progress':'completed',conclusion:mode==='business-failure'?'failure':'success'});
if(args[0]==='run') {
  const target=args[args.indexOf('--workflow')+1];
  if(target===names[self])out([recent()]);
  if(mode==='run-unavailable')process.exit(1);
  if(mode==='missing-run-fields')out([{databaseId:2}]);
  if(mode==='future-run')out([recent('2099-01-01T00:00:00Z')]);
  if(mode==='invalid-time')out([recent('invalid')]);
  if(state.dispatched&&mode==='dispatch-lost')out([recent(new Date().toISOString())]);
  if(['overdue','dispatch-unknown','dispatch-lost'].includes(mode))out([]);
  if(mode==='old-running')out([recent(new Date(Date.parse(now)-3*3600_000).toISOString())]);
  out([recent()]);
}
if(args[0]==='workflow') {
  state.dispatched=true;
  if(mode==='overdue'||mode==='old-running'){save();process.exit(0);}lost();
}
if(mode==='authentication'&&path==='repos/splrad/steward')process.exit(1);
if(path==='repos/splrad/steward')out({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});
if(path==='repos/splrad/steward/actions/runs/1')out({id:1,run_attempt:2,repository:{id:1296724484},head_repository:{id:1296724484},head_branch:'main',event:'schedule',path:'.github/workflows/'+file});
if(path.startsWith('users/'))out({id:41898282,type:'Bot'});
if(path.includes('/actions/workflows/')) {
  if(path.endsWith('/enable')){state.enabled=true;lost();}
  const last=path.split('/').at(-1),id=last==='release.yml'?311600220:last==='sync-managed.yml'?311600221:Number(last);
  if(id===other&&mode==='workflow-unavailable')process.exit(1);
  if(id===other&&mode==='manual-race'&&last===String(id))out({...workflow(id),state:'disabled_manually'});
  if(id===other&&mode==='manual-race')out({...workflow(id),state:'disabled_inactivity'});
  if(id===other&&mode==='wrong-workflow')out({...workflow(id),path:'.github/workflows/foreign.yml'});
  out(workflow(id));
}
if(path==='repos/splrad/steward/issues/7')out({id:70,number:7,state:'open'});
if(path.includes('/issues/7/comments')) {
  if(method==='POST') {
    if(mode==='comment-unknown')process.exit(1);
    state.comments.push({id:80+state.comments.length,user:{id:41898282},...JSON.parse(input)});lost();
  }
  out([state.comments]);
}
throw Error('Unregistered fixture request '+method+' '+path);
`;

const modes=['healthy','business-failure','manual-disable','expected-pause','wrong-pause-id','expected-other-paused','inactivity','authentication','workflow-unavailable','wrong-workflow',
  'unknown-state','run-unavailable','missing-run-fields','future-run','invalid-time','overdue','old-running','dispatch-unknown','dispatch-lost','manual-race','comment-unknown'];
for(const file of ['release.yml','sync-managed.yml']) {
  it.skipIf(process.platform==='win32').each(['unavailable','invalid'])(`${file}: rejects %s API version source before API writes`,async mode=>{
    const workflow=YAML.parse(await readFile('.github/workflows/'+file,'utf8'));
    const root=await mkdtemp(join(tmpdir(),'native-api-version-'));
    try {
      const curl=mode==='unavailable'?'return 22':`echo '{"version":"invalid"}'`;
      const args=['-c',`curl() { ${curl}; }\ngh() { touch api-called; return 0; }\n`+workflow.jobs['automation-health'].steps[0].run];
      permitOfflineCommand('bash',args);
      const result=spawnSync('bash',args,{cwd:root,env:{...process.env,HEALTH_SOURCE_SHA:'a'.repeat(40)},encoding:'utf8',timeout:10_000});
      expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
      await expect(readFile(join(root,'api-called'))).rejects.toMatchObject({code:'ENOENT'});
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it.skipIf(process.platform==='win32').each(modes)(`${file}: native entry health %s`,async mode=>{
    const workflow=YAML.parse(await readFile('.github/workflows/'+file,'utf8'));
    const script=workflow.jobs['automation-health'].steps[0].run;
    const root=await mkdtemp(join(tmpdir(),'native-entry-health-'));
    try {
      await writeFile(join(root,'service.mjs'),service);
      const other=file==='release.yml'?'sync-managed.yml':'release.yml';
      const initialState={comments:[],observedAt:new Date().toISOString()};
      // Force a notification transition without causing a workflow write.
      if(mode==='comment-unknown'||mode==='expected-pause')Object.assign(initialState,{comments:[{id:1,user:{id:41898282},body:'<!-- splrad-automation-health:v2 -->\n["'+(mode==='expected-pause'?'release.yml':other)+':WORKFLOW_DISABLED"]'}]});
      await writeFile(join(root,'state.json'),JSON.stringify(initialState));
      const sourceSha='a'.repeat(40);
      const args=['-c',`curl() { [[ "\${@: -1}" == 'https://raw.githubusercontent.com/splrad/steward/${sourceSha}/config/github-api.json' ]] || return 1; cat api-version.json; }\ngh() { node service.mjs '${file}' '${mode}' "$@"; }\n`+script];permitOfflineCommand('bash',args);
      await writeFile(join(root,'api-version.json'),await readFile('config/github-api.json'));
      const run=()=>spawnSync('bash',args,{cwd:root,env:{...process.env,GH_TOKEN:'offline',HEALTH_SOURCE_SHA:sourceSha,DEFAULT_BRANCH:'main',CURRENT_RUN_ID:'1',CURRENT_ATTEMPT:'2',HEALTH_ISSUE:'7',EXPECTED_PAUSED_RELEASE:['expected-pause','expected-other-paused'].includes(mode)?'311600220':mode==='wrong-pause-id'?'999':''},encoding:'utf8',timeout:60_000});
      const first=run(),successful=['healthy','business-failure','inactivity','dispatch-lost'].includes(mode)||(mode==='expected-pause'||(mode==='expected-other-paused'&&file==='sync-managed.yml'));
      expect(first.error).toBeUndefined();expect(first.status,first.stderr).toBe(successful?0:1);
      const requests=async()=> (await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      let calls=await requests();
      const writes=()=>calls.filter(x=>!['GET','LIST'].includes(x.method));
      const dispatches=()=>calls.filter(x=>x.method==='DISPATCH');
      if(['healthy','business-failure'].includes(mode))expect(writes()).toEqual([]);
      if(mode==='inactivity')expect(calls.filter(x=>x.path?.endsWith('/enable'))).toHaveLength(1);
      if(['manual-disable','expected-pause','wrong-pause-id','expected-other-paused','manual-race','unknown-state','workflow-unavailable','wrong-workflow','run-unavailable','missing-run-fields','future-run','invalid-time'].includes(mode)) {
        expect(calls.some(x=>x.path?.endsWith('/enable'))).toBe(false);expect(dispatches()).toHaveLength(0);
      }
      if(['overdue','old-running','dispatch-unknown','dispatch-lost'].includes(mode)){
        expect(dispatches()).toHaveLength(1);
        expect(dispatches()[0].args.includes('health_only=true')).toBe(other==='sync-managed.yml');
      }
      if(mode==='authentication')expect(writes()).toEqual([]);
      // Fixed errors are notified once; the Run link and changing observation IDs
      // do not create a second notification. A lost accepted comment is read back.
      if(['manual-disable','workflow-unavailable','run-unavailable'].includes(mode)) {
        const count=writes().length,second=run();expect(second.status).toBe(1);calls=await requests();expect(writes()).toHaveLength(count);
        const saved=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
        expect(saved.comments).toHaveLength(1);expect(saved.comments[0].body).toContain('https://github.com/splrad/steward/actions/runs/1');
      }
      if(mode==='expected-pause'||(mode==='expected-other-paused'&&file==='sync-managed.yml')) {
        const saved=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
        expect(saved.comments.at(-1).body).toContain('release.yml:WORKFLOW_PAUSED');
        const count=writes().length,second=run();expect(second.status).toBe(0);calls=await requests();
        expect(writes()).toHaveLength(count);expect(dispatches()).toHaveLength(0);
      }
      if(mode==='dispatch-lost') {
        const second=run();expect(second.status,second.stderr).toBe(0);calls=await requests();expect(dispatches()).toHaveLength(1);
      }
      if(mode==='dispatch-unknown') {
        const second=run();expect(second.status).toBe(1);calls=await requests();expect(dispatches()).toHaveLength(2);
        expect(JSON.parse(await readFile(join(root,'state.json'),'utf8')).comments).toHaveLength(1);
        const indices=calls.map((x,i)=>x.method==='DISPATCH'?i:-1).filter(i=>i>=0);
        expect(calls.slice(indices[0]!+1,indices[1]).some(x=>x.method==='LIST')).toBe(true);
      }
      expect(calls.some(x=>/\/(?:jobs|rerun|git)\b/.test(x.path??'')||x.path?.includes('created='))).toBe(false);
      expect(calls.filter(x=>x.method==='LIST').every(x=>x.args.includes('--limit')&&x.args[x.args.indexOf('--limit')+1]==='1')).toBe(true);
      expect(first.stdout).toBe('');
      if(process.env.STEWARD_OFFLINE_EVIDENCE) {
        await mkdir(process.env.STEWARD_OFFLINE_EVIDENCE,{recursive:true});
        await writeFile(join(process.env.STEWARD_OFFLINE_EVIDENCE,file+'-'+mode+'.json'),JSON.stringify({file,mode,
          scriptSha256:createHash('sha256').update(script).digest('hex'),firstStatus:first.status,requests:calls,
          initialState,finalState:JSON.parse(await readFile(join(root,'state.json'),'utf8')),assertions:'PASS'},null,2)+'\n');
      }
    } finally {await rm(root,{recursive:true,force:true});}
  },120_000);
}
