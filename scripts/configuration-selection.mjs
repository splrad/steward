import {productCITriggerGap} from './validation-input.mjs';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import YAML from 'yaml';
import {adaptBuild,renderBuild,repositoryPath,scriptBuild,selectWorkflow,staticMatrixRows} from './configuration-build.mjs';
import {changeChannels,channelWorkflowPath,ciPath,deliveryPath,explicitDelivery,jsonFile,managedPagesCondition,pagesPath,publishPath,versionsPath} from './configuration-view.mjs';
import {releaseAdoptionPlan} from './release-adoption.mjs';
import {assertRegisteredAdapters,parseDeliveryConfig,parseSupplementalNotes} from '../packages/runner/dist/index.js';

const key=/^[a-z][a-z0-9-]{0,63}$/;
const caller='.github/workflows/repository-configuration-trial.yml';
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

export async function applySelection(model,operation,plan,context) {
  const changes=new Map(),targets=[],prepared=[],formal=[];
  const requested=plan.targets??[];
  must(Array.isArray(requested),'Expected a list of build targets');
  for(const target of requested) {
    try {
      if(operation==='select' && !target.files?.length) throw Error('Select files from a verified archive');
      const item=prepareTarget(model,target);
      if(operation==='select' || operation==='trial') for(const [path,bytes] of item.files)
        must(model.files.get(path)===bytes,'Prepare and review the product entry at this head first');
      prepared.push(item);targets.push(target);
    } catch(error) {
      if(!context.describe) throw error;
      context.describe(target.unit+'/'+target.target+' · '+error.message);
    }
  }
  must(new Set(prepared.map(item=>item.path)).size===prepared.length,'Duplicate build target');
  if(operation==='configure') for(const item of prepared) for(const [path,bytes] of item.files) changes.set(path,bytes);
  if(operation==='trial' || operation==='select') {
    if(prepared.some(item=>!item.recipe.native)) must(model.files.has(caller),'Missing protected build trial entry or target');
    for(const item of prepared) for(const [path,bytes] of item.files) must(model.files.get(path)===bytes,'Build command changed. Review the prepared entry at this head first.');
  }
  if(operation==='trial') {
    for(let i=0;i<targets.length;i++) await context.trial(targets[i],prepared[i].recipe);
    return changes;
  }
  let delivery=model.delivery;
  if(operation==='select') {
    const declaredChannels=(unit,facts)=>(facts?.channels??[]).filter(c=>
      !(plan.channels??[]).some(edit=>edit.unit===unit && edit.id===c.id && edit.sources));
    delivery=explicitDelivery(delivery??{schemaVersion:2,repositoryAuthors:plan.repositoryAuthors,units:[]});
    const allAssets=new Map();
    for(let i=0;i<targets.length;i++) {
      const target=targets[i], recipe=prepared[i].recipe;
      try {
        const entries=await context.inventory(target,recipe);
        const existingUnit=delivery.units.find(u=>u.id===target.unit);
        let unit=structuredClone(existingUnit);
        const assets=[];
        if(!unit) {
          const facts=plan.units?.find(u=>u.id===target.unit);
          must(facts && model.files.has(repositoryPath(facts.notesPath)),'Missing declared unit and notes');
          const {notesBody,...definition}=facts;
          unit={...definition,path:repositoryPath(facts.path,true),assets:[],channels:declaredChannels(target.unit,facts)};
        }
        const facts=plan.units?.find(u=>u.id===unit.id);
        if(facts?.buildLocks) {
          must(facts.buildLocks.every(p=>model.files.has(repositoryPath(p))),'Missing declared build lock');
          unit.buildLocks=facts.buildLocks;
        }
        for(const c of declaredChannels(unit.id,facts)) if(!unit.channels.some(old=>old.id===c.id)) unit.channels.push(c);
        const cfg=model.versions?.packages?.[unit.path];
        must(cfg,'Missing Release Please package '+unit.path);
        const versionFile=cfg['version-file']??model.versions['version-file'];
        must(versionFile && model.files.has(posix.join(unit.path,repositoryPath(versionFile))),'Missing declared version file');
        const version=model.files.get(posix.join(unit.path,versionFile)).trim();
        const files=[];
        for(const selected of target.files) {
          const name=selected.name.replaceAll('${version}',version);
          must(key.test(selected.id) && entries.some(e=>e.path===selected.path)
            && posix.basename(selected.path)===name,'Archive path or confirmed versioned filename changed: '+selected.path);
          const {path:sourcePath,...declaration}=selected;
          if(declaration.rightsSource) must(model.files.has(repositoryPath(declaration.rightsSource)),'Missing asset rights source');
          const prior=unit.assets.find(a=>a.id===selected.id);
          assets.push({...prior,...declaration});
          files.push({id:selected.id,path:selected.path,pattern:selected.name});
        }
        if(existingUnit) delivery.units[delivery.units.indexOf(existingUnit)]=unit;
        else delivery.units.push(unit);
        allAssets.set(unit.id,[...(allAssets.get(unit.id)??[]),...assets]);
        formal.push({unit:target.unit,target:target.target,recipe:recipe.native?recipe:{...recipe,steps:[...recipe.steps.filter(step=>step.uses),{name:'Run reviewed packaging entry',shell:'pwsh',run:'node product/'+prepared[i].path}]},files});
      } catch(error) {
        if(!context.describe || error.status && ![404,410].includes(error.status) || error.code) throw error;
        context.describe(target.unit+'/'+target.target+' · '+error.message);
      }
    }
    if(!formal.length) return changes;

    for(const unit of delivery.units.filter(u=>formal.some(t=>t.unit===u.id))) {
      const retained=new Set((model.publish?.jobs?.build?.strategy?.matrix?.include??[])
        .filter(r=>r.unit===unit.id && !formal.some(t=>t.unit===r.unit && t.target===r.target)).flatMap(r=>r.assets));
      unit.assets=[...unit.assets.filter(a=>retained.has(a.id)),...allAssets.get(unit.id)];
    }
    const existing=model.files.get(publishPath);
    const pristine=existing?.replaceAll('\r\n','\n')===context.seed.replaceAll('\r\n','\n');
    changes.set(publishPath,existing && !pristine?adaptBuild(existing,context.seed,formal,context.controllerSha):
      renderBuild(context.seed,formal,{signing:plan.signing,controllerSha:context.controllerSha}));
    changes.set(deliveryPath,jsonFile(delivery));
  }
  const channelEdits=(plan.channels??[]).flatMap(edit=>{
    if(operation==='select' && requested.some(t=>t.unit===edit.unit) && !formal.some(t=>t.unit===edit.unit)) return [];
    if(operation!=='select' || !edit.artifactIds) return [edit];
    const unit=delivery?.units.find(u=>u.id===edit.unit);
    const accepted=edit.sources?.filter(s=>formal.some(t=>t.unit===edit.unit && t.target===s.target && t.files.some(f=>f.id===s.assetId)));
    if(accepted && !accepted.length) return [];
    const chosen=accepted?[...new Set([...(edit.existingIds??[]),...accepted.map(s=>s.assetId)])]:edit.artifactIds;
    const artifactIds=chosen.filter(id=>unit?.assets.some(a=>a.id===id));
    if(accepted && unit && !unit.channels.some(c=>c.id===edit.id))
      unit.channels.push({id:edit.id,location:edit.location,required:false});
    if(!artifactIds.length && edit.required && edit.artifactIds.length) return [];
    return [{...edit,artifactIds}];
  });
  if(channelEdits.length) {
    delivery=changeChannels(delivery,channelEdits);
    changes.set(deliveryPath,jsonFile(delivery));
  }
  if(changes.has(deliveryPath)) {
    const normalized=parseDeliveryConfig(delivery);
    const adoption=releaseAdoptionPlan(normalized);
    if(adoption.externalTargets.length) {
      const existing=model.files.has(channelWorkflowPath);
      const source=model.workflows.find(w=>w.path===(existing?channelWorkflowPath:plan.channelWorkflow));
      must(source,'请选择已审阅的本仓渠道工作流：'+adoption.externalTargets.map(t=>t.unitId+'/'+t.channelId+' '+t.location).join('、'));
      const dynamic=Object.values(source.document?.jobs??{}).some(job=>staticMatrixRows(job.strategy?.matrix)===null);
      const nativeJobs=dynamic?await context.channelEvidence?.(source,adoption.externalTargets):undefined;
      assertChannelWorkflow(source.document,adoption.externalTargets,nativeJobs);
      if(!existing) changes.set(channelWorkflowPath,model.files.get(source.path));
    }
    for(const path of adoption.files) must(changes.has(path)||model.files.has(path),'缺少本仓采用文件 '+path);
    if(context.repo) for(const target of adoption.externalTargets) {
      const unit=normalized.units.find(u=>u.id===target.unitId);
      try {
        assertRegisteredAdapters(context.repo.id,context.repo.full_name,{units:[{...unit,channels:unit.channels.filter(c=>c.id==='github-release'||c.id===target.channelId)}]});
      } catch(error) {
        context.describe?.(target.unitId+'/'+target.channelId+' · '+target.location+' · 待满足发布前提：'+error.message);
      }
    }
  }
  if(plan.ci) {
    must(Array.isArray(plan.ci) && plan.ci.length>0,'请选择至少一个产品工作流');
    for(const path of plan.ci) {
      const workflow=model.workflows.find(w=>w.path===path);
      must(workflow,'未找到产品工作流 '+path);
      const gap=productCITriggerGap(workflow,model.defaultBranch);
      must(!gap,'产品工作流 '+path+' · '+gap);
    }
    changes.set(ciPath,jsonFile(plan.ci));
  }
  if(plan.versions) {
    const manifestPath='.release-please-manifest.json';
    const manifest=JSON.parse(model.files.get(manifestPath)??'{}');
    const configuredUnits=(plan.units??[]).filter(u=>!requested.some(t=>t.unit===u.id) || targets.some(t=>t.unit===u.id));
    for(const unit of configuredUnits) if(unit.notesBody && !model.files.has(unit.notesPath)) {
      must(repositoryPath(unit.notesPath).startsWith('.release-notes/') && unit.notesPath.endsWith('.md'),'New notes belong in the release notes directory');
      parseSupplementalNotes(unit.notesBody,model.files.get('.github/release-template.md.mustache')??'');
      changes.set(unit.notesPath,unit.notesBody+'\n');
    }
    const config=structuredClone(model.versions??{'separate-pull-requests':false,packages:{}});
    for(const unit of plan.versions.filter(v=>!(plan.units??[]).some(u=>u.path===v.path) || configuredUnits.some(u=>u.path===v.path))) {
      const path=repositoryPath(unit.path,true), version=repositoryPath(unit.versionFile), log=repositoryPath(unit.changelog);
      const versionPath=posix.join(path,version),logPath=posix.join(path,log);
      must(model.files.has(versionPath),'Missing declared version file '+versionPath);
      if(!model.files.has(logPath)) {
        must(typeof unit.logBody==='string' && unit.logBody.trim() && /\.md$/i.test(logPath),'Supply the missing changelog '+logPath);
        changes.set(logPath,unit.logBody+'\n');
      }
      if(!Object.hasOwn(manifest,path)) {
        const bytes=model.files.get(versionPath)??await context.readSource?.(versionPath);
        const current=bytes?.trim();
        must(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(current??''),'Confirm the current version of '+versionPath);
        manifest[path]=current;
        changes.set(manifestPath,jsonFile(manifest));
      }
      const tagPolicy={};
      if(!config.packages[path] && unit.component && !config.component && config['include-component-in-tag']!==false) {
        if(unit.noComponent) tagPolicy['include-component-in-tag']=false;
        else tagPolicy.component=unit.component;
      }
      config.packages[path]={...tagPolicy,...config.packages[path],'release-type':unit.releaseType??config.packages[path]?.['release-type']??config['release-type']??'simple','version-file':version,'changelog-path':log};
    }
    changes.set(versionsPath,jsonFile(config));
  }
  if(plan.site) {
    const doc=YAML.parseDocument(model.files.get(pagesPath)??'');
    must(doc.getIn(['jobs','build','steps']) && typeof plan.site.build==='boolean' && typeof plan.site.deploy==='boolean','Missing site workflow or selections');
    must(!plan.site.deploy || plan.site.build,'Public deployment requires site build');
    must(['default-branch','release'].includes(plan.site.source),'Invalid site source');
    if(plan.site.source==='release') must(delivery?.units.some(u=>u.id===plan.site.unit),'Unknown site release unit');
    doc.setIn(['env','STEWARD_DOCS_SOURCE'],plan.site.source);
    if(plan.site.source==='release') doc.setIn(['env','STEWARD_DOCS_UNIT'],plan.site.unit);
    else doc.deleteIn(['env','STEWARD_DOCS_UNIT']);
    const title=doc.get('run-name');
    if(typeof title==='string') doc.set('run-name',title.replace(
      /inputs\.source_mode \|\| (?:vars\.STEWARD_DOCS_SOURCE|'default-branch'|'release')(?: \|\| 'default-branch')?/g,
      "inputs.source_mode || '"+plan.site.source+"'"));
    // Wrap the product's native condition. On re-edit remove only this generated outer condition.
    for(const [job,on] of [['build',plan.site.build],['deploy',plan.site.deploy]]) {
      if(!doc.hasIn(['jobs',job])) {must(!on,'Missing site job '+job);continue;}
      const path=['jobs',job,'if'];
      let condition=String(doc.getIn(path)??'success()');
      const prior=managedPagesCondition.exec(condition);
      if(prior) condition=prior[2];
      if(condition.startsWith('${{') && condition.endsWith('}}'))condition=condition.slice(3,-2).trim();
      const gate=job==='build' && plan.site.source==='release'?"needs.select.outputs.ready == 'true'":'true';
      doc.setIn(path,'('+on+' && '+gate+') && ('+condition+')');
    }
    changes.set(pagesPath,doc.toString({lineWidth:0}));
  }
  return new Map([...changes].filter(([path,bytes])=>model.files.get(path)!==bytes));
}
