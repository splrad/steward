import {productCITriggerGap,selectableProductCI,workflowEvent} from './validation-input.mjs';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {matrixValue,staticMatrixRows,supportedArchiveName} from './configuration-build.mjs';
import {channelWorkflowPath,effectiveChannels,pagesChoices,renderConfiguration} from './configuration-view.mjs';
const key=text=>createHash('sha256').update(text).digest('hex').slice(0,16);
const display=text=>String(text??'').replace(/[\r\n<>`]/g,' ');
const token=field=>'<!-- cfg '+field+' -->';
const ensure=(v,message)=>{if(!v)throw Error(message);};

export function candidates(model,values) {
  const entries=[];
  for(const workflow of model.workflows) {
    if(!workflow.document?.jobs || /\/steward-release-|\/pages\.ya?ml$/.test(workflow.path))continue;
    for(const [job,spec] of Object.entries(workflow.document.jobs)) {
      const matrix=spec.strategy?.matrix;
      const rows=staticMatrixRows(matrix);
      const uploads=(spec.steps??[]).filter(s=>s.uses?.startsWith('actions/upload-artifact@'));
      for(const [index,step] of uploads.entries()) {
        if(!supportedArchiveName(step.with?.name??'artifact'))
          entries.push({locked:true,label:workflow.path+' · '+job+' · 第 '+(index+1)+' 个上传步骤的归档名需要固定文本、矩阵字段或 GitHub 的 run_id、run_number、run_attempt。'});
      }

      if(!rows) {
        const variants=(model.nativeVariants??[]).filter(v=>v.workflow===workflow.path && v.job===job);
        for(const {observedArchive,...v} of variants) entries.push({...v,id:'d'+key(JSON.stringify(v)),matrix:{},label:workflow.path+' · '+v.nativeJobName+' · '+(observedArchive??v.archive)});
        if(!variants.length) entries.push({locked:true,label:workflow.path+' · '+job+' · 请先在当前源提交完成动态矩阵作业并上传可核验的归档。'});
        continue;
      }
      for(const row of rows) {
        const id='w'+key(workflow.path+' '+job+' '+JSON.stringify(row));
        for(const [index,step] of (uploads.length?uploads:[null]).entries()) {
          const declared=step?(step.with?.name??'artifact'):'';
          if(!supportedArchiveName(declared))continue;
          let archive=declared;
          try {archive=matrixValue(declared,row);} catch { /* An unresolved input remains editable for native evidence. */ }
          entries.push({id:id+'a'+index,workflow:workflow.path,job,matrix:row,archive,step,
            label:workflow.path+' · '+job+(Object.keys(row).length?' · '+Object.entries(row).map(([k,v])=>k+'='+v).join(' '):'')});
        }
      }
    }
  }
  let n=1;
  while(values['s'+n+'.use'] || values['s'+n+'.entry']) n++;
  for(let i=1;i<=n;i++) entries.push({id:'s'+i,label:'仓内打包脚本 '+i});
  return entries;
}

const metadataFiles=['sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'];
function channelSelection(delivery,unit,c) {
  return {ids:c.artifactIds??(!c.required && delivery.schemaVersion===2?[]:unit.assets.filter(a=>c.id!=='winget'||/\.(exe|msi|msix|appx|msixbundle|appxbundle)$/i.test(a.name)).map(a=>a.id)),
    metadata:c.metadata??(delivery.schemaVersion===1 && c.id!=='winget'?metadataFiles:[])};
}

function unitDefaults(model,entry,values) {
  const id=entry.id, raw=values[id+'.unit']??'';
  const unit=model.delivery?.units.find(u=>u.id===raw);
  const path=values[id+'.path']??unit?.path??'';
  const config=model.versions?.packages?.[path];
  return {raw,path,notes:unit?.notesPath??'',version:config?.['version-file']??model.versions?.['version-file']??'',
    changelog:config?.['changelog-path']??model.versions?.['changelog-path']??''};
}

export function configurationForm(model,head,state={}) {
  const values={...state.values},items=[], lines=[];
  const site=pagesChoices(model.pages);
  for(const [field,env] of [['source','STEWARD_DOCS_SOURCE'],['unit','STEWARD_DOCS_UNIT']]) {
    if(!site[field] && values['site.'+field]===model.pages?.env?.[env])delete values['site.'+field];
  }
  const field=(id,label,initial='',type='text')=>{
    const value=values[id]??initial;
    items.push({id,type,value});
    if(type==='check') lines.push('- ['+(value?'x':' ')+'] '+label+' '+token(id));
    else {
      const fence='~'.repeat(Math.max(3,...String(value).split('\n').map(l=>(/^~+/.exec(l)?.[0].length??0)+1)));
      lines.push(label+' '+token(id),fence+'text',String(value),fence);
    }
  };
  // Summarize adopted settings as values. Every editable control below has a real operation.
  lines.push(renderConfiguration(model,head).replace(/^- \[x\] /gm,'- ✓ ').replace(/^- \[ \] /gm,'- ○ '),'',
    '### 调整配置','','在本张 PR 勾选入口，编辑字段后保存。准备入口后可试跑，运行完成后选择归档文件和发布渠道。');
  for(const workflow of model.workflows) {
    const gap=productCITriggerGap(workflow,model.defaultBranch);
    if(gap) {
      const triggers=workflow.document?.on;
      if(model.ci.includes(workflow.path) || (workflow.path!=='.github/workflows/pr-validation-native.yml' &&
        workflowEvent(triggers,'push') && ['opened','synchronize','reopened'].some(action=>workflowEvent(triggers,'pull_request',action))))
        lines.push('- 🔒 PR 验证 · `'+display(workflow.path)+'` · '+display(gap));
      continue;
    }
    field('ci.'+key(workflow.path),'PR 验证 · `'+display(workflow.path)+'`',model.ci.includes(workflow.path),'check');
  }
  const entries=candidates(model,values);
  for(const entry of entries) {
    if(entry.locked){lines.push('- 🔒 '+display(entry.label));continue;}
    const id=entry.id,defaults=unitDefaults(model,entry,values);
    field(id+'.use',display(entry.label),false,'check');
    if(!values[id+'.use']) continue;
    field(id+'.unit','发行单元 ID',defaults.raw);
    field(id+'.target','目标 ID');
    field(id+'.path','发行单元目录（相对于仓库根目录）',defaults.path);
    field(id+'.notes','发行单元说明文件',defaults.notes);
    if(values[id+'.notes'] && !model.files.has(values[id+'.notes'])) field(id+'.notesBody','新说明的 Markdown 正文（概述和更新内容）');
    if(values[id+'.changelog'] && !model.files.has(posix.join(defaults.path,values[id+'.changelog']))) field(id+'.logBody','新变更日志的起始正文');
    const existingUnit=model.delivery?.units.find(u=>u.id===defaults.raw);
    field(id+'.locks','构建锁文件（每行一个仓根相对路径；无锁时输入 []）',existingUnit?.buildLocks?.join('\n')??'');
    const versionPolicy=model.versions?.packages?.[defaults.path];
    if(!versionPolicy) field(id+'.component','新单元的标签组件（勾选使用无组件标签时可留空）',defaults.raw);
    if(!versionPolicy) field(id+'.noComponent','新单元使用无组件前缀的版本标签',false,'check');
    field(id+'.version','版本文件（相对于单元目录）',defaults.version);
    field(id+'.changelog','变更日志（相对于单元目录）',defaults.changelog);
    if(entry.workflow) {
      field(id+'.archive','该作业上传的归档名',entry.archive);
      field(id+'.ref','原生运行的分支或标签（同一提交有多个来源时填写）');
      const spec=model.workflows.find(w=>w.path===entry.workflow).document.jobs[entry.job];
      lines.push('已声明 runner · `'+display(spec['runs-on']??spec.uses)+'`');
      for(const step of spec.steps??[]) lines.push('- `'+display(step['working-directory']??spec.defaults?.run?.['working-directory']??'.')+'` · `'+display(step.run??step.uses)+'`');
    } else {
      field(id+'.entry','打包脚本路径（相对于工作目录）');
      field(id+'.runner','GitHub 托管 runner');
      field(id+'.shell','Shell');
      field(id+'.directory','工作目录（相对于仓库根目录）');
      field(id+'.prepare','工具准备命令（已就绪可留空）');
      field(id+'.command','打包命令');
      field(id+'.output','输出目录（相对于工作目录）');
    }
    const evidence=state.evidence?.[id];
    if(evidence?.head===head) {
      lines.push('归档 · [查看原生运行]('+evidence.url+')');
      if(evidence.binding?.nativeEvent) lines.push('正式构建使用发行源提交，重新核验 `'+display(evidence.binding.nativeEvent)+'` 运行（`'+display(evidence.binding.nativeRef)+'`）、`'+display(evidence.binding.nativeJobName)+'` 作业，并按该次运行确定归档名。本次验证的归档为 `'+display(evidence.binding.evidenceArchive)+'`。');
      for(const file of evidence.files) {
        const asset=id+'.f'+key(file.path);
        field(asset+'.use','`'+display(file.path)+'` · '+file.size+' B',false,'check');
        if(!values[asset+'.use']) continue;
        const known=model.delivery?.units.find(u=>u.id===defaults.raw)?.assets.find(a=>a.name===posix.basename(file.path));
        field(asset+'.id','资产 ID',known?.id??'');
        field(asset+'.name','发行文件名（可用 `${version}`）',known?.name??posix.basename(file.path));
        field(asset+'.type','媒体类型',known?.mediaType??'application/octet-stream');
        field(asset+'.inspection','检查方式（pe、dll-zip、font-zip、wheel、sdist、zip、tar-gzip、node-package）',known?.inspection??'');
        field(asset+'.members','已声明的包内成员（每行：格式 空格 路径）',known?.members?.map(m=>m.format+' '+m.path).join('\n')??'');
        field(asset+'.rights','权利来源文件（如适用）',known?.rightsSource??'');
        for(const channel of ['github-release','ghcr-assets','winget'])
          field(asset+'.'+channel,'将此文件交付到 '+channel,false,'check');
      }
      for(const channel of ['github-release','ghcr-assets','winget'])
        if(evidence.files.some(f=>values[id+'.f'+key(f.path)+'.'+channel])) {
          const known=model.delivery?.units.find(u=>u.id===defaults.raw)?.channels.find(c=>c.id===channel);
          field(id+'.dest.'+channel,channel+' 目的地',known?.location??(channel==='github-release'?'github':''));
          if(channel!=='winget' && !known) for(const name of metadataFiles)
            field(id+'.metadata.'+channel+'.'+key(name),channel+' · '+name,known?.metadata?.includes(name)??false,'check');
        }
    }
  }
  for(const unit of model.delivery?.units??[]) for(const c of effectiveChannels(model.delivery,unit)) {
    const id='channel.'+unit.id+'.'+c.id;
    field(id,display(unit.id)+' · '+display(c.id)+' · '+display(c.location),c.required,'check');
    const resolved=channelSelection(model.delivery,unit,c);
    for(const asset of unit.assets) field(id+'.asset.'+asset.id,display(c.id)+' · '+display(asset.name),resolved.ids.includes(asset.id),'check');
    if(c.id!=='winget') for(const name of metadataFiles)
      field(id+'.meta.'+key(name),display(c.id)+' · '+display(name),resolved.metadata.includes(name),'check');
  }
  if(!model.files.has(channelWorkflowPath) && Object.entries(values).some(([k,v])=>v===true && /\.(?:ghcr-assets|winget)$/.test(k))) {
    const sources=model.workflows.filter(w=>w.document?.on?.workflow_dispatch?.inputs?.targets_json).map(w=>w.path);
    field('channel.workflow','本仓已审的渠道工作流路径'+(sources.length?'（'+sources.join('、')+'）':'（待提供支持 targets_json 的原生渠道入口）'),sources.length===1?sources[0]:'');
  }
  if(model.pages) {
    const build=model.pages.jobs?.build, deploy=model.pages.jobs?.deploy;
    if(build) field('site.build','选择构建文档站',site.build??false,'check');
    if(deploy) field('site.deploy','选择允许公开部署（须启用 Pages，运维批准的来源模式须一致，release 模式还须匹配同一非空单元）',site.deploy??false,'check');
    lines.push('仅构建可直接使用下方来源。公开部署条件未满足时，已启用的构建仍可运行。');
    field('site.source','站点来源（default-branch 或 release）',site.source);
    field('site.unit','正式 Release 来源单元',site.unit);
  }
  const hasReleaseEntry=entries.some(entry=>values[entry.id+'.use']);
  if(!model.delivery && hasReleaseEntry) {
    field('author.id','已核实仓库作者的 GitHub 数字 ID');
    field('author.evidence','作者身份核验依据');
  }
  if(hasReleaseEntry) field('signing','已确认所选单元签名不适用',false,'check');
  for(const [id,label] of [['configure','准备入口并写入本 PR'],['trial','使用已核验的运行或执行只构建试跑'],['select','将正式文件和各渠道选择写入本 PR'],['approve','批准本 PR 的当前提交']])
    field('operation.'+id,label,false,'check');
  if(state.notice) lines.push('',state.notice);
  return {body:lines.join('\n'),items};
}

// Compare the complete previous rendering. Only editable checkbox states and fenced field values may change.
export function parseForm(previous,next,items) {
  const lines=next.split(/\r?\n/), original=previous.split(/\r?\n/), controls=new Map(items.map(i=>[i.id,i]));
  const values={};let i=0,j=0;
  while(i<original.length && j<lines.length) {
    const marker=/<!-- cfg ([\w.-]+) -->$/.exec(original[i]);
    const control=marker&&controls.get(marker[1]);
    if(control?.type==='check') {
      ensure(/^- \[[ xX]\] /.test(lines[j]) && original[i].slice(5)===lines[j].slice(5),'Invalid checkbox edit');
      values[control.id]=lines[j][3].toLowerCase()==='x';i++;j++;
    } else if(control) {
      ensure(original[i]===lines[j] && original[i+1]===lines[j+1], 'Invalid field label');
      const fence=original[i+1].slice(0,-4);
      i+=2;j+=2;
      const end=lines.indexOf(fence,j), oldEnd=original.indexOf(fence,i);
      ensure(end>=j && oldEnd>=i,'Unclosed configuration field');
      values[control.id]=lines.slice(j,end).join('\n');i=oldEnd+1;j=end+1;
    } else {
      ensure(original[i]===lines[j],'Only the marked controls may be edited');i++;j++;
    }
  }
  ensure(i===original.length && j===lines.length,'Configuration body is incomplete');
  return values;
}

export function planFromForm(model,state,operation) {
  const v=state.values,targets=[],units=new Map(),versions=new Map(),channels=new Map();
  const entries=candidates(model,v).filter(e=>v[e.id+'.use']);
  for(const entry of entries) {
    const id=entry.id, unit=v[id+'.unit'],target=v[id+'.target'],evidence=state.evidence?.[id];
    const item={unit,target};
    if(entry.workflow) Object.assign(item,{workflow:entry.workflow,job:entry.job,matrix:entry.matrix,...(v[id+'.ref']?{nativeRef:v[id+'.ref']}:{}),...(entry.nativeJobName?{nativeJobName:entry.nativeJobName,uploadStep:entry.uploadStep}:{}),archive:v[id+'.archive']});
    else for(const k of ['entry','runner','shell','directory','prepare','command','output']) item[k]=v[id+'.'+k];
    if(evidence && operation==='select') {
      if(item.nativeRef && evidence.binding?.observedRef && item.nativeRef!==evidence.binding.observedRef) {
        throw Error('来源已变更，请重新核验原生运行。');
      } else Object.assign(item,evidence.binding);
      item.files=[];
      for(const f of evidence.files) {
        const asset=id+'.f'+key(f.path);
        if(!v[asset+'.use']) continue;
        const declaration={id:v[asset+'.id'],path:f.path,name:v[asset+'.name'],mediaType:v[asset+'.type']};
        if(v[asset+'.inspection']) declaration.inspection=v[asset+'.inspection'];
        if(v[asset+'.rights']) declaration.rightsSource=v[asset+'.rights'];
        if(v[asset+'.members']) declaration.members=v[asset+'.members'].split('\n').map(line=>{
          const match=/^(elf|text|version) (.+)$/.exec(line);
          ensure(match,'成员格式或路径缺失');return {format:match[1],path:match[2]};
        });
        item.files.push(declaration);
        for(const channel of ['github-release','ghcr-assets','winget']) if(v[asset+'.'+channel]) {
          const k=unit+'/'+channel;
          if(!channels.has(k)) channels.set(k,{unit,id:channel,required:true,sources:[],location:v[id+'.dest.'+channel],metadata:metadataFiles.filter(name=>v[id+'.metadata.'+channel+'.'+key(name)]),artifactIds:[]});
          channels.get(k).artifactIds.push(v[asset+'.id']);
          channels.get(k).sources.push({target,assetId:v[asset+'.id']});
        }
      }
    }
    targets.push(item);
    const facts={id:unit,path:v[id+'.path'],notesPath:v[id+'.notes'],channels:[]};
    if(v[id+'.locks']) facts.buildLocks=v[id+'.locks']==='[]'?[]:v[id+'.locks'].split('\n');
    if(v[id+'.notesBody']) facts.notesBody=v[id+'.notesBody'];
    units.set(unit,facts);
    versions.set(unit,{path:v[id+'.path'],component:v[id+'.component']||unit,noComponent:v[id+'.noComponent'],versionFile:v[id+'.version'],changelog:v[id+'.changelog'],logBody:v[id+'.logBody']});
  }
  for(const c of channels.values()) units.get(c.unit).channels.push({id:c.id,location:c.location,required:false});
  const settings={targets,channelWorkflow:v['channel.workflow'],units:[...units.values()],signing:v.signing?'not-applicable':null};
  if(operation==='configure' && versions.size) settings.versions=[...versions.values()];
  if(!model.delivery && entries.length) settings.repositoryAuthors=[{id:Number(v['author.id']),evidence:v['author.evidence']}];
  const edits=[];
  for(const unit of model.delivery?.units??[]) for(const c of effectiveChannels(model.delivery,unit)) {
    const field='channel.'+unit.id+'.'+c.id, enabled=v[field];
    const prior=channelSelection(model.delivery,unit,c);
    const ids=unit.assets.filter(a=>v[field+'.asset.'+a.id]??prior.ids.includes(a.id)).map(a=>a.id);
    const metadata=metadataFiles.filter(name=>v[field+'.meta.'+key(name)]??prior.metadata.includes(name));
    const edit={unit:unit.id,id:c.id,required:enabled??c.required};
    if(enabled && !c.required && !ids.length || JSON.stringify([...ids].sort())!==JSON.stringify([...prior.ids].sort())) edit.artifactIds=ids;
    if(JSON.stringify([...metadata].sort())!==JSON.stringify([...prior.metadata].sort())) edit.metadata=metadata;
    const addition=operation==='select'?channels.get(unit.id+'/'+c.id):undefined;
    if(addition) {
      addition.existingIds=ids;
      addition.artifactIds=[...new Set([...ids,...addition.artifactIds])];
      addition.metadata=metadata;
      if(enabled!==c.required) addition.required=edit.required;
    } else if(edit.required!==c.required || edit.artifactIds || edit.metadata) edits.push(edit);
  }
  if(operation==='select') edits.push(...channels.values());
  if(edits.length) settings.channels=edits;
  const ci=model.workflows.filter(w=>v['ci.'+key(w.path)]).map(w=>w.path);
  const changed=model.workflows.some(w=>selectableProductCI(w,model.defaultBranch) && Object.hasOwn(v,'ci.'+key(w.path))
    && Boolean(v['ci.'+key(w.path)])!==model.ci.includes(w.path));
  if(changed)settings.ci=ci;
  const site=pagesChoices(model.pages);
  const changedSite=['build','deploy','source','unit'].some(k=>Object.hasOwn(v,'site.'+k) && v['site.'+k] !== (site[k]??false));
  if(model.pages && changedSite && ['default-branch','release'].includes(v['site.source']))
    settings.site={build:v['site.build'],deploy:v['site.deploy'],source:v['site.source'],unit:v['site.unit']};
  return settings;
}
