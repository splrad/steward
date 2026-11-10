import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import semver from 'semver';

const check=(condition,message)=>{if(!condition)throw Error(`MAINTENANCE_DISCOVERY: ${message}`);};
export const sources={node:'https://nodejs.org/dist/index.json',npm:'https://registry.npmjs.org/npm'};
export function discover(nodeReleases,npmPackage,current){
  check(semver.valid(current.node)&&semver.valid(current.npm),'current versions');
  check(Array.isArray(nodeReleases)&&npmPackage.name==='npm'&&npmPackage.versions,'official response shape');
  const nodes=nodeReleases.filter(row=>semver.valid(row.version)&&!semver.prerelease(row.version))
    .sort((a,b)=>semver.rcompare(a.version,b.version));
  check(nodes.length&&nodes.some(row=>semver.eq(row.version,current.node)),'current Node absent from official index');
  const npmVersions=Object.entries(npmPackage.versions).filter(([version,value])=>
    semver.valid(version)&&!semver.prerelease(version)&&value.version===version)
    .sort(([a],[b])=>semver.rcompare(a,b));
  check(npmPackage.versions[current.npm], 'current npm absent from official registry');
  const npmRow=value=>value?{version:value.version,nodeEngine:value.engines?.node??null,
    integrity:value.dist?.integrity??null,tarball:value.dist?.tarball??null}:null;
  const nodeRow=value=>value?{version:semver.clean(value.version),date:value.date,lts:value.lts,
    bundledNpm:value.npm??null,security:value.security??null}:null;
  const compatible=version=>npmRow(npmVersions.find(([,value])=>typeof value.engines?.node==='string'
    && semver.satisfies(version,value.engines.node))?.[1]);
  const sameMajor=nodes.find(row=>semver.major(row.version)===semver.major(current.node));
  const latestTag=npmPackage['dist-tags']?.latest;
  check(semver.valid(latestTag)&&!semver.prerelease(latestTag)&&npmPackage.versions[latestTag],'npm latest tag');
  return {current,node:{latestStable:nodeRow(nodes[0]),latestLts:nodeRow(nodes.find(row=>row.lts)),
    latestCurrentMajor:nodeRow(sameMajor)},npm:{latestStable:npmRow(npmPackage.versions[latestTag]),
    latestCompatibleWithCurrentNode:compatible(current.node),
    latestCompatibleWithCurrentMajorCandidate:sameMajor?compatible(sameMajor.version):null},
    decision:'DISCOVERED_NOT_APPROVED',
    adoption:'Review version declarations and release contracts, run compatibility checks, then update trusted toolchainSource; discovery does not authorize an upgrade.'};
}
export async function main(argv=process.argv.slice(2),transport=fetch){
  const {values}=parseArgs({args:argv,options:{workspace:{type:'string'},output:{type:'string'}},strict:true});
  check(values.workspace&&values.output,'--workspace and --output required');
  const workspace=resolve(values.workspace),nodeText=await readFile(resolve(workspace,'.node-version'),'utf8');
  const manifestText=await readFile(resolve(workspace,'package.json'),'utf8'),manifest=JSON.parse(manifestText);
  const node=nodeText.trim(),npm=/^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  check(manifest.engines?.node===node&&npm,'maintenance manifest consistency');
  const evidence={};
  const get=async(name,url)=>{
    const response=await transport(url,{headers:{accept:name==='npm'?'application/vnd.npm.install-v1+json':'application/json'},signal:AbortSignal.timeout(60000)});
    check(response.ok,`${name} HTTP ${response.status}`);
    const bytes=await response.text();
    evidence[name]={url,etag:response.headers.get('etag'),sha256:createHash('sha256').update(bytes).digest('hex')};
    return JSON.parse(bytes);
  };
  const [nodes,npmPackage]=await Promise.all([get('node',sources.node),get('npm',sources.npm)]);
  const report={observedAt:new Date().toISOString(),sources:evidence,
    inputs:{workspace,nodeVersionSha256:createHash('sha256').update(nodeText).digest('hex'),
      manifestSha256:createHash('sha256').update(manifestText).digest('hex')},...discover(nodes,npmPackage,{node,npm})};
  await writeFile(resolve(values.output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output:resolve(values.output),decision:report.decision}));
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
