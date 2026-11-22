import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {init,parse} from 'es-module-lexer';
import YAML from 'yaml';
import {validatorPath} from './required-workflow-binding.mjs';

const roots=['package.json','package-lock.json','npm-shrinkwrap.json','.npmrc',
  'mise.toml','mise.lock','.mise/','.github/jactionlint.yaml'];
const policyPaths=/(?:^|[\s"'(])(?:\.\/)?policy\/([\w./-]+)/g;
const actionPaths=/\$\{\{\s*github\.action_path\s*\}\}\/([\w./-]+)/g;
const commandPaths=/(?:^|[\s;&|])(?:node|python3?|pwsh|bash|cat|source|\.)\s+(?:\.\/)?((?:scripts|tools|config|schema|templates|packages|\.mise)\/[\w./-]+)/g;
const localUrls=/new URL\(([^\n]+?),\s*import\.meta\.url\)/g;
const trustedAssets={
  'scripts/private-lifecycle-policy.mjs':[
    'config/private-lifecycle/dependabot.yml','config/private-lifecycle/renovate.json','config/private-lifecycle/history/',
    'templates/lifecycle-sample/','templates/release/steward-release-publish.yml','templates/release/steward-release-channels.yml'
  ]
};
const sourceKind=/\.(?:mjs|js|cjs|mts|ts|cts)$/;
const validSha=sha=>typeof sha==='string'&&/^[a-f0-9]{40}$/.test(sha);
const check=(ok,code)=>{if(!ok)throw Error('VALIDATOR_SOURCE_'+code);};
const utf8=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);

export function sourceGit(directory,args) {
  return execFileSync('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=',...args],
    {cwd:directory,windowsHide:true,timeout:90000,maxBuffer:64*1024*1024});
}

