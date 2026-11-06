import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import semver from 'semver';
import YAML from 'yaml';
import {assert} from './private-dependency-policy.mjs';
export async function publicBytes(url){
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  assert(response.ok,'SUPPLIER_HTTP_'+response.status);const b=Buffer.from(await response.arrayBuffer());
  assert(b.length<=32*1024*1024,'SUPPLIER_SIZE');return b;
}
export function nodeFindings(version,feed){
  assert(semver.valid(version)&&feed&&Object.keys(feed).length>0,'NODE_DATA');const matches=[];
  for(const item of Object.values(feed)){
    assert(semver.validRange(item.vulnerable)&&semver.validRange(item.patched),'NODE_RANGE');
    if(semver.satisfies(version,item.vulnerable)&&!semver.satisfies(version,item.patched)){
      const severity=item.severity?.toUpperCase();assert(['LOW','MEDIUM','MODERATE','HIGH','CRITICAL'].includes(severity),'NODE_SEVERITY');
      matches.push({id:item.cve,severity,version,source:'nodejs/security-wg'});
    }
  }return matches;
}
export function miseFindings(version,advisories){
  assert(semver.valid(version)&&Array.isArray(advisories),'MISE_DATA');const matches=[];
  for(const advisory of advisories){
    for(const item of advisory.vulnerabilities??[]){
      if(item.package?.name!=='mise')continue;
      assert(['rust','other'].includes(item.package.ecosystem),'MISE_ECOSYSTEM');
      const range=item.vulnerable_version_range,patched=item.patched_versions;
      assert(semver.validRange(range),'MISE_RANGE');
      // Supplier patched_versions is either a first patched release or a semver range.
      assert(!patched||semver.valid(patched)||semver.validRange(patched),'MISE_PATCH_RANGE');
      const fixed=patched&&(semver.valid(patched)?semver.gte(version,patched):semver.satisfies(version,patched));
      if(semver.satisfies(version,range)&&!fixed){
        const severity=advisory.severity?.toUpperCase();assert(['LOW','MEDIUM','MODERATE','HIGH','CRITICAL'].includes(severity),'MISE_SEVERITY');
        matches.push({id:advisory.ghsa_id,severity,version,source:'jdx/mise'});
      }
    }
  }return matches;
}
export function miseVersions(documents,requiredWorkflow){
  const collect=doc=>Object.values(doc?.jobs??{}).flatMap(job=>job.steps??[]).filter(step=>/^jdx\/mise-action@[a-f0-9]{40}$/.test(step.uses??''));
  assert(collect(documents.get(requiredWorkflow)).length===1,'MISE_RUNTIME_REQUIRED');
  const versions=new Set();
  for(const doc of documents.values())for(const step of collect(doc)){
    const version=step.with?.version;assert(typeof version==='string'&&semver.valid(version),'MISE_RUNTIME_VERSION');versions.add(version);
  }
  return [...versions].sort();
}
export function archiveInventory(python,archivePath,run,env){
  return JSON.parse(run(python,['-I','-c',`import json,tarfile,sys
manifests={}
with tarfile.open(sys.argv[1]) as archive:
 for item in archive:
  if item.name=='package.json' or item.name.endswith('/package.json'):
   if not item.isfile() or item.size>1048576: raise ValueError('unsupported manifest entry')
   if item.name in manifests: raise ValueError('duplicate manifest')
   manifests[item.name]=json.load(archive.extractfile(item))
packages=set(); named=[]; scopes=[]
for path,data in manifests.items():
 if isinstance(data.get('name'),str) and data['name'] and isinstance(data.get('version'),str) and data['version']:
  packages.add((data['name'],data['version']));named.append(path[:-len('package.json')])
 else:
  if not set(data).issubset({'type','sideEffects'}) or data.get('type') not in ('module','commonjs'): raise ValueError('unresolved manifest')
  if 'sideEffects' in data and not isinstance(data['sideEffects'],bool): raise ValueError('unsupported module metadata')
  scopes.append(path)
for path in scopes:
 if not any(path.startswith(parent) and path!=parent+'package.json' for parent in named): raise ValueError('orphan module metadata')
print(json.dumps({'packages':sorted(packages),'moduleScopes':sorted(scopes)}))`,archivePath],join(archivePath,'..'),env).stdout);
}
export async function scanTools({workspace,entries,blob,input,output,documents,requiredWorkflow,env,run,docker,image,github,supplier}){
  assert(env.PRIVATE_PYTHON&&env.PRIVATE_SYFT,'TRUSTED_TOOL_PATHS');
  const parsed={};
  for(const name of ['mise.toml','mise.lock']){
    const bytes=blob(workspace,entries,name),path=join(input,name);await writeFile(path,bytes);
    const result=run(env.PRIVATE_PYTHON,['-I','-c','import json,tomllib,sys; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path],input,env);
    parsed[name]=JSON.parse(result.stdout);
  }
  const config=parsed['mise.toml'],lock=parsed['mise.lock'];
  assert(Object.keys(config).every(k=>['tool_alias','tools','settings'].includes(k))&&Object.keys(config.tools??{}).sort().join(',')==='node,npm','MISE_CONFIG_SCOPE');
  assert(config.tool_alias?.node==='core:node'&&config.tool_alias?.npm==='npm:npm'&&Object.keys(config.tool_alias).length===2,'MISE_ALIASES');
  assert(Object.keys(config.settings??{}).every(k=>['lockfile','lockfile_platforms','node'].includes(k))&&config.settings.node?.compile===false,'MISE_SETTINGS');
  assert(Object.values(config.tools).every(v=>typeof v==='string'&&(v==='latest'||semver.valid(v))),'MISE_TOOL_OPTIONS');
  assert(lock.lockfile_version===3&&Object.keys(lock.tools??{}).sort().join(',')==='node,npm','MISE_LOCK_SCOPE');
  const node=lock.tools.node,npm=lock.tools.npm;assert(node.length===1&&npm.length===1,'TOOL_VERSIONS');
  const n=node[0],p=npm[0];assert(semver.valid(n.version)&&n.backend==='core:node'&&semver.valid(p.version)&&p.backend==='npm:npm','TOOL_BACKENDS');
  const knownRelease=supplier.nodeReleases.find(x=>x.version==='v'+n.version);assert(knownRelease,'NODE_RELEASE_UNKNOWN');
  const sums=(await publicBytes(`https://nodejs.org/dist/v${n.version}/SHASUMS256.txt`)).toString();
  const platforms=Object.fromEntries(Object.entries(n).filter(([key])=>key.startsWith('platforms.')).map(([key,value])=>[key.slice(10),value]));
  for(const [platform,asset] of Object.entries(platforms)){
    assert(['linux-x64','windows-x64'].includes(platform),'NODE_PLATFORM');
    const filename=platform==='linux-x64'?`node-v${n.version}-linux-x64.tar.gz`:`node-v${n.version}-win-x64.zip`;
    assert(asset.url===`https://nodejs.org/dist/v${n.version}/${filename}`&&sums.split('\n').some(line=>line.trim().split(/\s+/).join(' ')===(asset.checksum??'').replace('sha256:','')+' '+filename),'NODE_DISTRIBUTION');
  }
  assert(Object.keys(platforms).length===2,'NODE_PLATFORMS');
  const versions=miseVersions(documents,requiredWorkflow);
  for(const version of versions)await github(`/repos/jdx/mise/releases/tags/v${version}`,env.GH_TOKEN);
  const toolPath=`.mise/locks/npm/${p.version}`;assert(p.aube?.path===toolPath,'NPM_LOCK_PATH');
  const aube=YAML.parse(blob(workspace,entries,toolPath+'/aube-lock.yaml').toString());
  const pkg=JSON.parse(blob(workspace,entries,toolPath+'/package.json').toString());
  assert(Object.keys(pkg).every(k=>['name','private','dependencies'].includes(k))&&pkg.name==='mise-npm-install'&&pkg.private===true&&JSON.stringify(pkg.dependencies)===JSON.stringify({npm:p.version}),'NPM_TOOL_MANIFEST');
  assert(Object.keys(aube.packages??{}).join(',')===`npm@${p.version}`&&Object.keys(aube.importers??{}).join(',')==='.'&&aube.importers['.'].dependencies?.npm?.version===p.version,'NPM_TOOL_INVENTORY');
  const integrity=aube.packages[`npm@${p.version}`].resolution?.integrity;
  assert(/^sha512-[A-Za-z0-9+/=]+$/.test(integrity??''),'NPM_INTEGRITY');
  const meta=JSON.parse((await publicBytes(`https://registry.npmjs.org/npm/${p.version}`)).toString());
  assert(meta.dist?.integrity===integrity&&meta.dist.tarball===`https://registry.npmjs.org/npm/-/npm-${p.version}.tgz`,'NPM_DISTRIBUTION');
  const archive=await publicBytes(meta.dist.tarball);assert('sha512-'+createHash('sha512').update(archive).digest('base64')===integrity,'NPM_ARCHIVE_DIGEST');
  const dir=join(input,'npm-tool');await mkdir(dir);const archivePath=join(dir,'npm.tgz');await writeFile(archivePath,archive);
  const syftConfig=join(dir,'syft.yml');await writeFile(syftConfig,'check-for-app-update: false\n');
  run(env.PRIVATE_SYFT,['scan','file:'+archivePath,'--config',syftConfig,'--override-default-catalogers','javascript-package-cataloger','-o','cyclonedx-json='+join(dir,'bom.cdx.json')],dir,env);
  const sbom=JSON.parse(await readFile(join(dir,'bom.cdx.json'),'utf8'));
  const archiveFacts=archiveInventory(env.PRIVATE_PYTHON,archivePath,run,env),expected=archiveFacts.packages;
  const actual=new Set(sbom.components.filter(x=>x.purl?.startsWith('pkg:npm/')).map(x=>JSON.stringify([x.name,x.version])));
  assert(expected.length>1&&expected.length===actual.size&&expected.every(x=>actual.has(JSON.stringify(x))),'NPM_BUNDLED_COVERAGE');
  const scanDir=join(input,'npm-sbom');await mkdir(scanDir);await writeFile(join(scanDir,'bom.cdx.json'),JSON.stringify(sbom));await writeFile(join(scanDir,'osv-scanner.toml'),'');
  docker(image,'/root/osv-scanner',scanDir,output,['scan','source','--all-packages','--no-resolve','--licenses=','--config=/input/osv-scanner.toml','--format=json','--output-file=/out/npm-tool.json','/input']);
  const osv=JSON.parse(await readFile(join(output,'npm-tool.json'),'utf8'));const scanned=new Set(osv.results.flatMap(r=>r.packages).map(x=>JSON.stringify([x.package.name,x.package.version])));
  assert(scanned.size===actual.size&&[...actual].every(x=>scanned.has(x)),'NPM_TOOL_SCAN_INCOMPLETE');
  // Normalize ephemeral paths before the upstream reporter compares the two actual tool versions.
  for(const group of osv.results)group.source.path='/input/npm-tool/bom.cdx.json';
  await writeFile(join(output,'npm-tool.json'),JSON.stringify(osv));
  return {node:{version:n.version,findings:nodeFindings(n.version,supplier.nodeVulnerabilities)},mise:{versions,findings:versions.flatMap(version=>miseFindings(version,supplier.miseAdvisories))},npm:{version:p.version,integrity,bundledPackages:actual.size,moduleScopes:archiveFacts.moduleScopes},scope:'supplier advisories for tool versions; npm release archive and bundled dependencies; not exhaustive compiled binary internals',complete:true};
}
