import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {repositoryPath,scriptBuild,selectWorkflow,staticMatrixRows} from './configuration-build.mjs';

const key=/^[a-z][a-z0-9-]{0,63}$/;
const must=(condition,message)=>{if(!condition)throw Error(message);};
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const trialKey=(head,unit,target,recipe)=>digest(JSON.stringify([head,unit,target,recipe.runner,recipe.output,recipe.tools,recipe.steps]));
export const actionPath=(unit,target)=>{
  must(key.test(unit)&&key.test(target),'Invalid unit or target');
  return '.github/actions/configuration/'+unit+'/'+target+'/run.mjs';
};

export function prepareTarget(model,target) {
  const path=actionPath(target.unit,target.target);
  if(target.workflow) {
    must(/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(target.workflow) && model.files.has(target.workflow),'Missing declared source workflow');
    try {return prepareScripts(path,selectWorkflow(model.files.get(target.workflow),target));}
    catch(error) {
      const job=model.workflows.find(w=>w.path===target.workflow)?.document?.jobs?.[target.job];
      must(job && target.archive && job.steps?.some(s=>/^actions\/upload-artifact@[0-9a-f]{40}$/.test(s.uses??'')),error.message);
      const native={workflow:target.workflow,job:target.job,matrix:target.matrix??{},archive:target.archive};
      if(target.nativeJobName) native.nativeJobName=target.nativeJobName;
      if(target.uploadStep) native.uploadStep=target.uploadStep;
      if(target.nativeEvent) native.nativeEvent=target.nativeEvent;
      if(target.nativeRef) native.nativeRef=target.nativeRef;
      return {path,files:new Map(),recipe:{native,runner:'ubuntu-24.04',steps:[]}};
    }
  }
  const entry=repositoryPath(target.entry);
  must(model.files.has(posix.join(repositoryPath(target.directory,true),entry)), 'Missing declared packaging script '+entry);
  return prepareScripts(path,scriptBuild(target));
}

function prepareScripts(path,recipe) {
  const directory=posix.dirname(path), files=new Map(), commands=[], tools={};
  const allowed={
    'actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68':['dotnet','dotnet-version','global-json-file'],
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020':['node','node-version','node-version-file']
  };
  for(const [index,step] of recipe.steps.entries()) {
    if(step.uses) {
      const spec=allowed[step.uses];
      must(spec && !commands.length && !tools[spec[0]] && Object.keys(step.with??{}).every(k=>spec.slice(1).includes(k)),
        'Tool preparation requires a supported pinned setup or a reviewed repository preparation command');
      tools[spec[0]]=step.with??{};
      continue;
    }
    const ext={bash:'sh',sh:'sh',pwsh:'ps1',powershell:'ps1',cmd:'cmd'}[step.shell];
    const script=directory+'/'+(index+1)+'-'+step.shell+'.'+ext;
    const powershell=step.shell==='pwsh' || step.shell==='powershell';
    files.set(script,powershell?"$ErrorActionPreference = 'Stop'\n"+step.run+"\nif (Test-Path variable:global:LASTEXITCODE) { exit $global:LASTEXITCODE }\n":step.run+'\n');
    commands.push({shell:step.shell,script:'product/'+script,directory:step['working-directory']});
  }
  const bytes=[
    "import {spawnSync} from 'node:child_process';","import {resolve} from 'node:path';","import {readFileSync} from 'node:fs';",
    'const steps = '+JSON.stringify(commands,null,2)+';',
    "const commands = ['GITHUB_ENV','GITHUB_PATH'].map(key=>process.env[key]).filter(Boolean);",
    "const reads = () => commands.map(path=>readFileSync(path));",
    'for (const [index,step] of steps.entries()) {','  const before = reads();','  const file = resolve(step.script);',
    "  const args = {bash:['--noprofile','--norc','-eo','pipefail',file], sh:['-e',file],",
    "    pwsh:['-NoLogo','-NoProfile','-NonInteractive','-File',file], powershell:['-NoProfile','-NonInteractive','-File',file],",
    "    cmd:['/d','/c','call',file]}[step.shell];",
    "  const result = spawnSync(step.shell,args,{cwd:resolve(step.directory),stdio:'inherit'});",
    '  if (result.error) throw result.error;','  if (result.status !== 0) process.exit(result.status ?? 1);',
    "  if(index+1<steps.length && reads().some((after,i)=>!before[i].equals(after))) throw Error('Cross-step environment changes require a native product workflow');",'}',''
  ].join('\n');
  files.set(path,bytes);
  return {path,recipe:{...recipe,tools},files,bytes};
}

export function channelUploadSteps(job,id,mode,unitId,channelId,row) {
  const resolve=value=>String(value??'').replace(/\$\{\{\s*(matrix\.unitId|matrix\.channelId|inputs\.mode)\s*\}\}/g,
    (_,field)=>field==='inputs.mode'?mode:String(row[field.slice(7)]??''));
  if(resolve(job.name??id)!==mode+'/'+channelId+'/'+unitId)return [];
  const receipt='channel-${{ inputs.request_key }}-'+unitId+'-'+channelId+'-${{ github.run_id }}-${{ github.run_attempt }}';
  return (job.steps??[]).filter(step=>/^actions\/upload-artifact@[a-f0-9]{40}$/.test(step.uses??'')
    && resolve(step.with?.name)===receipt && step.with?.path==='report.json');
}

export function assertChannelWorkflow(workflow,targets,nativeJobs=new Set()) {
  const dispatch=workflow?.on?.workflow_dispatch, required=['cycle_id','source_sha','execution_sha','controller_sha','targets_json','mode','operation_key','request_key'];
  must(dispatch && Object.keys(workflow.on).length===1 && required.every(k=>dispatch.inputs?.[k]?.type==='string' && dispatch.inputs[k].required===true)
    && workflow['run-name']==='Channels ${{ inputs.mode }} ${{ inputs.request_key }}','渠道入口必须声明原生调度输入和运行名');
  for(const {unitId,channelId} of targets) for(const mode of ['submit','verify']) {
    const name=mode+'/'+channelId+'/'+unitId;
    const matches=Object.entries(workflow.jobs??{}).flatMap(([id,job])=>{
      // Dynamic matrices are supplied by the product's runtime. Static ones must actually contain the target.
      const declared=staticMatrixRows(job.strategy?.matrix);
      if(!declared && !nativeJobs.has(name)) return [];
      const rows=declared??[{unitId,channelId}];
      return rows.flatMap(row=>channelUploadSteps(job,id,mode,unitId,channelId,row));
    });
    must(matches.length===1,'缺少唯一的渠道作业或原生回执 '+name);
  }
}