/** Digest the executable policy checkout, independent of its surrounding commit. */
export async function validatorSource(directory,sha) {
  check(validSha(sha),'COMMIT');
  await init;
  const git=args=>sourceGit(directory,args);
  const inventory=new Map();
  for(const line of utf8(git(['ls-tree','-rz','--full-tree',sha])).split('\0').filter(Boolean)){
    const item=/^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/s.exec(line);
    check(item&&!inventory.has(item[4]),'TREE');
    inventory.set(item[4],{mode:item[1],oid:item[3]});
  }
  const selected=new Map(),queue=[];
  const add=(path,required=false)=>{
    if(inventory.has(path)){
      if(!selected.has(path)){
        selected.set(path,inventory.get(path));queue.push(path);
        // The opaque ncc entry can load its emitted runtime assets without explicit imports.
        if(path==='packages/runner/dist/index.js')add('packages/runner/dist/');
      }
      return;
    }
    const prefix=path.endsWith('/')?path:path+'/';
    const descendants=[...inventory.keys()].filter(p=>p.startsWith(prefix));
    check(!required||descendants.length,'LOCAL_DEPENDENCY');
    for(const file of descendants)add(file);
  };
  const resolve=(parent,path)=>posix.normalize(path.startsWith('.')?posix.join(posix.dirname(parent),path):path);
  const uses=value=>{
    check(typeof value==='string','ACTION_REFERENCE');
    if(value.startsWith('./')){
      const target=posix.normalize(value).replace(/^policy\//,'');
      check(!target.startsWith('target/'),'TARGET_ACTION');
      if(target.startsWith('.github/workflows/'))add(target,true);
      else {
        const metadata=['action.yml','action.yaml'].map(file=>posix.join(target,file)).filter(file=>inventory.has(file));
        check(metadata.length===1,'LOCAL_ACTION_METADATA');
        add(metadata[0],true);
      }
      return;
    }
    check(/@[a-f0-9]{40}$/.test(value),'UNPINNED_ACTION');
  };
  const runInputs=(text,directory,action)=>{
    for(const line of text.split('\n').filter(line=>!line.trimStart().startsWith('#'))) {
      for(const [,path] of line.matchAll(policyPaths))add(path,true);
      if(directory==='policy')for(const [,path] of line.matchAll(commandPaths))add(path,true);
      if(action)for(const [,path] of line.matchAll(actionPaths))add(resolve(action,'./'+path),true);
    }
  };
  const yaml=(text,path)=>{
    const document=YAML.parse(text);
    const step=(step,directory,action)=>{
      if(step.uses)uses(step.uses);
      if(typeof step.run==='string')runInputs(step.run,step['working-directory']??directory,action);
    };
    if(path.startsWith('.github/workflows/'))for(const job of Object.values(document.jobs??{})){
      if(job.uses)uses(job.uses);
      for(const item of job.steps??[])step(item,job.defaults?.run?.['working-directory']??document.defaults?.run?.['working-directory']);
    }else for(const item of document.runs?.steps??[])step(item,undefined,path);
    if(document.runs?.main)add(resolve(path,'./'+document.runs.main),true);
    if(document.runs?.pre)add(resolve(path,'./'+document.runs.pre),true);
    if(document.runs?.post)add(resolve(path,'./'+document.runs.post),true);
  };
  add(validatorPath,true);
  for(const path of roots)add(path);
  for(const path of inventory.keys())if(/^(?:packages\/[^/]+|services\/settings-events)\/package\.json$/.test(path))add(path);
  for(let index=0;index<queue.length;index++){
    const path=queue[index],entry=selected.get(path);
    check(entry.mode==='100644'||entry.mode==='100755','FILE_MODE');
    if(path.startsWith('packages/runner/dist/'))continue; // Installed bundle is already a Git-identified executable.
    if((!sourceKind.test(path)&&!/\.(?:ya?ml|ps1|py|sh)$/.test(path)))continue;
    const body=utf8(git(['cat-file','blob',entry.oid]));
    if(sourceKind.test(path)){
      const [imports]=parse(body,path);
      for(const item of imports){
        if(item.d===-2)continue;
        check(typeof item.n==='string','DYNAMIC_MODULE');
        if(item.n.startsWith('.'))add(resolve(path,item.n),true);
      }
      for(const [,input] of body.matchAll(/\brequire\(([^\n)]+)\)/g)){
        const match=/^['"]([^'"]+)['"]$/.exec(input.trim());
        check(match,'DYNAMIC_MODULE');
        if(match[1].startsWith('.'))add(resolve(path,match[1]),true);
      }
      for(const [,expression] of body.matchAll(localUrls)){
        const literal=/^['"]([^'"]+)['"]\s*$/.exec(expression);
        if(literal) {
          const asset=resolve(path,literal[1]);
          // A URL for the checkout directory only locates subsequent, separately bound reads.
          if(asset!=='.'&&asset!=='./')add(asset,true);
        }else check(Object.hasOwn(trustedAssets,path),'DYNAMIC_ASSET');
      }
      for(const asset of trustedAssets[path]??[])add(asset);
    }
    if(path===validatorPath||/\/action\.ya?ml$/.test(path)||path.startsWith('.github/workflows/'))yaml(body,path);
  }
  const files=[...selected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,{mode,oid}])=>[path,mode,oid]);
  return {sha,digest:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
}

export async function compareValidatorSources(directory,active,target) {
  check(validSha(active)&&validSha(target),'COMMIT');
  if(active===target)return {changed:false,files:[]};
  sourceGit(directory,['merge-base','--is-ancestor',active,target]);
  const before=await validatorSource(directory,active),after=await validatorSource(directory,target);
  const a=new Map(before.files.map(([path,mode,oid])=>[path,mode+':'+oid]));
  const b=new Map(after.files.map(([path,mode,oid])=>[path,mode+':'+oid]));
  return {changed:before.digest!==after.digest,before:before.digest,after:after.digest,
    files:[...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path)).sort()};
}
