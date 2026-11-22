import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {assert} from './private-dependency-policy.mjs';

function parse(source,decode,error) {
  try {return decode(source);}
  catch {throw Error(error);}
}

export function npmToolLock(manifest,lock,version,supplier) {
  const manifestShape={name:'mise-npm-install',private:true,dependencies:{npm:version}};
  assert(isDeepStrictEqual(parse(manifest,JSON.parse,'NPM_TOOL_MANIFEST'),manifestShape),'NPM_TOOL_MANIFEST');
  const id=`npm@${version}`,integrity=supplier.dist?.integrity;
  assert(supplier.name==='npm'&&supplier.version===version&&/^sha512-[A-Za-z0-9+/=]+$/.test(integrity??''),'NPM_INTEGRITY');
  assert(supplier.dist.tarball===`https://registry.npmjs.org/npm/-/npm-${version}.tgz`,'NPM_DISTRIBUTION');
  assert(Array.isArray(supplier.bundleDependencies),'NPM_BUNDLED_INVENTORY');
  const document=parse(lock,text=>YAML.parse(text,{maxAliasCount:0}),'NPM_TOOL_INVENTORY');
  const bundled=document?.snapshots?.[id]?.bundledDependencies;
  assert(Array.isArray(bundled)&&isDeepStrictEqual([...bundled].sort(),[...supplier.bundleDependencies].sort()),'NPM_BUNDLED_INVENTORY');
  const expected={
    lockfileVersion:'9.0',
    settings:{autoInstallPeers:true,excludeLinksFromLockfile:false},
    importers:{'.':{dependencies:{npm:{specifier:version,version}}}},
    packages:{[id]:{resolution:{integrity},engines:supplier.engines,hasBin:true}},
    snapshots:{[id]:{bundledDependencies:bundled}},
  };
  assert(isDeepStrictEqual(document,expected),'NPM_TOOL_INVENTORY');
  return integrity;
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const {manifest,lock,version,supplier}=parse(readFileSync(0,'utf8'),JSON.parse,'NPM_TOOL_INPUT');
    npmToolLock(manifest,lock,version,supplier);
  } catch (error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
