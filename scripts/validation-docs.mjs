import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join,basename} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {validationInput,regular} from './validation-input.mjs';
import {resolvePolicyTool,renderLinkcheckFirewall,linkcheckEnvironment} from '../packages/runner/dist/index.js';
const check=(ok,reason)=>{if(!ok)throw Error('DOC_LINK_'+reason);};
export async function documentInputs(workspace,files,affected){
  const docs=files.filter(p=>/\.(?:md|mdx|html?)$/.test(p)),selected=new Set();
  const targets=[...new Set(affected.map(path=>basename(path)))];
  for(const path of docs){
    const file=await regular(workspace,path);
    if(affected.includes(path)){selected.add(path);continue;}
    const text=await readFile(file,'utf8');
    if(targets.some(target=>text.includes(target)))selected.add(path);
  }
  return [...selected].sort();
}
function execute(command,args,options){
  const r=spawnSync(command,args,{...options,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,timeout:15*60000});
  check(!r.error&&r.signal===null&&Number.isInteger(r.status),'TOOL_EXECUTION');return r;
}
export async function guardedNetworkCheck(run,nft,firewall,record){
  const tables=await nft(['--json','list','tables']);
  check(Array.isArray(tables.nftables)&&!tables.nftables.some(row=>row.table?.family==='inet'&&row.table.name==='splrad_linkcheck'),'FIREWALL_OWNERSHIP');
  await nft(['--check','--file',firewall]);
  await nft(['--file',firewall]);
  try{return await run();}
  finally{try{await record(await nft(['--json','list','table','inet','splrad_linkcheck']));}
    finally{await nft(['delete','table','inet','splrad_linkcheck']);}}
}
export function externalResults(report){
  check(report&&Number.isSafeInteger(report.total),'NETWORK_REPORT');
  const results=[];
  for(const [kind,map] of Object.entries(report).filter(([key])=>key.endsWith('_map'))){
    for(const [document,rows] of Object.entries(map??{}))for(const row of rows){
      if(!/^https?:\/\//.test(row.url??'')||kind==='redirect_map'||kind==='suggestion_map')continue;
      const code=row.status?.code;
      results.push({document,url:row.url,status:kind==='success_map'?'OK':[404,410].includes(code)?'REPAIR_REQUIRED':'UNKNOWN',nativeStatus:row.status});
    }
  }
  return results;
}
export async function main(env=process.env){
  const workspace=resolve(env.VALIDATION_WORKSPACE??'target'),{files,input}=await validationInput(workspace,env);
  const documents=await documentInputs(workspace,files,input.changedPaths);
  if(!documents.length){console.log('docs: no affected current document references');return;}
  const output=resolve(env.DOC_LINK_EVIDENCE??'doc-link-evidence');await mkdir(output,{recursive:true});
  await writeFile(join(output,'inputs.json'),JSON.stringify({input,documents},null,2)+'\n');
  const tool=await resolvePolicyTool('lychee'),config=fileURLToPath(new URL('../config/linkcheck/lychee.toml',import.meta.url));
  // Explicit trusted config, isolated cwd and minimal environment prevent candidate configuration/auth loading.
  const clean=linkcheckEnvironment(env),args=['--config',config,'--format','json','--no-progress','--root-dir',workspace,'--include-fragments=anchor-only'];
  const paths=documents.map(p=>join(workspace,p));
  const offline=execute(tool,[...args,'--scheme','file','--offline','--',...paths],{cwd:output,env:clean});
  await writeFile(join(output,'offline.json'),offline.stdout);await writeFile(join(output,'offline.stderr'),offline.stderr);
  check(offline.status===0,'LOCAL_REFERENCE');
  if(env.DOC_LINK_NETWORK!=='true'){console.log('docs: offline passed');return;}
  check(process.platform==='linux','NETWORK_PLATFORM');
  const current=paths.filter(p=>!/(?:^|[\\/])(?:archive|archives|history)(?:[\\/])/i.test(p));
  if(!current.length){console.log('docs: changed historical files passed local references');return;}
  const firewall=join(output,'egress.nft');
  await writeFile(firewall,renderLinkcheckFirewall(await readFile(new URL('../config/linkcheck/egress.nft',import.meta.url),'utf8'),await readFile('/etc/resolv.conf','utf8')));
  const nft=async parameters=>{
    const r=execute('sudo',['-n','nft',...parameters],{cwd:output,env:clean});
    check(r.status===0,'FIREWALL');return parameters.includes('--json')?JSON.parse(r.stdout):null;
  };
  const result=await guardedNetworkCheck(async()=>execute(tool,[...args,'--scheme','http','--scheme','https','--',...current],{cwd:output,env:clean}),nft,firewall,value=>writeFile(join(output,'counters.json'),JSON.stringify(value,null,2)));
  await writeFile(join(output,'network.json'),result.stdout);await writeFile(join(output,'network.stderr'),result.stderr);
  check([0,2].includes(result.status),'NETWORK_TOOL'); // Native broken-link status is evidence; infrastructure errors remain failures.
  const report=JSON.parse(result.stdout),external=externalResults(report);
  await writeFile(join(output,'external-results.json'),JSON.stringify(external,null,2)+'\n');
  const count=status=>external.filter(row=>row.status===status).length;
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,`DOC-LINK: local references passed; external OK ${report.successful}, repair required (404/410) ${count('REPAIR_REQUIRED')}, unknown ${count('UNKNOWN')}. See the native artifact for URLs and original responses.\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
