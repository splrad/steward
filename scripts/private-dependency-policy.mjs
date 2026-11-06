import {readFile} from 'node:fs/promises';
export const assert=(ok,code)=>{if(!ok)throw Error('PRIVATE_DEPENDENCY_'+code);};
export async function loadPolicy(){
  const policy=JSON.parse(await readFile(new URL('../config/private-dependency-security.json',import.meta.url),'utf8'));
  assert(policy.schemaVersion===1&&Array.isArray(policy.administrators),'POLICY');
  assert(/^ghcr\.io\/google\/osv-scanner-action:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/.test(policy.osvImage),'SCANNER_PIN');
  for(const item of policy.administrators)assert(Number.isSafeInteger(item.repositoryId)&&item.repositoryId>0
    &&/^[\w.-]+\/[\w.-]+$/.test(item.repository)&&/^[\w.-]+\/[\w.-]+$/.test(item.upstream)
    &&/^\.github\/workflows\/[\w.-]+\.yml$/.test(item.workflow),'POLICY_TARGET');
  return policy;
}
export function dependencyMode(event,policy){
  const item=policy.administrators.find(x=>x.repositoryId===event.repository?.id);
  if(!item)return 'native';
  assert(event.repository.full_name===item.repository&&event.repository.private===true,'TARGET_IDENTITY');
  return 'private-administrator';
}
export function inventory(lock){
  assert(lock&&[2,3].includes(lock.lockfileVersion)&&lock.packages&&typeof lock.packages==='object','NPM_LOCK');
  const packages=new Map();
  for(const [path,pkg] of Object.entries(lock.packages)){
    if(!path)continue;
    assert(!pkg.link&&typeof pkg.version==='string'&&pkg.version.length>0,'NPM_UNRESOLVED');
    const name=pkg.name??path.split('node_modules/').at(-1);
    assert(name&&typeof pkg.resolved==='string'&&pkg.resolved.startsWith('https://registry.npmjs.org/'),'NPM_SOURCE');
    const key=JSON.stringify([name,pkg.version]);
    packages.set(key,{name,version:pkg.version,scope:pkg.dev===true?'development':pkg.dev===false?'runtime':'unknown'});
  }
  assert(packages.size>0,'NO_PACKAGES');return packages;
}
export function checkInventory(lock,result){
  const expected=inventory(lock),actual=new Set();
  assert(Array.isArray(result.results),'SCANNER_JSON');
  for(const group of result.results){assert(Array.isArray(group.packages),'SCANNER_JSON');for(const item of group.packages){
    assert(item.package?.ecosystem==='npm','UNEXPECTED_ECOSYSTEM');
    actual.add(JSON.stringify([item.package.name,item.package.version]));
  }}
  assert(expected.size===actual.size&&[...expected.keys()].every(k=>actual.has(k)),'INCOMPLETE_PACKAGES');
  return {lockEntries:Object.keys(lock.packages).length-1,uniquePackages:expected.size,complete:true};
}
export function highFindings(result,{emptyReporter=false}={}){
  if(emptyReporter&&result.results===null&&result.experimental_config?.licenses)result={...result,results:[]};
  assert(Array.isArray(result.results),'REPORTER_JSON');const findings=[];
  for(const group of result.results)for(const item of group.packages??[])for(const vuln of item.vulnerabilities??[]){
    const severity=vuln.database_specific?.severity?.toUpperCase();
    // Do not implement CVSS or ecosystem matching: missing database severity is unresolved.
    assert(['LOW','MODERATE','MEDIUM','HIGH','CRITICAL'].includes(severity),'UNKNOWN_SEVERITY');
    if(['HIGH','CRITICAL'].includes(severity))findings.push({source:group.source,package:item.package,id:vuln.id,severity});
  }
  return findings;
}
export function newPackageFindings(base,head,reported){
  // OSV Reporter first compares advisory occurrence counts, which can suppress a changed package version.
  // Reconcile the scanner's facts, without implementing advisory matching or version-range evaluation.
  const key=x=>JSON.stringify([x.source?.type,x.source?.path,x.package.ecosystem,x.package.name,x.package.version,x.id,x.severity]);
  const previous=new Set(highFindings(base).map(key));
  const exact=highFindings(head).filter(x=>!previous.has(key(x)));
  return [...new Map([...highFindings(reported,{emptyReporter:true}),...exact].map(x=>[key(x),x])).values()];
}
export function newTools(base,head){
  const key=x=>JSON.stringify([x.source,x.version,x.id,x.severity]);
  const previous=new Set(base.map(key));return head.filter(x=>!previous.has(key(x)));
}
export function requireOnline(env){
  assert(typeof env.GH_TOKEN==='string'&&env.GH_TOKEN.trim().length>0,'TOKEN_REQUIRED');
  assert(!env.ZIZMOR_OFFLINE&&!env.ZIZMOR_NO_ONLINE_AUDITS,'OFFLINE_FORBIDDEN');
}

