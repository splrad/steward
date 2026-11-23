import YAML from 'yaml';
import {parseDeliveryConfig} from '../packages/runner/dist/index.js';

export const deliveryPath='.github/delivery.json', versionsPath='release-please-config.json';
export const publishPath='.github/workflows/steward-release-publish.yml', pagesPath='.github/workflows/pages.yml';
export const channelWorkflowPath='.github/workflows/steward-release-channels.yml';
export const ciPath='.github/product-ci.json';
export const jsonFile=value=>JSON.stringify(value,null,2)+'\n';
export function inspectRepository(files, {normalizeCompactDelivery=false}={}) {
  const json=path=>files.has(path)?JSON.parse(files.get(path)):null;
  const yaml=path=>files.has(path)?YAML.parse(files.get(path)):null;
  const rawDelivery=json(deliveryPath), versions=json(versionsPath), publish=yaml(publishPath), pages=yaml(pagesPath);
  const delivery=normalizeCompactDelivery && rawDelivery?.schemaVersion===3 ? parseDeliveryConfig(rawDelivery,versions) : rawDelivery;
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

// Recognize the condition on existing Pages workflow revisions.
export const managedPagesCondition=/^\((true|false) && (?:true|needs\.select\.outputs\.ready == 'true'|vars\.STEWARD_DOCS_SOURCE == '(?:default-branch|release)'(?: && vars\.STEWARD_DOCS_UNIT == '[a-z][a-z0-9-]*')?)\) && \(([\s\S]*)\)$/;
export function pagesChoices(pages) {
  const declared=pages?.env?.STEWARD_DOCS_SOURCE,unit=pages?.env?.STEWARD_DOCS_UNIT;
  const flag=job=>{
    const match=managedPagesCondition.exec(pages?.jobs?.[job]?.if);
    return match?match[1]==='true':undefined;
  };
  return {build:flag('build'),deploy:flag('deploy'),source:['default-branch','release'].includes(declared)?declared:'',
    unit:typeof unit==='string' && /^[a-z][a-z0-9-]*$/.test(unit)?unit:''};
}
