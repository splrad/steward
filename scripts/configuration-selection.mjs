import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import YAML from 'yaml';
import {adaptBuild,renderBuild,repositoryPath,scriptBuild,selectWorkflow} from './configuration-build.mjs';
import {changeChannels,ciPath,deliveryPath,jsonFile,pagesPath,publishPath,versionsPath} from './configuration-view.mjs';
import {parseDeliveryConfig,parseSupplementalNotes} from '../packages/runner/dist/index.js';

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
  let recipe;
  if(target.workflow) {
    must(/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(target.workflow) && model.files.has(target.workflow),'Missing declared source workflow');
    recipe=selectWorkflow(model.files.get(target.workflow),target);
  } else {
    const entry=repositoryPath(target.entry);
    must(model.files.has(posix.join(repositoryPath(target.directory,true),entry)), 'Missing declared packaging script '+entry);
    recipe=scriptBuild(target);
  }
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
    files.set(script,step.run+'\n');
    commands.push({shell:step.shell,script:'product/'+script,directory:step['working-directory']});
  }
  const bytes=[
    "import {spawnSync} from 'node:child_process';","import {resolve} from 'node:path';",
    'const steps = '+JSON.stringify(commands,null,2)+';',
    'for (const step of steps) {','  const file = resolve(step.script);',
    "  const args = {bash:['--noprofile','--norc','-eo','pipefail',file], sh:['-e',file],",
    "    pwsh:['-NoLogo','-NoProfile','-NonInteractive','-File',file], powershell:['-NoProfile','-NonInteractive','-File',file],",
    "    cmd:['/d','/c','call',file]}[step.shell];",
    "  const result = spawnSync(step.shell,args,{cwd:resolve(step.directory),stdio:'inherit'});",
    '  if (result.error) throw result.error;','  if (result.status !== 0) process.exit(result.status ?? 1);','}',''
  ].join('\n');
  files.set(path,bytes);
  return {path,recipe:{...recipe,tools},files,bytes};
}

