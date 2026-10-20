import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import {buildLimits} from '../../core/src/build-manifest.js';
import {generationPlan} from '../../core/src/release-production.js';
import {nativeInspectionTimeoutMs} from '../src/release-native.js';
import {artifactDownloadTimeout} from '../src/artifact-handoff.js';
import {maxArtifactArchiveBytes} from '../src/artifact-file.js';
import {releasePublishTimeoutMinutes} from '../src/release-lifecycle.js';
import {assertWorkflowDocument} from '../src/workflow-policy.js';

const load=async(name:string)=>YAML.parse(await readFile('.github/workflows/'+name,'utf8'));
const minute=60000;
const transfer=artifactDownloadTimeout(maxArtifactArchiveBytes);
const native=buildLimits.maxFiles*nativeInspectionTimeoutMs;

it('covers complete inspection and build budgets at the asset limit',async()=>{
  const completion=await load('release-build-complete.yml');
  // Explicit allowance for setup, extraction, hashing and final artifact/report handling.
  const overhead=30*minute;
  expect(completion.jobs.inspect['timeout-minutes']*minute).toBeGreaterThanOrEqual(transfer+native+overhead);
  for(const name of ['release-build.yml','product-build.yml']){
    const d=await load(name);
    expect(d.jobs.plan['timeout-minutes']).toBeGreaterThanOrEqual(45+15);
    for(const job of ['build_windows','build_linux']){
      expect(d.jobs[job]['timeout-minutes']*minute).toBeGreaterThanOrEqual(45*minute+native+transfer+overhead);
      expect(d.jobs[job]['timeout-minutes']).toBeLessThanOrEqual(360);
    }
  }
  expect(completion.jobs.accept['timeout-minutes']*minute).toBeGreaterThanOrEqual(2*transfer+overhead);
});

it.each([undefined,30,275,361])('rejects an altered inspection job budget: %s',async value=>{
  const d=await load('release-build-complete.yml');
  expect(()=>assertWorkflowDocument('.github/workflows/release-build-complete.yml',d)).not.toThrow();
  if(value===undefined)delete d.jobs.inspect['timeout-minutes'];else d.jobs.inspect['timeout-minutes']=value;
  expect(()=>assertWorkflowDocument('.github/workflows/release-build-complete.yml',d)).toThrow();
});

it('covers seed consumers, maximum generation calls and upload/readback budgets',async()=>{
  const d=await load('release.yml');
  for(const job of ['prepare','generation-ticket','generated-candidate']){
    expect(d.jobs[job]['timeout-minutes']*minute).toBeGreaterThanOrEqual(transfer+30*minute);
  }
  const plan=generationPlan('a'.repeat(64),'b'.repeat(40),Array.from({length:8},(_,i)=>String(i)));
  expect(d.jobs.generate['timeout-minutes']*minute).toBeGreaterThanOrEqual(plan.jobTimeoutMs+transfer+10*minute);
  const assets=Array.from({length:buildLimits.maxFiles},(_,i)=>({name:String(i),size:buildLimits.maxTotalBytes/buildLimits.maxFiles,sha256:'a'.repeat(64)}));
  expect(releasePublishTimeoutMinutes(assets)).toBe(328);
  expect(releasePublishTimeoutMinutes(assets)).toBeLessThanOrEqual(360);
  expect(d.jobs.publish['timeout-minutes']).toBe('${{ fromJSON(needs.inspect.outputs.publishTimeoutMinutes) }}');
});
