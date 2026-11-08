import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const mode=process.argv[2];
const controller=process.env.STEWARD_TEST_TOOLCHAIN_ROOT;
assert(controller,'STEWARD_TEST_TOOLCHAIN_ROOT required');
const compile=output=>{
  const args=[join(resolve(controller),'node_modules/typescript/bin/tsc'),'--allowJs','--checkJs','--target','es2022','--module','nodenext','--skipLibCheck',...(output?['--outDir',output]:['--noEmit']),'acceptance-app.js'];
  const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  assert.equal(result.status,0,'TypeScript compilation failed');
};
if(mode==='build')compile('dist');
else if(mode==='types')compile();
else if(mode==='dist'){
  const temporary=mkdtempSync(join(tmpdir(),'lifecycle-build-'));
  try{compile(temporary);assert.deepEqual(readFileSync('dist/acceptance-app.js'),readFileSync(join(temporary,'acceptance-app.js')));}
  finally{rmSync(temporary,{recursive:true,force:true});}
}else if(mode==='config'){
  const version=readFileSync('VERSION','utf8').trim();
  assert.match(version,/^\d+\.\d+\.\d+$/);
  const manifest=JSON.parse(readFileSync('.release-please-manifest.json','utf8'));
  assert.deepEqual(manifest,{'.':version});
  const config=JSON.parse(readFileSync('release-please-config.json','utf8'));
  assert.deepEqual(config.packages,{'.':{'release-type':'simple','version-file':'VERSION'}});
  const delivery=JSON.parse(readFileSync('.github/delivery.json','utf8'));
  assert.equal(delivery.units.length,1);assert.equal(delivery.units[0].id,'app');assert.equal(delivery.units[0].path,'.');
}else throw Error('Unknown validation operation');