export async function applySelection(model,operation,plan,context) {
  const changes=new Map(),targets=plan.targets??[];
  must(Array.isArray(targets),'Expected a list of build targets');
  const prepared=targets.map(target=>prepareTarget(model,target));
  must(new Set(prepared.map(item=>item.path)).size===prepared.length,'Duplicate build target');
  if(operation==='configure') for(const item of prepared) for(const [path,bytes] of item.files) changes.set(path,bytes);
  if(operation==='trial' || operation==='select') {
    must(targets.length && model.files.has(caller),'Missing protected build trial entry or target');
    for(const item of prepared) for(const [path,bytes] of item.files) must(model.files.get(path)===bytes,'Build command changed. Review the prepared entry at this head first.');
  }
  if(operation==='trial') {
    for(let i=0;i<targets.length;i++) await context.trial(targets[i],prepared[i].recipe);
    return changes;
  }
  let delivery=model.delivery;
  if(operation==='select') {
    const formal=[];
    delivery=structuredClone(delivery??{schemaVersion:2,repositoryAuthors:plan.repositoryAuthors,units:[]});
    const selectedUnits=new Set(targets.map(t=>t.unit));
    const allAssets=new Map();
    for(let i=0;i<targets.length;i++) {
      const target=targets[i], recipe=prepared[i].recipe;
      const entries=await context.inventory(target,recipe);
      if(!target.files?.length) {
        context.describe(target.unit+'/'+target.target+' 归档文件\n'+entries.map(e=>'- `'+e.path.replace(/[`\n<>]/g,'')+'` · '+e.size+' B').join('\n'));
        continue;
      }
      let unit=delivery.units.find(u=>u.id===target.unit);
      if(!unit) {
        const facts=plan.units?.find(u=>u.id===target.unit);
        must(facts && model.files.has(repositoryPath(facts.notesPath)),'Missing declared unit and notes');
        const {notesBody,...definition}=facts;
        unit={...definition,path:repositoryPath(facts.path,true),assets:[],channels:facts.channels??[]};
        delivery.units.push(unit);
      }
      const facts=plan.units?.find(u=>u.id===unit.id);
      if(facts?.buildLocks) {
        must(facts.buildLocks.every(p=>model.files.has(repositoryPath(p))),'Missing declared build lock');
        unit.buildLocks=facts.buildLocks;
      }
      for(const c of facts?.channels??[]) if(!unit.channels.some(old=>old.id===c.id)) unit.channels.push(c);
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
        const assets=allAssets.get(unit.id)??[];
        const {path:sourcePath,...declaration}=selected;
        if(declaration.rightsSource) must(model.files.has(repositoryPath(declaration.rightsSource)),'Missing asset rights source');
        const prior=unit.assets.find(a=>a.id===selected.id);
        assets.push({...prior,...declaration});
        allAssets.set(unit.id,assets);
        files.push({id:selected.id,path:selected.path,pattern:selected.name});
      }
      formal.push({unit:target.unit,target:target.target,recipe:{...recipe,steps:[...recipe.steps.filter(step=>step.uses),{name:'Run reviewed packaging entry',shell:'pwsh',run:'node product/'+prepared[i].path}]},files});
    }
    if(!formal.length) return changes;
    must(formal.length===targets.length,'Complete file choices for each target before applying formal configuration');
    for(const unit of delivery.units.filter(u=>selectedUnits.has(u.id))) {
      const retained=new Set((model.publish?.jobs?.build?.strategy?.matrix?.include??[])
        .filter(r=>r.unit===unit.id && !targets.some(t=>t.unit===r.unit && t.target===r.target)).flatMap(r=>r.assets));
      unit.assets=[...unit.assets.filter(a=>retained.has(a.id)),...allAssets.get(unit.id)];
    }
    changes.set(publishPath,model.files.has(publishPath)?adaptBuild(model.files.get(publishPath),context.seed,formal):
      renderBuild(context.seed,formal,{signing:plan.signing,controllerSha:context.controllerSha}));
    changes.set(deliveryPath,jsonFile(delivery));
  }
  if(plan.channels?.length) {
    delivery=changeChannels(delivery,plan.channels);
    changes.set(deliveryPath,jsonFile(delivery));
  }
  if(changes.has(deliveryPath)) (context.validateDelivery??parseDeliveryConfig)(structuredClone(delivery));
  if(plan.ci) {
    must(Array.isArray(plan.ci) && plan.ci.every(p=>model.workflows.some(w=>w.path===p && JSON.stringify(w.document.on).includes('pull_request'))),'Choose declared PR workflows');
    changes.set(ciPath,jsonFile(plan.ci));
  }
  if(plan.versions) {
    const manifestPath='.release-please-manifest.json';
    const manifest=JSON.parse(model.files.get(manifestPath)??'{}');
    for(const unit of plan.units??[]) if(unit.notesBody && !model.files.has(unit.notesPath)) {
      must(repositoryPath(unit.notesPath).startsWith('.release-notes/') && unit.notesPath.endsWith('.md'),'New notes belong in the release notes directory');
      parseSupplementalNotes(unit.notesBody,model.files.get('.github/release-template.md.mustache')??'');
      changes.set(unit.notesPath,unit.notesBody+'\n');
    }
    const config=structuredClone(model.versions??{'separate-pull-requests':false,packages:{}});
    for(const unit of plan.versions) {
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
      config.packages[path]={...config.packages[path],'release-type':unit.releaseType??config.packages[path]?.['release-type']??config['release-type']??'simple','version-file':version,'changelog-path':log};
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
    // Wrap the product's native condition. On re-edit remove only this generated outer condition.
    for(const [job,on] of [['build',plan.site.build],['deploy',plan.site.deploy]]) {
      if(!doc.hasIn(['jobs',job])) {must(!on,'Missing site job '+job);continue;}
      const path=['jobs',job,'if'];
      let condition=String(doc.getIn(path)??'success()');
      const prior=/^\((true|false) && (?:true|needs\.select\.outputs\.ready == 'true'|vars\.STEWARD_DOCS_SOURCE == '(?:default-branch|release)'(?: && vars\.STEWARD_DOCS_UNIT == '[a-z][a-z0-9-]*')?)\) && \(([\s\S]*)\)$/.exec(condition);
      if(prior) condition=prior[2];
      if(condition.startsWith('${{') && condition.endsWith('}}'))condition=condition.slice(3,-2).trim();
      const gate=job==='build'?(plan.site.source==='release'?"needs.select.outputs.ready == 'true'":'true'):
        "vars.STEWARD_DOCS_SOURCE == '"+plan.site.source+"'"+(plan.site.source==='release'?" && vars.STEWARD_DOCS_UNIT == '"+plan.site.unit+"'":'');
      doc.setIn(path,'('+on+' && '+gate+') && ('+condition+')');
    }
    changes.set(pagesPath,doc.toString({lineWidth:0}));
  }
  return new Map([...changes].filter(([path,bytes])=>model.files.get(path)!==bytes));
}
