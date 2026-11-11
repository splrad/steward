import {parseAcceptanceTarget} from './bootstrap-acceptance.mjs';
import {replaceScanOutput} from './private-scan-output.mjs';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {chmodSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {validationInput,git} from './validation-input.mjs';
import {assert,loadPolicy,checkInventory,highFindings,requireOnline,actionFindings,newActions,newPackageFindings,newTools,assertInputScope,assertGovernanceOnlyScope,assertCopierInputs,licenseFacts} from './private-dependency-policy.mjs';
import {assertLifecycleScope,assertLifecycleSnapshot,lifecycleMiseVersions,assertLifecycleMissingActionLock} from './private-lifecycle-policy.mjs';
import {assertActionInputs,reusableActions,verifyReusableLock} from './private-reusable-actions.mjs';
import {miseFindings} from './private-tool-security.mjs';
import {scanTools,publicBytes} from './private-tool-security.mjs';
import {effectiveLock} from './private-lock-exception.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function run(command,args,cwd,env,accepted=[0]){
  const r=spawnSync(command,args,{cwd,env,encoding:'utf8',shell:false,windowsHide:true,timeout:180000,maxBuffer:64*1024*1024});
  if(r.error||!accepted.includes(r.status)){
    let stderr=r.stderr??'';
    for(const [key,value] of Object.entries({...process.env,...env})){
      if(/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION/i.test(key)&&value)stderr=stderr.split(value).join('[REDACTED]');
    }
    const error=Error('PRIVATE_DEPENDENCY_TOOL_FAILED_'+command.replace(/[^a-zA-Z0-9]/g,'_'));
    error.toolFailure={tool:command,exitStatus:r.status,signal:r.signal,errorCode:r.error?.code??null,stderr:stderr.slice(-4000)};
    throw error;
  }
  return r;
}
function cleanEnv(){
  const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','SSL_CERT_FILE','SSL_CERT_DIR'])
    if(process.env[key])env[key]=process.env[key];
  return env;
}
export async function github(path,token){
  assert(/^\/[A-Za-z0-9_%/?=&.,+:-]+$/.test(path),'API_PATH');
  const response=await fetch('https://api.github.com'+path,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000),redirect:'error'});
  assert(response.ok,'GITHUB_HTTP_'+response.status);return response.json();
}
export function tree(workspace,sha){
  return git(workspace,['ls-tree','-r','-z',sha]).toString().split('\0').filter(Boolean).map(line=>{
    const match=/^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);assert(match,'TREE_ENTRY');
    assert(match[1]==='100644'||match[1]==='100755','SYMLINK_OR_SUBMODULE');
    return {mode:match[1],oid:match[2],path:match[3]};
  });
}
function blob(workspace,entries,path,optional=false){
  const e=entries.find(e=>e.path===path);if(!e){assert(optional,'MISSING_'+path);return null;}
  assert(e.mode==='100644','EXECUTABLE_INPUT');return git(workspace,['cat-file','blob',e.oid]);
}
export function upstreamReference(text,item){
  const doc=YAML.parse(text),matches=[];
  for(const job of Object.values(doc.jobs??{}))for(const step of job.steps??[]){
    if(step.with?.repository!==item.upstream&&step.with?.path?.startsWith('.safe-settings-code'))assert(false,'UPSTREAM_PATH_COLLISION');
    if(step.with?.repository===item.upstream){
      assert(/^actions\/checkout@[a-f0-9]{40}$/.test(step.uses??''),'UPSTREAM_CHECKOUT');
      assert(step.with.path==='.safe-settings-code','UPSTREAM_PATH');
      assert(/^[a-f0-9]{40}$/.test(step.with.ref??''),'UPSTREAM_SHA');matches.push(step.with.ref);
    }
  }
  assert(matches.length===1,'UPSTREAM_REFERENCE');return matches[0];
}
async function upstreamFiles(item,sha,directory,token){
  const repo=await github(`/repos/${item.upstream}`,token);assert(repo.private===false,'UPSTREAM_PRIVATE');
  const evidence={repository:item.upstream,repositoryId:repo.id,sha,files:{}};
  for(const name of ['package.json','package-lock.json']){
    const response=await fetch(`https://raw.githubusercontent.com/${item.upstream}/${sha}/${name}`,{signal:AbortSignal.timeout(30000),redirect:'error'});
    assert(response.ok,'UPSTREAM_LOCK_HTTP_'+response.status);
    const body=Buffer.from(await response.arrayBuffer());assert(body.length<16*1024*1024,'UPSTREAM_SIZE');
    JSON.parse(body.toString());await writeFile(join(directory,name),body);evidence.files[name]=hash(body);
  }
  return evidence;
}
export function docker(image,entry,input,output,args,network=true){
  const groups=[];
  if(typeof process.getgid==='function'){
    // The pinned image runs from /root. With all capabilities dropped, UID 0
    // cannot write a runner-owned 0755 bind mount. Share only this output
    // directory with the runner's group; retain read-only input/rootfs.
    chmodSync(output,0o770);groups.push('--group-add',String(statSync(output).gid));
  }
  try{
    return run('docker',['run','--rm','--cap-drop=ALL',...groups,'--security-opt=no-new-privileges','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=128m',
      ...(network?[]:['--network=none']),'-v',`${input}:/input:ro`,'-v',`${output}:/out`,'--entrypoint',entry,image,...args],input,cleanEnv(),[0,1]);
  }catch(error){
    if(error.toolFailure)error.toolFailure.containerEntrypoint=entry;
    throw error;
  }
}
export function assertVerifiedActionTag(ref,matching){
  assert(matching.includes(ref)&&matching.every(tag=>tag===ref||tag.length<ref.length),'ZIZMOR_TAG_AMBIGUOUS');
}
const actionTags=new Map();
export async function actionsInventory(text,token){
  const lock=YAML.parse(text);assert(['v0.0.2','v0.0.3'].includes(lock.version)&&lock.dependencies&&lock.workflows,'ACTIONS_LOCK_FORMAT');
  const entries=[];
  for(const [key,value] of Object.entries(lock.dependencies)){
    const match=/^([\w.-]+\/[\w.-]+)(?:\/[^@]+)?@([^@]+)$/.exec(key);
    assert(match&&key.startsWith(match[1]+'@')&&/^sha1-[a-f0-9]{40}$/.test(value.commit??''),'ACTION_LOCK_ENTRY');
    // Verify server identity and ref/commit association; comments are never a version source.
    const repo=await github(`/repos/${match[1]}`,token);
    assert(!repo.private&&repo.id===value.repo_id&&repo.owner.id===value.owner_id,'ACTION_IDENTITY');
    assert(typeof value.ref==='string'&&/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.ref),'ACTION_VERSION_UNRESOLVED');
    const commit=await github(`/repos/${match[1]}/commits/${encodeURIComponent(value.ref)}`,token);
    assert(commit.sha===value.commit.slice(5),'ACTION_REF_MISMATCH');
    if(!actionTags.has(match[1])){
      const refs=run('git',['-c','credential.helper=','-c','core.hooksPath=','ls-remote','--tags',`https://github.com/${match[1]}.git`],process.cwd(),{...cleanEnv(),GIT_TERMINAL_PROMPT:'0'}).stdout;
      actionTags.set(match[1],refs.split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/)));
    }
    const matching=[...new Set(actionTags.get(match[1]).filter(([sha])=>sha===commit.sha).map(([,ref])=>ref.replace(/^refs\/tags\//,'').replace(/\^\{\}$/,'')))];
    // The upstream scanner chooses a longest matching tag. Require a unique longest tag equal to the verified ref,
    // rather than silently allowing its heuristic to select another release/version on the same commit.
    assertVerifiedActionTag(value.ref,matching);

    entries.push({key,repo:match[1],ref:value.ref,sha:commit.sha});
  }
  assert(entries.length>0,'ACTIONS_EMPTY');return entries;
}
export async function main(env=process.env){
  const out=resolve(env.PRIVATE_DEPENDENCY_EVIDENCE??'private-dependency-evidence');await mkdir(out,{recursive:true});
  const report={identity:null,scanner:null,snapshots:{},newHigh:[],coverage:[],complete:false};
  try{
    requireOnline(env);const workspace=resolve(env.VALIDATION_WORKSPACE??'target'),policy=await loadPolicy();
    const value=await validationInput(workspace,env);assert(['private-administrator','private-governance','private-lifecycle'].includes(value.dependencyMode),'NOT_APPLICABLE');
    const lifecycle=value.dependencyMode==='private-lifecycle';
    const governanceOnly=value.dependencyMode==='private-governance';
    const managedOnly=governanceOnly||lifecycle;
    report.identity=value.input;report.scanner=policy.osvImage;
    const item=managedOnly?null:policy.administrators.find(x=>x.repositoryId===value.input.repositoryId);
    const temporary=await mkdtemp(join(tmpdir(),'steward-private-dependencies-'));
    const supplier={nodeReleases:JSON.parse((await publicBytes('https://nodejs.org/dist/index.json')).toString()),
      nodeVulnerabilities:JSON.parse((await publicBytes('https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json')).toString()),miseAdvisories:[]};
    for(let page=1;page<=10;page++){const rows=await github(`/repos/jdx/mise/security-advisories?per_page=100&page=${page}`,env.GH_TOKEN);supplier.miseAdvisories.push(...rows);if(rows.length<100)break;assert(page<10,'MISE_ADVISORY_PAGINATION');}
    await writeFile(join(out,'supplier-data.json'),JSON.stringify(supplier));
    for(const side of ['base','head']){
      const sha=value.input[side],entries=tree(workspace,sha);(lifecycle?assertLifecycleScope:governanceOnly?assertGovernanceOnlyScope:assertInputScope)(entries.map(e=>e.path));const snapshot={sha,upstream:null,actions:[],coverage:[]};report.snapshots[side]=snapshot;
      const managedPaths=managedOnly?['AGENTS.md','CONTRIBUTING.md','.github/labeler.yml','.github/release-template.md.mustache','.github/workflows/pr-labeler.yml','.github/workflows/pr-title.yml']:['.github/labeler.yml','.github/workflows/pr-labeler.yml'];
      if(managedOnly&&side==='head')assert([...managedPaths,'.copier-answers.yml'].every(path=>entries.some(e=>e.path===path)),'GOVERNANCE_HEAD_INCOMPLETE');
      const files=new Map([...managedPaths,'.copier-answers.yml'].flatMap(path=>{
        const bytes=blob(workspace,entries,path,true);return bytes?[[path,bytes]]:[];
      }));
      assertCopierInputs(files,ref=>{
        // Resolve only a real version tag in the trusted policy checkout, never a target ref.
        const controller=fileURLToPath(new URL('..',import.meta.url));
        const sha=git(controller,['rev-parse','--verify','refs/tags/'+ref+'^{commit}']).toString('utf8').trim();
        assert(/^[a-f0-9]{40}$/.test(sha),'COPIER_TEMPLATE_SOURCE');
        git(controller,['merge-base','--is-ancestor',sha,'HEAD']);
        return new Map(managedPaths.map(path=>[path,git(controller,['show',sha+':templates/repository/'+(path==='CONTRIBUTING.md'?'CONTRIBUTING.md.jinja':path)])]));
      },managedPaths);
      const control=blob(workspace,entries,'acceptance/bootstrap-target.json',true);
      if(control){assert(control.length<=1024,'CONTROL_SIZE');parseAcceptanceTarget(control.toString('utf8'));}
      if(lifecycle)snapshot.application=await assertLifecycleSnapshot(new Map(entries.map(e=>[e.path,blob(workspace,entries,e.path)])),{side,controllerSha:env.WORKFLOW_SHA,verifyController:sha=>{
        const controller=fileURLToPath(new URL('..',import.meta.url));
        git(controller,['merge-base','--is-ancestor',sha,env.WORKFLOW_SHA]);return true;
      },loadControllerTemplate:(sha,path)=>{
        const controller=fileURLToPath(new URL('..',import.meta.url));
        git(controller,['merge-base','--is-ancestor',sha,env.WORKFLOW_SHA]);
        return git(controller,['show',sha+':'+path]);
      }});
      const input=join(temporary,side),output=join(out,side);await mkdir(input,{recursive:true});await mkdir(output,{recursive:true});
      const workflow=managedOnly?null:blob(workspace,entries,item.workflow,true);
      if(!workflow){
        // An empty seed has no upstream dependency. Never substitute head for missing base.
        assert(managedOnly||side==='base','HEAD_RUNTIME_MISSING');
        assert(!entries.some(e=>['safe-settings/upstream-lock-exception.json','safe-settings/upstream-package-lock.patch'].includes(e.path)),'LOCK_EXCEPTION_WITHOUT_RUNTIME');
        await writeFile(join(output,'osv.json'),JSON.stringify({results:[]}));
      }else{
        const ref=upstreamReference(workflow.toString(),item);
        snapshot.upstream=await upstreamFiles(item,ref,input,env.GH_TOKEN);
        snapshot.upstream.lockException=await effectiveLock({item,sourceSha:ref,directory:input,
          manifest:blob(workspace,entries,'safe-settings/upstream-lock-exception.json',true),
          patch:blob(workspace,entries,'safe-settings/upstream-package-lock.patch',true)});
        snapshot.upstream.effectiveLockSha256=hash(await readFile(join(input,'package-lock.json')));
        snapshot.upstream.callerWorkflowSha256=hash(workflow);
        snapshot.upstream.installationBoundary='Declared checkout and lock bytes verified; shell/install behavior remains under normal protected PR review.';
        await writeFile(join(input,'osv-scanner.toml'),'');
        docker(policy.osvImage,'/root/osv-scanner',input,output,['scan','source','--recursive','--no-ignore','--no-resolve','--all-packages','--licenses=','--config=/input/osv-scanner.toml','--format=json','--output-file=/out/osv.json','/input']);
        const scanned=JSON.parse(await readFile(join(output,'osv.json'),'utf8'));
        snapshot.inventory=checkInventory(JSON.parse(await readFile(join(input,'package-lock.json'),'utf8')),scanned);
        highFindings(scanned); // Unknown severity cannot disappear through a differential comparison.
      }
      // Existing native gh actions-lock verification remains mandatory in the governance job.
      const lock=blob(workspace,entries,'.github/workflows/actions.lock',managedOnly&&side==='base');
      if(!lock){
        if(lifecycle)assertLifecycleMissingActionLock(entries.map(e=>e.path),{side,application:snapshot.application.application});
        else assert(entries.every(e=>e.path==='README.md'),'GOVERNANCE_BASE_NOT_EMPTY');
      }
      const consumerActions=lock?await actionsInventory(lock.toString(),env.GH_TOKEN):[];
      snapshot.actions=[...consumerActions];
      const docs=[],documents=new Map(),workflowDocuments=new Map();
      const workflowInputs=entries.filter(e=>/^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.path)).map(e=>({path:e.path,bytes:blob(workspace,entries,e.path),actions:consumerActions}));
      const reusableSeen=new Set();snapshot.reusable=[];
      for(const e of workflowInputs){
        const text=e.bytes.toString();const doc=YAML.parse(text);workflowDocuments.set(e.path,doc);
        for(const job of Object.values(doc.jobs??{})){
          if(job.uses){
            assert(lifecycle,'REUSABLE_WORKFLOW_UNCOVERED');
            if(!reusableSeen.has(job.uses)){
              const nested=await reusableActions(job.uses,{
                loadSource:sha=>{
                  const controller=fileURLToPath(new URL('..',import.meta.url));
                  git(controller,['merge-base','--is-ancestor',sha,env.WORKFLOW_SHA]);
                  const sourceEntries=tree(controller,sha);
                  return new Map(sourceEntries.filter(e=>/^\.github\/workflows\/[^/]+\.(?:ya?ml|lock)$/.test(e.path)).map(e=>[e.path,blob(controller,sourceEntries,e.path)]));
                },
                verifyLock:(files,sha)=>verifyReusableLock(files,join(temporary,side+'-controller-'+sha),{
                  ...cleanEnv(),GH_TOKEN:env.GH_TOKEN,...(env.GH_CONFIG_DIR?{GH_CONFIG_DIR:env.GH_CONFIG_DIR}:{})},run),
                inventory:text=>actionsInventory(text,env.GH_TOKEN),
              });
              reusableSeen.add(job.uses);workflowInputs.push(nested);snapshot.actions.push(...nested.actions);
              snapshot.reusable.push({sha:nested.sha,sha256:hash(nested.bytes),lockSha256:nested.lockSha256,actions:nested.actions,native:nested.native});
            }
          }
        }
        assertActionInputs(doc,e.actions);
        const path=join(input,e.path);await mkdir(join(input,'.github/workflows'),{recursive:true});await writeFile(path,text);docs.push(path);documents.set(path,doc);
      }
      // Include every locked action, not only the top-level workflow uses.
      const inventoryPath=join(input,'locked-actions.yml');await writeFile(inventoryPath,YAML.stringify({name:'Locked action inventory',on:'push',permissions:{contents:'read'},jobs:{inventory:{'runs-on':'ubuntu-latest',steps:snapshot.actions.map(x=>({uses:`${x.repo}@${x.sha}`}))}}}));docs.push(inventoryPath);documents.set(inventoryPath,YAML.parse(await readFile(inventoryPath,'utf8')));
      const tool=env.PRIVATE_ZIZMOR;assert(tool,'TRUSTED_ZIZMOR_REQUIRED');
      const processEnv={...cleanEnv(),GH_TOKEN:env.GH_TOKEN};
      const result=run(tool,['--no-config','--no-ignores','--strict-collection','--no-progress','--color','never','--format=json-v1',...docs],temporary,processEnv,[0,11,12,13,14]);
      assert(!/offline mode|no audit was performed/i.test(result.stderr),'ONLINE_AUDIT_INCOMPLETE');
      const findings=JSON.parse(result.stdout);assert(Array.isArray(findings),'ZIZMOR_JSON');
      snapshot.actionsFindings=actionFindings(findings,documents);
      await writeFile(join(output,'zizmor.json'),result.stdout);
      if(entries.some(e=>e.path==='mise.toml'||e.path==='mise.lock')){
        snapshot.tools=await scanTools({workspace,entries,blob,input,output,documents:workflowDocuments,requiredWorkflow:item.workflow,env,run,docker,image:policy.osvImage,github,supplier});
      }else{
        assert(managedOnly||(side==='base'&&!workflow),'HEAD_TOOL_INPUT_MISSING');snapshot.tools={};
        if(lifecycle){
          const versions=lifecycleMiseVersions(workflowDocuments);
          for(const version of versions)await github(`/repos/jdx/mise/releases/tags/v${version}`,env.GH_TOKEN);
          snapshot.tools.mise={versions,findings:versions.flatMap(version=>miseFindings(version,supplier.miseAdvisories))};
        }
        await writeFile(join(output,'npm-tool.json'),JSON.stringify({results:[]}));
      }
      const upstreamResult=JSON.parse(await readFile(join(output,'osv.json'),'utf8'));
      const npmResult=JSON.parse(await readFile(join(output,'npm-tool.json'),'utf8'));
      upstreamResult.results.push(...npmResult.results);
      highFindings(upstreamResult);
      await replaceScanOutput(join(output,'osv.json'),upstreamResult);
    }
    const comparison=join(out,'comparison');await mkdir(comparison,{recursive:true});
    docker(policy.osvImage,'/root/osv-reporter',out,comparison,['--old=/input/base/osv.json','--new=/input/head/osv.json','--output-files=json:/out/new.json','--fail-on-vuln=false'],false);
    const difference=JSON.parse(await readFile(join(comparison,'new.json'),'utf8'));report.reporterNewHigh=highFindings(difference,{emptyReporter:true});
    const baseResult=JSON.parse(await readFile(join(out,'base/osv.json'),'utf8')),headResult=JSON.parse(await readFile(join(out,'head/osv.json'),'utf8'));
    report.newHigh=newPackageFindings(baseResult,headResult,difference);
    report.licenses=licenseFacts(baseResult,headResult);
    report.newActionVulnerabilities=newActions(report.snapshots.base.actionsFindings,report.snapshots.head.actionsFindings);
    report.newToolFindings=newTools(['node','mise'].flatMap(k=>report.snapshots.base.tools[k]?.findings??[]),['node','mise'].flatMap(k=>report.snapshots.head.tools[k]?.findings??[]));
    report.coverage=lifecycle?{npm:'exact dependency-free package and lock; no third-party npm packages',source:'normal Linux/Windows source jobs; trusted sample validation scripts',actions:'complete locked action inventory and online zizmor advisory audit',mise:'all declared workflow versions checked against supplier advisories',templates:'exact trusted Copier and updater contracts; trusted release workflow structure with validated action/mise/controller version slots'}:governanceOnly?{actions:'complete locked action inventory and online zizmor advisory audit',templates:'exact trusted version bytes; no product code, ecosystem manifests, administrator runtime or tool locks admitted'}:{node:'supplier security-wg',mise:'supplier repository advisories',npm:'verified release archive with bundled package reconciliation'};
    assert(report.newHigh.length===0,'NEW_HIGH_OR_CRITICAL');
    assert(!report.newActionVulnerabilities.some(x=>x.severity==='High'),'NEW_HIGH_ACTION');
    assert(!report.newToolFindings.some(x=>['HIGH','CRITICAL'].includes(x.severity)),'NEW_HIGH_TOOL');
    report.complete=true;return report;
  }catch(error){report.error=error.message;if(error.toolFailure)report.toolFailure=error.toolFailure;if(error.reusableSource)report.reusableSource=error.reusableSource;throw error;}
  finally{await writeFile(join(out,'summary.json'),JSON.stringify(report,null,2)+'\n');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
