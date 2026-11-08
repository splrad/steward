import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import {isDeepStrictEqual} from 'node:util';
import {parseDeliveryConfig} from '../packages/runner/dist/index.js';
import {assert,assertGovernanceOnlyScope} from './private-dependency-policy.mjs';
export const lifecycleSupport=['package.json','package-lock.json','.gitignore','scripts/verify.mjs'];
export const lifecycleWorkflows=['.github/workflows/steward-release-publish.yml','.github/workflows/steward-release-channels.yml'];
const required=[...lifecycleSupport,...lifecycleWorkflows,'acceptance-app.js','acceptance-app.test.js','VERSION','release-please-config.json','.release-please-manifest.json','.github/delivery.json'];
export const lifecycleUpdaters=['.github/dependabot.yml','.github/renovate.json'];
const extra=new Set([...required,...lifecycleUpdaters,'CHANGELOG.md','.release-notes/app.md']);
export function assertLifecycleScope(paths){
  for(const path of paths)if(!extra.has(path))assertGovernanceOnlyScope([path]);
}
// This deliberately admits only the dependency-free sample, not general private Node products.
export async function assertLifecycleSnapshot(files,{controllerSha,verifyController,side}={}){
  assert(side==='base'||side==='head','LIFECYCLE_SIDE');
  assertLifecycleScope([...files.keys()]);
  await assertLifecycleUpdaters(files);
  const hasApplication=required.some(path=>files.has(path));
  if(!hasApplication){assert(side==='base','LIFECYCLE_HEAD_INCOMPLETE');return {application:false,npmPackages:0};}
  assert(required.every(path=>files.has(path)),'LIFECYCLE_APPLICATION_INCOMPLETE');
  for(const path of lifecycleSupport){
    const expected=await readFile(new URL('../templates/lifecycle-sample/'+path,import.meta.url));
    assert(files.get(path).toString('utf8').replaceAll('\r\n','\n')===expected.toString('utf8').replaceAll('\r\n','\n'),'LIFECYCLE_SUPPORT_BYTES');
  }
  assert(/^[a-f0-9]{40}$/.test(controllerSha??''),'LIFECYCLE_CONTROLLER');
  let selectedController;
  for(const path of lifecycleWorkflows){
    const expected=YAML.parse(await readFile(new URL('../templates/release/'+path.split('/').at(-1),import.meta.url),'utf8'));
    const actual=YAML.parse(files.get(path).toString('utf8'));
    const refs=Object.values(actual?.jobs??{}).flatMap(job=>[
      ...(job.uses?[job.uses.match(/^splrad\/steward\/\.github\/workflows\/product-release\.yml@([a-f0-9]{40})$/)?.[1]]:[]),
      ...(job.steps??[]).filter(step=>step.with?.repository==='splrad/steward').map(step=>step.with.ref)]);
    assert(refs.length>0&&refs.every(ref=>typeof ref==='string'&&/^[a-f0-9]{40}$/.test(ref)&&ref===refs[0]),'LIFECYCLE_CONTROLLER');
    if(selectedController)assert(selectedController===refs[0],'LIFECYCLE_CONTROLLER_GROUP');
    selectedController=refs[0];
    assert(refs[0]===controllerSha||(verifyController&&await verifyController(refs[0])),'LIFECYCLE_CONTROLLER_UNTRUSTED');
    for(const [jobId,job] of Object.entries(expected.jobs)){
      if(job.uses)job.uses='splrad/steward/.github/workflows/product-release.yml@'+refs[0];
      for(const [index,step] of (job.steps??[]).entries()){
        if(step.with?.repository==='splrad/steward')step.with.ref=refs[0];
        const candidate=actual.jobs?.[jobId]?.steps?.[index];
        if(step.uses){
          const action=/^([^@]+)@([a-f0-9]{40})$/.exec(step.uses);
          assert(action&&typeof candidate?.uses==='string'&&candidate.uses.startsWith(action[1]+'@')
            &&/^[a-f0-9]{40}$/.test(candidate.uses.slice(action[1].length+1)),'LIFECYCLE_ACTION_REFERENCE');
          // Only the SHA varies. Native actions-lock and online inventory validate
          // its official repository, release-tag identity and advisory coverage.
          step.uses=candidate.uses;
          if(action[1]==='jdx/mise-action'){
            assert(typeof candidate.with?.version==='string'&&/^\d+\.\d+\.\d+$/.test(candidate.with.version),'LIFECYCLE_MISE_VERSION');
            step.with.version=candidate.with.version;
          }
        }
      }
    }
    assert(isDeepStrictEqual(actual,expected),'LIFECYCLE_WORKFLOW_TEMPLATE');
  }
  const parse=path=>JSON.parse(files.get(path).toString('utf8'));
  const version=files.get('VERSION').toString('utf8').trim();
  assert(/^\d+\.\d+\.\d+$/.test(version),'LIFECYCLE_VERSION');
  assert(isDeepStrictEqual(parse('.release-please-manifest.json'),{'.':version}),'LIFECYCLE_MANIFEST');
  const config=parse('release-please-config.json');
  assert(isDeepStrictEqual(config,{'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'simple','version-file':'VERSION'}}}),'LIFECYCLE_RELEASE_CONFIG');
  const delivery=parseDeliveryConfig(parse('.github/delivery.json'));
  assert(delivery.schemaVersion===1&&delivery.units?.length===1&&delivery.units[0].id==='app'&&delivery.units[0].path==='.'
    &&delivery.units[0].notesPath==='.release-notes/app.md'&&delivery.units[0].channels?.length===0,'LIFECYCLE_DELIVERY');
  return {application:true,npmPackages:0,coverage:'exact dependency-free support and updater contracts; trusted workflow structure with explicit version slots; online action/mise identity and advisories; normal source jobs compile and test application'};
}
export function lifecycleMiseVersions(documents){
  const versions=new Set();
  for(const doc of documents.values())for(const job of Object.values(doc.jobs??{}))for(const step of job.steps??[]){
    if(/^jdx\/mise-action(?:@|\/|$)/.test(step.uses??'')){
      assert(/^jdx\/mise-action@[a-f0-9]{40}$/.test(step.uses),'LIFECYCLE_MISE_REFERENCE');
      assert(typeof step.with?.version==='string'&&/^\d+\.\d+\.\d+$/.test(step.with.version),'LIFECYCLE_MISE_VERSION');versions.add(step.with.version);
    }
  }
  return [...versions].sort();
}

export async function lifecycleReusable(uses,loadTrusted){
  const match=/^splrad\/steward\/\.github\/workflows\/product-release\.yml@([a-f0-9]{40})$/.exec(uses??'');
  assert(match,'LIFECYCLE_REUSABLE_IDENTITY');
  const bytes=await loadTrusted(match[1],'.github/workflows/product-release.yml');
  const doc=YAML.parse(bytes.toString('utf8'));
  assert(doc?.on?.workflow_call&&doc.jobs&&Object.values(doc.jobs).every(job=>!job.uses),'LIFECYCLE_REUSABLE_NESTING');
  return {path:'.github/workflows/trusted-product-release-'+match[1]+'.yml',bytes,sha:match[1]};
}

export function assertLifecycleMissingActionLock(paths,{side,application}){
  assert(side==='base'&&!application&&!paths.some(path=>path.startsWith('.github/workflows/')),'LIFECYCLE_ACTION_LOCK_REQUIRED');
}


export async function assertLifecycleUpdaters(files){
  if(!lifecycleUpdaters.some(path=>files.has(path)))return;
  assert(lifecycleUpdaters.every(path=>files.has(path)),'LIFECYCLE_UPDATERS_INCOMPLETE');
  for(const path of lifecycleUpdaters){
    const parse=text=>path.endsWith('.json')?JSON.parse(text):YAML.parse(text);
    const expected=parse(await readFile(new URL('../config/private-lifecycle/'+path.split('/').at(-1),import.meta.url),'utf8'));
    assert(isDeepStrictEqual(parse(files.get(path).toString('utf8')),expected),'LIFECYCLE_UPDATER_CONTRACT');
  }
}
