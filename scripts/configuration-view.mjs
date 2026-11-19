import YAML from 'yaml';
import {posix} from 'node:path';

export const deliveryPath='.github/delivery.json', versionsPath='release-please-config.json';
export const publishPath='.github/workflows/steward-release-publish.yml', pagesPath='.github/workflows/pages.yml';
export const channelWorkflowPath='.github/workflows/steward-release-channels.yml';
export const ciPath='.github/product-ci.json';
export const jsonFile=value=>JSON.stringify(value,null,2)+'\n';
const format=value=>'`'+String(value).replace(/[`\r\n<>]/g,'')+'`';
const line=(on,text)=>'- ['+(on?'x':' ')+'] '+text;
const locked=(text,reason)=>'- 🔒 '+text+' · '+reason;
const platforms=[['Windows','windows'],['Linux','ubuntu'],['macOS','macos']];
const packaging=['Windows MSI','CMake/CPack 打包','Node 发行包','Python 发行包','Go 程序或模块','Rust crate','JVM JAR','OCI 容器镜像','Helm chart'];
const channels=new Map([['github-release','GitHub Release'],['ghcr-assets','GHCR 文件制品'],['winget','WinGet'],['npm','npm'],['nuget','NuGet'],['pypi','PyPI'],['oci','OCI 容器镜像分发'],['helm','Helm chart 分发']]);

export function inspectRepository(files) {
  const json=path=>files.has(path)?JSON.parse(files.get(path)):null;
  const yaml=path=>files.has(path)?YAML.parse(files.get(path)):null;
  const delivery=json(deliveryPath), versions=json(versionsPath), publish=yaml(publishPath), pages=yaml(pagesPath);
  const workflows=[];
  for(const [path,bytes] of files) if(/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) && !path.includes('repository-configuration')) {
    const doc=YAML.parse(bytes);
    workflows.push({path,jobs:Object.keys(doc?.jobs??{}),document:doc});
  }
  return {delivery,versions,publish,pages,ci:json(ciPath)??[],workflows,files};
}

export function effectiveChannels(delivery,unit) {
  const result=structuredClone(unit.channels);
  if(!result.some(c=>c.id==='github-release') && delivery.schemaVersion===1)
    result.unshift({id:'github-release',required:true,location:'github'});
  return result;
}

export function renderConfiguration(model,head,extra='') {
  const {delivery,versions,publish,pages,ci,workflows}=model, units=delivery?.units??[];
  const body=['<!-- steward-repository-configuration -->','### 版本管理',''];
  for(const unit of units) {
    const cfg=versions?.packages?.[unit.path];
    if(cfg) body.push(line(true,'版本建议与同步 · '+format(unit.id)+' · '+format(posix.join(unit.path,cfg['version-file']??versions['version-file']??'VERSION'))+'、'+format(posix.join(unit.path,cfg['changelog-path']??versions['changelog-path']??'CHANGELOG.md'))));
    else body.push(locked(format(unit.id),'缺少对应 Release Please 单元'));
  }
  if(!units.length) body.push(locked('版本建议与同步','待声明发行单元及版本文件'));
  body.push(units.length>1?line(true,'多发行单元联动'):locked('多发行单元联动','需要多个发行单元'),'','### 构建与打包','');
  const matrix=publish?.jobs?.build?.strategy?.matrix?.include??[];
  const runner=publish?.jobs?.build?.['runs-on'];
  for(const [name,prefix] of platforms) {
    const fixed=typeof runner==='string' && runner.toLowerCase().startsWith(prefix+'-');
    const native=workflows.flatMap(w=>Object.entries(w.document?.jobs??{}).filter(([,job])=>
      typeof job['runs-on']==='string' && job['runs-on'].toLowerCase().startsWith(prefix+'-')
      && job.steps?.some(s=>s.uses?.startsWith('actions/upload-artifact@'))).map(([id])=>w.path+' · '+id));
    if(fixed && matrix.length) body.push(line(true,name+' 构建 · '+format(runner)+' · '+matrix.map(r=>format(r.unit+'/'+r.target)).join('、')));
    else if(native.length) body.push('- '+name+' 构建待选择 · '+native.map(format).join('、'));
    else body.push(locked(name+' 构建','待确认产品构建目标'));
  }
  if(typeof runner==='string' && runner.includes('${{')) for(const row of matrix) body.push('- '+format(row.unit+'/'+row.target)+' · runner 由产品矩阵选择');
  const declared=units.flatMap(u=>u.assets.map(a=>({...a,unit:u.id})));
  const byInspection={'node-package':'Node 发行包',wheel:'Python 发行包',sdist:'Python 发行包'};
  for(const item of packaging) {
    const assets=declared.filter(a=>byInspection[a.inspection]===item || (item==='Windows MSI' && a.name.toLowerCase().endsWith('.msi')));
    if(assets.length) body.push(line(true,item+' · '+assets.map(a=>format(a.unit+'/'+a.name)).join('、')));
    else body.push(locked(item,'待确认打包用途'));
  }
  for(const asset of declared.filter(a=>a.inspection && !byInspection[a.inspection])) body.push(line(true,format(asset.inspection)+' · '+format(asset.unit+'/'+asset.name)));
  body.push('','### 发布渠道','');
  const used=new Set();
  for(const unit of units) for(const channel of effectiveChannels(delivery,unit)) {
    used.add(channel.id);
    const names=unit.assets.filter(asset=>!channel.artifactIds || channel.artifactIds.includes(asset.id)).map(a=>format(a.name));
    body.push(line(channel.required,(channels.get(channel.id)??format(channel.id))+' · '+format(unit.id)+' · '+format(channel.location)+' · '+names.join('、')));
  }
  for(const [id,title] of channels) if(!used.has(id)) body.push(locked(title,'待声明渠道与交付对象'));
  body.push('','### 文档站','');
  const output=pages?.jobs?.build?.steps?.find(step=>step.uses?.startsWith('actions/upload-pages-artifact@'))?.with?.path;
  body.push(output?line(!/^\(?false\b/.test(String(pages.jobs.build.if)),'构建文档站 · '+format(output)):locked('构建文档站','待确认原生构建及上传目录'));
  body.push(pages?.jobs?.deploy?line(!/^\(?false\b/.test(String(pages.jobs.deploy.if)),'仓内允许 GitHub Pages 公开部署（执行时另核对 Pages 和运维授权来源）'):locked('GitHub Pages 公开部署','缺少部署作业'));
  if(pages) body.push('站点来源 · '+format(pages.env?.STEWARD_DOCS_SOURCE??'沿用仓库运维变量'));
  body.push('','### 原生入口','',...workflows.map(w=>'- '+format(w.path)+' · '+w.jobs.map(format).join('、')+(ci.includes(w.path)?' · 已选 PR 验证':'')));
  if(!workflows.length) body.push('待配置仓内工作流或受审打包脚本。');
  body.push('','配置变更见 **Files changed**，合并后生效。','', '当前提交 '+format(head)+'。');
  if(extra) body.push('',extra);
  return body.join('\n');
}

export function explicitDelivery(input) {
  const delivery=structuredClone(input);
  if(!delivery || ![1,2].includes(delivery.schemaVersion)) throw Error('Missing supported delivery configuration');
  // Preserve version-1 defaults for *every* unit when the first explicit subset upgrades the document.
  if(delivery.schemaVersion===1) {
    for(const unit of delivery.units) {
      unit.channels=effectiveChannels(delivery,unit);
      for(const channel of unit.channels) channel.metadata??=channel.id==='winget'?[]:['sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'];
    }
    delivery.schemaVersion=2;
  }
  return delivery;
}
export function changeChannels(input, edits) {
  const delivery=edits.some(e=>e.artifactIds || e.metadata || e.id==='github-release')?explicitDelivery(input):structuredClone(input);
  for(const edit of edits) {
    const unit=delivery.units.find(u=>u.id===edit.unit);
    const channel=unit?.channels.find(c=>c.id===edit.id);
    if(!channel || typeof edit.required!=='boolean') throw Error('Select a declared channel and enablement');
    channel.required=edit.required;
    if(edit.location) channel.location=edit.location;
    if(edit.artifactIds) {
      if(!Array.isArray(edit.artifactIds)||new Set(edit.artifactIds).size!==edit.artifactIds.length
        ||edit.artifactIds.some(id=>!unit.assets.some(a=>a.id===id))) throw Error('Unknown or duplicate channel artifact');
      if(edit.artifactIds.length)channel.artifactIds=edit.artifactIds;
      else if(!edit.required)delete channel.artifactIds;
      else throw Error('请为启用的渠道选择至少一个发行文件');
    }
    if(edit.metadata) channel.metadata=edit.metadata;
  }
  return delivery;
}
