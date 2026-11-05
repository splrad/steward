import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { permitOfflineScript } from './offline-fixtures.js';
import { BuildContractError } from '../../core/src/build-manifest.js';
import { nativePythonSourceVersion } from '../src/release-native.js';
import { pipelineIdentity } from '../src/release-pipeline.js';
import { nativeRequestIdentity } from '../src/native-release-evidence.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { digest } from './native-evidence-fixture.js';
afterEach(()=>vi.restoreAllMocks());
beforeEach(()=>permitOfflineScript(resolve('scripts/inspect-python-release.py')));
it.each([['1.0.0','1.0.0','1.0.0'],['1.0.0rc1','1.0.0-rc.1','1.0.0rc1'],['1.0.0-beta.2','1.0.0-beta.2','1.0.0b2']])('parses exact native Python source %s against RP %s',async(native,rp,expected)=>{
  expect(await nativePythonSourceVersion(process.cwd(),Buffer.from(`[project]\nname="fixture"\nversion="${native}"\n`),rp)).toBe(expected);
});
it.each(['[project]\nversion="1.0.1"','[project]\nversion="1.0.0rc1"','[project]\ndynamic=["version"]','[project]\nversion="1.0.0"\ndynamic=["version"]','[project]\nversion="1.0.0-unknown"'])('rejects conflicting, dynamic or invalid Python metadata: %s',async content=>{
  await expect(nativePythonSourceVersion(process.cwd(),Buffer.from(content),'1.0.0')).rejects.toBeInstanceOf(BuildContractError);
});
it.each(['python-stable','python-rc','python-no-lock','node','node-no-lock'])('build identity derives exact S versions and enabled-ecosystem locks: %s',async kind=>{
  const f=productPipelineFixture(),python=kind.startsWith('python'),version=kind==='python-rc'?'1.0.0-rc.1':'1.0.0',native=kind==='python-rc'?'1.0.0rc1':version;
  f.input.controllerDirectory=process.cwd();delete f.source['global.json'];delete f.source.VERSION;
  f.source['release-please-config.json']=JSON.stringify({'include-component-in-tag':false,'include-v-in-tag':true,packages:{'.':{'release-type':python?'python':'node'}}});
  f.source['.release-please-manifest.json']=JSON.stringify({'.':version});
  f.source[python?'pyproject.toml':'package.json']=python?`[project]\nname="fixture"\nversion="${native}"\n`:JSON.stringify({name:'fixture',version});
  if(!kind.endsWith('no-lock'))f.source[python?'requirements-build.txt':'package-lock.json']=python?'fixture==1.0 --hash=sha256:'+'f'.repeat(64):'{"lockfileVersion":3}';
  const unit=f.context.cycle.units[0]!;Object.assign(unit,{version,tag:`v${version}`});
  Object.assign(f.request,nativeRequestIdentity(1,f.context.cycle,f.request));f.request.inputs.operation_key=f.request.operationKey;
  f.input.operationKey=f.request.operationKey;
  f.runs.get(1).display_title=`Build ${f.request.operationKey}`;
  const chunk:any=f.input.state.domainRecords[0]!.value,session=JSON.parse(chunk.content);
  Object.assign(session.generated.units[0],{version,tag:unit.tag});chunk.content=JSON.stringify(session);chunk.documentDigest=digest(chunk.content);
  if(kind.endsWith('no-lock'))await expect(pipelineIdentity(f.input,f.environment,f.gh,f.io)).rejects.toThrow('missing source input');
  else {
    const result=await pipelineIdentity(f.input,f.environment,f.gh,f.io);expect(result.status).toBe('ADMITTED');
    if(result.status==='ADMITTED') {
      expect(result.record.units[0]).toMatchObject({version,packageVersion:native});
      expect(Object.keys(result.record.toolLocks)).toEqual(['controller/mise.lock',python?'source/requirements-build.txt':'source/package-lock.json']);
    }
  }
});

it.each(['1','true','"version"','[1]','["name", false]'])('classifies malformed Python dynamic declaration as a source contract error: %s',async dynamic=>{
  await expect(nativePythonSourceVersion(process.cwd(),Buffer.from(`[project]\nversion="1.0.0"\ndynamic=${dynamic}\n`),'1.0.0')).rejects.toBeInstanceOf(BuildContractError);
});
it.each(['tool = 1','[tool]\npoetry = 1','project = 1'])('classifies malformed Python metadata tables as source contract errors: %s',async content=>{
  await expect(nativePythonSourceVersion(process.cwd(),Buffer.from(content),'1.0.0')).rejects.toBeInstanceOf(BuildContractError);
});