export function actionFindings(findings,documents){
  assert(Array.isArray(findings),'ZIZMOR_JSON');const results=new Map();
  for(const finding of findings.filter(f=>f.ident==='known-vulnerable-actions')){
    const severity=finding.determinations?.severity;assert(['Low','Medium','High'].includes(severity),'ACTION_SEVERITY');
    let linked=false;
    for(const location of finding.locations??[]){
      const symbolic=location.symbolic,annotation=symbolic?.annotation;
      if(!/^GHSA-[a-z0-9-]+$/.test(annotation??''))continue;
      const file=symbolic.key?.Local?.verbatim_path,doc=documents.get(file);assert(doc,'ACTION_LOCATION');
      let value=doc;
      for(const element of symbolic.route?.route??[]){
        const key=Object.hasOwn(element,'Key')?element.Key:element.Index;
        assert(key!==undefined&&value!=null,'ACTION_ROUTE');value=value[key];
      }
      const match=/^([\w.-]+\/[\w.-]+)(?:\/[^@]+)?@([a-f0-9]{40})$/.exec(value??'');assert(match,'ACTION_REFERENCE');
      const item={repository:match[1],sha:match[2],id:annotation,severity};results.set(JSON.stringify([item.repository,item.sha,item.id]),item);linked=true;
    }
    assert(linked,'ACTION_ADVISORY_LINK');
  }return [...results.values()];
}
export function newActions(base,head){
  const key=x=>JSON.stringify([x.repository,x.sha,x.id,x.severity]);const old=new Set(base.map(key));return head.filter(x=>!old.has(key(x)));
}
export function assertInputScope(paths){
  const allowed=/^(?:AGENTS\.md|CONTRIBUTING\.md|README\.md|\.gitignore|mise\.(?:toml|lock)|\.github\/(?:dependabot\.yml|renovate\.json|release-template\.md\.mustache|workflows\/(?:actions\.lock|pr-title\.yml|settings-sync\.yml))|\.mise\/locks\/npm\/\d+\.\d+\.\d+\/(?:aube-lock\.yaml|package\.json)|safe-settings\/(?:deployment-settings\.yml|settings\.yml|repos\/[^/]+\.ya?ml))$/;
  assert(paths.every(path=>allowed.test(path)),'INPUT_UNCOVERED');
}

export function licenseFacts(base,head){
  const collect=result=>new Map(result.results.flatMap(group=>group.packages.map(item=>[JSON.stringify([group.source?.path,item.package.name,item.package.version]),{package:item.package,licenses:[...(item.licenses??[])].sort()}])));
  const before=collect(base),after=collect(head),changes=[];
  for(const key of new Set([...before.keys(),...after.keys()])){
    const old=before.get(key),current=after.get(key);
    if(JSON.stringify(old?.licenses)!==JSON.stringify(current?.licenses))changes.push({package:(current??old).package,before:old?.licenses??null,after:current?.licenses??null});
  }
  return {changes,unknown:[...after.values()].filter(x=>!x.licenses.length),blocking:false};
}
